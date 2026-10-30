import {useState, type ReactNode} from 'react';
import type {FireData} from '../data/fire';
import {formatDate} from '../lib/format';
import {useTime} from '../state/time';
import {LAYERS, useUi} from '../state/ui';

/** Card with a title row (DESIGN.md §5). */
export function Card({title, aside, children}: {title: ReactNode; aside?: ReactNode; children: ReactNode}) {
  return (
    <section className="mx-2 mt-2 overflow-hidden rounded-md bg-card shadow-[0_0_0_1px_var(--hairline)]">
      <div className="flex items-center justify-between bg-section px-3 py-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Pending({children}: {children: ReactNode}) {
  return <div className="px-3 py-6 text-center text-sm text-muted">{children}</div>;
}

const THUMBS: Record<string, string> = {
  terrain: 'linear-gradient(135deg,#6f7d4f,#a99e6c)',
  imagery: 'linear-gradient(135deg,#9a9a92,#c8c6bd)',
  burnScar: 'linear-gradient(135deg,#3a1f17,#a3381e)',
  fireSpread: 'linear-gradient(135deg,#f08a2b,#d4521f)',
  ignition: 'radial-gradient(circle,#ffd27a 0 18%,#c8321f 45%)',
  wind: 'linear-gradient(135deg,#d6dadb,#eef0ee)',
  suppression: 'linear-gradient(135deg,#cdb79a,#b4442f)',
  structures: 'linear-gradient(135deg,#8d8d86,#b9b7ae)',
  roads: 'linear-gradient(135deg,#d9d6cc,#bcb8ab)',
  boundaries: 'linear-gradient(135deg,#e3e0d6,#cfcabd)'
};

function LayersList() {
  const {layers, setLayer} = useUi();
  return (
    <ul className="py-1">
      {LAYERS.map(({id}) => {
        const l = layers[id];
        const active = l.ready && l.visible;
        return (
          <li key={id} className="flex items-center gap-2.5 px-3 py-1.5" title={l.ready ? undefined : `Data from pipeline step ${l.step}`}>
            <input
              type="checkbox"
              checked={l.visible}
              disabled={!l.ready}
              onChange={e => setLayer(id, {visible: e.target.checked})}
              className="h-3.5 w-3.5 accent-[var(--text)]"
            />
            <span className="h-7 w-7 shrink-0 rounded-sm" style={{background: THUMBS[id], opacity: l.ready ? 1 : 0.45}} />
            <span className={`flex-1 truncate text-sm ${active ? 'text-ink' : 'text-muted'}`}>
              {l.label}
              {!l.ready && <span className="ml-1 font-mono text-2xs">· step {l.step}</span>}
            </span>
            {l.opacity !== null && (
              <>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={l.opacity}
                  disabled={!active}
                  onChange={e => setLayer(id, {opacity: Number(e.target.value)})}
                  className="slider w-14"
                />
                <span className={`w-9 text-right text-xs tabular-nums ${active ? '' : 'text-muted'}`}>
                  {Math.round(l.opacity * 100)}%
                </span>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Row({k, v}: {k: string; v: ReactNode}) {
  return (
    <div className="flex gap-3 px-3 py-[3px] text-sm">
      <span className="w-[104px] shrink-0 text-muted">{k}</span>
      <span className="min-w-0 flex-1">{v}</span>
    </div>
  );
}

function IncidentOverview({fire}: {fire: FireData}) {
  const {start, end} = useTime();
  const tz = fire.aoi.timezone;
  const o = fire.aoi.official;
  return (
    <Card title="Incident Overview" aside={<span className="text-sm text-muted">Edit</span>}>
      <div className="py-2">
        <Row k="Incident" v={fire.aoi.name} />
        <Row k="Location" v={fire.aoi.location} />
        <Row k="Replay window" v={`${formatDate(start, tz)} – ${formatDate(end, tz)}`} />
        <Row k="Ignition (est.)" v={<span className="text-muted">pending · step 11</span>} />
        <Row
          k="Final acres"
          v={o.final_acres ? `${Math.round(o.final_acres).toLocaleString()} acres · CAL FIRE` : '—'}
        />
        <Row
          k="Contained"
          v={o.containment_date ? `${formatDate(Date.parse(o.containment_date + 'T12:00:00Z'), tz)} · CAL FIRE` : '—'}
        />
        <Row k="Cause" v={<span className="font-medium">Not assessed by this tool</span>} />
        <Row
          k="Analysis status"
          v={
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-muted" /> Scaffold · data steps 1–2
            </span>
          }
        />
      </div>
    </Card>
  );
}

function WeatherCard() {
  const cells = ['Wind', 'Temp', 'RH', 'Fuel Moisture', 'ERC', 'Flame Length'];
  return (
    <Card title={<>Weather &amp; Fire Behavior <span className="text-sm font-normal text-muted">(at cursor)</span></>}>
      <div className="grid grid-cols-3 gap-y-3 px-3 py-3">
        {cells.map(c => (
          <div key={c}>
            <div className="text-xs text-muted">{c}</div>
            <div className="text-base font-semibold text-muted">—</div>
          </div>
        ))}
      </div>
      <div className="border-t border-hairline px-3 py-1.5 text-xs text-muted">Hourly Open-Meteo + gridMET land in step 07</div>
    </Card>
  );
}

function Evidence({fire}: {fire: FireData}) {
  const tone = {REAL: 'bg-okbg text-ok', MODELED: 'bg-tabgroup text-ink', SIM: 'bg-selected text-live'} as const;
  return (
    <ul className="divide-y divide-hairline">
      {fire.manifest.sources.map(s => (
        <li key={s.layer} className="px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{s.layer}</span>
            <span className={`rounded px-1.5 font-mono text-2xs ${tone[s.status]}`}>{s.status}</span>
          </div>
          <div className="text-xs text-muted">
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer" className="underline decoration-hairline">
                {s.source}
              </a>
            ) : (
              s.source
            )}{' '}
            · retrieved {s.retrieved}
          </div>
          {s.notes && <div className="text-xs text-muted">{s.notes}</div>}
        </li>
      ))}
    </ul>
  );
}

const SUBTABS = ['Layers', 'Analysis', 'Evidence', 'Notes'] as const;

function IncidentRail({fire}: {fire: FireData}) {
  const [sub, setSub] = useState<(typeof SUBTABS)[number]>('Layers');
  return (
    <>
      <section className="mx-2 mt-2 overflow-hidden rounded-md bg-card shadow-[0_0_0_1px_var(--hairline)]">
        <div className="flex border-b border-hairline bg-section px-1">
          {SUBTABS.map(s => (
            <button
              key={s}
              onClick={() => setSub(s)}
              className={`px-3 py-2 text-sm ${sub === s ? 'border-b-2 border-ink font-medium' : 'text-muted'}`}
            >
              {s}
            </button>
          ))}
        </div>
        {sub === 'Layers' && <LayersList />}
        {sub === 'Analysis' && <Pending>Ignition back-trace and house-level outcomes land Sunday (steps 09b, 11).</Pending>}
        {sub === 'Evidence' && <Evidence fire={fire} />}
        {sub === 'Notes' && <Pending>The Muse Spark analyst with cited answers lands Sunday (web/api/analyst).</Pending>}
      </section>
      <IncidentOverview fire={fire} />
      <WeatherCard />
    </>
  );
}

/** DESIGN.md §5: 308px rail, full height below the header. */
export function Rail({fire}: {fire: FireData}) {
  const tab = useUi(s => s.tab);
  return (
    <aside className="w-[308px] shrink-0 overflow-y-auto border-l border-hairline bg-rail pb-3">
      {tab === 'incident' && <IncidentRail fire={fire} />}
      {tab === 'drones' && (
        <Card title="Drone footage" aside={<span className="text-xs text-muted">Monday</span>}>
          <Pending>Recorded footage with Sentinel boxes and SAM 3.1 masks (steps 12, 12c).</Pending>
        </Card>
      )}
      {tab === 'resources' && (
        <Card title="Resources" aside={<span className="text-xs text-muted">Could tier</span>}>
          <Pending>Aircraft, engines and crews are a stretch goal (BUILD.md §9).</Pending>
        </Card>
      )}
    </aside>
  );
}
