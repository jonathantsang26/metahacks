import {IconX} from '@tabler/icons-react';
import {useEffect, useState, type ReactElement} from 'react';
import {addHours, FIRE_LABEL, usePlanContext, usePlanData} from './data';
import {usePlanUi} from './store';
import {PLAN_VARS} from './ui';

export type GuideStepsProps = {
  fire?: string | undefined;
  t?: string | undefined;
  className?: string | undefined;
  /** Show even after dismissal (e.g. a "Guide" button). */
  open?: boolean | undefined;
  onClose?: (() => void) | undefined;
};

const KEY = 'sentinel-ember:guide-dismissed:v1';

const STEPS: {title: string; body: string}[] = [
  {title: 'Pick the hour', body: 'Drag the timeline to the hour you want to plan. The dashed line is the cached forecast front for the next hour.'},
  {title: 'Ask the agent to plan', body: 'Press "Ask agent to plan" (or type it in the chat). It places up to six drones on the front and scores the plan.'},
  {title: 'Drag a drone', body: 'Drag a marker on the map to a better spot. The score updates when you drop it, and the agent sees your change.'},
  {title: 'Click a drone, ask the agent', body: 'Select a drone, then ask the agent to change it, e.g. "move D3 north toward the homes".'},
  {title: 'Write the briefing', body: 'Ask the agent to write the crew briefing. Every number is checked against its source; click a paragraph to edit it.'},
  {title: 'Approve & next hour', body: 'Approve the plan. The clock moves on and the hindsight check shows how much of the real fire the drones watched.'}
];

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    window.localStorage.setItem(KEY, '1');
  } catch {
    /* private window: dismissal lasts until reload */
  }
}

/** Index (0-based) of the step the viewer is on, from the plan state. */
export function useGuideStep(props: {fire?: string | undefined; t?: string | undefined} = {}): number {
  const {fire, t} = usePlanContext(props);
  const here = usePlanData(fire, t);
  const before = usePlanData(fire, t ? addHours(t, -1) : null);
  const moved = usePlanUi(s => s.movedByHand);
  const asked = usePlanUi(s => s.askedAboutDrone);
  const selected = usePlanUi(s => s.selected);
  if (before.plan?.status === 'approved' && !here.plan) return 5; // just approved: on the next hour
  if (!t) return 0;
  const plan = here.plan;
  if (!plan) return 1;
  if (plan.status === 'approved') return 5;
  const personMoved = moved || here.assignments.some(a => a.updatedBy === 'person');
  if (!personMoved) return 2;
  if (!asked && !(selected && here.briefing)) return 3;
  if (!here.briefing?.paragraphs.length) return 4;
  return 5;
}

/** A dismissible numbered "Start here" card for first-time viewers. */
export function GuideSteps(props: GuideStepsProps = {}): ReactElement | null {
  // Read storage after mount so server and client render the same thing first.
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => setDismissed(readDismissed()), []);
  const step = useGuideStep(props);
  const {fire} = usePlanContext(props);
  if (dismissed && !props.open) return null;
  const close = () => {
    writeDismissed();
    setDismissed(true);
    props.onClose?.();
  };
  return (
    <section
      style={PLAN_VARS}
      aria-label="Start here"
      className={`w-[300px] rounded-lg bg-[var(--pl-hud)] p-3 text-[12px] leading-[16px] text-[#f2efe6] shadow-lg backdrop-blur-sm ${props.className ?? ''}`}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#f2efe6]/70">Start here</h2>
        <button type="button" onClick={close} aria-label="Dismiss the guide" className="rounded p-0.5 text-[#f2efe6]/60 hover:text-white">
          <IconX size={14} />
        </button>
      </div>
      <p className="mt-1 text-[12px] text-[#f2efe6]/80">Plan the next hour of drone coverage on a replay of the {FIRE_LABEL[fire] ?? fire} Fire, with the agent.</p>
      <ol className="mt-2 space-y-1">
        {STEPS.map((s, i) => {
          const done = i < step;
          const current = i === step;
          return (
            <li key={s.title} aria-current={current ? 'step' : undefined} className={`flex gap-2 rounded-md px-1.5 py-1 ${current ? 'bg-white/10' : ''}`}>
              <span
                className={`mt-px inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums ${
                  current ? 'bg-[var(--pl-accent)] text-white' : done ? 'bg-white/20 text-white/80' : 'bg-white/10 text-white/50'
                }`}
              >
                {done ? '✓' : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`block font-medium ${current ? 'text-white' : done ? 'text-white/60' : 'text-white/75'}`}>{s.title}</span>
                {current && <span className="block pt-0.5 text-[11px] leading-[15px] text-white/75">{s.body}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mt-2 flex items-center justify-between text-[10px] text-white/50">
        <span>Replay of a past fire · no drone flies</span>
        <button type="button" onClick={close} className="rounded px-1.5 py-0.5 text-[11px] font-medium text-white/80 hover:bg-white/10">
          Got it
        </button>
      </div>
    </section>
  );
}
