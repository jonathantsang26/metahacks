const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Parses an ISO-8601 time. Strings without a zone are read as UTC (and flagged). */
export function parseTime(input: string): {ms: number; assumedUtc: boolean} | null {
  const s = input.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const assumedUtc = !HAS_ZONE.test(s);
  const ms = Date.parse(assumedUtc ? (s.includes('T') ? `${s}Z` : `${s}T00:00:00Z`) : s);
  return Number.isFinite(ms) ? {ms, assumedUtc} : null;
}

/** Whole-second UTC ISO string: "2025-01-08T02:18:00Z". */
export function isoUtc(ms: number): string {
  return new Date(Math.round(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

export function roundToMinute(ms: number): number {
  return Math.round(ms / 60_000) * 60_000;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** "Tue, Jan 7, 2025, 6:18 PM PST": the zone label comes from Intl, so PDT/PST is never hardcoded. */
export function localLabel(ms: number, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    });
    formatters.set(timeZone, f);
  }
  return f.format(ms);
}

/** Local calendar date (YYYY-MM-DD) in the fire's time zone. */
export function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(ms);
}

/** The pair every tool returns for a time: UTC for citing, local for writing. */
export function stamp(ms: number, timeZone: string): {t: string; t_local: string} {
  return {t: isoUtc(ms), t_local: localLabel(ms, timeZone)};
}
