import {useShallow} from 'zustand/react/shallow';
import {useEffect, useState} from 'react';
import type {FireData} from '../data/fire';
import {DronesRail} from '../drones/DronesRail';
import {BriefingPanel, HindsightCard, PlanPanel} from '@/plan';
import {getMapCenter} from '../stage/map-center';
import {LAYERS, useUi, type LayerId} from '../state/ui';
import {Analysis} from './analysis';
import {AskAgent} from './ask-agent';
import {IncidentOverview} from './overview';
import {RiskRail} from './risk';
import {SwarmPanel} from './swarm';
import {POSTERIOR_THUMB, SCAR_THUMB} from './ramps';
import {WeatherCard} from './weather';

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
  labels: 'linear-gradient(135deg,#ebe8de,#d6d2c6)',
  forecast: `${svgThumb("<path d='M5 18 9 7 19 5 24 14 16 23Z' fill='none' stroke='#7e57ff' stroke-width='1.8' stroke-dasharray='3 2'/>")} #8f8a7c`,
  dronePlan: `${svgThumb("<circle cx='10' cy='12' r='6' fill='none' stroke='#2f6fd6' stroke-width='1.6'/><circle cx='19' cy='17' r='6' fill='none' stroke='#2f6fd6' stroke-width='1.6'/><circle cx='10' cy='12' r='1.8' fill='#2f6fd6'/><circle cx='19' cy='17' r='1.8' fill='#2f6fd6'/>")} #8f8a7c`,
  liveHits: `${svgThumb("<path d='M6 20 10 9 21 8 22 19Z' fill='none' stroke='#ffd640' stroke-width='1.5'/><circle cx='12' cy='14' r='2.2' fill='#ff4020'/><circle cx='17' cy='12' r='2.2' fill='#ff4020'/><circle cx='15' cy='18' r='2.2' fill='#ff4020' opacity='.5'/>")} #8f8a7c`
};

function LayersList() {
  const {layers, setLayer} = useUi(useShallow(s => ({layers: s.layers, setLayer: s.setLayer})));
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
            <span className="h-7 w-7 shrink-0 rounded-xs" style={{background: THUMBS[id], opacity: l.ready ? 1 : 0.45}} />
            <span className={`flex-1 truncate text-sm ${active ? 'text-ink' : 'text-se-muted'}`}>
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
                <span className={`w-9 text-right text-xs tabular-nums ${active ? '' : 'text-se-muted'}`}>
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
  return (
    <ul className="divide-y divide-hairline">
      {fire.manifest.sources.map(s => (
        <li key={s.layer} className="px-3 py-2">
          <div className="text-sm font-medium">{s.layer}</div>
          <div className="text-xs text-se-muted">
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer" className="underline decoration-hairline">
                {s.source}
              </a>
            ) : (
              s.source
            )}{' '}
            · retrieved {s.retrieved}
          </div>
          {s.notes && <div className="text-xs text-se-muted">{s.notes}</div>}
        </li>
      ))}
    </ul>
  );
}

const SUBTABS = ['Layers', 'Analysis', 'Evidence', 'Ask', 'Swarm'] as const;

function IncidentRail({fire}: {fire: FireData}) {
  // Collapsed (header only) until a tab is picked, so the plan cards lead the rail; a click on
  // the open tab collapses it again.
  const [sub, setSub] = useState<(typeof SUBTABS)[number] | null>(null);
  const selected = useUi(s => s.selectedStructure);
  // Picking a structure on the map opens Analysis → Homes, where its record is shown.
  useEffect(() => {
    if (selected !== null) setSub('Analysis');
  }, [selected]);
  return (
    <>
      <section className="mx-2 mt-2 overflow-hidden rounded-md bg-se-card shadow-[0_0_0_1px_var(--hairline)]">
        <div className={`flex bg-section px-1 ${sub ? 'border-b border-hairline' : ''}`} role="tablist">
          {SUBTABS.map(s => (
            <button
              key={s}
              role="tab"
              aria-selected={sub === s}
              aria-expanded={sub === s}
              onClick={() => setSub(cur => (cur === s ? null : s))}
              className={`px-2 py-2 text-sm ${sub === s ? 'border-b-2 border-ink font-medium' : 'text-se-muted hover:text-ink'}`}
            >
              {s}
            </button>
          ))}
        </div>
        {sub === 'Layers' && <LayersList />}
        {sub === 'Analysis' && <Analysis fire={fire} />}
        {sub === 'Evidence' && <Evidence fire={fire} />}
        {sub === 'Ask' && <AskAgent fire={fire} />}
        {sub === 'Swarm' && <SwarmPanel fire={fire} />}
      </section>
      <IncidentOverview fire={fire} />
      <WeatherCard fire={fire} />
    </>
  );
}

/**
 * The drone plan for the next hour (app/plan, owned by the plan UI): score, drones, briefing and
 * the hindsight check, each its own card. Shown above the incident and drones rails, since
 * planning is the main job. They read `fire` and `t` from the URL, which IncidentSync keeps current.
 */
function PlanSection() {
  return (
    <div data-sentinel-plan>
      <PlanPanel className="mx-2 mt-2" getMapCenter={getMapCenter} />
      <BriefingPanel className="mx-2 mt-2" />
      <HindsightCard className="mx-2 mt-2" />
    </div>
  );
}

/** DESIGN.md §5: 308px rail, full height below the header. */
export function Rail({fire}: {fire: FireData}) {
  const tab = useUi(s => s.tab);
  return (
    <aside className="w-[308px] shrink-0 overflow-y-auto border-l border-hairline bg-rail pb-3">
      {tab !== 'risk' && <PlanSection />}
      {tab === 'incident' && <IncidentRail fire={fire} />}
      {tab === 'drones' && <DronesRail fire={fire} />}
      {tab === 'risk' && <RiskRail fire={fire} />}
    </aside>
  );
}
