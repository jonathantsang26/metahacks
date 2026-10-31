import {useEffect, useMemo, useRef, useState} from 'react';
import type {FireData} from '../data/fire';
import {useFireJson, type Perimeters, type Profile, type Series} from '../data/files';
import {DronesCharts, DronesSide} from '../drones/DronesDock';
import {formatDateTime, tickParts, zoneLabel} from '../lib/format';
import {SPEEDS, useProgress, useTime} from '../state/time';
import {useUi} from '../state/ui';
import {Icon} from '../ui/Icon';
import {arrivalWindow, useBurnedArea} from './area';
import {ElevationProfileChart, FireAreaChart, RateOfSpreadChart} from './charts';
import {EventGlyph, isMappingArtifact, KeyEventsList, stepLine, useKeyEvents, type KeyEvents} from './events';
import {rosAxis, type ArrivalIntervals} from './scale';
import {RiskCharts, RiskSide} from './risk';

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

/**
 * Faint red band under the track: each hour's opacity is its rate of spread over the chart's
 * (possibly capped) axis, so one spike hour doesn't wash out the rest.
 */
function ActivityBand({series, start, end}: {series: Series; start: number; end: number}) {
  const rects = useMemo(() => {
    const times = series.t.map(Date.parse);
    const {top} = rosAxis(series.ros_chains_hr);
    const span = end - start;
    const out: {x: number; w: number; a: number}[] = [];
    // Hour i covers (t[i-1], t[i]].
    for (let i = 1; i < times.length; i++) {
      const v = series.ros_chains_hr[i];
      if (v > 0) out.push({x: (times[i - 1] - start) / span, w: (times[i] - times[i - 1]) / span, a: Math.min(1, v / top)});
    }
    return out;
  }, [series, start, end]);
  return (
    <svg className="pointer-events-none absolute inset-x-0 top-[6px] h-[10px] w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
      {rects.map(r => (
        <rect key={r.x} x={r.x} y={0} width={r.w} height={1} fill="var(--chart-rate)" fillOpacity={0.12 + 0.43 * r.a} />
      ))}
    </svg>
  );
}

/** Event glyphs are 14px wide; one that would overlap the last glyph in its lane moves up a lane. */
const GLYPH_PX = 14;

function useGlyphLanes(events: KeyEvents, start: number, end: number, widthPx: number) {
  return useMemo(() => {
    const lastX = [-Infinity, -Infinity];
    return (events.events ?? [])
      .filter(e => e.ms >= start && e.ms <= end)
      .map(e => {
        const px = ((e.ms - start) / (end - start)) * widthPx;
        let lane = lastX.findIndex(x => px - x >= GLYPH_PX);
        if (lane < 0) lane = lastX[0] <= lastX[1] ? 0 : 1;
        lastX[lane] = px;
        return {...e, lane};
      });
  }, [events, start, end, widthPx]);
}

function Scrubber({tz, series, events}: {tz: string; series: Series | null; events: KeyEvents}) {
  const {start, end, t, setTime} = useTime();
  const requestFlyTo = useUi(s => s.requestFlyTo);
  const progress = useProgress();
  const [track, width] = useWidth<HTMLDivElement>();
  const ticks = useTicks(start, end, tz, width);
  const glyphs = useGlyphLanes(events, start, end, width);
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
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Synthetic or already-released pointers can't be captured; seeking still works.
          }
          // A press on an event glyph jumps to that event, like its row in Key Events; a drag
          // from there scrubs as usual.
          const id = (e.target as HTMLElement).closest<HTMLElement>('[data-event]')?.dataset.event;
          const ev = id ? glyphs.find(g => g.id === id) : undefined;
          if (ev) {
            setTime(ev.ms);
            requestFlyTo(ev.lon, ev.lat);
          } else seek(e.clientX);
        }}
        onPointerMove={e => e.buttons === 1 && seek(e.clientX)}
      >
        {series && <ActivityBand series={series} start={start} end={end} />}
        <div className="absolute inset-x-0 top-2.5 h-[2px] rounded bg-ink opacity-70" />
        <div className="absolute left-0 top-2.5 h-[2px] rounded bg-accent" style={{width: pct(t)}} />
        {glyphs.map(e => (
          <span
            key={e.id}
            data-event={e.id}
            className={`absolute ${e.lane ? '-top-1' : 'top-[4px]'} -ml-[7px] flex h-3.5 w-3.5 items-center justify-center rounded-full bg-card shadow-[0_0_0_1px_var(--hairline)]`}
            style={{left: pct(e.ms), opacity: (e.ms > t ? 0.6 : 1) * (isMappingArtifact(e.step) ? 0.75 : 1)}}
            title={`${e.label}\n${formatDateTime(e.ms, tz)} ${zoneLabel(e.ms, tz)}${e.step ? `\n${stepLine(e.step)}` : ''}`}
          >
            <EventGlyph kind={e.kind} size={10} soft={isMappingArtifact(e.step)} />
          </span>
        ))}
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

const SIDE = {
  incident: 'Key Events',
  drones: 'Detections',
  risk: 'Debris-Flow Models'
};

/** DESIGN.md §6: 226px dock under the map; side list on the right. */
export function Dock({fire}: {fire: FireData}) {
  const tab = useUi(s => s.tab);
  const {start, end} = useTime();
  const tz = fire.aoi.timezone;
  const series = useFireJson<Series>(fire, 'series.json');
  const profile = useFireJson<Profile>(fire, 'profile.json');
  const meta = useFireJson<ArrivalIntervals>(fire, 'arrival_meta.json');
  const perimeters = useFireJson<Perimeters>(fire, 'perimeters.geojson');
  const span = useMemo(() => arrivalWindow(fire, meta.data), [fire, meta.data]);
  const burned = useBurnedArea(fire, span);
  const events = useKeyEvents(fire);
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
            <Scrubber tz={tz} series={series.data} events={events} />
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          {tab === 'incident' ? (
            <>
              <FireAreaChart
                area={burned.area}
                unavailable={burned.error}
                perimeters={perimeters.data}
                fire={fire}
                base={fire.base}
              />
              <RateOfSpreadChart series={series} meta={meta} tz={tz} base={fire.base} />
              <ElevationProfileChart profile={profile} tz={tz} base={fire.base} />
            </>
          ) : tab === 'risk' ? (
            <RiskCharts fire={fire} />
          ) : (
            <DronesCharts fire={fire} />
          )}
        </div>
      </div>
      <aside className="flex w-[221px] shrink-0 flex-col border-l border-hairline bg-card">
        <div className="flex items-center justify-between bg-section px-3 py-2">
          <span className="text-base font-semibold">{SIDE[tab]}</span>
          {tab === 'incident' && events.events && (
            <span className="text-xs text-muted">{events.events.length + (events.withheld ? 1 : 0)}</span>
          )}
        </div>
        {tab === 'incident' ? (
          <KeyEventsList fire={fire} data={events} />
        ) : tab === 'risk' ? (
          <RiskSide />
        ) : (
          <DronesSide fire={fire} />
        )}
      </aside>
    </div>
  );
}
