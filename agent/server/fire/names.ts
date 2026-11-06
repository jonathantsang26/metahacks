/**
 * Street-name normalization. Mirrors pipeline/steps/s09_vectors.py `normalize_street` exactly,
 * because gazetteer.json keys were built with it: 'North Lake Avenue' -> 'n lake ave'.
 */
const STREET_WORDS: Record<string, string> = {
  avenue: 'ave',
  street: 'st',
  road: 'rd',
  boulevard: 'blvd',
  drive: 'dr',
  lane: 'ln',
  place: 'pl',
  court: 'ct',
  canyon: 'cyn',
  mountain: 'mtn'
};
const DIRECTIONS: Record<string, string> = {north: 'n', south: 's', east: 'e', west: 'w'};
const SHORT_DIRECTIONS = new Set(Object.values(DIRECTIONS));

export function normalizeName(name: string): string {
  const s = name.toLowerCase().replace(/['’.]/g, '');
  const tokens = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokens.length && tokens[0] in DIRECTIONS) tokens[0] = DIRECTIONS[tokens[0]];
  return tokens.map(t => STREET_WORDS[t] ?? t).join(' ');
}

/** 'n lake ave' -> 'lake ave', so "Lake Ave" finds both North and South Lake Avenue. */
export function withoutDirection(key: string): string {
  const [first, ...rest] = key.split(' ');
  return rest.length && SHORT_DIRECTIONS.has(first) ? rest.join(' ') : key;
}

export type MatchTier = 'exact' | 'prefix' | 'contains';

export function matchTier(key: string, query: string): MatchTier | null {
  const bare = withoutDirection(key);
  if (key === query || bare === query) return 'exact';
  if (key.startsWith(query) || bare.startsWith(query)) return 'prefix';
  if (key.includes(query)) return 'contains';
  return null;
}

export const TIER_RANK: Record<MatchTier, number> = {exact: 0, prefix: 1, contains: 2};
