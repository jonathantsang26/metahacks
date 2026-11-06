import {useEffect, useState} from 'react';
import {GuideSteps} from '@/plan';
import {useFireData, type FireId} from '../data/fire';
import {Dock} from '../dock/Dock';
import {LivePlayer} from '../drones/live/LivePlayer';
import {FootagePlayer} from '../drones/Player';
import {Header} from '../header/Header';
import {Rail} from '../rail/Rail';
import {Stage} from '../stage/Stage';
import {startClock} from '../state/time';
import {IncidentSync, MapCommands} from './agent-sync';

/** DESIGN.md §1: header 40 / [stage + dock | rail 308]. Rendered client-only by app/routes/incident.tsx. */
export function AppShell({fire}: {fire: FireId}) {
  // `?t=` is read once per fire load; later URL changes are applied by IncidentSync.
  const [initialT] = useState(() => new URLSearchParams(window.location.search).get('t'));
  const {data, error} = useFireData(fire, initialT);

  useEffect(() => startClock(), []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm">
        <div>
          <div className="font-semibold">Couldn't load fire data</div>
          <div className="mt-1 font-mono text-xs text-se-muted">{error}</div>
        </div>
      </div>
    );
  }
  if (!data) {
    return <div className="flex h-full items-center justify-center text-sm text-se-muted">Loading fire data…</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <IncidentSync fire={data} />
      <MapCommands />
      <Header fire={data} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <Stage fire={data} />
            <FootagePlayer fire={data} />
            <LivePlayer fire={data} />
            {/* The plan UI's one-line guide strip, centred at the top of the map, clear of the compass. */}
            <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-14">
              <div className="pointer-events-auto min-w-0 max-w-[640px]">
                <GuideSteps />
              </div>
            </div>
          </div>
          <Dock fire={data} />
        </div>
        <Rail fire={data} />
      </div>
    </div>
  );
}

export default AppShell;
