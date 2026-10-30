import {useEffect, useState} from 'react';
import type {FireData} from '../data/fire';
import {LAYERS, useUi, type LayerId} from '../state/ui';
import {Analysis} from './analysis';
import {Analyst} from './analyst';
import {IncidentOverview} from './overview';
import {POSTERIOR_THUMB, SCAR_THUMB} from './ramps';
import {Card, Pending} from './ui';
import {WeatherCard} from './weather';

export {Card} from './ui';

/** A 28×28 SVG drawing as a CSS background layer, for thumbnails a gradient cannot draw. */
const svgThumb = (body: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 28'>${body}</svg>`)}") center/100% no-repeat,`;

const THUMBS: Partial<Record<LayerId, string>> = {
  terrain: 'linear-gradient(135deg,#6f7d4f,#a99e6c)',
  // Both fire-related thumbnails come from the shader's ramps (ramps.ts), as the map draws them.
  burnScar: SCAR_THUMB,
  fireSpread: 'linear-gradient(135deg,#f08a2b,#d4521f)',
  perimeters: `${svgThumb("<path d='M6 9 17 5 23 13 17 23 7 20Z' fill='none' stroke='#fff7ec' stroke-width='1.6'/>")} #8f8a7c`,
  ignition: POSTERIOR_THUMB,
  spine: `${svgThumb("<path d='M4 22 12 15 18 12 24 5' fill='none' stroke='#f2b233' stroke-width='2' stroke-dasharray='3 2'/>")} #8f8a7c`,
  wind: 'linear-gradient(135deg,#d6dadb,#eef0ee)',
  structures: 'linear-gradient(135deg,#8d8d86,#b9b7ae)',
  roads: 'linear-gradient(135deg,#d9d6cc,#bcb8ab)',
  labels: 'linear-gradient(135deg,#ebe8de,#d6d2c6)'
};

function LayersList() {
  const {layers, setLayer} = useUi();
  return (
    <ul className="py-1">
      {LAYERS.map(({id}) => {
        const l = layers[id];
        const active = l.ready && l.visible;
        const pending = l.pending;
        return (
          <li key={id} className="flex items-center gap-2.5 px-3 py-1.5" title={l.ready ? undefined : pending}>
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
              {!l.ready && <span className="ml-1 font-mono text-2xs">· {pending}</span>}
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

const SUBTABS = ['Layers', 'Analysis', 'Evidence', 'Analyst'] as const;

function IncidentRail({fire}: {fire: FireData}) {
  const [sub, setSub] = useState<(typeof SUBTABS)[number]>('Layers');
  const selected = useUi(s => s.selectedStructure);
  // Picking a structure on the map opens Analysis → Homes, where its record is shown.
  useEffect(() => {
    if (selected !== null) setSub('Analysis');
  }, [selected]);
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
        {sub === 'Analysis' && <Analysis fire={fire} />}
        {sub === 'Evidence' && <Evidence fire={fire} />}
        {sub === 'Analyst' && <Analyst fire={fire} />}
      </section>
      <IncidentOverview fire={fire} />
      <WeatherCard fire={fire} />
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
        <Card title="Drone footage">
          <Pending>Drone footage is not available in this build.</Pending>
        </Card>
      )}
      {tab === 'resources' && (
        <Card title="Resources">
          <Pending>Aircraft, engines and crews are not available in this build.</Pending>
        </Card>
      )}
    </aside>
  );
}
