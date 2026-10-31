import {useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {FireData} from '../data/fire';
import {insideRings, perimeterRings} from '../data/fire';
import {compassPoint, formatDateTime, formatElapsed, formatLatLon, zoneLabel} from '../lib/format';
import {useTime} from '../state/time';
import {useUi} from '../state/ui';
import {burnReadout, sampleArrivalCode, type ArrivalGrid} from './arrival';
import type {Dem} from './dem';
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

/** Labels the fire pattern as a synthetic shader test until pipeline step 06 exists. */
export function SyntheticChip({visible}: {visible: boolean}) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-hud px-2.5 py-1 text-xs text-white">
      <span className="mr-1.5 rounded bg-white/15 px-1 font-mono text-2xs tracking-wide">SIM</span>
      Fire spread is a synthetic shader test inside the real final perimeter · real arrival times come from step 06
    </div>
  );
}

/**
 * Keep the tooltip inside the map stage. Deck's hover coordinates are relative
 * to the canvas, which fills the stage, and the stage clips overflow.
 */
function useTooltipPosition(x: number, y: number, active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({left: x + 16, top: y + 16});
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!active || !el || !parent) return;
    const margin = 12;
    let left = x + margin;
    let top = y + margin;
    if (left + el.offsetWidth > parent.clientWidth - 8) left = x - el.offsetWidth - margin;
    if (top + el.offsetHeight > parent.clientHeight - 8) top = y - el.offsetHeight - margin;
    left = Math.max(8, left);
    top = Math.max(8, top);
    setPos(prev => (prev.left === left && prev.top === top ? prev : {left, top}));
  }, [x, y, active]);
  return {ref, pos};
}

/** Dark tooltip that follows the cursor over terrain (DESIGN.md §4.1). */
export function HoverInspector({
  dem,
  fire,
  arrival
}: {
  dem: Dem | null;
  fire: FireData;
  /** Null hides the burn line (layer off, or the grid is not ready). */
  arrival: ArrivalGrid | null;
}) {
  const hover = useUi(s => s.hover);
  const {t, start, end} = useTime();
  const rings = useMemo(() => perimeterRings(fire.perimeter), [fire]);
  const visible = Boolean(hover && dem?.contains(hover.lon, hover.lat));
  const {ref, pos} = useTooltipPosition(hover?.x ?? 0, hover?.y ?? 0, visible);
  if (!hover || !dem || !dem.contains(hover.lon, hover.lat)) return null;

  const elev = dem.heightAt(hover.lon, hover.lat);
  const {slope, aspect} = dem.slopeAspect(hover.lon, hover.lat);
  const inside = insideRings(rings, hover.lon, hover.lat);
  const tz = fire.aoi.timezone;
  const code = arrival ? sampleArrivalCode(arrival, hover.lon, hover.lat) : null;
  const burn = code === null ? null : burnReadout(code, t, start, end);
  const showBurn = burn !== null && burn.kind !== 'never';
  const burnText =
    burn?.kind === 'burned'
      ? `Burned ${formatDateTime(burn.at, tz)} ${zoneLabel(burn.at, tz)} · ${formatElapsed(burn.agoMs)} ago`
      : burn?.kind === 'future'
        ? `Arrives ${formatDateTime(burn.at, tz)} ${zoneLabel(burn.at, tz)}`
        : null;

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-10 min-w-[220px] max-w-[280px] rounded-md bg-hud px-3 py-2 text-xs text-white shadow-lg"
      style={{left: pos.left, top: pos.top}}
    >
      <div className="font-semibold">
        {Math.round(elev).toLocaleString()} m · {Math.round(slope)}° slope · {compassPoint(aspect)}-facing
      </div>
      {showBurn ? (
        <div className="mt-0.5 flex items-start gap-1.5">
          <span
            className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              burn?.kind === 'burned' ? 'bg-[#ff8a3d]' : 'bg-white/50'
            }`}
          />
          <span>
            {arrival?.simulated && (
              <>
                <span className="mr-1 rounded bg-white/15 px-1 font-mono text-2xs tracking-wide">SIM</span>{' '}
              </>
            )}
            {burnText}
          </span>
        </div>
      ) : (
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${inside ? 'bg-[#ff8a3d]' : 'bg-white/50'}`} />
          {inside ? 'Inside the final perimeter' : 'Outside the final perimeter'}
        </div>
      )}
      <div className="mt-0.5 text-white/55">Fuel class: pending (step 03)</div>
      <div className="mt-1 font-mono text-2xs text-white/55">{formatLatLon(hover.lat, hover.lon)}</div>
    </div>
  );
}
