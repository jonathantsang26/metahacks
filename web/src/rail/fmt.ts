/** Rail-only formatting on top of lib/format.ts. Inputs come from pipeline files; nothing here invents a value. */
import {formatDateTime, zoneLabel} from '../lib/format';

const dateFmt = new Map<string, Intl.DateTimeFormat>();

/** Local calendar date at `ms` as "2025-01-08", the key weather.json's daily rows use. */
export function localDate(ms: number, timeZone: string): string {
  let f = dateFmt.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'});
    dateFmt.set(timeZone, f);
  }
  const parts = f.formatToParts(ms);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "Jan 8, 02:14 PST" */
export function stamp(iso: string | number, timeZone: string): string {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  return `${formatDateTime(ms, timeZone)} ${zoneLabel(ms, timeZone)}`;
}

/** "Jan 8 02:14", the chip form (no comma, no zone). */
export function chipTime(ms: number, timeZone: string): string {
  return formatDateTime(ms, timeZone).replace(',', '');
}

/** 860 m, 2.2 km */
export function meters(m: number): string {
  return m < 1000 ? `${Math.round(m).toLocaleString('en-US')} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Minutes → signed hours with one decimal: "+2.3 h", "−30.9 h". */
export function signedHours(min: number): string {
  const h = min / 60;
  return `${h > 0 ? '+' : h < 0 ? '−' : ''}${Math.abs(h).toFixed(1)} h`;
}

/** Minutes → unsigned hours with one decimal. */
export function hours(min: number): string {
  return `${(min / 60).toFixed(1)} h`;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Like pct, with one decimal under 10% so a small rate does not read as "0%": 0.3%, 4.4%, 72%. */
export function pctFine(x: number): string {
  return x > 0 && x < 0.1 ? `${(x * 100).toFixed(1)}%` : pct(x);
}
