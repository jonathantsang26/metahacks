import {useEffect, useMemo, useRef, useState} from 'react';
import {create} from 'zustand';
import type {FireData} from '../data/fire';
import {useFireJson, type FireEvent} from '../data/files';
import {formatDate} from '../lib/format';
import {useTime} from '../state/time';
import {useUi, type Highlight} from '../state/ui';
import {Icon} from '../ui/Icon';
import {chipTime, stamp} from './fmt';
import {Button, Chip} from './ui';

/**
 * Mirrors web/api/_lib/types.ts (POST /api/analyst); kept local because api/ is a separate TS project.
 * `date_only` is not sent yet; it is honored if the server adds it.
 */
type Cite = {id: string; layer: string; t?: string; lon?: number; lat?: number; label: string; date_only?: boolean};
type Paragraph = {text: string; cites: Cite[]};
type Mode = 'answer' | 'report';
type AnalystResponse = {
  paragraphs: Paragraph[];
  tool_calls: {name: string; args: unknown}[];
  dropped: {uncited: number; guardrail: number; ungrounded: number};
  model: string;
  note?: string;
};
type HistoryTurn = {role: 'user' | 'assistant'; content: string};

type Turn = {question: string; mode: Mode; response?: AnalystResponse; error?: string};

/** The server needs a question; in report mode its system prompt carries the actual task. */
const REPORT_QUESTION = 'Draft the incident report.';

const plain = (r: AnalystResponse) => r.paragraphs.map(p => p.text).join('\n\n');

/**
 * Chat state lives outside the component so switching sub-tabs or header tabs keeps the
 * conversation, and an answer that lands while the panel is hidden still arrives.
 */
const useAnalyst = create<{
  fire: string | null;
  turns: Turn[];
  pending: boolean;
  ask: (fire: string, question: string, mode: Mode) => Promise<void>;
}>((set, get) => ({
  fire: null,
  turns: [],
  pending: false,
  ask: async (fire, question, mode) => {
    if (get().pending) return;
    const prior = get().fire === fire ? get().turns : [];
    // Only answered turns go back as history: {role, content} with the answer's plain text.
    const history: HistoryTurn[] = prior.flatMap(t =>
      t.response?.paragraphs.length
        ? [
            {role: 'user' as const, content: t.question},
            {role: 'assistant' as const, content: plain(t.response)}
          ]
        : []
    );
    const index = prior.length;
    set({fire, turns: [...prior, {question, mode}], pending: true});
    const settle = (patch: Partial<Turn>) =>
      set(s => ({pending: false, turns: s.turns.map((t, i) => (i === index ? {...t, ...patch} : t))}));
    try {
      const r = await fetch('/api/analyst', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({question, fire, history, mode})
      });
      const body = (await r.json().catch(() => null)) as (AnalystResponse & {error?: string}) | null;
      if (!r.ok || !body || body.error || !Array.isArray(body.paragraphs)) {
        settle({error: body?.error ?? `The analyst returned HTTP ${r.status}.`});
      } else settle({response: body});
    } catch (e) {
      settle({error: `Could not reach /api/analyst: ${(e as Error).message}`});
    }
  }
}));

const LAYER_ICON: Record<string, string> = {
  series: 'chart',
  exposure_stats: 'chart',
  weather: 'chart',
  events: 'calendar'
};

/**
 * DESIGN.md §9: a chip per cite. Hovering marks the cited place on the map; click sets t (inside the
 * window) and eases the camera there. A date-only event (containment) has a date but no clock time:
 * its t is a placeholder noon, so the chip shows the date alone and never moves the scrubber to it.
 */
function CiteChip({cite, tz, dateOnly}: {cite: Cite; tz: string; dateOnly: Set<string>}) {
  const requestFlyTo = useUi(s => s.requestFlyTo);
  const setHighlight = useUi(s => s.setHighlight);
  // The highlight this chip set, so leaving or unmounting clears only its own, never another's.
  const mine = useRef<Highlight>(null);
  const unmark = () => {
    if (mine.current && useUi.getState().highlight === mine.current) setHighlight(null);
    mine.current = null;
  };
  // On unmount (sub-tab switch, new fire) a chip under the pointer leaves its mark behind otherwise.
  useEffect(() => unmark, []);
  const ms = cite.t ? Date.parse(cite.t) : NaN;
  const hasTime = Number.isFinite(ms);
  const dayOnly = hasTime && (cite.date_only === true || (cite.layer === 'events' && dateOnly.has(cite.t!)));
  const hasPlace = Number.isFinite(cite.lon) && Number.isFinite(cite.lat);
  const when = dayOnly ? formatDate(ms, tz) : hasTime ? chipTime(ms, tz) : '';
  const label = hasTime ? `${cite.layer.replace(/_/g, ' ').toUpperCase()} · ${when}` : cite.label;
  const go = () => {
    const {start, end, setTime} = useTime.getState();
    if (hasTime && !dayOnly && ms >= start && ms <= end) setTime(ms);
    if (hasPlace) requestFlyTo(cite.lon!, cite.lat!);
  };
  const mark = () => {
    if (!hasPlace) return;
    mine.current = {lon: cite.lon!, lat: cite.lat!, label: cite.label};
    setHighlight(mine.current);
  };
  return (
    <button
      onClick={go}
      onMouseEnter={mark}
      onMouseLeave={unmark}
      onFocus={mark}
      onBlur={unmark}
      disabled={(!hasTime || dayOnly) && !hasPlace}
      title={cite.label + (hasTime ? ` · ${dayOnly ? `${when} (date only)` : stamp(ms, tz)}` : '')}
      className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded bg-selected px-1.5 align-baseline font-mono text-2xs tracking-wide text-ink disabled:cursor-default"
    >
      <Icon name={LAYER_ICON[cite.layer] ?? 'map'} size={10} className="shrink-0 text-muted" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function Answer({turn, tz, dateOnly}: {turn: Turn; tz: string; dateOnly: Set<string>}) {
  const [copied, setCopied] = useState(false);
  const r = turn.response;
  if (turn.error) {
    return <div className="rounded-md bg-tabactive px-2.5 py-2 text-sm shadow-[0_0_0_1px_var(--hairline)]">{turn.error}</div>;
  }
  if (!r) return <div className="px-1 text-sm text-muted">Working…</div>;
  const copy = async () => {
    // The copied report keeps each paragraph's sources as bracketed cite labels.
    const text = r.paragraphs.map(p => `${p.text} [${p.cites.map(c => c.label).join('; ')}]`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="rounded-md bg-tabactive px-2.5 py-2 shadow-[0_0_0_1px_var(--hairline)]">
      {turn.mode === 'report' && r.paragraphs.length > 0 && (
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold">Incident report (draft)</span>
          <button onClick={copy} className="text-xs text-muted underline decoration-hairline">
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <div className="space-y-1.5">
        {r.paragraphs.map((p, i) => (
          <p key={i} className="text-sm leading-[19px]">
            {p.text}{' '}
            {p.cites.map(c => (
              <CiteChip key={c.id} cite={c} tz={tz} dateOnly={dateOnly} />
            ))}
          </p>
        ))}
      </div>
      {r.note && <div className="mt-1.5 text-xs text-muted">{r.note}</div>}
      <div className="mt-1.5 text-2xs text-muted">
        {r.tool_calls.length} tool call{r.tool_calls.length === 1 ? '' : 's'} · dropped {r.dropped.uncited} uncited,{' '}
        {r.dropped.guardrail} guardrail, {r.dropped.ungrounded} ungrounded
      </div>
    </div>
  );
}

/** Analyst sub-tab: the Muse Spark analyst (DESIGN.md §9). Answers come only from the server; nothing is canned. */
export function Analyst({fire}: {fire: FireData}) {
  const {turns: all, pending, ask, fire: chatFire} = useAnalyst();
  const turns = chatFire === fire.id ? all : [];
  const [q, setQ] = useState('');
  const tz = fire.aoi.timezone;
  // The analyst's event cites carry events.json's t verbatim, so date-only events are matched on it.
  const {data: events} = useFireJson<FireEvent[]>(fire, 'events.json');
  const dateOnly = useMemo(() => new Set((events ?? []).filter(e => e.date_only).map(e => e.t)), [events]);
  const send = (mode: Mode) => {
    const question = mode === 'report' ? REPORT_QUESTION : q.trim();
    if (!question || pending) return;
    if (mode === 'answer') setQ('');
    void ask(fire.id, question, mode);
  };
  return (
    <div className="flex flex-col">
      <div className="flex justify-end px-3 pt-2">
        <Chip tone="modeled">MUSE SPARK</Chip>
      </div>
      <div className="space-y-2 px-3 py-2">
        {turns.length === 0 && (
          <div className="py-3 text-center text-sm text-muted">
            Ask about when and where the fire spread, the weather it burned in, or the damage it left.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-1">
            <div className="text-right">
              <span className="inline-block max-w-[90%] rounded-md bg-section px-2 py-1 text-left text-sm">
                {t.mode === 'report' ? 'Report' : t.question}
              </span>
            </div>
            <Answer turn={t} tz={tz} dateOnly={dateOnly} />
          </div>
        ))}
      </div>
      <form
        className="flex items-center gap-1.5 border-t border-hairline px-3 py-2"
        onSubmit={e => {
          e.preventDefault();
          send('answer');
        }}
      >
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Ask the analyst…"
          disabled={pending}
          maxLength={2000}
          className="min-w-0 flex-1 rounded-md bg-tabactive px-2 py-1 text-sm shadow-[0_0_0_1px_var(--hairline)] outline-none placeholder:text-muted disabled:opacity-60"
        />
        <Button primary onClick={() => send('answer')} disabled={pending || !q.trim()}>
          Ask
        </Button>
        <Button onClick={() => send('report')} disabled={pending} title="Draft a cited incident report">
          Report
        </Button>
      </form>
      <div className="px-3 pb-2 text-2xs text-muted">Muse Spark · answers cite their sources · no cause is inferred</div>
    </div>
  );
}
