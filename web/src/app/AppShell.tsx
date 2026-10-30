import {useEffect} from 'react';
import {useFireData} from '../data/fire';
import {Dock} from '../dock/Dock';
import {Header} from '../header/Header';
import {Rail} from '../rail/Rail';
import {Stage} from '../stage/Stage';
import {startClock} from '../state/time';

/** DESIGN.md §1: header 40 / [stage + dock | rail 308]. */
export function AppShell() {
  const {data, error} = useFireData();

  useEffect(() => startClock(), []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm">
        <div>
          <div className="font-semibold">Couldn't load fire data</div>
          <div className="mt-1 font-mono text-xs text-muted">{error}</div>
        </div>
      </div>
    );
  }
  if (!data) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">Loading fire data…</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <Header fire={data} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Stage fire={data} />
          </div>
          <Dock fire={data} />
        </div>
        <Rail fire={data} />
      </div>
    </div>
  );
}
