import {useMemo} from 'react';
import type {FireData} from '../data/fire';
import {indexAtOrBefore, useFireJson, type Weather} from '../data/files';
import {compassPoint, formatDate} from '../lib/format';
import {useTime} from '../state/time';
import {localDate, stamp} from './fmt';
import {Card, Missing, Stat} from './ui';

/**
 * NWS red-flag thresholds; a value is tinted --live only when it crosses one. Stated in the footer.
 * The test uses the whole number the card shows, so a value displayed as "25 mph" is never left untinted.
 */
const RED_FLAG = {rh_pct: 15, wind_mph: 25, gust_mph: 35};
/** An hourly row older than this at `t` is stale (gap in the series), so the card shows dashes. */
const MAX_AGE_MS = 2 * 3600_000;

const n0 = (v: number) => Math.round(v).toLocaleString('en-US');

/** DESIGN.md §5.1, driven by the global t: the HRRR hour at or before t and the gridMET day at t. */
export function WeatherCard({fire}: {fire: FireData}) {
  const {data: w, error} = useFireJson<Weather>(fire, 'weather.json');
  const t = useTime(s => s.t);
  const tz = fire.aoi.timezone;
  const times = useMemo(() => w?.hourly.map(h => h.t) ?? [], [w]);

  const i = indexAtOrBefore(times, t);
  const hour = w && i >= 0 && t - Date.parse(times[i]) <= MAX_AGE_MS ? w.hourly[i] : null;
  const date = localDate(t, tz);
  const day = w?.daily.find(d => d.date === date) ?? null;

  const title = (
    <>
      Weather &amp; Fire Behavior{' '}
      <span className="text-sm font-normal text-muted">({w ? `${w.model_label}, ` : ''}fire-area center)</span>
    </>
  );
  if (!w) {
    return (
      <Card title={title}>
        <Missing file="weather.json" error={error} />
      </Card>
    );
  }

  const dash = <span className="text-muted">—</span>;
  return (
    <Card title={title}>
      <div className="grid grid-cols-3 gap-x-2 gap-y-3 px-3 py-3">
        <Stat
          label="Wind"
          value={hour ? `${n0(hour.wind_mph)} mph` : dash}
          sub={hour && `from ${compassPoint(hour.wind_dir_deg)} (${hour.wind_dir_deg}°)`}
          tone={hour && Math.round(hour.wind_mph) >= RED_FLAG.wind_mph ? 'live' : undefined}
        />
        <Stat
          label="Gust"
          value={hour ? `${n0(hour.gust_mph)} mph` : dash}
          sub={hour && 'max of preceding hour'}
          tone={hour && Math.round(hour.gust_mph) >= RED_FLAG.gust_mph ? 'live' : undefined}
        />
        <Stat label="Temp" value={hour ? `${n0(hour.temp_c)} °C` : dash} />
        <Stat
          label="RH"
          value={hour ? `${n0(hour.rh_pct)}%` : dash}
          tone={hour && Math.round(hour.rh_pct) <= RED_FLAG.rh_pct ? 'live' : undefined}
        />
        <Stat label="Fuel Moisture" value={day?.fm100 != null ? `${day.fm100.toFixed(1)}%` : dash} sub="100-h, daily" />
        <Stat label="ERC" value={day?.erc != null ? n0(day.erc) : dash} sub="daily" />
      </div>
      <div className="space-y-0.5 border-t border-hairline px-3 py-1.5 text-xs text-muted">
        <div>
          {hour ? `${w.model_label} hour ${stamp(hour.t, tz)}` : `No ${w.model_label} hour at this time`} · gridMET{' '}
          {day ? `day ${formatDate(Date.parse(day.date + 'T12:00:00Z'), tz)}` : 'day not available'}
        </div>
        {day?.qc?.length ? <div>gridMET QC (kept as published): {day.qc.join('; ')}</div> : null}
        <div>
          <span className="text-live">Red</span>: at an NWS red-flag threshold, as shown (RH ≤ {RED_FLAG.rh_pct}%, wind ≥{' '}
          {RED_FLAG.wind_mph} mph or gusts ≥ {RED_FLAG.gust_mph} mph)
        </div>
      </div>
    </Card>
  );
}
