import type {Cite, Paragraph, RawParagraph} from './types.js';

/**
 * Server-side checks on the model's final answer. The system prompt asks for the same things;
 * these make them hold whatever the model does.
 */

/** Cause or attribution language. "\bcaus(e|es|ed|ing)\b" leaves "because" and "causal" alone. */
const CAUSE_PATTERNS: RegExp[] = [
  /\bcaus(?:e|es|ed|ing)\b/i,
  /\b(?:ignited|sparked|lit)\s+(?:off\s+)?by\b/i,
  /\bstarted\s+by\s+(?:a|an|the|someone|people|humans?)\b/i,
  /\bignition\s+source\b/i,
  /\barson(?:ist)?s?\b/i,
  /\bpower\s*-?lines?\b/i,
  /\btransmission\s+(?:lines?|towers?|equipment|structures?)\b/i,
  /\butility\s+(?:equipment|lines?|poles?|infrastructure|company|companies)\b/i,
  /\belectrical\s+(?:equipment|fault|failure|infrastructure|lines?)\b/i,
  /\b(?:downed|arcing)\s+(?:power\s+)?(?:lines?|wires?|conductors?)\b/i,
  /\bEdison\b/i,
  /\bSCE\b/,
  /\b(?:lightning|campfire|cigarette|fireworks)\b/i,
  /\battribut(?:e|ed|es|ing|able)\s+to\b/i,
  /\bblam(?:e|ed|es|ing)\b/i,
  /\bresponsible\s+for\b/i,
  /\b(?:originated|began|started)\s+(?:from|with)\b/i,
  /\borigin\s+of\s+the\s+fire\b/i,
  /\bshort[\s-]?circuit(?:ed|s)?\b/i,
  /\belectrical\s+short\b/i
];

const STREET_SUFFIX =
  'Ave(?:nue)?|St(?:reet)?|R(?:oa)?d|Blvd|Boulevard|Dr(?:ive)?|Lane|Ln|Way|Pl(?:ace)?|Ct|Court|Cir(?:cle)?|Ter(?:race)?|Trl|Trail|Pkwy|Parkway|Hwy|Highway|Canyon|Cyn|Loop|Crest|Vista|View';
const NAME_TOKEN = "(?!(?:AM|PM|PST|PDT|UTC|GMT)\\b)(?:[A-Z][A-Za-z'’.-]*|\\d+(?:st|nd|rd|th))";
/** A house number followed by one to four capitalized name words and a street suffix. */
const ADDRESS = new RegExp(`(?<![:\\d])\\b(\\d{1,6})[A-Za-z]?\\s+(?:${NAME_TOKEN}\\s+){1,4}(?:${STREET_SUFFIX})\\b`, 'g');
const DATE_BEFORE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s*$/;

/** A capture group the pattern always fills when it matches. */
function group(m: RegExpMatchArray, i: number): string {
  const g = m[i];
  if (g === undefined) throw new Error(`regex group ${i} is empty in ${JSON.stringify(m[0])}`);
  return g;
}

export function mentionsCause(text: string): boolean {
  return CAUSE_PATTERNS.some(p => p.test(text));
}

export function containsAddress(text: string): boolean {
  for (const m of text.matchAll(ADDRESS)) {
    // "Jan 8, 2025 Lake Avenue ..." is a date running into a street name, not an address.
    const isYear = /^(?:19|20)\d\d$/.test(group(m, 1));
    if (isYear && DATE_BEFORE.test(text.slice(Math.max(0, m.index - 16), m.index))) continue;
    return true;
  }
  return false;
}

/** The tool output behind each cite id, and the question, for checking numbers in the prose. */
export type Grounding = {evidence: ReadonlyMap<string, unknown>; question?: string};

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
const CLOCK = /\b(\d{1,2}):(\d{2})(?:\s*([ap])\.?\s*m\b\.?)?/gi;
const DATES = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}(?:T[\\d:]+Z?)?\\b|\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?|\\b(?:19|20)\\d{2}\\b`, 'gi');
const NUMBER = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s*%)?(?![\w])/g;

/** "45 percent" or "45 per cent" right after a number. */
const PERCENT_WORD = /^\s*per\s?cent\b/i;

/** A number from a cited result; `pct` when it is already a percentage (its key or a % after it says so). */
type Evidence = {v: number; pct: boolean};

/** Key names whose values are percentages, shares or rates: rh_pct, burnedFraction, destroyed_rate. */
function percentKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/);
  return words.some(w => /^(?:pct|percent(?:age)?s?|shares?|fractions?|rates?)$/.test(w));
}

function collect(value: unknown, numbers: Evidence[], strings: string[], pctKey = false): void {
  if (typeof value === 'number' && Number.isFinite(value)) numbers.push({v: value, pct: pctKey});
  else if (typeof value === 'string') {
    strings.push(value);
    const plain = value.replace(CLOCK, ' ');
    for (const m of plain.matchAll(NUMBER)) {
      const pct = pctKey || !!m[3] || PERCENT_WORD.test(plain.slice(m.index + m[0].length));
      numbers.push({v: Number((group(m, 1) + (m[2] ?? '')).replace(/,/g, '')), pct});
    }
  } else if (Array.isArray(value)) value.forEach(v => collect(v, numbers, strings, pctKey));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => collect(v, numbers, strings, percentKey(k)));
}

/** v (written with `decimals` places) is x rounded: to those places, or to 2+ significant figures. */
function roundsTo(x: number, v: number, decimals: number): boolean {
  if (Math.abs(x - v) <= 0.5 * 10 ** -decimals + 1e-9) return true;
  if (v === 0 || x === 0) return false;
  for (let sig = 2; sig <= 6; sig++) {
    const p = 10 ** (Math.floor(Math.log10(Math.abs(x))) - sig + 1);
    if (Math.abs(Math.round(x / p) * p - v) <= 1e-9 * Math.abs(v)) return true;
  }
  return false;
}

/**
 * Numbers and clock times in the prose that appear in none of the paragraph's cited tool outputs
 * (nor in the question). Rounding is allowed; integers up to 10 are exempt, since prose counts
 * ("two perimeters") are rarely the claim being made. A percentage ("45%", "45 percent") matches
 * only a cited percentage (a pct/percent/share/fraction/rate field, or a number written with %)
 * or a cited value from 0 to 1 taken ×100, never an unrelated count that happens to be 45.
 */
export function ungroundedNumbers(text: string, cites: Cite[], g: Grounding): string[] {
  const numbers: Evidence[] = [];
  const strings: string[] = [];
  for (const c of cites) collect([g.evidence.get(c.id), c], numbers, strings);
  collect(g.question ?? '', numbers, strings);
  const haystack = strings.join(' | ').toLowerCase();
  const bad: string[] = [];
  for (const m of text.matchAll(CLOCK)) {
    const [, , mm, ap] = m;
    const h = group(m, 1);
    const local = `${Number(h)}:${mm}${ap ? ` ${ap.toLowerCase()}m` : ''}`;
    const utc = `t${h.padStart(2, '0')}:${mm}`;
    if (!haystack.includes(local) && !haystack.includes(utc)) bad.push(m[0].trim());
  }
  const prose = text.replace(CLOCK, ' ').replace(DATES, ' ');
  for (const m of prose.matchAll(NUMBER)) {
    const v = Number(group(m, 1).replace(/,/g, '') + (m[2] ?? ''));
    const decimals = m[2] ? m[2].length - 1 : 0;
    const after = prose.slice(m.index + m[0].length).match(PERCENT_WORD)?.[0];
    const percent = !!m[3] || after !== undefined;
    if (!percent && !m[2] && v <= 10) continue;
    const ok = percent
      ? numbers.some(x => (x.pct && roundsTo(x.v, v, decimals)) || (Math.abs(x.v) <= 1 && roundsTo(100 * x.v, v, decimals)))
      : numbers.some(x => roundsTo(x.v, v, decimals));
    if (!ok) bad.push((m[0] + (after ?? '')).trim());
  }
  return bad;
}

export type Verified = {
  paragraphs: Paragraph[];
  dropped: {uncited: number; guardrail: number; ungrounded: number};
  /** Every cite id the model proposed, and the ones that no tool had returned. */
  audit: {proposed: number; invalid: number};
};

const INLINE_CITE = /\s*[[(]\s*(c\d+(?:\s*[,;]\s*c\d+)*)\s*[\])]/gi;

/**
 * Guardrails run first (cause or address → dropped.guardrail), then citations: only ids in the
 * registry survive, and a paragraph left with none is dropped (dropped.uncited). With grounding,
 * a paragraph whose numbers or times appear in none of its cited tool outputs is dropped too
 * (dropped.ungrounded): a cite has to support the numbers, not just exist.
 */
export function verifyAnswer(raw: unknown, registry: ReadonlyMap<string, Cite>, grounding?: Grounding): Verified {
  const out: Verified = {paragraphs: [], dropped: {uncited: 0, guardrail: 0, ungrounded: 0}, audit: {proposed: 0, invalid: 0}};
  const list: RawParagraph[] = Array.isArray(raw) ? raw : [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const ids: string[] = Array.isArray(p.cite_ids) ? p.cite_ids.filter((x): x is string => typeof x === 'string') : [];
    let text = typeof p.text === 'string' ? p.text : '';
    // Ids written into the text ("... [c3, c4]") count as cites and are removed from the prose.
    text = text.replace(INLINE_CITE, (_m, group: string) => {
      ids.push(...group.split(/[,;]/).map(s => s.trim().toLowerCase()));
      return '';
    });
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const unique = [...new Set(ids.map(s => s.trim().toLowerCase()))];
    out.audit.proposed += unique.length;
    const cites = unique.map(id => registry.get(id)).filter((c): c is Cite => !!c);
    out.audit.invalid += unique.length - cites.length;
    if (mentionsCause(text) || containsAddress(text)) out.dropped.guardrail++;
    else if (!cites.length) out.dropped.uncited++;
    else if (grounding && ungroundedNumbers(text, cites, grounding).length) out.dropped.ungrounded++;
    else out.paragraphs.push({text, cites});
  }
  return out;
}
