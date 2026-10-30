/**
 * Key Events (DESIGN.md §6.3) from events.json: one glyph per kind, shared by the side list and
 * the timeline track. An ignition estimate is listed only when ignition.json says its start
 * time is identifiable; otherwise the list says the time is withheld and why.
 */
import {useEffect, useMemo, useRef} from 'react';
import type {FireData} from '../data/fire';
import {useFireJson, type EventKind, type FireEvent, type Ignition, type Perimeters, type Series} from '../data/files';
import {formatDate, formatDateTime, zoneLabel} from '../lib/format';
import {useTime} from '../state/time';
import {useUi} from '../state/ui';
import {formatMinutes, interpolate} from './scale';

const HOUR = 3600_000;

/**
 * 12×12 glyphs: ● reported start, ◎ ignition estimate, flame, ▲ spot, ⧗ ridge, wind, ■ containment.
 * `soft` draws the flame as an outline, for an hourly growth rate that is mostly a mapping step.
 */
export function EventGlyph({kind, size = 12, soft = false}: {kind: EventKind; size?: number; soft?: boolean}) {
  const shape = (() => {
    switch (kind) {
      case 'reported_start':
        return <circle cx={6} cy={6} r={4} fill="var(--live)" />;
      case 'ignition_estimate':
        return (
          <>
            <circle cx={6} cy={6} r={4.2} fill="none" stroke="var(--live)" strokeWidth={1.4} />
            <circle cx={6} cy={6} r={1.6} fill="var(--live)" />
          </>
        );
      case 'rapid_growth':
        return (
          <path
            d="M6 1C7 3 9.5 4.2 9.5 7.2A3.5 3.5 0 0 1 2.5 7.2C2.5 5.4 3.8 4.9 4.2 3.2C4.9 4.3 5.4 4.4 6 1Z"
            fill={soft ? 'none' : 'var(--accent)'}
            stroke={soft ? 'var(--accent)' : undefined}
            strokeWidth={soft ? 1.1 : undefined}
            strokeLinejoin="round"
          />
        );
      case 'spot_fire':
        return <path d="M6 1.8 10.4 10H1.6Z" fill="var(--chart-area-stroke)" />;
      case 'ridge_crossing':
        return <path d="M2.5 1.5h7L6 6l3.5 4.5h-7L6 6Z" fill="none" stroke="var(--text)" strokeWidth={1.3} strokeLinejoin="round" />;
      case 'peak_gust':
        return (
          <path
            d="M1.5 4.5h6a1.6 1.6 0 1 0-1.6-1.6M1.5 7.5h8a1.6 1.6 0 1 1-1.6 1.6M1.5 6h3"
            fill="none"
            stroke="var(--text)"
            strokeWidth={1.2}
            strokeLinecap="round"
          />
        );
      case 'containment':
        return <rect x={2.5} y={2.5} width={7} height={7} fill="var(--ok)" />;
    }
  })();
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
      {shape}
    </svg>
  );
}

/**
 * Two consecutive mapped perimeters under an hour apart inside the span a growth event's rate is
 * taken over. The arrival raster spreads every acre between them over those minutes, so an
 * hourly rate over such a pair mostly measures when the perimeters were mapped. A rate averaged
 * between observations (events.json `interval`) merges the pair instead, and says so.
 */
export type MappingStep = {
  from: number;
  to: number;
  minutes: number;
  acresFrom: number;
  acresTo: number;
  /** The event's rate is averaged over `spanH` hours between observations, with this pair merged into it. */
  averaged: boolean;
  spanH: number;
  /** The step's acres prorated to the part of its interval inside the span. */
  inSpan: number;
  /** Hourly rates only: the hour's growth from series.json, and the step's share of it. */
  hourGrowth: number | null;
  share: number | null;
};

/**
 * An events.json row. `interval` is the span a rate is averaged over ([from, to], ISO UTC); the
 * shared FireEvent type does not declare it yet, so the dock reads it through this type.
 */
type EventRow = FireEvent & {interval?: [string, string]};

export type KeyEvent = EventRow & {ms: number; step: MappingStep | null};

export type KeyEvents = {
  /** Events to show, sorted by t, with any ignition estimate the timing rule does not allow removed. */
  events: KeyEvent[] | null;
  error: string | null;
  /** Set when ignition.json withholds the start time. */
  withheld: Ignition | null;
};

/**
 * For a rapid-growth event: the largest sub-hour perimeter step inside the span its rate covers,
 * which is the event's `interval` when events.json gives one, else the hour ending at its time.
 */
function mappingStep(
  e: EventRow & {ms: number},
  perimeters: Perimeters | null,
  series: Series | null
): MappingStep | null {
  const averaged = Array.isArray(e.interval);
  const a = e.interval ? Date.parse(e.interval[0]) : e.ms - HOUR;
  const b = e.interval ? Date.parse(e.interval[1]) : e.ms;
  const p = (perimeters?.features ?? [])
    .map(f => ({t: Date.parse(f.properties.t), acres: f.properties.acres}))
    .sort((x, y) => x.t - y.t);
  let best: MappingStep | null = null;
  for (let k = 1; k < p.length; k++) {
    const from = p[k - 1].t;
    const to = p[k].t;
    const overlap = Math.min(to, b) - Math.max(from, a);
    if (!(to > from && to - from < HOUR && overlap > 0)) continue;
    const gain = p[k].acres - p[k - 1].acres;
    const inSpan = (gain * overlap) / (to - from);
    if (gain > 0 && (!best || inSpan > best.inSpan))
      best = {
        from,
        to,
        minutes: (to - from) / 60_000,
        acresFrom: p[k - 1].acres,
        acresTo: p[k].acres,
        averaged,
        spanH: (b - a) / HOUR,
        inSpan,
        hourGrowth: null,
        share: null
      };
  }
  if (best && !averaged && series) {
    const times = series.t.map(Date.parse);
    const before = interpolate(times, series.area_acres, a);
    const after = interpolate(times, series.area_acres, b);
    if (before !== null && after !== null && after > before) {
      best.hourGrowth = after - before;
      best.share = Math.min(1, best.inSpan / best.hourGrowth);
    }
  }
  return best;
}

/** events.json filtered by ignition.json's timing rule; rapid-growth events carry their perimeter step. */
export function useKeyEvents(fire: FireData): KeyEvents {
  const ev = useFireJson<EventRow[]>(fire, 'events.json');
  const ig = useFireJson<Ignition>(fire, 'ignition.json');
  const perims = useFireJson<Perimeters>(fire, 'perimeters.geojson');
  const series = useFireJson<Series>(fire, 'series.json');
  return useMemo(() => {
    // Without a readable ignition.json the start time can't be shown as identifiable, so any
    // ignition_estimate event is dropped.
    const timeOk = ig.data?.timing.identifiable === true;
    const events = ev.data
      ? ev.data
          .filter(e => e.kind !== 'ignition_estimate' || timeOk)
          .map(e => {
            const timed = {...e, ms: Date.parse(e.t)};
            return {...timed, step: e.kind === 'rapid_growth' ? mappingStep(timed, perims.data, series.data) : null};
          })
          .sort((a, b) => a.ms - b.ms)
      : null;
    return {events, error: ev.error, withheld: ig.data && !ig.data.timing.identifiable ? ig.data : null};
  }, [ev, ig, perims.data, series.data]);
}

/** An hourly rate whose hour holds a mapping step: drawn with the softer glyph. */
export const isMappingArtifact = (s: MappingStep | null): boolean => s !== null && !s.averaged;

/** The muted line under a rapid-growth row (and the track glyph's tooltip line). */
export function stepLine(s: MappingStep): string {
  const gap = formatMinutes(s.minutes);
  // Names the span itself, so the line reads on its own beside the label.
  if (s.averaged) return `${s.spanH.toFixed(1)} h average spans perimeters mapped ${gap} apart`;
  return `Perimeters mapped ${gap} apart; ${s.share !== null && s.share >= 0.5 ? 'mostly' : 'partly'} a mapping step`;
}

/** The full explanation, for the row's tooltip. */
export function stepNote(s: MappingStep, tz: string): string {
  const acres = (v: number) => Math.round(v).toLocaleString('en-US');
  const gap = formatMinutes(s.minutes);
  const gain = s.acresTo - s.acresFrom;
  const pair =
    `Two NIFC perimeters were mapped ${gap} apart ` +
    `(${formatDateTime(s.from, tz)} and ${formatDateTime(s.to, tz)} ${zoneLabel(s.to, tz)}: ${acres(s.acresFrom)} → ${acres(s.acresTo)} acres).`;
  if (s.averaged)
    return (
      `${pair} This rate is averaged over the ${s.spanH.toFixed(1)} h ending at this perimeter, with that pair taken as one, ` +
      `so the ${acres(gain)}-acre jump between them counts toward the average instead of reading as a ${gap} speed.`
    );
  // inSpan equals the whole gain exactly when the pair lies inside the hour.
  const inside = s.inSpan > gain - 0.5;
  return (
    `${pair} The arrival raster spreads the area between them over those minutes` +
    (inside ? `, so all ${acres(gain)} acres fall in this hour` : `; prorated to the part inside this hour, ~${acres(s.inSpan)} acres`) +
    (s.share !== null && s.hourGrowth !== null ? ` (~${Math.round(s.share * 100)}% of its +${acres(s.hourGrowth)} acres)` : '') +
    `. ${s.share !== null && s.share >= 0.5 ? 'Most of' : 'Part of'} this hour's rate reflects when the perimeters were mapped, not a measured spread speed.`
  );
}

/** Index of the last in-window event at or before `t` (−1 if none). */
export function currentEventIndex(events: {ms: number}[], start: number, end: number, t: number): number {
  let cur = -1;
  events.forEach((e, i) => {
    if (e.ms >= start && e.ms <= end && e.ms <= t) cur = i;
  });
  return cur;
}

/** Events whose time comes from a model output: the ignition estimate, or the arrival raster's series/profile. */
function modeled(e: FireEvent): boolean {
  return e.kind === 'ignition_estimate' || /^(series|profile)\.json/.test(e.source);
}

function ModeledChip() {
  return <span className="ml-1 shrink-0 rounded bg-tabgroup px-1 font-mono text-2xs font-normal text-ink">MODELED</span>;
}

/** The side list. Rows inside the replay window seek and fly there; rows outside it don't. */
export function KeyEventsList({fire, data}: {fire: FireData; data: KeyEvents}) {
  const tz = fire.aoi.timezone;
  const {start, end, t, setTime} = useTime();
  const requestFlyTo = useUi(s => s.requestFlyTo);
  const list = useRef<HTMLUListElement>(null);
  const {events, error, withheld} = data;
  const cur = events ? currentEventIndex(events, start, end, t) : -1;

  // Keep the highlighted row visible while the playhead moves (scroll the list only, not the page).
  useEffect(() => {
    const ul = list.current;
    const row = ul?.querySelector<HTMLElement>('[data-current]');
    if (!ul || !row) return;
    if (row.offsetTop < ul.scrollTop) ul.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > ul.scrollTop + ul.clientHeight)
      ul.scrollTop = row.offsetTop + row.offsetHeight - ul.clientHeight;
  }, [cur, events]);

  if (error) return <div className="px-3 py-6 text-center text-sm text-muted">events.json unavailable</div>;
  if (!events) return <div className="px-3 py-6 text-center text-sm text-muted">Loading…</div>;

  return (
    <ul ref={list} className="relative min-h-0 flex-1 overflow-y-auto py-1">
      {withheld && (
        <li>
          <button
            onClick={() => requestFlyTo(withheld.map.lon, withheld.map.lat)}
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-tabgroup"
            title={`Ignition location estimate (model output), 90% radius ${formatRadius(withheld.r90_m)}. Start time withheld: ${withheld.timing.reasons.join('; ')}`}
          >
            <span className="mt-0.5 shrink-0">
              <EventGlyph kind="ignition_estimate" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center text-xs font-medium">
                <span className="truncate">Ignition location (est.)</span>
                <ModeledChip />
              </span>
              <span className="block truncate text-2xs text-muted">90% radius {formatRadius(withheld.r90_m)}</span>
              {withheld.timing.reasons.length > 0 && (
                <span className="block text-2xs text-muted">
                  Start time withheld: {withheld.timing.reasons[0]}
                  {withheld.timing.reasons.length > 1 && (
                    <span className="whitespace-nowrap text-ink" title={`Start time withheld:\n${withheld.timing.reasons.join('\n')}`}>
                      {' '}
                      · +{withheld.timing.reasons.length - 1} more
                    </span>
                  )}
                </span>
              )}
            </span>
          </button>
        </li>
      )}
      {events.map((e, i) => {
        const inWindow = e.ms >= start && e.ms <= end;
        const future = inWindow && e.ms > t;
        const when = e.date_only ? formatDate(e.ms, tz) : `${formatDateTime(e.ms, tz)} ${zoneLabel(e.ms, tz)}`;
        const body = (
          <>
            {i === cur && <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" />}
            <span className={`mt-0.5 shrink-0 ${future || !inWindow ? 'opacity-50' : ''}`}>
              <EventGlyph kind={e.kind} soft={isMappingArtifact(e.step)} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-xs font-medium ${future || !inWindow ? 'text-muted' : ''}`}>
                {e.label}
              </span>
              <span className="block truncate text-2xs text-muted">
                {when}
                {!inWindow && ` · ${e.ms > end ? 'after' : 'before'} the replay window`}
                {modeled(e) && <ModeledChip />}
              </span>
              {e.step && <span className="block text-2xs text-muted">{stepLine(e.step)}</span>}
            </span>
          </>
        );
        const cls = `relative flex w-full items-start gap-2 px-3 py-1.5 text-left ${i === cur ? 'bg-selected' : ''}`;
        const title = `${e.label}\n${when}\nSource: ${e.source}${e.step ? `\n${stepNote(e.step, tz)}` : ''}`;
        return (
          <li key={e.id} data-current={i === cur ? '' : undefined}>
            {inWindow ? (
              <button
                className={`${cls} ${i === cur ? '' : 'hover:bg-tabgroup'}`}
                title={title}
                onClick={() => {
                  setTime(e.ms);
                  requestFlyTo(e.lon, e.lat);
                }}
              >
                {body}
              </button>
            ) : (
              <div className={`${cls} cursor-default`} title={`${title}\nOutside the replay window: no seek`}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function formatRadius(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
