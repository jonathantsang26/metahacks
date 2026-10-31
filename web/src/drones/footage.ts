import {useEffect, useMemo, useState} from 'react';
import {create} from 'zustand';
import type {FireData} from '../data/fire';
import {loadFireJson, useFireJson} from '../data/files';

/** C → B footage files (WORKSTREAMS.md §1): web/public/data/<fire>/footage/. */
export type Clip = {
  id: string;
  title: string;
  /** Relative to footage/. */
  src: string;
  fps: number;
  width: number;
  height: number;
  source: string;
  /** Shown in the PiP, e.g. "FLAME 2 · prescribed burn · not this fire". */
  note: string;
  /** False for footage we may not redistribute (FLAME 2): the video is local-only, the overlays are not. */
  publish?: boolean;
  /** The ≤ 30 s window of the source video that Sentinel picked, in seconds. */
  window_s?: [number, number];
  sentinel?: {weights: string; fps: number; conf: number};
};

/** Sentinel boxes, source pixels. */
export type Detection = {frame: number; box: [number, number, number, number]; cls: 'fire' | 'smoke'; conf: number};

/** SAM 3.1 masks: `path` is in the mask raster's own coordinates (`size`); `bounds` in source pixels. */
export type Mask = {
  frame: number;
  object_id: string;
  prompt: string;
  bounds: [number, number, number, number];
  size: [number, number];
  path: string;
  conf: number | null;
  /** Fraction of the frame the mask covers (optional; computed by step 12c). */
  area_frac?: number;
};

export type FrameMetrics = {precision: number | null; recall: number | null; f1: number; tp: number; fp: number; fn: number; tn: number};

/** eval/sentinel.json and eval/sam_video.json share this shape (steps 12b and 12c). */
export type DetectorEval = {
  metric: string;
  precision: number | null;
  recall: number | null;
  f1: number;
  n: number;
  n_positive: number;
  threshold: number;
  dataset: {kind: string; name: string; sample: number | null};
  any: FrameMetrics;
  fire: FrameMetrics;
  smoke: FrameMetrics;
  weights?: {file: string; fire_classes: string[]; training: {val: {map50: number}; epochs: number; data: unknown} | null};
  baseline?: {weights: {file: string; fire_classes: string[]}; any: FrameMetrics};
  clips?: Record<string, {masks: number; objects: number; share: number | null; sentinel_boxes: number}>;
  method: string;
  date: string;
};

type FootageState = {
  clipId: string | null;
  /** Playback position of the selected clip, seconds. */
  time: number;
  playing: boolean;
  expanded: boolean;
  showBoxes: boolean;
  showMasks: boolean;
  /** A seek request for the player; `seq` makes repeated requests distinct. */
  seek: {time: number; seq: number} | null;
  select: (id: string | null) => void;
  setTime: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  setExpanded: (expanded: boolean) => void;
  toggle: (key: 'showBoxes' | 'showMasks') => void;
  requestSeek: (time: number) => void;
};

export const useFootage = create<FootageState>(set => ({
  clipId: null,
  time: 0,
  playing: false,
  expanded: false,
  showBoxes: true,
  showMasks: true,
  seek: null,
  select: clipId => set({clipId, time: 0, playing: clipId !== null, expanded: false}),
  setTime: time => set({time}),
  setPlaying: playing => set({playing}),
  setExpanded: expanded => set({expanded}),
  toggle: key => set(s => ({[key]: !s[key]}) as Partial<FootageState>),
  requestSeek: time => set(s => ({time, seek: {time, seq: (s.seek?.seq ?? 0) + 1}}))
}));

export function useClips(fire: FireData) {
  return useFireJson<Clip[]>(fire, 'footage/clips.json');
}

export function useSelectedClip(fire: FireData): Clip | null {
  const clips = useClips(fire).data;
  const id = useFootage(s => s.clipId);
  return clips?.find(c => c.id === id) ?? null;
}

/** Detections and masks for one clip; a missing masks file is not an error (SAM may not have run yet). */
export function useClipOverlays(fire: FireData, clip: Clip | null) {
  const [state, setState] = useState<{detections: Detection[] | null; masks: Mask[] | null; error: string | null}>({
    detections: null,
    masks: null,
    error: null
  });
  useEffect(() => {
    if (!clip) return;
    let live = true;
    setState({detections: null, masks: null, error: null});
    Promise.all([
      loadFireJson<Detection[]>(fire, `footage/detections/${clip.id}.json`),
      loadFireJson<Mask[]>(fire, `footage/masks/${clip.id}.json`).catch(() => [] as Mask[])
    ]).then(
      ([detections, masks]) => live && setState({detections, masks, error: null}),
      e => live && setState({detections: null, masks: null, error: String(e.message ?? e)})
    );
    return () => {
      live = false;
    };
  }, [fire, clip]);
  return state;
}

/** Frame-indexed lookups, so the overlay for any playback time is a cheap search. */
export function useFrameIndex<T extends {frame: number}>(items: T[] | null) {
  return useMemo(() => {
    const frames = [...new Set((items ?? []).map(i => i.frame))].sort((a, b) => a - b);
    const byFrame = new Map<number, T[]>();
    for (const i of items ?? []) {
      const list = byFrame.get(i.frame);
      if (list) list.push(i);
      else byFrame.set(i.frame, [i]);
    }
    return {frames, byFrame};
  }, [items]);
}

/** The items on the last sampled frame at or before `frame`, if it is within `hold` frames. */
export function itemsAt<T>(index: {frames: number[]; byFrame: Map<number, T[]>}, frame: number, hold: number): T[] {
  const {frames, byFrame} = index;
  let lo = 0;
  let hi = frames.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid] <= frame) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0 || frame - frames[found] > hold) return [];
  return byFrame.get(frames[found]) ?? [];
}

/** A run of Sentinel boxes or one SAM object, for the Detections list. */
export type Track = {
  key: string;
  kind: 'sentinel' | 'sam';
  label: string;
  conf: number | null;
  start: number;
  end: number;
  count: number;
};

/** Sentinel boxes of one class merged into runs (gaps ≤ 1 s), and one row per SAM object. */
export function buildTracks(clip: Clip, detections: Detection[], masks: Mask[]): Track[] {
  const tracks: Track[] = [];
  for (const cls of ['fire', 'smoke'] as const) {
    let run: Track | null = null;
    for (const d of detections.filter(x => x.cls === cls).sort((a, b) => a.frame - b.frame)) {
      const t = d.frame / clip.fps;
      if (run && t - run.end <= 1) {
        run.end = t;
        run.count++;
        run.conf = Math.max(run.conf ?? 0, d.conf);
      } else {
        if (run) tracks.push(run);
        run = {key: `s-${cls}-${d.frame}`, kind: 'sentinel', label: cls, conf: d.conf, start: t, end: t, count: 1};
      }
    }
    if (run) tracks.push(run);
  }
  const objects = new Map<string, Track>();
  for (const m of masks) {
    const t = m.frame / clip.fps;
    const o = objects.get(m.object_id);
    if (o) {
      o.start = Math.min(o.start, t);
      o.end = Math.max(o.end, t);
      o.count++;
      if (m.conf !== null) o.conf = Math.max(o.conf ?? 0, m.conf);
    } else {
      objects.set(m.object_id, {key: `m-${m.object_id}`, kind: 'sam', label: m.prompt, conf: m.conf, start: t, end: t, count: 1});
    }
  }
  return [...tracks, ...objects.values()].sort((a, b) => a.start - b.start);
}

export const CLASS_LABEL: Record<string, string> = {fire: 'Flame', smoke: 'Smoke', 'sentinel box': 'Sentinel box'};

export const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
