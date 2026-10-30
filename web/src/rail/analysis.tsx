import type {FireData} from '../data/fire';
import {useFireJson} from '../data/files';
import {useUi} from '../state/ui';
import {hours, meters, pct, signedHours, stamp} from './fmt';
import {Homes} from './homes';
import {EstimatedPlace, EstimatedStart, type IgnitionFile} from './ignition';
import {Button, Chip, Missing, Stat, SubHead} from './ui';

/**
 * The heat layer's own color stops (stage/fire-extension.ts, ignition block): relative posterior
 * p = 0 is pale yellow and faint, 0.5 orange, 1 deep red and opaque (alpha 0.25 + 0.65p).
 * Keep in step with that shader and with THUMBS.ignition in Rail.tsx.
 */
export const POSTERIOR_RAMP =
  'linear-gradient(90deg, rgba(255,214,92,0.25), rgba(255,107,26,0.58) 50%, rgba(199,15,26,0.9))';

const yesNo = (v: boolean) => (v ? 'Yes' : 'No');

type Synthetic = IgnitionFile['synthetic_summary'];

/** One setup's synthetic medians: rows of a [label, back-trace, baseline] grid. */
function Benchmark({title, s}: {title: string; s: Synthetic}) {
  return (
    <>
      <span className="col-span-3 pt-1 font-medium">
        {title} <span className="font-normal text-muted">({s.n} synthetic fires)</span>
      </span>
      <span>Distance</span>
      <span className="text-right">{meters(s.distance_m.backtrace.median)}</span>
      <span className="text-right">{meters(s.distance_m.baseline_first_footprint_centroid.median)}</span>
      <span>Start-time error</span>
      <span className="text-right">{hours(s.start_time_error_min.backtrace.median)}</span>
      <span className="text-right">{hours(s.start_time_error_min.baseline_area_backcast.median)}</span>
      <span className="col-span-3 text-muted">
        Back-trace beat the baseline on {pct(s.backtrace_beats_baseline.distance)} of fires for distance and{' '}
        {pct(s.backtrace_beats_baseline.time)} for start time.
      </span>
    </>
  );
}

/** DESIGN.md §9: heatmap legend, the estimate with its credible region, then the hold-out score. */
function IgnitionSection({fire}: {fire: FireData}) {
  const {data: ig, error} = useFireJson<IgnitionFile>(fire, 'ignition.json');
  const requestFlyTo = useUi(s => s.requestFlyTo);
  const tz = fire.aoi.timezone;
  const head = (
    <SubHead aside={<Chip tone="modeled">MODELED</Chip>}>Ignition back-trace</SubHead>
  );
  if (!ig) {
    return (
      <>
        {head}
        <Missing file="ignition.json" error={error} />
      </>
    );
  }
  const {calibration: cal, holdout, synthetic_summary: syn, synthetic_summary_holdout: synHold} = ig;
  // Absent when the fire has no CAL FIRE reported start to score the hold-out fit against.
  const e = holdout.errors;
  const outside = e?.reference_outside_first_fit_footprint_m;
  return (
    <>
      {head}
      <div className="px-3 pt-2">
        <div className="h-2 rounded-sm shadow-[0_0_0_1px_var(--hairline)]" style={{background: POSTERIOR_RAMP}} />
        <div className="mt-0.5 flex justify-between text-2xs text-muted">
          <span>low</span>
          <span>Ignition Probability layer · relative posterior</span>
          <span>high</span>
        </div>
        {ig.candidates_evaluated != null && (
          <div className="text-2xs text-muted">
            Posterior across {ig.candidates_evaluated.toLocaleString('en-US')} evaluated start candidates
          </div>
        )}
      </div>

      <div className="space-y-1 px-3 py-2 text-sm">
        <div>
          <EstimatedPlace ig={ig} />
        </div>
        <div className="text-xs text-muted">
          90% credible region (highest-posterior cells): {ig.region90_km2} km²
        </div>
        <div className="text-xs">
          <EstimatedStart ig={ig} tz={tz} showWidth />
        </div>
        <div className="text-xs text-muted">
          Fit to {ig.observations_used} of {ig.perimeters_total} mapped perimeters, first mapped {stamp(ig.first_observation, tz)}
        </div>
        <div className="pt-1">
          <Button primary onClick={() => requestFlyTo(ig.map.lon, ig.map.lat)}>
            Fly to estimate
          </Button>
        </div>
      </div>

      <div className="border-t border-hairline px-3 py-2 text-xs">
        <div className="mb-1 font-medium">Calibration</div>
        <div className="text-muted">
          τ = {cal.tau_h} h. On {cal.test_cases} unseen synthetic cases the 90% radius held the true point in{' '}
          <span className="text-ink">{pct(cal.test_coverage.distance)}</span> and the 90% interval held the true start in{' '}
          <span className="text-ink">{pct(cal.test_coverage.time)}</span>
          {cal.target != null && <> (target {pct(cal.target)})</>}. Median test radius {meters(cal.median_test_r90_m)}, median
          interval {cal.median_test_t90_width_h.toFixed(1)} h.
        </div>
        <div className="mt-0.5 text-muted">
          A start time would have been shown on{' '}
          <span className="text-ink">
            {cal.test_start_time_shown.cases} of {cal.test_start_time_shown.of}
          </span>{' '}
          test cases.
        </div>
      </div>

      <div className="border-t border-hairline px-3 py-2">
        <div className="mb-1.5 text-xs font-medium">
          Hold-out fit ({holdout.held_out.length} perimeters withheld)
          {e && (
            <>
              {' '}
              vs CAL FIRE's reported start <span className="font-normal text-muted">(a report, not an origin)</span>
            </>
          )}
        </div>
        {e ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
            <Stat
              label="Distance to reported point"
              value={meters(e.backtrace_distance_m)}
              sub={`baseline ${meters(e.baseline_distance_m)} (first-footprint centroid)`}
            />
            <Stat
              label="Start-time error"
              value={signedHours(e.backtrace_time_error_min)}
              sub={`hold-out fit − reported · baseline ${signedHours(e.baseline_time_error_min)} (area backcast)`}
            />
            <Stat
              label="Reported point within 90% radius"
              value={yesNo(e.reference_within_r90)}
              sub={
                outside != null && outside > 0
                  ? `CAL FIRE's point is ${meters(outside)} outside the first mapped footprint the search is confined to`
                  : undefined
              }
            />
            <Stat label="Reported time in 90% interval" value={yesNo(e.reference_within_t90)} />
          </div>
        ) : (
          <div className="text-xs text-muted">
            No CAL FIRE reported start for this fire, so the hold-out fit has no reference to be scored against.
          </div>
        )}
        {holdout.held_out.length > 0 && (
          <div className="mt-2 text-xs">
            <div className="text-muted">IoU with held-out perimeters</div>
            {holdout.held_out.map(h => (
              <div key={h.t} className="flex justify-between tabular-nums">
                <span>{stamp(h.t, tz)}</span>
                <span className="font-medium">{h.iou.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-hairline px-3 py-2 text-xs">
        <div className="mb-1 font-medium">
          Synthetic benchmark <span className="font-normal text-muted">(medians, true start known)</span>
        </div>
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 tabular-nums">
          <span className="text-muted" />
          <span className="text-muted">back-trace</span>
          <span className="text-muted">baseline</span>
          <Benchmark title="All observations, as the estimate" s={syn} />
          {synHold && <Benchmark title="Hold-out, as the fit scored above" s={synHold} />}
        </div>
      </div>

      <div className="border-t border-hairline px-3 py-2 text-xs">
        <div className="text-muted">Fit IoU, forward run vs observed perimeters</div>
        <div className="font-medium tabular-nums">{ig.modeled_vs_observed_iou.map(v => v.toFixed(2)).join(' · ')}</div>
        <div className="mt-1.5 text-2xs text-muted">{ig.model_card}</div>
      </div>
    </>
  );
}

export function Analysis({fire}: {fire: FireData}) {
  return (
    <div className="pb-2">
      <IgnitionSection fire={fire} />
      <Homes fire={fire} />
    </div>
  );
}
