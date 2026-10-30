import {useMemo} from 'react';
import type {FireData} from '../data/fire';
import {insideRings, perimeterRings} from '../data/fire';
import {compassPoint, formatLatLon} from '../lib/format';
import {useUi} from '../state/ui';
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

/** Dark tooltip that follows the cursor over terrain (DESIGN.md §4.1). */
export function HoverInspector({dem, fire}: {dem: Dem | null; fire: FireData}) {
  const hover = useUi(s => s.hover);
  const rings = useMemo(() => perimeterRings(fire.perimeter), [fire]);
  if (!hover || !dem || !dem.contains(hover.lon, hover.lat)) return null;

  const elev = dem.heightAt(hover.lon, hover.lat);
  const {slope, aspect} = dem.slopeAspect(hover.lon, hover.lat);
  const inside = insideRings(rings, hover.lon, hover.lat);
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-[220px] rounded-md bg-hud px-3 py-2 text-xs text-white shadow-lg"
      style={{left: hover.x + 16, top: hover.y + 16}}
    >
      <div className="font-semibold">
        {Math.round(elev).toLocaleString()} m · {Math.round(slope)}° slope · {compassPoint(aspect)}-facing
      </div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${inside ? 'bg-[#ff8a3d]' : 'bg-white/50'}`} />
        {inside ? 'Inside the final perimeter' : 'Outside the final perimeter'}
      </div>
      <div className="mt-0.5 text-white/55">Fuel class: pending (step 03)</div>
      <div className="mt-1 font-mono text-2xs text-white/55">{formatLatLon(hover.lat, hover.lon)}</div>
    </div>
  );
}
