import {useMemo, useState} from 'react';
import type {AgentEvent} from './data';

/**
 * The agent tree of a swarm rollout (Forecaster → Commander → 3 squads → 6 drones), replayed from its
 * precomputed event log in step with the clock. A node takes the status of its latest event at t; an
 * edge lights while the message it carries is fresh (its child's latest event is the current step and
 * under LIT_MS old). Under each node: decisions so far · rejected or failed outputs.
 */

type Node = {id: string; role: AgentEvent['role']; label: string; x: number; y: number; w: number};
type AgentState = {last: AgentEvent | null; decisions: number; rejected: number; spawn: AgentEvent};

const W = 320;
const LIT_MS = 6 * 60_000;
const COLOR: Record<AgentEvent['status'], string> = {spawned: 'var(--text-muted)', done: 'var(--ok)', failed: 'var(--live)'};
const ROLE: Record<AgentEvent['role'], string> = {forecaster: 'Forecaster', commander: 'Commander', squad: 'Squad', drone: 'Drone'};

function layout(ids: Map<string, AgentEvent>): Node[] {
  const nodes: Node[] = [];
  const hasFc = ids.has('forecaster');
  if (hasFc) nodes.push({id: 'forecaster', role: 'forecaster', label: 'Forecaster', x: 70, y: 18, w: 100});
  nodes.push({id: 'commander', role: 'commander', label: 'Commander', x: hasFc ? 220 : W / 2, y: 18, w: 100});
  const squads = [...ids.values()].filter(e => e.role === 'squad');
  const drones = [...ids.values()].filter(e => e.role === 'drone');
  squads.forEach((e, i) => nodes.push({id: e.agent, role: 'squad', label: `Squad ${i}`, x: ((i + 0.5) * W) / squads.length, y: 88, w: 74}));
  drones.forEach((e, i) => nodes.push({id: e.agent, role: 'drone', label: `D${i}`, x: ((i + 0.5) * W) / drones.length, y: 158, w: 42}));
  return nodes;
}

export function AgentGraph({events, t}: {events: AgentEvent[]; t: number}) {
  const [selected, setSelected] = useState<string | null>('commander');
  const {spawns, times, byAgent} = useMemo(() => {
    const spawns = new Map<string, AgentEvent>();
    const byAgent = new Map<string, AgentEvent[]>();
    for (const e of events) {
      if (e.status === 'spawned') spawns.set(e.agent, e);
      else {
        const list = byAgent.get(e.agent) ?? [];
        list.push(e);
        byAgent.set(e.agent, list);
      }
    }
    const times = new Map<AgentEvent, number>();
    for (const e of events) times.set(e, Date.parse(e.t_utc));
    return {spawns, times, byAgent};
  }, [events]);
  const nodes = useMemo(() => layout(spawns), [spawns]);
  const state = useMemo(() => {
    const out = new Map<string, AgentState>();
    for (const [id, spawn] of spawns) {
      let last: AgentEvent | null = null;
      let decisions = 0;
      let rejected = 0;
      for (const e of byAgent.get(id) ?? []) {
        if (times.get(e)! > t) break;
        last = e;
        decisions += 1;
        if (e.status === 'failed') rejected += 1;
      }
      out.set(id, {last, decisions, rejected, spawn});
    }
    return out;
  }, [spawns, byAgent, times, t]);
  const stepT = Math.max(0, ...[...state.values()].map(s => (s.last ? times.get(s.last)! : 0)));
  const pos = new Map(nodes.map(n => [n.id, n]));
  const sel = selected ? state.get(selected) : null;
  return (
    <div className="px-3 py-1.5">
      <svg viewBox={`0 0 ${W} 190`} className="w-full" role="img" aria-label="Agent graph: forecaster, commander, squads and drones">
        <style>{`@keyframes agpulse{from{stroke-dashoffset:12}to{stroke-dashoffset:0}}.aglit{stroke-dasharray:4 2;animation:agpulse .6s linear infinite}`}</style>
        {nodes.map(n => {
          const parent = state.get(n.id)?.spawn.parent;
          const p = parent ? pos.get(parent) : undefined;
          if (!p) return null;
          const s = state.get(n.id)!;
          const lit = !!s.last && times.get(s.last) === stepT && t - stepT < LIT_MS;
          const horizontal = p.y === n.y;
          const x1 = horizontal ? p.x + p.w / 2 : p.x;
          const y1 = horizontal ? p.y : p.y + 11;
          const x2 = horizontal ? n.x - n.w / 2 : n.x;
          const y2 = horizontal ? n.y : n.y - 11;
          return (
            <line
              key={`e-${n.id}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={lit ? (s.last!.status === 'failed' ? COLOR.failed : 'var(--text)') : 'var(--hairline)'}
              strokeWidth={lit ? 1.6 : 1}
              className={lit ? 'aglit' : undefined}
            />
          );
        })}
        {nodes.map(n => {
          const s = state.get(n.id)!;
          const status = s.last?.status ?? 'spawned';
          return (
            <g key={n.id} onClick={() => setSelected(n.id)} style={{cursor: 'pointer'}}>
              <rect
                x={n.x - n.w / 2}
                y={n.y - 11}
                width={n.w}
                height={22}
                rx={5}
                fill="var(--bg-tab-active)"
                stroke={COLOR[status]}
                strokeWidth={selected === n.id ? 2.4 : 1.4}
              />
              <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize={n.role === 'drone' ? 10 : 11} fill="var(--text)">
                {n.label}
              </text>
              <text x={n.x} y={n.y + 23} textAnchor="middle" fontSize={8.5} fill="var(--text-muted)">
                {s.decisions}
                {s.rejected ? ` · ${s.rejected} rej` : ''}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-0.5 flex gap-3 text-2xs text-muted">
        <span>
          <span style={{color: COLOR.done}}>■</span> done
        </span>
        <span>
          <span style={{color: COLOR.failed}}>■</span> rejected or failed
        </span>
        <span>count = decisions · rejected</span>
      </div>
      {sel && (
        <div className="mt-1.5 rounded-md px-2 py-1.5 text-xs shadow-[0_0_0_1px_var(--hairline)]">
          <div className="flex justify-between">
            <span className="font-medium">
              {ROLE[sel.spawn.role]} {sel.spawn.role === 'squad' || sel.spawn.role === 'drone' ? sel.spawn.agent.split('-')[1] : ''}
            </span>
            <span className="font-mono text-2xs text-muted">{sel.spawn.model ?? 'rule'}</span>
          </div>
          <div className="text-2xs text-muted">{sel.spawn.task}</div>
          <div className="mt-1">
            {sel.last ? (
              <>
                <span className="font-mono text-2xs" style={{color: COLOR[sel.last.status]}}>
                  {sel.last.status} · {sel.last.t_utc.slice(11, 16)}Z
                </span>{' '}
                {sel.last.output}
              </>
            ) : (
              <span className="text-muted">No output yet.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
