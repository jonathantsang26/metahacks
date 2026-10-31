/**
 * All timestamps are stored in UTC and rendered in the incident's time zone with a
 * computed zone label (BUILD.md §8): a January fire shows PST, never a copied "PDT".
 */

const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = timeZone + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {timeZone, ...opts});
    cache.set(key, f);
  }
  return f;
}

/** "Jan 8, 02:00" */
export function formatDateTime(ms: number, timeZone: string): string {
  const parts = fmt(timeZone, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(ms);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('month')} ${get('day')}, ${get('hour')}:${get('minute')}`;
}

/** "PST" / "PDT" for the given instant. */
export function zoneLabel(ms: number, timeZone: string): string {
  const parts = fmt(timeZone, {timeZoneName: 'short'}).formatToParts(ms);
  return parts.find(p => p.type === 'timeZoneName')?.value ?? '';
}

/** "Jan 8, 2025" */
export function formatDate(ms: number, timeZone: string): string {
  return fmt(timeZone, {month: 'short', day: 'numeric', year: 'numeric'}).format(ms);
}

/** Two-level timeline ticks: "Jan 8" and "06:00". */
export function tickParts(ms: number, timeZone: string): {day: string; hour: string} {
  const parts = fmt(timeZone, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'})
    .formatToParts(ms);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return {day: `${get('month')} ${get('day')}`, hour: `${get('hour')}:${get('minute')}`};
}

/** 34°17.44'N 117°55.91'W */
export function formatLatLon(lat: number, lon: number): string {
  const dm = (v: number) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    return `${d}°${((a - d) * 60).toFixed(2).padStart(5, '0')}'`;
  };
  return `${dm(lat)}${lat >= 0 ? 'N' : 'S'} ${dm(lon)}${lon >= 0 ? 'E' : 'W'}`;
}

/** "42 h 29 min", matching the hover inspector's burned-ago line. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  if (total < 1) return 'less than 1 min';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${m} min`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compassPoint(deg: number): string {
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}
