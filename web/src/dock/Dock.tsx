import {useEffect, useMemo, useRef, useState} from 'react';
import type {FireData} from '../data/fire';
import {formatDateTime, tickParts, zoneLabel} from '../lib/format';
import {SPEEDS, useProgress, useTime} from '../state/time';
import {useUi} from '../state/ui';
import {Icon} from '../ui/Icon';

const HOUR = 3600_000;

/** Ticks on local 6/12/24-hour boundaries, spaced ≥ 52px apart; day label on midnight and the first tick. */
function useTicks(start: number, end: number, tz: string, widthPx: number) {
  return useMemo(() => {
    const hours = (end - start) / HOUR;
    const every = [6, 12, 24].find(h => (widthPx * h) / hours >= 52) ?? 24;
    const ticks: {t: number; day: string | null; hour: string}[] = [];
    for (let t = Math.ceil(start / HOUR) * HOUR; t <= end; t += HOUR) {
      const {day, hour} = tickParts(t, tz);
      if (Number(hour.slice(0, 2)) % every !== 0) continue;
      ticks.push({t, day: hour === '00:00' || ticks.length === 0 ? day : null, hour});
    }
    return ticks;
  }, [start, end, tz, widthPx]);
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function Transport() {
  const {playing, toggle, step, speed, setSpeed} = useTime();
  const btn = 'flex h-7 w-8 items-center justify-center rounded-md shadow-[0_0_0_1px_var(--hairline)]';
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => !playing && toggle()} className={`${btn} ${playing ? 'bg-card' : 'bg-btndark text-white'}`} title="Play">
        <Icon name="play" size={13} />
      </button>
      <button onClick={() => playing && toggle()} className={`${btn} ${playing ? 'bg-btndark text-white' : 'bg-card'}`} title="Pause">
        <Icon name="pause" size={13} />
      </button>
      <button onClick={step} className={`${btn} bg-card`} title="Step 1 h">
        <Icon name="stepFwd" size={13} />
      </button>
      <select
        value={speed}
        onChange={e => setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])}
        className="h-7 rounded-md bg-card px-1.5 text-sm shadow-[0_0_0_1px_var(--hairline)]"
      >
        {SPEEDS.map(s => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
    </div>
  );
}

function Scrubber({tz}: {tz: string}) {
  const {start, end, t, setTime} = useTime();
  const progress = useProgress();
  const [track, width] = useWidth<HTMLDivElement>();
  const ticks = useTicks(start, end, tz, width);
  const seek = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    setTime(start + ((clientX - r.left) / r.width) * (end - start));
  };
  const pct = (ms: number) => `${((ms - start) / (end - start)) * 100}%`;
  // Keep the time tooltip inside the track at both ends.
  const tipShift = progress < 0.06 ? '0%' : progress > 0.94 ? '-100%' : '-50%';

  return (
    <div className="relative min-w-0 flex-1 select-none">
      <div
        ref={track}
        className="relative h-6 cursor-pointer"
        onPointerDown={e => {
          try {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          } catch {
            // Synthetic or already-released pointers can't be captured; seeking still works.
          }
          seek(e.clientX);
        }}
        onPointerMove={e => e.buttons === 1 && seek(e.clientX)}
      >
        <div className="absolute inset-x-0 top-2.5 h-[2px] rounded bg-ink/70" />
        <div className="absolute left-0 top-2.5 h-[2px] rounded bg-accent" style={{width: pct(t)}} />
        <div className="absolute top-[3px] -ml-[7px] h-4 w-4 rounded-full border-2 border-white bg-ink shadow" style={{left: pct(t)}} />
        <div
          className="pointer-events-none absolute -top-6 whitespace-nowrap rounded bg-btndark px-1.5 py-0.5 text-xs text-white"
          style={{left: `${progress * 100}%`, transform: `translateX(${tipShift})`}}
        >
          {formatDateTime(t, tz)} {zoneLabel(t, tz)}
        </div>
      </div>
      <div className="relative mt-1 h-8">
        {ticks.map(k => (
          <div key={k.t} className="absolute -translate-x-1/2 text-center leading-tight" style={{left: pct(k.t)}}>
            <div className="h-3.5 text-xs font-medium">{k.day ?? ''}</div>
            <div className="text-xs text-muted">{k.hour}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartFrame({title, unit, note}: {title: string; unit?: string; note: string}) {
  const progress = useProgress();
  return (
    <div className="relative flex min-w-0 flex-1 flex-col border-r border-hairline px-3 pt-2 last:border-r-0">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {title} {unit && <span className="font-normal text-muted">({unit})</span>}
        </span>
        <Icon name="dots" size={14} className="text-muted" />
      </div>
      <div className="relative mb-2 mt-1 flex-1">
        <div className="absolute inset-x-0 bottom-3 border-b border-dashed border-ink/25" />
        <div className="absolute bottom-3 top-0 w-px bg-ink/60" style={{left: `${progress * 100}%`}} />
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">{note}</div>
      </div>
    </div>
  );
}

const CHARTS = {
  incident: [
    {title: 'Fire Area', unit: 'acres', note: 'from the arrival raster · step 06'},
    {title: 'Rate of Spread', unit: 'chains/hr', note: 'from the arrival raster · step 06'},
    {title: 'Elevation Profile', unit: 'selected path', note: 'along the spread spine · step 06'}
  ],
  drones: [
    {title: 'Altitude', unit: 'ft AGL', note: 'clip telemetry · Monday'},
    {title: 'Detections per second', note: 'Sentinel + SAM 3.1 · Monday'},
    {title: 'Mask area', unit: '% of frame', note: 'SAM 3.1 · Monday'}
  ],
  resources: [
    {title: 'Retardant Dropped', unit: 'gal', note: 'Could tier'},
    {title: 'Fire Line Built', unit: 'chains', note: 'Could tier'},
    {title: 'Personnel Assigned', note: 'CAL FIRE daily updates'}
  ]
};

const SIDE = {
  incident: {title: 'Key Events', note: 'Derived from the data in step 10'},
  drones: {title: 'Detections', note: 'Sentinel + SAM 3.1 on footage'},
  resources: {title: 'Air Ops Log', note: 'Could tier'}
};

/** DESIGN.md §6: 226px dock under the map; side list on the right. */
export function Dock({fire}: {fire: FireData}) {
  const tab = useUi(s => s.tab);
  const {start, end} = useTime();
  const tz = fire.aoi.timezone;
  return (
    <div className="flex h-[226px] shrink-0 border-t border-hairline bg-chrome">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[100px] shrink-0 flex-col border-b border-hairline px-3 pt-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Timeline</span>
            <span className="text-xs text-muted">
              {formatDateTime(start, tz)} – {formatDateTime(end, tz)} {zoneLabel(start, tz)}
            </span>
          </div>
          <div className="mt-5 flex items-start gap-4">
            <Transport />
            <Scrubber tz={tz} />
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          {CHARTS[tab].map(c => (
            <ChartFrame key={c.title} {...c} />
          ))}
        </div>
      </div>
      <aside className="w-[221px] shrink-0 border-l border-hairline bg-card">
        <div className="flex items-center justify-between bg-section px-3 py-2">
          <span className="text-base font-semibold">{SIDE[tab].title}</span>
          {tab === 'incident' && (
            <span className="flex items-center gap-1 rounded border border-hairline bg-card px-1.5 text-xs">
              <Icon name="plus" size={11} /> Add
            </span>
          )}
        </div>
        <div className="px-3 py-6 text-center text-sm text-muted">{SIDE[tab].note}</div>
      </aside>
    </div>
  );
}
