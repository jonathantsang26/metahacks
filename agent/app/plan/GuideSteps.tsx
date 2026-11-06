import {IconCheck, IconChevronDown, IconChevronUp, IconX} from '@tabler/icons-react';
import {useEffect, useState, type ReactElement} from 'react';
import {addHours, usePlanContext, usePlanData} from './data';
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

const STEPS: {title: string; hint: string; body: string}[] = [
  {title: 'Pick the hour', hint: 'Drag the timeline to the hour you want to plan', body: 'Drag the timeline to the hour you want to plan. The dashed line is the cached forecast front for the next hour.'},
  {title: 'Ask the agent to plan', hint: 'Press "Ask agent to plan" in the Plan card', body: 'Press "Ask agent to plan" (or type it in the chat). It places up to six drones on the front and scores the plan.'},
  {title: 'Drag a drone', hint: 'Drag a marker on the map to a better spot', body: 'Drag a marker on the map to a better spot. The score updates when you drop it, and the agent sees your change.'},
  {title: 'Click a drone, ask the agent', hint: 'Select a drone, then ask the agent to change it', body: 'Select a drone, then ask the agent to change it, e.g. "move D3 north toward the homes".'},
  {title: 'Write the briefing', hint: 'Press "Write with agent" under the plan', body: 'Ask the agent to write the crew briefing. Every number is checked against its source; click a paragraph to edit it.'},
  {title: 'Approve & next hour', hint: 'Approve the plan; the clock moves on', body: 'Approve the plan. The clock moves on and the hindsight check shows how much of the real fire the drones watched.'}
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
  if (before.plan?.status === 'approved' && !here.plan) return 1; // just approved: plan the next hour
  if (!t) return 0;
  const plan = here.plan;
  if (!plan) return 1;
  if (plan.status === 'approved') return 5;
  const personMoved = moved || here.assignments.some(a => a.updatedBy === 'person');
  if (!personMoved) return 2;
  if (!asked) return 3;
  if (!here.briefing?.paragraphs.length) return 4;
  return 5;
}

/**
 * A dismissible one-line step strip: the current step's number, title and a short hint, with the
 * full list behind "Steps ▾". The host positions it (top-centre of the map); it only sizes itself.
 */
export function GuideSteps(props: GuideStepsProps = {}): ReactElement | null {
  // Read storage after mount so server and client render the same thing first.
  const [dismissed, setDismissed] = useState(true);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setDismissed(readDismissed()), []);
  const step = useGuideStep(props);
  if (dismissed && !props.open) return null;
  const close = () => {
    writeDismissed();
    setDismissed(true);
    setExpanded(false);
    props.onClose?.();
  };
  const current = STEPS[step] ?? STEPS[0]!;
  return (
    <section style={PLAN_VARS} aria-label="Guide" className={`pointer-events-auto flex w-max max-w-[min(600px,100%)] flex-col items-center text-[#f2efe6] ${props.className ?? ''}`}>
      <div className="flex h-[34px] max-w-full items-center gap-2.5 rounded-lg bg-[var(--pl-hud)] pl-2 pr-1.5 text-[12px] leading-[16px] shadow-lg backdrop-blur-sm">
        <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--pl-accent)] text-[10px] font-semibold tabular-nums text-white">{step + 1}</span>
        <span className="shrink-0 whitespace-nowrap font-semibold text-white" aria-current="step">
          {current.title}
        </span>
        <span className="min-w-0 truncate text-white/70" title={current.body}>
          {current.hint}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded px-1 py-0.5 text-[11px] tabular-nums text-white/60 hover:bg-white/10 hover:text-white"
        >
          {step + 1} / {STEPS.length} · Steps {expanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
        </button>
        <button type="button" onClick={close} aria-label="Dismiss the guide" className="shrink-0 rounded p-0.5 text-white/55 hover:bg-white/10 hover:text-white">
          <IconX size={14} />
        </button>
      </div>
      {expanded && (
        <ol className="mt-1.5 w-[320px] max-w-full space-y-0.5 rounded-lg bg-[var(--pl-hud)] p-1.5 text-[12px] leading-[16px] shadow-lg backdrop-blur-sm">
          {STEPS.map((s, i) => {
            const done = i < step;
            const now = i === step;
            return (
              <li key={s.title} aria-current={now ? 'step' : undefined} className={`flex gap-2 rounded-md px-1.5 py-1 ${now ? 'bg-white/10' : ''}`}>
                <span
                  className={`mt-px inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums ${
                    now ? 'bg-[var(--pl-accent)] text-white' : done ? 'bg-white/20 text-white/80' : 'bg-white/10 text-white/50'
                  }`}
                >
                  {done ? <IconCheck size={11} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className={`block ${now ? 'font-semibold text-white' : done ? 'text-white/60' : 'text-white/75'}`}>{s.title}</span>
                  {now && <span className="block pt-0.5 text-[11px] leading-[15px] text-white/70">{s.body}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
