import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam
} from 'openai/resources/chat/completions';
import type {Aoi, FireStore} from './data.js';
import {createToolRunner, DATA_TOOLS, FINAL_ANSWER_TOOL} from './tools.js';
import type {AnalystRequest, AnalystResponse, Mode} from './types.js';
import {verifyAnswer} from './verify.js';

/** The analyst's tool loop. The chat client is injected so the loop can be unit-tested. */

export const DEFAULT_MODEL = 'muse-spark-1.3';
export const MAX_ROUNDS = 8;

export type ChatRequest = Pick<ChatCompletionCreateParamsNonStreaming, 'model' | 'messages' | 'tools' | 'tool_choice'>;
type ToolCallLike = {id: string; type: string; function?: {name: string; arguments: string}};
export type ChatReply = {choices: {message: {content: string | null; tool_calls?: ToolCallLike[] | null}}[]};
export type ChatClient = {create(req: ChatRequest): Promise<ChatReply>};

export type AnalystRun = {
  response: AnalystResponse;
  audit: {rounds: number; proposed_cite_ids: number; invalid_cite_ids: number; final_answer: boolean};
};

function systemPrompt(aoi: Aoi, mode: Mode): string {
  const rules = `You are the analyst for Sentinel Ember, a forensic replay of the ${aoi.name} (${aoi.location}). You answer only from the tools, which read precomputed data layers for this fire.

Times: tools take UTC ISO-8601 (e.g. 2025-01-08T06:00:00Z) and return each time in UTC (t) and local ${aoi.timezone} time (t_local, with its zone label). Write local times with the zone label, e.g. "6:18 PM PST on Jan 7"; add the UTC time when the user asks for it. The data window is ${aoi.window_utc[0]} to ${aoi.window_utc[1]}.

Hard rules. The server deletes any paragraph that breaks them:
1. Never state, suggest or speculate about what started the fire or who or what is responsible. Do not use the words "cause", "caused" or "causes" at all, and never mention arson, power lines, utilities, utility equipment or any company. If asked how the fire began, say this analysis covers when and where it spread, not how it began, and offer the reported start and the model ignition estimate instead.
2. Never write a street address or house number, and never single out an individual home. Talk about streets, neighborhoods and counts.
3. Use only facts the tools returned. When the tools return nothing relevant, say "The data doesn't show ..." and cite the tool result that came back empty.
4. ignition_summary is a statistical model estimate, not an investigated origin. Say so whenever you use it.
5. exposure_stats are associations in observational data, not effects of a feature. Say so whenever you use them.
6. Arrival times are interpolated between observed perimeters and are approximate (about half-hour resolution).

Method: resolve place names with place_lookup first, then use street_fire_timeline, arrival_at, fire_state_at, weather_at, structures_near, events, ignition_summary or exposure_stats as needed. Every tool result lists cites with ids like "c3".

Finish by calling final_answer exactly once, on its own. Each paragraph is {text, cite_ids}; cite_ids are the ids of the cites, from tool results you received, that support that paragraph. A paragraph without a valid cite id is deleted. Do not write cite ids in the text and do not answer in plain text.`;
  if (mode === 'report') {
    return `${rules}

Task: draft the incident report. Call events, ignition_summary, fire_state_at and weather_at at the key times, structures_near where damage concentrated, and exposure_stats. Write 4 to 7 paragraphs of one or two sentences each, in time order: reported start, early spread and the wind, peak growth, the model ignition estimate with its hold-out error, structure damage, and house-level associations. Every sentence must be supported by its paragraph's cites.`;
  }
  return `${rules}

Keep answers short: one to three paragraphs of one to three sentences.`;
}

const NUDGE = 'Call final_answer now with your paragraphs and their cite_ids. Do not reply in plain text.';

function isFunctionCall(c: ToolCallLike): c is ToolCallLike & {function: {name: string; arguments: string}} {
  return c.type === 'function' && !!c.function;
}

function errorStatus(e: unknown): number | undefined {
  const status = (e as {status?: unknown})?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Asks for final_answer by name; if the API rejects a named tool_choice, falls back to "auto". */
async function forceFinal(chat: ChatClient, base: Omit<ChatRequest, 'tools' | 'tool_choice'>): Promise<ChatReply> {
  const tools = [FINAL_ANSWER_TOOL];
  try {
    return await chat.create({...base, tools, tool_choice: {type: 'function', function: {name: 'final_answer'}}});
  } catch (e) {
    const status = errorStatus(e);
    if (status === undefined || status < 400 || status >= 500 || status === 401 || status === 403) throw e;
    return chat.create({...base, tools, tool_choice: 'auto'});
  }
}

export async function runAnalyst(
  req: AnalystRequest,
  deps: {chat: ChatClient; store: FireStore; model?: string; maxRounds?: number; deadline?: number}
): Promise<AnalystRun> {
  const model = deps.model ?? DEFAULT_MODEL;
  const maxRounds = deps.maxRounds ?? MAX_ROUNDS;
  const tools = createToolRunner(deps.store);
  const messages: ChatCompletionMessageParam[] = [
    {role: 'system', content: systemPrompt(deps.store.aoi(), req.mode)},
    ...req.history.map(h => ({role: h.role, content: h.content})),
    {role: 'user', content: req.question}
  ];
  const toolCalls: AnalystResponse['tool_calls'] = [];
  let forced = false;

  let rounds = 0;
  while (rounds < maxRounds) {
    const round = ++rounds;
    // Past the deadline (or on the last round) the model gets one call that must be final_answer.
    const lastChance = round === maxRounds || (deps.deadline !== undefined && Date.now() >= deps.deadline);
    const base = {model, messages};
    const reply = forced || lastChance ? await forceFinal(deps.chat, base) : await deps.chat.create({...base, tools: [...DATA_TOOLS, FINAL_ANSWER_TOOL], tool_choice: 'auto'});
    const msg = reply.choices[0]?.message;
    const calls = (msg?.tool_calls ?? []).filter(isFunctionCall);

    if (!calls.length) {
      if (lastChance) break;
      messages.push({role: 'assistant', content: msg?.content ?? ''}, {role: 'user', content: NUDGE});
      forced = true;
      continue;
    }

    const final = calls.find(c => c.function.name === 'final_answer');
    if (final) {
      let parsed: {paragraphs?: unknown} | null = null;
      try {
        parsed = JSON.parse(final.function.arguments || '{}');
      } catch {
        parsed = null;
      }
      if (parsed && Array.isArray(parsed.paragraphs)) {
        // Verified against cites registered before this message: tools called alongside
        // final_answer are not run, so their cites can't be claimed.
        const v = verifyAnswer(parsed.paragraphs, tools.registry);
        const removed = v.dropped.uncited + v.dropped.guardrail;
        const note = !v.paragraphs.length && removed ? `All ${removed} paragraphs were removed by the citation and guardrail checks.` : undefined;
        return {
          response: {paragraphs: v.paragraphs, tool_calls: toolCalls, dropped: v.dropped, model, ...(note ? {note} : {})},
          audit: {rounds: round, proposed_cite_ids: v.audit.proposed, invalid_cite_ids: v.audit.invalid, final_answer: true}
        };
      }
    }

    messages.push({role: 'assistant', content: msg?.content ?? null, tool_calls: calls.map(toParam)});
    for (const call of calls) {
      let content: string;
      if (call.function.name === 'final_answer') {
        content = JSON.stringify({error: 'final_answer needs {"paragraphs": [{"text": "...", "cite_ids": ["c1"]}]} as valid JSON.'});
        forced = true;
      } else {
        const out = tools.run(call.function.name, call.function.arguments ?? '');
        toolCalls.push({name: call.function.name, args: out.args});
        content = out.content;
      }
      messages.push({role: 'tool', tool_call_id: call.id, content});
    }
    if (lastChance) break;
  }

  return {
    response: {
      paragraphs: [],
      tool_calls: toolCalls,
      dropped: {uncited: 0, guardrail: 0},
      model,
      note: `The model did not return a final answer within ${rounds} rounds, so there is nothing verified to show.`
    },
    audit: {rounds, proposed_cite_ids: 0, invalid_cite_ids: 0, final_answer: false}
  };
}

function toParam(c: ToolCallLike & {function: {name: string; arguments: string}}): ChatCompletionMessageFunctionToolCall {
  return {id: c.id, type: 'function', function: {name: c.function.name, arguments: c.function.arguments ?? ''}};
}
