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
  /\b(?:lightning|campfire|cigarette|fireworks)\b/i
];

const STREET_SUFFIX =
  'Ave(?:nue)?|St(?:reet)?|R(?:oa)?d|Blvd|Boulevard|Dr(?:ive)?|Lane|Ln|Way|Pl(?:ace)?|Ct|Court|Cir(?:cle)?|Ter(?:race)?|Trl|Trail|Pkwy|Parkway|Hwy|Highway|Canyon|Cyn|Loop|Crest|Vista|View';
const NAME_TOKEN = "(?!(?:AM|PM|PST|PDT|UTC|GMT)\\b)(?:[A-Z][A-Za-z'’.-]*|\\d+(?:st|nd|rd|th))";
/** A house number followed by one to four capitalized name words and a street suffix. */
const ADDRESS = new RegExp(`(?<![:\\d])\\b(\\d{1,6})[A-Za-z]?\\s+(?:${NAME_TOKEN}\\s+){1,4}(?:${STREET_SUFFIX})\\b`, 'g');
const DATE_BEFORE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s*$/;

export function mentionsCause(text: string): boolean {
  return CAUSE_PATTERNS.some(p => p.test(text));
}

export function containsAddress(text: string): boolean {
  for (const m of text.matchAll(ADDRESS)) {
    // "Jan 8, 2025 Lake Avenue ..." is a date running into a street name, not an address.
    const isYear = /^(?:19|20)\d\d$/.test(m[1]);
    if (isYear && DATE_BEFORE.test(text.slice(Math.max(0, m.index - 16), m.index))) continue;
    return true;
  }
  return false;
}

export type Verified = {
  paragraphs: Paragraph[];
  dropped: {uncited: number; guardrail: number};
  /** Every cite id the model proposed, and the ones that no tool had returned. */
  audit: {proposed: number; invalid: number};
};

const INLINE_CITE = /\s*[[(]\s*(c\d+(?:\s*[,;]\s*c\d+)*)\s*[\])]/gi;

/**
 * Guardrails run first (cause or address → dropped.guardrail), then citations: only ids in the
 * registry survive, and a paragraph left with none is dropped (dropped.uncited).
 */
export function verifyAnswer(raw: unknown, registry: ReadonlyMap<string, Cite>): Verified {
  const out: Verified = {paragraphs: [], dropped: {uncited: 0, guardrail: 0}, audit: {proposed: 0, invalid: 0}};
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
    else out.paragraphs.push({text, cites});
  }
  return out;
}
