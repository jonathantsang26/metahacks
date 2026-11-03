import {useEffect} from 'react';
import type {FireData} from '../data/fire';
import {useTime} from '../state/time';
import {AgentGraph} from '../swarm/AgentGraph';
import {decisionAt, dronesAt, POLICY_LABEL, useAgentEvents, useRollout, useSwarmEval, useSwarmUi, type SwarmEval, type SwarmPolicy} from '../swarm/data';
import {chipTime, pct} from './fmt';
import {Button, Missing, SubHead} from './ui';

const POLICIES: SwarmPolicy[] = ['muse-fcst-muse', 'forecast-physics', 'muse', 'muse-hybrid', 'greedy', 'lawnmower'];
const SHORT: Record<SwarmPolicy, string> = {
  'muse-fcst-muse': 'Forecast+Muse',
  'forecast-physics': 'Forecast+rule',
  muse: 'Muse',
  'muse-hybrid': 'Muse+rule',
  greedy: 'Greedy',
  lawnmower: 'Lawnmower'
};
/** Until the live Muse Spark forecast run is published, the panel opens on the physics forecast run. */
const FALLBACK: Partial<Record<SwarmPolicy, SwarmPolicy>> = {'muse-fcst-muse': 'forecast-physics'};
const OBJECTIVE: Record<string, string> = {
  track_head: 'Track the head',
  track_flank: 'Track a flank',
  search: 'Search',
  map_burned: 'Map burned ground',
  hold: 'Hold'
};
const MODE: Record<string, string> = {fly: 'Flying', rtb: 'Returning', swap: 'Battery swap', base: 'At base', lost: 'Lost'};

function spread(s: {mean: number; min: number; max: number} | null | undefined, f: (x: number) => string) {
  if (!s) return '–';
  return s.min === s.max ? f(s.mean) : `${f(s.mean)} (${f(s.min)}–${f(s.max)})`;
}

function EvalTable({evalDoc}: {evalDoc: SwarmEval}) {
  const rows = POLICIES.filter(p => evalDoc.policies[p]);
  return (
    <div className="px-3 py-2">
      <table className="w-full text-xs tabular-nums">
        <thead className="text-muted">
          <tr>
            <th className="py-0.5 text-left font-normal">Policy</th>
            <th className="text-right font-normal" title={evalDoc.metric_notes.front_seen_within_60min}>
              Front seen ≤60 min
            </th>
            <th className="text-right font-normal" title={evalDoc.metric_notes.mean_map_awareness}>
              Area mapped
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => {
            const r = evalDoc.policies[p]!;
            return (
              <tr key={p} className="border-t border-hairline">
                <td className="py-1">
                  {POLICY_LABEL[p]}
                  <div className="text-2xs text-muted">
                    {r.runs} run{r.runs === 1 ? '' : 's'}
                    {r.model ? ` · ${r.model}` : ' · no model'}
                    {r.spent_usd !== undefined ? ` · $${r.spent_usd.toFixed(2)}` : ''}
                  </div>
                </td>
                <td className="text-right">{spread(r.front_seen_within_60min, pct)}</td>
                <td className="text-right">{spread(r.mean_map_awareness, pct)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-1 text-2xs text-muted">{evalDoc.metric_notes.front_seen_within_60min}</div>
    </div>
  );
}

/** Incident rail → Swarm: the simulated drone swarm, its agents and latest decision at t, and the eval. */
export function SwarmPanel({fire}: {fire: FireData}) {
  const {policy, setPolicy, show, setShow} = useSwarmUi();
  const t = useTime(s => s.t);
  const setTime = useTime(s => s.setTime);
  const tz = fire.aoi.timezone;
  const {data: rollout, error} = useRollout(fire, policy);
  const {data: evalDoc} = useSwarmEval(fire);
  const events = useAgentEvents(fire, policy);
  useEffect(() => {
    const f = FALLBACK[policy];
    if (error && f) setPolicy(f);
  }, [error, policy, setPolicy]);
  // Opening the panel shows the swarm on the map.
  useEffect(() => setShow(true), [setShow]);
  const t0 = rollout ? Date.parse(rollout.t0) : 0;
  const t1 = rollout ? Date.parse(rollout.t_end) : 0;
  const inWindow = !!rollout && t >= t0 && t <= t1;
  const decision = rollout && inWindow ? decisionAt(rollout, t) : null;
  const drones = rollout && inWindow ? dronesAt(rollout, t) : [];
  const squadNote = (s: number) => decision?.squad_notes?.[String(s)];
  return (
    <div className="pb-2">
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="text-sm font-semibold">Drone swarm</span>
        <span className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-muted">
            <input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)} className="h-3 w-3 accent-[var(--text)]" />
            On map
          </label>
        </span>
      </div>
      <div className="px-3 pt-1 text-xs text-muted">
        Would a drone swarm have kept eyes on the front? Simulated thermal survey drones (DJI Matrice 4TD class: 12 m/s wind limit, 120 m up; MuJoCo physics, HRRR wind) fly over this fire&apos;s real
        terrain and its reconstructed spread, and see only what their cameras see. No drones flew this fire.
      </div>
      <div className="mx-3 mt-2 grid grid-cols-3 overflow-hidden rounded-md shadow-[0_0_0_1px_var(--hairline)]">
        {POLICIES.map(p => (
          <button
            key={p}
            onClick={() => setPolicy(p)}
            className={`px-1 py-1 text-xs ${policy === p ? 'bg-selected font-medium' : 'bg-tabactive text-muted'}`}
          >
            {SHORT[p]}
          </button>
        ))}
      </div>
      {!rollout ? (
        error ? (
          <div className="px-3 py-4 text-center text-sm text-muted">
            No {SHORT[policy]} rollout has been published for this fire yet.
          </div>
        ) : (
          <Missing file={`swarm/${policy}_s0.json`} error={null} />
        )
      ) : (
        <>
          <div className="flex items-center justify-between px-3 pt-2 text-xs">
            <span className="text-muted">
              {chipTime(t0, tz)} to {chipTime(t1, tz)}
            </span>
            {!inWindow && (
              <Button onClick={() => setTime(t0 + 60_000)} title="Move the clock to the start of the simulated flights">
                Go to start
              </Button>
            )}
          </div>
          {inWindow && !!events?.length && (
            <>
              <SubHead>Agents</SubHead>
              <AgentGraph events={events} t={t} />
            </>
          )}
          {inWindow && (
            <>
              <SubHead aside={decision ? <span className="font-mono text-2xs text-muted">{chipTime(Date.parse(decision.t), tz)}</span> : null}>
                {policy.startsWith('muse') ? 'Latest orders' : 'Latest plan'}
              </SubHead>
              <div className="space-y-1 px-3 py-1.5 text-sm">
                {!decision && <div className="text-muted">No decision yet.</div>}
                {decision && !policy.startsWith('muse') && <div className="text-xs text-muted">A fixed rule plans this swarm; no model is involved.</div>}
                {decision?.forecast && (
                  <div className="text-xs">
                    <span className="font-mono text-2xs text-live">FORECAST +1 h</span>{' '}
                    {decision.forecast.rejected
                      ? 'rejected by the validator; no growth assumed'
                      : `${decision.forecast.growth_areas.length} growth areas by ${chipTime(Date.parse(decision.forecast.valid_utc), tz)}, from the ${chipTime(Date.parse(decision.forecast.from_map_utc), tz)} official map`}
                    <span className="text-muted"> · {decision.forecast.method === 'muse' ? 'Muse Spark forecaster' : 'physics forecaster'}</span>
                  </div>
                )}
                {decision?.assessment && <div>{decision.assessment}</div>}
                {decision?.tasks?.map(task => (
                  <div key={task.squad} className="text-xs">
                    <span className="font-medium">Squad {task.squad}</span> · {OBJECTIVE[task.objective] ?? task.objective}
                    {task.why ? <span className="text-muted"> · {task.why}</span> : null}
                    {squadNote(task.squad) ? <div className="text-muted">↳ {squadNote(task.squad)}</div> : null}
                  </div>
                ))}
                {!!decision?.errors?.length && (
                  <div className="text-2xs text-muted">
                    {decision.errors.length} model call{decision.errors.length === 1 ? '' : 's'} failed; those drones kept their previous plan.
                  </div>
                )}
                {decision && (policy === 'muse' || policy === 'muse-fcst-muse') && (
                  <div className="text-2xs text-muted">
                    {rollout.model} · a commander and {decision.tasks?.length ?? 0} squad agents · the model&apos;s own words
                  </div>
                )}
                {decision && policy === 'muse-hybrid' && (
                  <div className="text-2xs text-muted">
                    {rollout.model} commander assigns the areas (its own words); a fixed rule flies the drones inside them
                  </div>
                )}
              </div>
              <SubHead>Drones</SubHead>
              <ul className="grid grid-cols-2 gap-x-3 px-3 py-1.5 text-xs">
                {drones.map(d =>
                  d ? (
                    <li key={d.id} className="flex justify-between">
                      <span>
                        Drone {d.id} · {MODE[d.mode] ?? d.mode}
                      </span>
                      <span className="tabular-nums text-muted">{Math.round(d.battery * 100)}%</span>
                    </li>
                  ) : null
                )}
              </ul>
            </>
          )}
          <SubHead>This run</SubHead>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 px-3 py-1.5 text-xs tabular-nums">
            <span className="text-muted">Front seen ≤60 min</span>
            <span className="text-right">{pct(rollout.metrics.front_seen_within_60min)}</span>
            <span className="text-muted">Burned area mapped</span>
            <span className="text-right">{pct(rollout.metrics.mean_map_awareness)}</span>
            <span className="text-muted">Flight hours</span>
            <span className="text-right">{rollout.metrics.flight_hours.toFixed(1)}</span>
            <span className="text-muted">Grounded by wind</span>
            <span className="text-right">{rollout.metrics.wind_grounded_hours.toFixed(1)} h</span>
            <span className="text-muted">Drones lost</span>
            <span className="text-right">{rollout.metrics.crashes.length}</span>
            {rollout.usage && (
              <>
                <span className="text-muted">Model calls · cost</span>
                <span className="text-right">
                  {rollout.usage.calls} · ${rollout.usage.spent_usd.toFixed(2)}
                </span>
              </>
            )}
          </div>
          {rollout.truncated && <div className="px-3 text-2xs text-muted">Ended early: {rollout.truncated}</div>}
        </>
      )}
      {evalDoc && (
        <>
          <SubHead>All runs</SubHead>
          <EvalTable evalDoc={evalDoc} />
        </>
      )}
    </div>
  );
}
