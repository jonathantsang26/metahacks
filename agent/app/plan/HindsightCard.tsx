import type {ReactElement} from 'react';
import {addHours, fireTime, useHindsight, usePlanContext, usePlanData} from './data';
import {Card, Chip, Label, Spinner} from './ui';

export type HindsightCardProps = {
  fire?: string | undefined;
  t?: string | undefined;
  /** Check this plan instead of finding the approved one for this hour or the hour before. */
  planId?: string | undefined;
  className?: string | undefined;
};

const pctText = (v: number | null) => (v === null ? '–' : `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)}%`);

/**
 * After a plan is approved: how much of the ground that really burned in that hour sat inside the
 * drone footprints, against the baseline. After "Approve & next hour" the screen is on the next
 * hour, so the card looks back one hour when this hour has no approved plan.
 */
export function HindsightCard(props: HindsightCardProps = {}): ReactElement | null {
  const {fire, t} = usePlanContext(props);
  const here = usePlanData(fire, t, props.planId ? {planId: props.planId} : {});
  const before = usePlanData(fire, t && !props.planId ? addHours(t, -1) : null);
  const plan = here.plan?.status === 'approved' ? here.plan : !props.planId && before.plan?.status === 'approved' ? before.plan : null;
  const h = useHindsight(plan?.id, !!plan);
  if (!plan) return null;
  const d = h.data;
  const sentence =
    d && d.pct !== null
      ? `The drones watched ${pctText(d.pct)} of the ${d.burnedHa !== null ? `${Math.round(d.burnedHa).toLocaleString('en-US')} ha ` : 'ground '}that burned in that hour` +
        (d.baselinePct !== null ? `, against ${pctText(d.baselinePct)} for the same number of ${d.baselineLabel ?? 'baseline drones'}.` : '.')
      : null;

  return (
    <Card
      title={
        <span>
          Hindsight <span className="font-normal text-[var(--pl-muted)]">· hour from {fireTime(plan.t)}</span>
        </span>
      }
      aside={
        <Chip tone="modeled" title="Burned area comes from the arrival raster, interpolated between official perimeters (about 28 min steps)">
          MODELED
        </Chip>
      }
      className={props.className}
    >
      <div className="px-3 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--pl-muted)]">Hindsight: the real fire, mapped after the fact</div>
      {h.loading ? (
        <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-[var(--pl-muted)]">
          <Spinner /> Checking the plan against the real fire…
        </div>
      ) : h.error || !d ? (
        <p className="px-3 py-3 text-[12px] text-[var(--pl-muted)]">{h.error ? `Hindsight check failed: ${h.error}` : 'No hindsight data for this hour.'}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 px-3 pt-2">
            <div>
              <Label>This plan</Label>
              <div className="text-[26px] font-semibold leading-tight tabular-nums">{pctText(d.pct)}</div>
            </div>
            <div>
              <Label>
                <span title={d.baselineMethod ?? undefined}>Baseline: {d.baselineLabel ?? 'baseline'}</span>
              </Label>
              <div className="text-[26px] font-semibold leading-tight tabular-nums text-[var(--pl-muted)]">{pctText(d.baselinePct)}</div>
            </div>
          </div>
          <p className="px-3 pb-3 pt-1.5 text-[12px] leading-[16px]">
            {sentence}
            {d.label ? <span className="block pt-1 text-[11px] text-[var(--pl-muted)]">{d.label}</span> : null}
          </p>
        </>
      )}
    </Card>
  );
}
