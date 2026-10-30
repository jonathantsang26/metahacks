import {useMemo} from 'react';
import type {FireData} from '../data/fire';
import {insideRings, perimeterRings} from '../data/fire';
import {useFireJson, type FuelClasses} from '../data/files';
import {decodeArrival, useRaster} from '../data/raster';
import {compassPoint, formatLatLon} from '../lib/format';
import {useTime} from '../state/time';
import {useUi} from '../state/ui';
import type {Dem} from './dem';
import {span, stamp} from './labels';
import {bracketingInterval, type ArrivalMeta} from './load';
import {Icon} from '../ui/Icon';

/** Top-left compass; the arrow follows the camera bearing, click resets north-up. */
export function Compass({onReset}: {onReset: () => void}) {
  const bearing = useUi(s => s.bearing);
  return (
    <button
      onClick={onReset}
      title="Reset north"
      className="absolute left-3 top-3 flex h-9 w-9 flex-col items-center justify-center rounded-full bg-card/90 shadow-[0_0_0_1px_var(--hairline)]"
    >
      <span className="absolute -top-3 text-2xs font-semibold text-ink">N</span>
      <svg width="18" height="18" viewBox="0 0 18 18" style={{transform: `rotate(${-bearing}deg)`}}>
        <path d="M9 1.5 L14 15 L9 12 L4 15 Z" fill="var(--text)" />
      </svg>
    </button>
  );
}

/** Bottom-right cluster: 2D/3D segmented toggle and fullscreen (DESIGN.md §4.1). */
export function MapControls() {
  const {viewMode, setViewMode} = useUi();
  const seg = (mode: '2d' | '3d', label: string) => (
    <button
      onClick={() => setViewMode(mode)}
      className={`px-2 py-1 text-xs font-semibold ${viewMode === mode ? 'rounded bg-accent text-white' : 'text-muted'}`}
    >
      {label}
    </button>
  );
  return (
    <div className="absolute bottom-3 right-3 flex items-center gap-2">
      <div className="flex rounded-md bg-hud p-0.5">
        {seg('2d', '2D')}
        {seg('3d', '3D')}
      </div>
      <button
        title="Fullscreen"
        onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}
        className="flex h-7 w-7 items-center justify-center rounded-md bg-hud text-white"
      >
        <Icon name="expand" size={14} />
      </button>
    </div>
  );
}

/** Shown only when arrival.png failed to load and the fire pattern fell back to the synthetic test. */
export function SyntheticChip({visible}: {visible: boolean}) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-hud px-2.5 py-1 text-xs text-white">
      <span className="mr-1.5 rounded bg-white/15 px-1 font-mono text-2xs tracking-wide">SIM</span>
      arrival.png did not load · fire spread is a synthetic shader test inside the real final perimeter
    </div>
  );
}

/** One line of the map key: what a visible layer is, where it comes from, and whether it is modeled. */
export type StageNote = {
  id: string;
  /** Mono chip before the title, e.g. MODELED. */
  tag?: string;
  title: string;
  detail?: string;
  swatches?: {color: string; label: string}[];
};

/** Bottom-left key for the visible layers. */
export function MapNotes({notes}: {notes: StageNote[]}) {
  if (!notes.length) return null;
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[380px] flex-col gap-1">
      {notes.map(n => (
        <div key={n.id} className="rounded-md bg-hud px-2.5 py-1.5 text-xs text-white">
          <div className="flex items-baseline gap-1.5">
            {n.tag && <span className="rounded bg-white/15 px-1 font-mono text-2xs tracking-wide">{n.tag}</span>}
            <span>{n.title}</span>
          </div>
          {n.detail && <div className="mt-0.5 whitespace-pre-line text-white/60">{n.detail}</div>}
          {n.swatches && (
            <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-2xs text-white/75">
              {n.swatches.map(s => (
                <span key={s.label} className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full" style={{background: s.color}} />
                  {s.label}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const HOUR = 3_600_000;

/** "~5 h" / "under 1 h": for arrivals interpolated across long gaps, where minutes would be false precision. */
function roughSpan(ms: number): string {
  const h = Math.round(Math.abs(ms) / HOUR);
  return h < 1 ? 'under 1 h' : `~${h} h`;
}

/** Which observations a cell's arrival was interpolated between, from arrival_meta.json. */
function bracketText(meta: ArrivalMeta | null, at: number, green: number, window: [number, number], tz: string) {
  const iv = bracketingInterval(meta, at, green, (window[1] - window[0]) / 253);
  if (!iv) return undefined;
  const from = Date.parse(iv.from);
  const to = Date.parse(iv.to);
  // The first interval grows from step 06's seed (CAL FIRE's report), not from a mapped perimeter.
  if (meta?.seed && Date.parse(meta.seed.t) === from)
    return `Interpolated between the ${meta.seed.source} (${stamp(from, tz)}) and the first mapped perimeter (${stamp(to, tz)})`;
  return `Interpolated between perimeters mapped ${stamp(from, tz)} and ${stamp(to, tz)}`;
}

/**
 * "Burned … before t" / "Burns at … (after t)" / "Not burned", from the arrival raster under the
 * cursor. Green is step 06's interpolation confidence: only cells whose bracketing observations
 * are ≤ 2 h apart (255) get a minute; the rest get the hour and the observations that bracket them.
 */
function arrivalLine(
  code: number,
  green: number,
  t: number,
  window: [number, number],
  tz: string,
  meta: ArrivalMeta | null
): {text: string; detail?: string; burned: boolean} {
  if (code >= 255) return {text: 'Not burned', burned: false};
  // Green 32: inside CAL FIRE's final perimeter but in no timed footprint (step 06). The map
  // burns these cells only at the window's end, and the text follows it.
  if (green === 32)
    return t >= window[1]
      ? {text: 'Burned (time not resolved, mapped only in the final perimeter)', burned: true}
      : {text: 'Inside the final perimeter · burn time not resolved', burned: false};
  const at = decodeArrival(code, window[0], window[1]);
  if (at === null) return {text: 'Not burned', burned: false};
  // 254 is the clamp for arrivals at or after the window's end.
  if (code === 254) return {text: `Reached at or after ${stamp(window[1], tz)} (window end)`, burned: t >= window[1]};
  if (green >= 255) {
    if (at <= t) return {text: `Burned ${stamp(at, tz)} · ${span(t - at)} before t`, burned: true};
    return {text: `Burns at ${stamp(at, tz)} (after t)`, burned: false};
  }
  const approx = `~${stamp(Math.round(at / HOUR) * HOUR, tz)}`;
  const detail = bracketText(meta, at, green, window, tz);
  if (at <= t) return {text: `Burned ${approx} · ${roughSpan(t - at)} before t`, detail, burned: true};
  return {text: `Burns ${approx} (after t)`, detail, burned: false};
}

/** Dark tooltip that follows the cursor over terrain (DESIGN.md §4.1). */
export function HoverInspector({
  dem,
  fire,
  arrivalWindow,
  arrivalMeta
}: {
  dem: Dem | null;
  fire: FireData;
  arrivalWindow: [number, number];
  arrivalMeta: ArrivalMeta | null;
}) {
  const hover = useUi(s => s.hover);
  const t = useTime(s => s.t);
  const rings = useMemo(() => perimeterRings(fire.perimeter), [fire]);
  const arrival = useRaster(fire, 'arrival.png');
  const fuel = useRaster(fire, 'fuel.png');
  const fuelClasses = useFireJson<FuelClasses>(fire, 'fuel_classes.json');
  if (!hover || !dem || !dem.contains(hover.lon, hover.lat)) return null;

  const tz = fire.aoi.timezone;
  const elev = dem.heightAt(hover.lon, hover.lat);
  const {slope, aspect} = dem.slopeAspect(hover.lon, hover.lat);
  const inside = insideRings(rings, hover.lon, hover.lat);

  const px = arrival?.pixel(hover.lon, hover.lat);
  const arr = arrival && px
    ? arrivalLine(
        arrival.data[(px.row * arrival.width + px.col) * 4],
        arrival.data[(px.row * arrival.width + px.col) * 4 + 1],
        t,
        arrivalWindow,
        tz,
        arrivalMeta
      )
    : null;

  const fuelIndex = fuel?.red(hover.lon, hover.lat);
  const fuelLabel = fuelIndex != null ? fuelClasses.data?.[String(fuelIndex)]?.label : undefined;
  const fuelText = fuelClasses.error
    ? 'Fuel class unavailable'
    : fuelLabel
      ? `Fuel class: ${fuelLabel}`
      : null;

  return (
    <div
      className="pointer-events-none absolute z-10 min-w-[220px] max-w-[340px] rounded-md bg-hud px-3 py-2 text-xs text-white shadow-lg"
      style={{left: hover.x + 16, top: hover.y + 16}}
    >
      <div className="font-semibold">
        {Math.round(elev).toLocaleString()} m · {Math.round(slope)}° slope · {compassPoint(aspect)}-facing
      </div>
      {arr && (
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${arr.burned ? 'bg-[#ff8a3d]' : 'bg-white/50'}`} />
          <span>{arr.text}</span>
          <span className="font-mono text-2xs text-white/45">MODELED</span>
        </div>
      )}
      {arr?.detail && <div className="ml-3 text-white/55">{arr.detail}</div>}
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${inside ? 'bg-[#ff8a3d]' : 'bg-white/50'}`} />
        {inside ? 'Inside the final perimeter' : 'Outside the final perimeter'}
      </div>
      {fuelText && <div className="mt-0.5 text-white/55">{fuelText}</div>}
      <div className="mt-1 font-mono text-2xs text-white/55">{formatLatLon(hover.lat, hover.lon)}</div>
    </div>
  );
}
