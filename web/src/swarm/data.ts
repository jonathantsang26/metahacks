import {useEffect, useState} from 'react';
import {create} from 'zustand';
import type {FireData} from '../data/fire';
import {loadFireJson} from '../data/files';

/**
 * The drone-swarm simulation's outputs (pipeline/sim/run.py → public/data/<fire>/swarm/): simulated
 * drones flown over the replayed fire (docs/SWARM.md). Rollouts are precomputed and replayed as static
 * files; the app makes no model calls for them.
 */

export type SwarmPolicy = 'muse-fcst-muse' | 'forecast-physics' | 'muse' | 'muse-hybrid' | 'greedy' | 'lawnmower';
export const POLICY_LABEL: Record<SwarmPolicy, string> = {
  'muse-fcst-muse': 'Muse Spark forecaster + swarm',
  'forecast-physics': 'Physics forecast edge + rule',
  muse: 'Muse Spark swarm',
  'muse-hybrid': 'Muse Spark commander + greedy squads',
  greedy: 'Greedy baseline',
  lawnmower: 'Lawnmower baseline'
};

export type SwarmTask = {squad: number; center_km: [number, number]; radius_km: number; objective: string; why?: string};
/** The forecast the commander targeted at a decision (sim/forecast.py SwarmForecast.targets). */
export type SwarmForecast = {
  method: 'physics' | 'muse';
  status?: 'FORECAST';
  from_map_utc: string;
  valid_utc: string;
  rejected?: boolean;
  note?: string;
  growth_areas: {center_km: [number, number]; area_ha: number; bearing_deg: number}[];
};
export type SwarmDecision = {
  forecast?: SwarmForecast | null;
  t: string;
  waypoints_km: Record<string, [number, number][]>;
  rejected: string[];
  assessment?: string;
  tasks?: SwarmTask[];
  squad_notes?: Record<string, string>;
  errors?: string[];
  spent_usd?: number;
  calls?: number;
};
export type SwarmMetrics = {
  front_cells: number;
  front_seen_within_60min: number;
  front_seen_within_30min: number;
  front_seen_ever: number;
  median_latency_min: number | null;
  mean_map_awareness: number;
  events: {id: string; kind: string; label: string; t: string; first_seen_min: number | null}[];
  flight_hours: number;
  wind_grounded_hours: number;
  crashes: {t: string; drone: number; why: string}[];
  recalls: number;
};
/** One sample: [t_s since t0, lon, lat, alt_m (absolute), mode index, battery 0-1]. */
export type TrackSample = [number, number, number, number, number, number];
export type Rollout = {
  label: string;
  disclaimer: string;
  fire: string;
  policy: SwarmPolicy;
  model: string | null;
  seed: number;
  t0: string;
  t_end: string;
  base_lonlat: [number, number];
  drone_spec: Record<string, number>;
  modes: string[];
  tracks: TrackSample[][];
  decisions: SwarmDecision[];
  recalls: {t: string; drone: number; why: string}[];
  metrics: SwarmMetrics;
  usage?: {calls: number; input_tokens: number; output_tokens: number; spent_usd: number; cap_usd: number};
  truncated: string | null;
};
type Spread = {mean: number; min: number; max: number} | null;
export type SwarmEval = {
  label: string;
  disclaimer: string;
  metric_notes: Record<string, string>;
  policies: Partial<
    Record<
      SwarmPolicy,
      {
        runs: number;
        seeds: number[];
        model: string | null;
        front_seen_within_60min: Spread;
        front_seen_within_30min: Spread;
        front_seen_ever: Spread;
        mean_map_awareness: Spread;
        median_latency_min: Spread;
        flight_hours: Spread;
        wind_grounded_hours: Spread;
        crashes: number;
        spent_usd?: number;
        model_errors?: number;
        model_calls?: number;
      }
    >
  >;
};

export const useSwarmUi = create<{policy: SwarmPolicy; show: boolean; setPolicy: (p: SwarmPolicy) => void; setShow: (v: boolean) => void}>(
  set => ({
    policy: 'muse-fcst-muse',
    show: false,
    setPolicy: policy => set({policy}),
    setShow: show => set({show})
  })
);

function useJson<T>(fire: FireData, file: string | null): {data: T | null; error: string | null} {
  const [state, setState] = useState<{data: T | null; error: string | null}>({data: null, error: null});
  useEffect(() => {
    if (!file) return;
    let live = true;
    setState({data: null, error: null});
    loadFireJson<T>(fire, file).then(
      data => live && setState({data, error: null}),
      e => live && setState({data: null, error: String(e.message ?? e)})
    );
    return () => {
      live = false;
    };
  }, [fire, file]);
  return state;
}

export const useSwarmEval = (fire: FireData) => useJson<SwarmEval>(fire, 'swarm/eval.json');
export const useRollout = (fire: FireData, policy: SwarmPolicy, seed = 0) =>
  useJson<Rollout>(fire, `swarm/${policy}_s${seed}.json`);

/** One line of <run>_s<seed>_events.jsonl: an agent's status and short output at a decision. */
export type AgentEvent = {
  seq: number;
  t_utc: string;
  agent: string;
  parent: string | null;
  role: 'forecaster' | 'commander' | 'squad' | 'drone';
  model: string | null;
  task: string;
  status: 'spawned' | 'done' | 'failed';
  output: string;
};

const eventCache = new Map<string, Promise<AgentEvent[]>>();
export function useAgentEvents(fire: FireData, policy: SwarmPolicy, seed = 0): AgentEvent[] | null {
  const [events, setEvents] = useState<AgentEvent[] | null>(null);
  useEffect(() => {
    let live = true;
    setEvents(null);
    const url = `${fire.base}/swarm/${policy}_s${seed}_events.jsonl`;
    let p = eventCache.get(url);
    if (!p) {
      p = fetch(url).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text().then(txt => txt.split('\n').filter(Boolean).map(l => JSON.parse(l) as AgentEvent));
      });
      eventCache.set(url, p);
    }
    p.then(
      e => live && setEvents(e),
      () => live && setEvents([])
    );
    return () => {
      live = false;
    };
  }, [fire, policy, seed]);
  return events;
}

/** Each drone's state at time t (ms): interpolated position, and the mode and battery of the sample before. */
export function dronesAt(r: Rollout, t: number) {
  const s = (t - Date.parse(r.t0)) / 1000;
  return r.tracks.map((track, id) => {
    if (!track.length) return null;
    let lo = 0;
    let hi = track.length - 1;
    if (s <= track[0][0]) hi = 0;
    else if (s >= track[hi][0]) lo = hi;
    else
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (track[mid][0] <= s) lo = mid;
        else hi = mid;
      }
    const a = track[lo];
    const b = track[hi];
    const f = hi > lo ? Math.min(1, Math.max(0, (s - a[0]) / (b[0] - a[0]))) : 0;
    return {
      id,
      lon: a[1] + (b[1] - a[1]) * f,
      lat: a[2] + (b[2] - a[2]) * f,
      alt: a[3] + (b[3] - a[3]) * f,
      mode: r.modes[a[4]] ?? 'base',
      battery: a[5],
      index: lo
    };
  });
}

/** The latest decision at or before t (ms), or null before the first. */
export function decisionAt(r: Rollout, t: number): SwarmDecision | null {
  let out: SwarmDecision | null = null;
  for (const d of r.decisions) {
    if (Date.parse(d.t) <= t) out = d;
    else break;
  }
  return out;
}

/** km east/north of the AOI's south-west corner → lon/lat (the sim's local frame, equirectangular). */
export function kmToLonLat(fire: FireData, [x, y]: [number, number]): [number, number] {
  const [w, s, , n] = fire.aoi.bbox;
  const mLat = (Math.PI * 6378137) / 180;
  const mLon = mLat * Math.cos((((s + n) / 2) * Math.PI) / 180);
  return [w + (x * 1000) / mLon, s + (y * 1000) / mLat];
}
