/**
 * Key Events (DESIGN.md §6.3) from events.json: one glyph per kind, shared by the side list and
 * the timeline track. An ignition estimate is listed only when ignition.json says its start
 * time is identifiable; otherwise the list says the time is withheld and why.
 */
import {useEffect, useMemo, useRef} from 'react';
import type {FireData} from '../data/fire';
import {useFireJson, type EventKind, type FireEvent, type Ignition} from '../data/files';
import {formatDate, formatDateTime, zoneLabel} from '../lib/format';
import {useTime} from '../state/time';
import {useUi} from '../state/ui';
import {formatMinutes, shortInterval, type ArrivalIntervals} from './scale';

const HOUR = 3600_000;

/** 12×12 glyphs: ● reported start, ◎ ignition estimate, flame, ▲ spot, ⧗ ridge, wind, ■ containment. */
export function EventGlyph({kind, size = 12}: {kind: EventKind; size?: number}) {
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
            fill="var(--accent)"
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

export type KeyEvents = {
  /** Events to show, sorted by t, with any ignition estimate the timing rule does not allow removed. */
  events: (FireEvent & {ms: number})[] | null;
  error: string | null;
  /** Set when ignition.json withholds the start time. */
  withheld: Ignition | null;
};

/** events.json filtered by ignition.json's timing rule. */
export function useKeyEvents(fire: FireData): KeyEvents {
  const ev = useFireJson<FireEvent[]>(fire, 'events.json');
  const ig = useFireJson<Ignition>(fire, 'ignition.json');
  return useMemo(() => {
    // Without a readable ignition.json the start time can't be shown as identifiable, so any
    // ignition_estimate event is dropped.
    const timeOk = ig.data?.timing.identifiable === true;
    const events = ev.data
      ? ev.data
          .filter(e => e.kind !== 'ignition_estimate' || timeOk)
          .map(e => ({...e, ms: Date.parse(e.t)}))
          .sort((a, b) => a.ms - b.ms)
      : null;
    return {events, error: ev.error, withheld: ig.data && !ig.data.timing.identifiable ? ig.data : null};
  }, [ev, ig]);
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

/** For an hourly event from series.json: a note when its hour holds perimeters mapped minutes apart. */
function perimeterNote(e: FireEvent & {ms: number}, meta: ArrivalIntervals | null): string | null {
  if (!e.source.startsWith('series.json')) return null;
  const s = shortInterval(meta, e.ms - HOUR, e.ms);
  return (
    s &&
    `This hour holds two perimeters mapped ${formatMinutes(s.minutes)} apart (${s.cells.toLocaleString('en-US')} cells between ` +
      'them), so its growth reflects perimeter timing as much as fire spread.'
  );
}

/** The side list. Rows inside the replay window seek and fly there; rows outside it don't. */
export function KeyEventsList({fire, data, meta}: {fire: FireData; data: KeyEvents; meta: ArrivalIntervals | null}) {
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
              <span className="line-clamp-2 text-2xs text-muted">Start time withheld: {withheld.timing.reasons.join('; ')}</span>
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
              <EventGlyph kind={e.kind} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-xs font-medium ${future || !inWindow ? 'text-muted' : ''}`}>
                {e.label}
              </span>
              <span className="block truncate text-2xs text-muted">
                {when}
                {!inWindow && ` · ${e.ms > end ? 'after' : 'before'} the replay window`}
                {modeled(e) && <ModeledChip />}
              </span>
            </span>
          </>
        );
        const cls = `relative flex w-full items-start gap-2 px-3 py-1.5 text-left ${i === cur ? 'bg-selected' : ''}`;
        const note = perimeterNote(e, meta);
        const title = `${e.label}\n${when}\nSource: ${e.source}${note ? `\n${note}` : ''}`;
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
