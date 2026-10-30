import {useMemo} from 'react';
import type {FireData} from '../data/fire';
import {indexAtOrBefore, useFireJson, type Weather, type WindField} from '../data/files';
import {compassPoint, formatDate, formatLatLon} from '../lib/format';
import {useTime} from '../state/time';
import {useUi} from '../state/ui';
import {localDate, stamp} from './fmt';
import {windAt, windHour} from './geo';
import {Card, Missing, Stat} from './ui';

/**
 * NWS red-flag thresholds; a value is tinted --live only when it crosses one. Stated in the footer.
 * The test uses the whole number the card shows, so a value displayed as "25 mph" is never left untinted.
 */
const RED_FLAG = {rh_pct: 15, wind_mph: 25, gust_mph: 35};
/** An hourly row older than this at `t` is stale (gap in the series), so the card shows dashes. */
const MAX_AGE_MS = 2 * 3600_000;

const n0 = (v: number) => Math.round(v).toLocaleString('en-US');

type StationHour = {t: string; wind_mph: number | null; gust_mph: number | null; wind_dir_deg: number | null; rh_pct: number | null; temp_c: number | null};
/** weather_station.json: hourly observations (REAL) at the surface station step 07 compares HRRR with. */
type Station = {station: string; name: string; distance_km: number; selection: string; hourly: StationHour[]};

/** One muted line: the station's observed wind, gust and RH in the hour at or before t. */
function StationLine({fire, t}: {fire: FireData; t: number}) {
  const {data: s} = useFireJson<Station>(fire, 'weather_station.json');
  const times = useMemo(() => s?.hourly.map(h => h.t) ?? [], [s]);
  if (!s) return null;
  const tz = fire.aoi.timezone;
  const i = indexAtOrBefore(times, t);
  const h = i >= 0 && t - Date.parse(times[i]) <= MAX_AGE_MS ? s.hourly[i] : null;
  const where = `${s.name} (${s.station}), observed, ${s.distance_km.toFixed(1)} km from the fire-area center`;
  const about = `Chosen as the ${s.selection}.`;
  if (!h) return <div title={about}>{where}: no report at this time</div>;
  const wind =
    h.wind_mph == null
      ? null
      : h.wind_dir_deg == null
        ? `${n0(h.wind_mph)} mph${h.wind_mph === 0 ? ' (calm)' : ''}`
        : `${n0(h.wind_mph)} mph from ${compassPoint(h.wind_dir_deg)}`;
  const parts = [wind, h.gust_mph != null ? `gusts ${n0(h.gust_mph)} mph` : null, h.rh_pct != null ? `RH ${n0(h.rh_pct)}%` : null];
  return (
    <div title={about}>
      {where}: {parts.filter(Boolean).join(', ') || 'no wind or RH reported'} · {stamp(h.t, tz)}
    </div>
  );
}

/**
 * DESIGN.md §5.1, driven by the global t and the cursor. Over the terrain, wind and gust are the
 * HRRR grid (wind_field.json) interpolated at the cursor; otherwise weather.json at the fire-area
 * center. Temp and RH stay center values and fuel moisture and ERC the gridMET day, at any cursor.
 */
export function WeatherCard({fire}: {fire: FireData}) {
  const {data: w, error} = useFireJson<Weather>(fire, 'weather.json');
  const {data: wf} = useFireJson<WindField>(fire, 'wind_field.json');
  const t = useTime(s => s.t);
  const hover = useUi(s => s.hover);
  const tz = fire.aoi.timezone;
  const times = useMemo(() => w?.hourly.map(h => h.t) ?? [], [w]);

  const i = indexAtOrBefore(times, t);
  const hour = w && i >= 0 && t - Date.parse(times[i]) <= MAX_AGE_MS ? w.hourly[i] : null;
  const date = localDate(t, tz);
  const day = w?.daily.find(d => d.date === date) ?? null;

  // At the cursor: the grid hour at or before t, bilinear over the HRRR points (cheap: four points).
  const k = wf && hover ? windHour(wf, wf.t, t, MAX_AGE_MS) : -1;
  const cursor = wf && hover ? {at: k >= 0 ? windAt(wf, k, hover.lon, hover.lat) : null, hourT: k >= 0 ? wf.t[k] : null} : null;
  const wind = cursor
    ? cursor.at && {mph: cursor.at.speed_mph, dir: Math.round(cursor.at.from_deg) % 360, gust: cursor.at.gust_mph}
    : hour && {mph: hour.wind_mph, dir: hour.wind_dir_deg, gust: hour.gust_mph};
  const label = w?.model_label ?? 'HRRR';

  const title = (
    <>
      Weather &amp; Fire Behavior{' '}
      <span className="text-sm font-normal text-muted">({cursor ? `at cursor · ${label}` : `${label}, fire-area center`})</span>
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
  const center = cursor ? 'at center' : undefined;
  return (
    <Card title={title}>
      <div className="grid grid-cols-3 gap-x-2 gap-y-3 px-3 py-3">
        <Stat
          label="Wind"
          value={wind ? `${n0(wind.mph)} mph` : dash}
          sub={wind && `from ${compassPoint(wind.dir)} (${wind.dir}°)`}
          tone={wind && Math.round(wind.mph) >= RED_FLAG.wind_mph ? 'live' : undefined}
        />
        <Stat
          label="Gust"
          value={wind ? `${n0(wind.gust)} mph` : dash}
          sub={wind && 'max of preceding hour'}
          tone={wind && Math.round(wind.gust) >= RED_FLAG.gust_mph ? 'live' : undefined}
        />
        <Stat label="Temp" value={hour ? `${n0(hour.temp_c)} °C` : dash} sub={center} />
        <Stat
          label="RH"
          value={hour ? `${n0(hour.rh_pct)}%` : dash}
          sub={center}
          tone={hour && Math.round(hour.rh_pct) <= RED_FLAG.rh_pct ? 'live' : undefined}
        />
        <Stat
          label="Fuel Moisture"
          value={day?.fm100 != null ? `${day.fm100.toFixed(1)}%` : dash}
          sub={cursor ? '100-h, daily, at center' : '100-h, daily'}
        />
        <Stat label="ERC" value={day?.erc != null ? n0(day.erc) : dash} sub={cursor ? 'daily, at center' : 'daily'} />
      </div>
      <div className="space-y-0.5 border-t border-hairline px-3 py-1.5 text-xs text-muted">
        {cursor && hover && (
          <div>
            Wind and gust: {label} grid ({wf!.rows}×{wf!.cols} points) interpolated at {formatLatLon(hover.lat, hover.lon)}
            {cursor.hourT ? `, hour ${stamp(cursor.hourT, tz)}` : ', no hour at this time'}. Temp, RH, fuel moisture and ERC: fire-area center.
          </div>
        )}
        <div>
          {hour ? `${w.model_label} hour ${stamp(hour.t, tz)}` : `No ${w.model_label} hour at this time`} · gridMET{' '}
          {day ? `day ${formatDate(Date.parse(day.date + 'T12:00:00Z'), tz)}` : 'day not available'} (fuel moisture, ERC)
        </div>
        {day?.qc?.length ? <div>gridMET QC (kept as published): {day.qc.join('; ')}</div> : null}
        <StationLine fire={fire} t={t} />
        <div>
          <span className="text-live">Red</span>: at an NWS red-flag threshold, as shown (RH ≤ {RED_FLAG.rh_pct}%, wind ≥{' '}
          {RED_FLAG.wind_mph} mph or gusts ≥ {RED_FLAG.gust_mph} mph)
        </div>
      </div>
    </Card>
  );
}
