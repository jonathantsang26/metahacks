import {sendToAgentChat} from '@agent-native/core/client/agent-chat';
import {IconChevronRight, IconMapPin} from '@tabler/icons-react';
import {useQueryClient} from '@tanstack/react-query';
import {useEffect, useRef, useState, type ReactElement} from 'react';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';
import {act, errorText, FIRE_LABEL, fireTime, usePlanContext, usePlanData} from './data';
import {useGuideStep} from './GuideSteps';
import {requestFlyTo} from './store';
import type {BriefingCite, BriefingEvidence, BriefingParagraph} from './types';
import {Btn, ByChip, Card, PLAN_VARS, Spinner} from './ui';

export type BriefingPanelProps = {fire?: string | undefined; t?: string | undefined; className?: string | undefined};

export function askAgentToBrief(fire: string, t: string, planId: string) {
  sendToAgentChat({
    message:
      `Write the crew briefing for drone plan ${planId} on the ${FIRE_LABEL[fire] ?? fire} fire, hour from ${fireTime(t)} (fire=${fire}, t=${t}). ` +
      `Gather the facts with the data actions (fire-state-at, weather-at, get-forecast-front, structures-near at the watched points) and score-plan, ` +
      `then save it with save-briefing: 3 to 5 short paragraphs a crew lead can read aloud, every number cited to the action call it came from. ` +
      `Tell me if any paragraph was dropped by verification and why.`,
    submit: true,
    openSidebar: true
  });
}

/** A chip per source: what the cited action returned (evidence) when saved, else the action call itself. */
function chipsOf(p: BriefingParagraph): {key: string; name: string; label: string; lon: number | null; lat: number | null}[] {
  if (p.evidence.length) return p.evidence.map((e: BriefingEvidence, i) => ({key: `e${i}`, name: e.layer.replace(/[-_]/g, ' '), label: e.label || e.layer, lon: e.lon, lat: e.lat}));
  return p.cites.map((c: BriefingCite, i) => ({key: `c${i}`, name: c.action.replace(/-/g, ' '), label: c.label, lon: c.lon, lat: c.lat}));
}

function CiteChip({cite}: {cite: {name: string; label: string; lon: number | null; lat: number | null}}) {
  const place = cite.lon !== null && cite.lat !== null;
  const name = cite.name;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={place ? () => requestFlyTo(cite.lon!, cite.lat!) : undefined}
          className={`inline-flex max-w-[180px] items-center gap-0.5 rounded bg-[var(--pl-tab)] px-1.5 align-middle font-mono text-[10px] leading-[16px] text-[var(--pl-ink)] ${place ? 'cursor-pointer hover:bg-[var(--pl-selected)]' : 'cursor-default'}`}
          aria-label={`Source: ${cite.label}${place ? ' (show on map)' : ''}`}
        >
          {place && <IconMapPin size={10} className="shrink-0 text-[var(--pl-muted)]" />}
          <span className="truncate">{name}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-xs">
        {cite.label}
        {place ? ' · click to show on the map' : ''}
      </TooltipContent>
    </Tooltip>
  );
}

function Paragraph({p, index, briefingId, editable}: {p: BriefingParagraph; index: number; briefingId: string; editable: boolean}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();
  useEffect(() => {
    if (!editing) setDraft(p.text);
  }, [p.text, editing]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const save = async () => {
    const text = draft.trim();
    if (!text || text === p.text) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    setShown(text); // optimistic
    setEditing(false);
    try {
      await act('edit-briefing-paragraph', {briefingId, index, text}, 'POST');
      await qc.invalidateQueries({queryKey: ['action']});
    } catch (e) {
      setError(errorText(e));
      setDraft(text);
      setEditing(true);
    } finally {
      setShown(null);
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="px-3 py-2">
        <textarea
          ref={ref}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') setEditing(false);
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          }}
          rows={Math.min(8, Math.max(3, Math.ceil(draft.length / 48)))}
          aria-label={`Edit paragraph ${index + 1}`}
          className="w-full resize-y rounded border-0 bg-[var(--pl-tab-active)] p-2 text-[12px] leading-[17px] text-[var(--pl-ink)] shadow-[0_0_0_1px_var(--pl-hair)] outline-none focus:shadow-[0_0_0_1.5px_var(--pl-accent)]"
        />
        <div className="mt-1 flex items-center gap-1.5">
          <Btn primary onClick={() => void save()} disabled={saving}>
            Save
          </Btn>
          <Btn onClick={() => setEditing(false)}>Cancel</Btn>
          <span className="ml-auto text-[10px] text-[var(--pl-muted)]">Saved as edited by a person. ⌘↵ saves.</span>
        </div>
        {error && <p className="mt-1 text-[11px] text-[var(--pl-live)]">{error}</p>}
      </div>
    );
  }

  return (
    <div className="group border-t border-[var(--pl-hair)] px-3 py-2 first:border-t-0">
      <p
        className={`text-[12px] leading-[17px] ${editable ? 'cursor-text rounded hover:bg-[var(--pl-tab-active)]/70' : ''}`}
        onClick={editable ? () => setEditing(true) : undefined}
        onKeyDown={editable ? e => e.key === 'Enter' && setEditing(true) : undefined}
        tabIndex={editable ? 0 : undefined}
        role={editable ? 'button' : undefined}
        title={editable ? 'Click to edit' : undefined}
      >
        {shown ?? p.text}
        {saving && <Spinner className="ml-1 align-middle text-[var(--pl-muted)]" />}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {chipsOf(p).map(c => (
          <CiteChip key={c.key} cite={c} />
        ))}
      </div>
    </div>
  );
}

/** The saved crew briefing for the plan on screen, with cites, verification and inline edits. */
export function BriefingPanel(props: BriefingPanelProps = {}): ReactElement | null {
  const {fire, t} = usePlanContext(props);
  const data = usePlanData(fire, t);
  const step = useGuideStep({fire, t: t ?? undefined});
  if (!t || !data.plan) return null;
  const plan = data.plan;
  const b = data.briefing;
  const editable = plan.status !== 'approved';
  const write = () => askAgentToBrief(fire, plan.t || t, plan.id);

  if (!b || !b.paragraphs.length) {
    // Empty: one quiet row until writing the briefing is the current step (step 5, index 4).
    const now = step === 4 && editable;
    return (
      <section style={PLAN_VARS} className={`overflow-hidden rounded-md bg-[var(--pl-card)] text-[13px] leading-[18px] text-[var(--pl-ink)] shadow-[0_0_0_1px_var(--pl-hair)] ${props.className ?? ''}`}>
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <h2 className="min-w-0 text-[13px] font-semibold">
            Crew briefing <span className="font-normal text-[var(--pl-muted)]">· not written yet</span>
          </h2>
          {editable && (
            <Btn variant={now ? 'accent' : 'quiet'} className={now ? '' : '-mr-1.5'} onClick={write} title="Send the briefing request to the agent">
              Write with agent
              {!now && <IconChevronRight size={13} className="-mr-1" />}
            </Btn>
          )}
        </div>
        {now && <p className="border-t border-[var(--pl-hair)] px-3 py-2 text-[11px] leading-[15px] text-[var(--pl-muted)]">Every number is re-checked against its source before it is saved.</p>}
      </section>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Card
        title="Crew briefing"
        className={props.className}
        aside={
          <span className="flex items-center gap-1.5">
            <ByChip by={b.updatedBy} />
          </span>
        }
      >
        {b.paragraphs.map((p, i) => (
          <Paragraph key={i} p={p} index={i} briefingId={b.id} editable={editable && !!b.id} />
        ))}
        {b.droppedCount > 0 && (
          <div className="border-t border-[var(--pl-hair)] px-3 py-2 text-[11px] leading-[15px] text-[var(--pl-muted)]">
            {b.droppedCount} paragraph{b.droppedCount === 1 ? ' was' : 's were'} dropped because {b.droppedCount === 1 ? 'its numbers' : 'their numbers'} did not match the cited sources.
            {b.dropped
              .filter(d => d.reason || d.text)
              .slice(0, 3)
              .map((d, i) => (
                <div key={i} className="mt-0.5 truncate" title={d.text ?? undefined}>
                  · {d.reason ?? d.text}
                </div>
              ))}
          </div>
        )}
        {editable && (
          <div className="flex items-center justify-between gap-2 border-t border-[var(--pl-hair)] px-3 py-1.5">
            <span className="text-[11px] text-[var(--pl-muted)]">Click a paragraph to edit it.</span>
            <Btn variant="quiet" className="-mr-1.5" onClick={write} title="Ask the agent to rewrite the briefing">
              Rewrite <IconChevronRight size={13} className="-mr-1" />
            </Btn>
          </div>
        )}
      </Card>
    </TooltipProvider>
  );
}
