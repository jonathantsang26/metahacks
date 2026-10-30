import type {FireData} from '../data/fire';
import {useFireJson} from '../data/files';
import {formatDate} from '../lib/format';
import {stamp} from './fmt';
import {EstimatedPlace, EstimatedStart, type IgnitionFile} from './ignition';
import {Card, Chip, Row} from './ui';

/** Counts manifest sources by status, so "Analysis status" says what is real and what is modeled. */
function AnalysisStatus({fire}: {fire: FireData}) {
  const counts = {REAL: 0, MODELED: 0, SIM: 0};
  for (const s of fire.manifest.sources) counts[s.status]++;
  return (
    <span className="inline-flex items-center gap-1.5" title="From manifest.json (Evidence tab)">
      <span className={`h-2 w-2 rounded-full ${counts.SIM ? 'bg-live' : 'bg-muted'}`} />
      {counts.REAL} real · {counts.MODELED} modeled sources · {counts.SIM ? `${counts.SIM} simulated` : 'none simulated'}
    </span>
  );
}

export function IncidentOverview({fire}: {fire: FireData}) {
  const {data: ig, error} = useFireJson<IgnitionFile>(fire, 'ignition.json');
  const tz = fire.aoi.timezone;
  const o = fire.aoi.official;
  // From aoi.json itself, not the time store, which is only set after the first render.
  const [w0, w1] = fire.aoi.window_utc.map(Date.parse);
  return (
    <Card title="Incident Overview">
      <div className="py-2">
        <Row
          k="Incident"
          v={
            o.incident?.url ? (
              <a
                href={o.incident.url}
                target="_blank"
                rel="noreferrer"
                title="CAL FIRE incident page"
                className="underline decoration-hairline underline-offset-2"
              >
                {fire.aoi.name} ↗
              </a>
            ) : (
              fire.aoi.name
            )
          }
        />
        <Row k="Location" v={fire.aoi.location} />
        <Row k="Replay window" v={`${formatDate(w0, tz)} – ${formatDate(w1, tz)}`} />
        <Row
          k="Reported start"
          v={
            o.incident ? (
              <>
                {stamp(o.incident.start_utc, tz)} <span className="text-muted">· reported, CAL FIRE</span>
              </>
            ) : (
              '—'
            )
          }
        />
        <Row
          k="Ignition (est.)"
          v={
            ig ? (
              <>
                <div>
                  <EstimatedPlace ig={ig} />
                </div>
                <div className="text-xs">
                  <EstimatedStart ig={ig} tz={tz} />
                </div>
                <div className="mt-0.5">
                  <Chip tone="modeled">MODELED</Chip> <span className="text-2xs text-muted">back-trace, not an investigated origin</span>
                </div>
              </>
            ) : (
              <span className="text-muted">{error ? 'not available (ignition.json)' : '…'}</span>
            )
          }
        />
        <Row
          k="Final acres"
          v={o.final_acres ? `${Math.round(o.final_acres).toLocaleString('en-US')} acres · CAL FIRE` : '—'}
        />
        <Row
          k="Contained"
          v={o.containment_date ? `${formatDate(Date.parse(o.containment_date + 'T12:00:00Z'), tz)} · CAL FIRE` : '—'}
        />
        <Row k="Cause" v={<span className="font-medium">Not assessed by this tool</span>} />
        <Row k="Analysis status" v={<AnalysisStatus fire={fire} />} />
      </div>
    </Card>
  );
}
