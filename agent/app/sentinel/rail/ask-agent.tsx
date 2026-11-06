import {useState} from 'react';
import {sendToAgentChat} from '@agent-native/core/client/agent-chat';
import type {FireData} from '../data/fire';
import {Button, Chip} from './ui';

/**
 * "Ask the agent" sub-tab. Replaces the Meta build's Analyst panel (POST /api/analyst): questions
 * now go to the Agent-Native agent in the sidebar, which sees the same screen (navigation +
 * selection app state) and answers with the same cited data actions.
 */
const SUGGESTIONS = [
  'Plan drone coverage for the next hour',
  'When did the fire reach Lake Ave?',
  'How many homes are within 500 m of the forecast front?',
  'Write the crew briefing for this plan'
];

function ask(message: string) {
  sendToAgentChat({message, submit: true, openSidebar: true});
}

export function AskAgent({fire}: {fire: FireData}) {
  const [q, setQ] = useState('');
  const send = () => {
    const question = q.trim();
    if (!question) return;
    setQ('');
    ask(question);
  };
  return (
    <div className="flex flex-col">
      <div className="flex justify-end px-3 pt-2">
        <Chip tone="modeled">AGENT</Chip>
      </div>
      <div className="px-3 pb-1 pt-1 text-sm text-se-muted">
        Ask about the {fire.aoi.name}: the agent sees the map time, tab and selection, and cites the data it uses.
      </div>
      <ul className="space-y-1.5 px-3 py-2">
        {SUGGESTIONS.map(s => (
          <li key={s}>
            <button
              type="button"
              onClick={() => ask(s)}
              className="w-full rounded-md bg-tabactive px-2.5 py-1.5 text-left text-sm shadow-[0_0_0_1px_var(--hairline)] hover:bg-selected"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex items-center gap-1.5 border-t border-hairline px-3 py-2"
        onSubmit={e => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Ask the agent…"
          maxLength={2000}
          className="min-w-0 flex-1 rounded-md bg-tabactive px-2 py-1 text-sm shadow-[0_0_0_1px_var(--hairline)] outline-hidden placeholder:text-se-muted"
        />
        <Button primary onClick={send} disabled={!q.trim()}>
          Ask
        </Button>
      </form>
      <div className="px-3 pb-2 text-2xs text-se-muted">Answers open in the agent panel · no cause is inferred</div>
    </div>
  );
}
