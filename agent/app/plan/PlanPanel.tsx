import {sendToAgentChat} from '@agent-native/core/client/agent-chat';
import {IconArrowsMove, IconChevronRight, IconLock, IconLockOpen, IconMessage, IconPlus, IconX} from '@tabler/icons-react';
import {useQueryClient} from '@tanstack/react-query';
import {useState, type ReactElement} from 'react';
import {useSearchParams} from 'react-router';
import {act, errorText, FIRE_LABEL, fireTime, freeSpotOnFront, MAX_DRONES, nextDroneId, useForecastFront, usePlanContext, usePlanData, useSelectionGuard, useUpdateDrone} from './data';
import {selectPlanDrone, setPlanError, usePlanUi} from './store';
import type {Assignment, LonLat, Score} from './types';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';
import {useGuideStep} from './GuideSteps';
import {Btn, ByWord, Card, Chip, Label, Spinner} from './ui';

export type PlanPanelProps = {
  /** Defaults to the `fire` URL param. */
  fire?: string | undefined;
  /** Defaults to the `t` URL param (ISO UTC). */
  t?: string | undefined;
  /** Where "Add drone" puts a drone; without it the drone goes to the free-est spot on the front. */
  getMapCenter?: (() => LonLat | null) | undefined;
  /** Called with the next hour after "Approve & next hour" (approve-plan also writes a set-time map-command). */
  onTimeChange?: ((t: string) => void) | undefined;
  className?: string | undefined;
};

const fmtKm = (km: number | null) => (km === null ? '–' : km < 10 ? km.toFixed(1) : Math.round(km).toString());
const fmtInt = (n: number | null) => (n === null ? '–' : Math.round(n).toLocaleString('en-US'));

export function askAgentToPlan(fire: string, t: string, locked: Assignment[] = []) {
  const name = FIRE_LABEL[fire] ?? fire;
  const keep = locked.length ? ` Keep the locked drones (${locked.map(a => a.droneId).join(', ')}) where they are.` : '';
  sendToAgentChat({
    message:
      `Plan the next hour of drone coverage on the ${name} fire for the hour starting ${fireTime(t)} (fire=${fire}, t=${t}). ` +
      `Read the +1 h forecast front with get-forecast-front, then place up to ${MAX_DRONES} watch points (D1–D${MAX_DRONES}) along the advancing edge and near homes with create-drone-plan, giving each drone a one-line reason.${keep} ` +
      `Then check score-plan and tell me the front coverage, any grounded drones and why, and the weakest stretch of front.`,
    submit: true,
    openSidebar: true
  });
}

export function askAgentAboutDrone(planId: string, a: Assignment) {
  usePlanUi.setState({askedAboutDrone: true});
  sendToAgentChat({
    message: `Change ${a.droneId} (plan ${planId}, now at ${a.lon.toFixed(4)}, ${a.lat.toFixed(4)}): `,
    context: `Selected drone ${a.droneId} in plan ${planId}. Reason: ${a.reason || 'none given'}. Radius ${Math.round(a.radiusM)} m.${a.locked ? ' Locked.' : ''}${a.grounded ? ` Grounded${a.groundedReason ? `: ${a.groundedReason}` : ''}.` : ''} Edit it with update-drone-assignment.`,
    contextLabel: `Drone ${a.droneId}`,
    submit: false,
    openSidebar: true
  });
}

const METHOD_LABEL: Record<string, string> = {muse: 'Muse Spark forecast', physics: 'physics forecast'};

function ScoreBlock({score, method}: {score: Score | null; method: string | null}) {
  if (!score) {
    return <div className="px-3 py-3 text-[12px] text-[var(--pl-muted)]">Scoring the plan…</div>;
  }
  const pct = score.frontCoveragePct;
  const methodText = method ? METHOD_LABEL[method] ?? method : 'forecast';
  return (
    <div className="px-3 pb-2.5 pt-3">
      <div className="flex items-center gap-2.5">
        <div className="text-[28px] font-semibold leading-none tracking-[-0.01em] tabular-nums">{pct === null ? '–' : `${Math.round(pct)}%`}</div>
        <div className="min-w-0 text-[12px] leading-[15px]">
          of the forecast front watched
          <div className="tabular-nums text-[var(--pl-muted)]">
            {fmtKm(score.coveredKm)} of {fmtKm(score.frontKm)} km
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 text-[12px] leading-[16px] text-[var(--pl-muted)]">
        <span className="tabular-nums">
          <span className="font-semibold text-[var(--pl-ink)]">{fmtInt(score.homesWatched)}</span> of {fmtInt(score.homesNearFront)} homes
        </span>
        <span className="tabular-nums">
          <span className={`font-semibold ${score.groundedCount ? 'text-[var(--pl-live)]' : 'text-[var(--pl-ink)]'}`}>{fmtInt(score.groundedCount)}</span> grounded by wind
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="whitespace-nowrap rounded px-0.5 text-[11px] leading-[16px] text-[var(--pl-muted)] hover:text-[var(--pl-ink)] focus-visible:outline-2 focus-visible:outline-[var(--pl-accent)]">
                How it&apos;s scored ›
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="max-w-[280px] space-y-1.5 text-xs leading-[16px]">
              <p>
                <b>Front watched:</b> the share of the +1 h {methodText} front that lies inside a drone&apos;s view circle.
              </p>
              <p>
                <b>Homes:</b> homes near the front that sit inside a drone footprint.
              </p>
              <p>
                <b>Grounded:</b> gusts at flight height over the 12 m/s limit (shaded cells on the map); a grounded drone covers nothing.
              </p>
              <p className="opacity-80">{score.label ?? 'A geometric estimate on the saved forecast. This is a replay; the drones are a plan.'}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

const ICON_BTN = 'rounded p-1 text-[var(--pl-muted)] hover:bg-[var(--pl-tab-active)] hover:text-[var(--pl-ink)] focus-visible:outline-2 focus-visible:outline-[var(--pl-accent)]';

function DroneRow({a, planId, selected, armed, approved, accent}: {a: Assignment; planId: string; selected: boolean; armed: boolean; approved: boolean; accent: boolean}) {
  const update = useUpdateDrone();
  // Clicking the selected drone keeps it selected (a drag already selects, and the follow-up click
  // must not drop the agent's selection); Esc or a click on empty map clears it.
  const select = () => selectPlanDrone(planId, a, {fly: !selected});
  const groundedText = a.grounded ? (a.gustMs !== null ? `grounded, gust ${a.gustMs.toFixed(1)} m/s` : 'grounded') : null;
  const controls = !approved && (
    <span className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        title={armed ? 'Click the map to place it (Esc to cancel)' : `Move ${a.droneId}: drag its marker, or press this then click the map`}
        aria-label={`Move ${a.droneId}`}
        aria-pressed={armed}
        onClick={() => usePlanUi.setState({moveArmed: armed ? null : a.droneId})}
        className={armed ? 'rounded bg-[var(--pl-ink)] p-1 text-white' : ICON_BTN}
      >
        <IconArrowsMove size={13} />
      </button>
      <button
        type="button"
        title={a.locked ? `Unlock ${a.droneId} (the agent may move it)` : `Lock ${a.droneId} (the agent keeps it when re-planning)`}
        aria-label={a.locked ? `Unlock ${a.droneId}` : `Lock ${a.droneId}`}
        aria-pressed={a.locked}
        onClick={() => void update({planId, droneId: a.droneId, locked: !a.locked}, {locked: !a.locked})}
        className={`${ICON_BTN} ${a.locked ? 'text-[var(--pl-ink)]' : ''}`}
      >
        {a.locked ? <IconLock size={13} /> : <IconLockOpen size={13} />}
      </button>
      <button
        type="button"
        title={`Remove ${a.droneId}`}
        aria-label={`Remove ${a.droneId}`}
        onClick={() => {
          if (selected) selectPlanDrone(null, null);
          void update({planId, droneId: a.droneId, remove: true}, {removed: true});
        }}
        className={`${ICON_BTN} hover:text-[var(--pl-live)]`}
      >
        <IconX size={13} />
      </button>
    </span>
  );
  const marker = a.locked ? (
    <IconLock size={12} className="shrink-0 text-[var(--pl-muted)]" aria-label="Locked" />
  ) : (
    <ByWord by={a.updatedBy} />
  );
  // An unselected row shows one quiet marker; hover or keyboard focus swaps it for the controls.
  return (
    <li className={`group border-t border-[var(--pl-hair)] ${selected ? 'bg-[var(--pl-selected)]' : 'hover:bg-[var(--pl-tab-active)]/50'}`} aria-selected={selected}>
      <div className={`flex min-h-[30px] gap-2 px-3 ${selected ? 'items-start py-1.5' : 'items-center'}`}>
        <button
          type="button"
          onClick={select}
          className={`flex min-h-[18px] min-w-0 flex-1 gap-2 rounded text-left ${selected ? 'items-start' : 'items-center'} focus-visible:outline-2 focus-visible:outline-[var(--pl-accent)]`}
          aria-label={`Select ${a.droneId}${a.reason ? `: ${a.reason}` : ''}`}
          title={selected ? undefined : [a.reason, a.grounded ? (a.groundedReason ?? groundedText) : null].filter(Boolean).join(' · ') || undefined}
        >
          <span
            className={`inline-flex h-[18px] w-[26px] shrink-0 items-center justify-center rounded font-mono text-[11px] font-semibold ${
              a.grounded ? 'bg-[var(--pl-tab)] text-[var(--pl-muted)] line-through' : selected && accent ? 'bg-[var(--pl-accent)] text-white' : 'bg-[var(--pl-ink)] text-white'
            }`}
          >
            {a.droneId}
          </span>
          <span className={`min-w-0 text-[12px] leading-[18px] ${selected ? '' : 'truncate'} ${a.grounded ? 'text-[var(--pl-muted)]' : ''}`}>{a.reason || <span className="text-[var(--pl-muted)]">No reason given</span>}</span>
          {groundedText && <span className="-ml-1 shrink-0 whitespace-nowrap text-[11px] leading-[18px] text-[var(--pl-muted)]">· {groundedText}</span>}
        </button>
        {selected || approved ? (
          marker
        ) : armed ? (
          controls
        ) : (
          <>
            <span className="flex items-center group-hover:hidden">{marker}</span>
            <span className="hidden group-hover:flex">{controls}</span>
          </>
        )}
      </div>
      {selected && (
        <div className="px-3 pb-2.5 pl-[46px] -mt-0.5">
          {a.grounded && a.groundedReason && <p className="pb-1 text-[11px] leading-[15px] text-[var(--pl-muted)]">{a.groundedReason}</p>}
          <div className="flex items-center justify-between gap-1 text-[11px] text-[var(--pl-muted)]">
            <span className="min-w-0 truncate whitespace-nowrap tabular-nums" title={`${Math.round(a.radiusM)} m view radius at ${a.lon.toFixed(4)}, ${a.lat.toFixed(4)}`}>
              {Math.round(a.radiusM)} m · {a.lon.toFixed(4)}, {a.lat.toFixed(4)}
            </span>
            {controls}
          </div>
          {!approved && (
            <Btn variant={accent ? 'accent' : 'plain'} className="mt-1.5" onClick={() => askAgentAboutDrone(planId, a)} title={`Ask the agent to change ${a.droneId}`}>
              <IconMessage size={12} /> Ask agent to change {a.droneId}
            </Btn>
          )}
        </div>
      )}
    </li>
  );
}

/** The plan for the hour on screen: score, drones, and the three loop buttons. */
export function PlanPanel(props: PlanPanelProps = {}): ReactElement | null {
  const {fire, t} = usePlanContext(props);
  const data = usePlanData(fire, t);
  const front = useForecastFront(fire, t);
  const selected = usePlanUi(s => s.selected);
  const armed = usePlanUi(s => s.moveArmed);
  const uiError = usePlanUi(s => s.error);
  const qc = useQueryClient();
  const update = useUpdateDrone();
  const [, setParams] = useSearchParams();
  const [busy, setBusy] = useState<null | 'add' | 'approve'>(null);
  useSelectionGuard(data.plan?.id ?? null, data.assignments, !data.fetching);
  // One accent on screen at a time, on the current guide step's control (0-based steps).
  const step = useGuideStep({fire, t: t ?? undefined});

  const plan = data.plan;
  const approved = plan?.status === 'approved';
  const full = data.assignments.length >= MAX_DRONES;

  const addDrone = async () => {
    if (!t) return;
    const droneId = nextDroneId(data.serverAssignments);
    if (!droneId) return;
    const spot = props.getMapCenter?.() ?? freeSpotOnFront(front?.paths ?? data.score?.segments?.map(s => s.path) ?? [], data.assignments);
    if (!spot) {
      setPlanError('No forecast front for this hour yet, so there is nowhere to put a drone. Pan the map and try again.');
      return;
    }
    setBusy('add');
    setPlanError(null);
    const reason = 'Placed by hand on the forecast front';
    try {
      if (plan) await update({planId: plan.id, droneId, lon: spot[0], lat: spot[1], reason});
      else {
        await act('create-drone-plan', {fire, t, drones: [{droneId, lon: spot[0], lat: spot[1], reason}]}, 'POST');
        await qc.invalidateQueries({queryKey: ['action']});
      }
      usePlanUi.setState({movedByHand: true});
    } catch (e) {
      setPlanError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!plan) return;
    setBusy('approve');
    setPlanError(null);
    try {
      const res = (await act<Record<string, unknown>>('approve-plan', {planId: plan.id}, 'POST')) ?? {};
      const next = [res.nextT, res.next_t, res.t, (res.next as Record<string, unknown> | undefined)?.t].find((v): v is string => typeof v === 'string');
      selectPlanDrone(null, null);
      await qc.invalidateQueries({queryKey: ['action']});
      // approve-plan also writes a set-time map-command; moving the shareable URL param as well
      // means the clock follows even if that command is missed.
      if (next && res.nextTInWindow !== false) {
        if (props.onTimeChange) props.onTimeChange(next);
        else
          setParams(
            prev => {
              const p = new URLSearchParams(prev);
              p.set('t', next);
              return p;
            },
            {replace: true, preventScrollReset: true}
          );
      }
    } catch (e) {
      setPlanError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const status = plan ? <Chip tone={approved ? 'ok' : 'ghost'}>{approved ? 'APPROVED' : 'DRAFT'}</Chip> : data.fetching ? <Spinner className="text-[var(--pl-muted)]" /> : null;
  const title = (
    <span>
      Plan <span className="font-normal text-[var(--pl-muted)]">· {t ? `hour from ${fireTime(plan?.t || t)}` : 'no hour picked'}</span>
    </span>
  );
  if (!t) {
    return (
      <Card title={title} className={props.className}>
        <p className="px-3 py-3 text-[12px] text-[var(--pl-muted)]">Pick an hour on the timeline to plan drone coverage for it.</p>
      </Card>
    );
  }

  const planAccent = !plan && (step === 1 || step === 5);
  const askBtn = (
    <Btn variant={planAccent ? 'accent' : 'plain'} className="px-2" onClick={() => askAgentToPlan(fire, t, data.assignments.filter(a => a.locked))} disabled={approved} title="Send the planning request to the agent">
      {plan ? 'Re-plan with agent' : 'Ask agent to plan'}
    </Btn>
  );
  const addBtn = (
    <Btn variant="quiet" className="px-1" onClick={() => void addDrone()} disabled={approved || full || busy !== null} title={full ? `The plan already has ${MAX_DRONES} drones` : 'Add a drone on the front'}>
      {busy === 'add' ? <Spinner /> : <IconPlus size={12} />} Drone
    </Btn>
  );

  return (
    <Card title={title} aside={status} className={props.className}>
      {data.missing && <p className="px-3 pt-2 text-[11px] text-[var(--pl-live)]">The plan actions are not available on this server yet.</p>}
      {!plan ? (
        <div className="px-3 py-3">
          <p className="text-[12px] leading-[16px] text-[var(--pl-muted)]">
            {data.loading ? 'Loading the plan for this hour…' : 'No drones planned for this hour. The agent places up to six on the forecast front.'}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {askBtn}
            {addBtn}
          </div>
        </div>
      ) : (
        <>
          <ScoreBlock score={data.score} method={front?.method ?? data.score?.forecastMethod ?? null} />
          <div className="flex items-center justify-between border-t border-[var(--pl-hair)] px-3 pb-1.5 pt-2">
            <Label>
              Drones {data.assignments.length}/{MAX_DRONES}
            </Label>
            {plan.updatedBy && (
              <span className="text-[10px] text-[var(--pl-muted)]">
                last change: {plan.updatedBy === 'agent' ? 'agent' : 'you'}
                {plan.updatedAt ? ` · ${new Date(plan.updatedAt).toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit'})}` : ''}
              </span>
            )}
          </div>
          {data.assignments.length ? (
            <ul>
              {data.assignments.map(a => (
                <DroneRow
                  key={a.droneId}
                  a={a}
                  planId={plan.id}
                  selected={selected?.droneId === a.droneId && selected.planId === plan.id}
                  armed={armed === a.droneId}
                  approved={approved}
                  accent={step === 3}
                />
              ))}
            </ul>
          ) : (
            <p className="border-t border-[var(--pl-hair)] px-3 py-2 text-[12px] text-[var(--pl-muted)]">Every drone was removed. Add one or ask the agent to re-plan.</p>
          )}
          {!approved && data.assignments.length > 0 && (
            <p className="border-t border-[var(--pl-hair)] px-3 py-1.5 text-[11px] text-[var(--pl-muted)]">Drag a marker on the map to move a drone.</p>
          )}
          <div className="flex items-center gap-1 border-t border-[var(--pl-hair)] py-2 pl-3 pr-2">
            {askBtn}
            {addBtn}
            <Btn
              variant={step === 5 && !approved ? 'accent' : 'plain'}
              className="ml-auto px-2"
              onClick={() => void approve()}
              disabled={approved || busy !== null || !data.assignments.length}
              title="Approve this plan and move to the next hour"
            >
              {busy === 'approve' ? <Spinner /> : null}
              {approved ? 'Approved' : 'Approve'}
              {!approved && busy !== 'approve' && <IconChevronRight size={13} className="-mr-1" />}
            </Btn>
          </div>
        </>
      )}
      {(uiError || (data.error && !data.missing)) && <p role="alert" className="px-3 pb-2 text-[11px] text-[var(--pl-live)]">{uiError ?? data.error}</p>}
    </Card>
  );
}
