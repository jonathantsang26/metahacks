import type {FireData} from '../data/fire';
import {useFireJson} from '../data/files';
import {formatDate} from '../lib/format';
import {stamp} from './fmt';
import {EstimatedPlace, EstimatedStart, type IgnitionFile} from './ignition';
import {Card, Row} from './ui';

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
        <Row k="Replay window" v={`${formatDate(w0!, tz)} – ${formatDate(w1!, tz)}`} />
        <Row
          k="Reported start"
          v={
            o.incident ? (
              <>
                {stamp(o.incident.start_utc, tz)} <span className="text-se-muted">· reported, CAL FIRE</span>
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
                <div className="mt-0.5 text-2xs text-se-muted">Estimated from the spread, not an investigated origin</div>
              </>
            ) : (
              <span className="text-se-muted">{error ? 'not available (ignition.json)' : '…'}</span>
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
      </div>
    </Card>
  );
}
