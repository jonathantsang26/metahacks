import {useEffect, useMemo, useRef, type ReactNode} from 'react';
import type {FireData} from '../data/fire';
import {useFireJson, type Exposure, type ExposureStats, type Structures} from '../data/files';
import {useTime} from '../state/time';
import {useUi} from '../state/ui';
import {ExposureTimeline} from './exposure-timeline';
import {meters, pctFine, stamp} from './fmt';
import {Button, Chip, Missing, SubHead} from './ui';

type Damage = Structures['features'][number]['properties']['damage'];

const DAMAGE_TONE: Record<Damage, 'live' | 'modeled' | 'real' | 'muted'> = {
  Destroyed: 'live',
  Major: 'live',
  Minor: 'modeled',
  Affected: 'modeled',
  'No Damage': 'real',
  Inaccessible: 'muted'
};

function KV({k, v}: {k: string; v: ReactNode}) {
  return (
    <div className="flex gap-2 py-[2px] text-xs">
      <span className="w-[92px] shrink-0 text-muted">{k}</span>
      <span className="min-w-0 flex-1">{v ?? '—'}</span>
    </div>
  );
}

/**
 * One inspected structure: CAL FIRE's construction record and its modeled exposure. Mounted only
 * while a structure is selected, so the large structures/exposure files load on demand (the stage
 * shares the same fetch cache). No address, parcel, owner or year built exists in either file.
 */
function HomeDetail({fire, id}: {fire: FireData; id: number}) {
  const {data: st, error: stErr} = useFireJson<Structures>(fire, 'structures.geojson');
  const {data: ex, error: exErr} = useFireJson<Exposure>(fire, 'exposure.json');
  const byId = useMemo(() => (st ? new Map(st.features.map(f => [f.properties.id, f])) : null), [st]);
  const exRow = useMemo(() => (ex ? new Map(ex.id.map((v, i) => [v, i])) : null), [ex]);
  const selectStructure = useUi(s => s.selectStructure);
  const requestFlyTo = useUi(s => s.requestFlyTo);
  const setTime = useTime(s => s.setTime);
  const start = useTime(s => s.start);
  const end = useTime(s => s.end);
  const tz = fire.aoi.timezone;

  if (!byId) return <Missing file="structures.geojson" error={stErr} />;
  const f = byId.get(id);
  if (!f) return <div className="px-3 py-3 text-sm text-muted">The selected structure is not in structures.geojson.</div>;
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;

  const k = exRow?.get(id);
  const row =
    ex && k !== undefined
      ? {
          exposed: ex.exposed[k],
          arrival: ex.arrival_t[k],
          imputed: ex.arrival_imputed[k],
          gust: ex.gust_mph[k],
          dist: ex.dist_wildland_m[k]
        }
      : null;
  const arrivalMs = row?.arrival ? Date.parse(row.arrival) : null;
  const inWindow = arrivalMs !== null && arrivalMs >= start && arrivalMs <= end;

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{p.structure_type}</span>
        <Chip tone={DAMAGE_TONE[p.damage] ?? 'muted'}>{p.damage}</Chip>
      </div>
      <div className="mb-1 text-2xs text-muted">CAL FIRE damage inspection (DINS)</div>
      <KV k="Roof" v={p.roof} />
      <KV k="Eaves" v={p.eaves} />
      <KV k="Vents" v={p.vents} />
      <KV k="Siding" v={p.siding} />
      <KV k="Windows" v={p.window_pane} />
      <KV k="Elevated deck" v={p.deck_elevated} />
      <KV k="Attached fence" v={p.fence_attached} />

      <div className="mb-0.5 mt-2 flex items-center gap-1.5 text-xs font-medium">
        Exposure <Chip tone="modeled">MODELED</Chip>
      </div>
      {!row ? (
        ex ? (
          <div className="text-xs text-muted">No exposure row for this structure.</div>
        ) : (
          <Missing file="exposure.json" error={exErr} />
        )
      ) : (
        <>
          <KV
            k="Fire arrival"
            v={
              row.arrival ? (
                <>
                  {stamp(row.arrival, tz)}
                  {row.imputed && <span className="text-muted"> · imputed from the nearest burned cell</span>}
                </>
              ) : (
                <span className="text-muted">
                  {row.exposed ? 'No arrival recorded' : 'Not exposed: no fire arrival near this structure'}
                </span>
              )
            }
          />
          <KV k="Gust at arrival" v={row.gust != null ? `${Math.round(row.gust)} mph · HRRR` : null} />
          <KV k="To wildland" v={row.dist != null ? meters(row.dist) : null} />
        </>
      )}
      <ExposureTimeline fire={fire} lon={lon} lat={lat} arrivalMs={arrivalMs} />

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button onClick={() => requestFlyTo(lon, lat)}>Fly to</Button>
        <Button
          onClick={() => arrivalMs !== null && setTime(arrivalMs)}
          disabled={!inWindow}
          title={arrivalMs !== null && !inWindow ? 'Arrival falls outside the replay window' : undefined}
        >
          Go to arrival
        </Button>
        <Button onClick={() => selectStructure(null)}>Clear</Button>
      </div>
    </div>
  );
}

/**
 * When an attribute is often missing on destroyed homes but recorded on surviving ones, the
 * contrast is suspect (the caveat says to compare these rates). Stated under the table.
 */
const UNKNOWN_WARN = {min_destroyed: 0.2, ratio: 5};
const unknownWarn = (u: {destroyed: number; surviving: number}) =>
  u.destroyed > UNKNOWN_WARN.min_destroyed && u.destroyed > UNKNOWN_WARN.ratio * u.surviving;

/** Log-scale CI bars around OR = 1, one row per construction contrast. */
function ExposureTable({fire}: {fire: FireData}) {
  const {data: s, error} = useFireJson<ExposureStats>(fire, 'exposure_stats.json');
  if (!s) return <Missing file="exposure_stats.json" error={error} />;

  const bounds = s.contrasts.flatMap(c => [...(c.ci95 ?? []), ...(c.or != null ? [c.or] : [])]);
  const lo = Math.log(Math.min(1, ...bounds)) - 0.1;
  const hi = Math.log(Math.max(1, ...bounds)) + 0.1;
  const x = (v: number) => `${((Math.log(v) - lo) / (hi - lo)) * 100}%`;
  const ticks = [Math.min(1, ...bounds), 1, Math.max(1, ...bounds)].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div className="pt-2">
      <div className="px-3 text-xs text-muted">
        <Chip tone="modeled">MODELED</Chip> Odds ratio of destruction, first-named vs second, matched on gust at arrival (split at {s.gust_split_mph} mph) ×
        distance to wildland across {s.strata.length} strata. {s.population}: {s.n.toLocaleString('en-US')} homes,{' '}
        {s.destroyed.toLocaleString('en-US')} destroyed.
      </div>
      <ul className="mt-1.5 divide-y divide-hairline">
        {s.contrasts.map(c => (
          <li key={c.feature} className="px-3 py-1.5">
            <div className="text-xs">{c.label}</div>
            <div className="mt-0.5 flex items-center gap-2">
              <div className="relative h-3 flex-1">
                <div className="absolute inset-y-0 w-px" style={{left: x(1), background: 'var(--text)', opacity: 0.4}} />
                {c.ci95 && (
                  <div
                    className="absolute top-1/2 h-[2px] -translate-y-1/2 bg-ink"
                    style={{left: x(c.ci95[0]), width: `calc(${x(c.ci95[1])} - ${x(c.ci95[0])})`}}
                  />
                )}
                {c.or != null && (
                  <div className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink" style={{left: x(c.or)}} />
                )}
              </div>
              <span className="w-[96px] shrink-0 text-right text-xs tabular-nums">
                {c.or != null ? c.or.toFixed(2) : 'n/a'}
                {c.ci95 && (
                  <span className="text-muted">
                    {' '}
                    ({c.ci95[0].toFixed(2)}–{c.ci95[1].toFixed(2)})
                  </span>
                )}
              </span>
            </div>
            <div className={`text-2xs ${unknownWarn(c.unknown_rate) ? 'text-live' : 'text-muted'}`}>
              n = {c.n.toLocaleString('en-US')} · recorded unknown: {pctFine(c.unknown_rate.destroyed)} of destroyed vs{' '}
              {pctFine(c.unknown_rate.surviving)} of surviving
              {unknownWarn(c.unknown_rate) && <> · often unrecorded on destroyed homes; read this odds ratio with caution</>}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 px-3">
        <div className="relative h-4 flex-1 text-2xs text-muted">
          {ticks.map(v => (
            <span key={v} className="absolute -translate-x-1/2 tabular-nums" style={{left: x(v)}}>
              {v === 1 ? 'OR 1' : v.toFixed(2)}
            </span>
          ))}
        </div>
        <span className="w-[96px] shrink-0 text-right text-2xs text-muted">OR (95% CI), log</span>
      </div>
      <div className="mt-1 space-y-1 px-3 text-2xs text-muted">
        <p>
          {s.arrival_imputed.n.toLocaleString('en-US')} arrivals imputed. {s.arrival_imputed.note}
        </p>
        <p>Wildland: {s.wildland_definition}.</p>
        <p>
          <span className="text-live">Red</span>: the attribute is unknown for more than{' '}
          {Math.round(UNKNOWN_WARN.min_destroyed * 100)}% of destroyed homes and over {UNKNOWN_WARN.ratio}× the rate for
          surviving ones.
        </p>
        <p className="text-ink">{s.caveat}</p>
      </div>
    </div>
  );
}

/** DESIGN.md §9 Analysis → Homes. */
export function Homes({fire}: {fire: FireData}) {
  const id = useUi(s => s.selectedStructure);
  const structuresOn = useUi(s => s.layers.structures.visible);
  const setLayer = useUi(s => s.setLayer);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (id !== null) ref.current?.scrollIntoView({block: 'start', behavior: 'smooth'});
  }, [id]);
  return (
    <>
      <div ref={ref}>
        <SubHead>Homes</SubHead>
      </div>
      {id !== null ? (
        <HomeDetail fire={fire} id={id} />
      ) : (
        <div className="px-3 py-3 text-sm text-muted">
          Click a structure on the map (layer Structures) to see its construction record and exposure.
          {!structuresOn && (
            <div className="mt-1.5">
              <Button onClick={() => setLayer('structures', {visible: true})}>Show Structures</Button>
            </div>
          )}
        </div>
      )}
      <ExposureTable fire={fire} />
    </>
  );
}
