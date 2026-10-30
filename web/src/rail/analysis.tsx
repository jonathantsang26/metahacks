import type {FireData} from '../data/fire';
import {useFireJson, type Perimeters} from '../data/files';
import {useUi} from '../state/ui';
import {hours, meters, pct, signedHours, stamp} from './fmt';
import {greatCircleM} from './geo';
import {Homes} from './homes';
import {EstimatedPlace, EstimatedStart, type IgnitionFile} from './ignition';
import {POSTERIOR_LEGEND} from './ramps';
import {Button, Chip, Missing, Stat, SubHead} from './ui';

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

/** eval/wind_ablation.json: the full fit rerun with each wind input (step 11). */
type WindVariant = {
  wind: string;
  lb_max: number;
  k: number;
  k_at_ceiling: boolean;
  loss_h: number;
  t: string;
  lonlat: [number, number];
  iou_by_observation: number[];
  mean_iou: number;
};
type WindAblation = {note: string; variants: Record<string, WindVariant>};

/** k to three significant figures: 0.424, 11.3, 76.8. */
const k3 = (k: number) => String(Number(k.toPrecision(3)));

/** The wind ablation as a table, so the README's claim about the HRRR field can be checked here. */
function WindTable({fire, ig}: {fire: FireData; ig: IgnitionFile}) {
  const {data: a, error} = useFireJson<WindAblation>(fire, 'eval/wind_ablation.json');
  const head = <div className="mb-1 font-medium">Wind in the spread model</div>;
  if (!a) {
    return (
      <div className="border-t border-hairline px-3 py-2 text-xs">
        {head}
        <Missing file="eval/wind_ablation.json" error={error} />
      </div>
    );
  }
  // The variant whose fit is the estimate on the map (same point, start and k as ignition.json).
  const shown = (v: WindVariant) =>
    v.t === ig.map.t && v.lonlat[0] === ig.map.lon && v.lonlat[1] === ig.map.lat && v.k === ig.map.k;
  const rows = Object.entries(a.variants);
  return (
    <div className="border-t border-hairline px-3 py-2 text-xs">
      {head}
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-2.5 tabular-nums">
        <span className="text-muted">Variant</span>
        <span className="text-right text-muted">L:B cap</span>
        <span className="text-right text-muted">Mean IoU</span>
        <span className="text-right text-muted">k</span>
        <span className="text-right text-muted">Loss</span>
        {rows.map(([name, v]) => {
          const bold = shown(v) ? 'font-semibold' : '';
          return [
            <span key={`${name}-n`} className={`font-mono text-2xs leading-[15px] ${bold}`}>
              {name}
            </span>,
            <span key={`${name}-b`} className={`text-right ${bold}`}>
              {v.lb_max}
            </span>,
            <span key={`${name}-i`} className={`text-right ${bold}`}>
              {v.mean_iou.toFixed(2)}
            </span>,
            <span key={`${name}-k`} className={`text-right ${bold}`}>
              {k3(v.k)}
              {v.k_at_ceiling && <span className="text-2xs font-normal text-muted"> (ceiling)</span>}
            </span>,
            <span key={`${name}-l`} className={`text-right ${bold}`}>
              {v.loss_h.toFixed(2)} h
            </span>
          ];
        })}
      </div>
      <div className="mt-1 space-y-0.5 text-2xs text-muted">
        <p>
          Mean IoU: modeled vs observed footprint, averaged over the fit's observations. k: spread-rate scale. Loss: the
          fit's arrival-time loss.{rows.some(([, v]) => shown(v)) && ' Bold: the fit behind the estimate on the map.'}
        </p>
        <p>{a.note}</p>
      </div>
    </div>
  );
}

/** DESIGN.md §9: heatmap legend, the estimate with its credible region, then the hold-out score. */
function IgnitionSection({fire}: {fire: FireData}) {
  const {data: ig, error} = useFireJson<IgnitionFile>(fire, 'ignition.json');
  const {data: perims} = useFireJson<Perimeters>(fire, 'perimeters.geojson');
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
  // The hold-out fit's first footprint: the first mapped perimeter it did not withhold.
  const held = new Set(holdout.held_out.map(h => Date.parse(h.t)));
  const fitFirst = perims?.features.find(f => !held.has(Date.parse(f.properties.t)))?.properties.t ?? null;
  // The estimate on the map vs CAL FIRE's reported point, great-circle, the distance the map key states.
  const reported = fire.aoi.official.incident?.reported_location;
  const shownDist = reported ? greatCircleM(ig.map.lon, ig.map.lat, reported[0], reported[1]) : null;
  const fullOutside = ig.reference_outside_first_footprint_m;
  // The hold-out fit's start, from its error vs CAL FIRE's start; later than a withheld perimeter
  // means it predicts that perimeter unburned, so its start-time error is not a result.
  const reportedStart = fire.aoi.official.incident?.start_utc;
  const startsAfterHeldOut =
    !!e && !!reportedStart && holdout.held_out.length > 0 &&
    Date.parse(reportedStart) + e.backtrace_time_error_min * 60_000 > Math.min(...holdout.held_out.map(h => Date.parse(h.t)));
  return (
    <>
      {head}
      <div className="px-3 pt-2">
        <div className="h-2 rounded-sm shadow-[0_0_0_1px_var(--hairline)]" style={{background: POSTERIOR_LEGEND}} />
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
        {shownDist !== null && (
          <div className="text-xs">
            {meters(shownDist)} from CAL FIRE's reported point{' '}
            <span className="text-muted">
              ({shownDist <= ig.r90_m ? 'inside' : 'outside'} the 90% radius; a report, not an investigated origin)
            </span>
          </div>
        )}
        {fullOutside != null && (
          <div className="text-xs text-muted">
            CAL FIRE's point lies {fullOutside > 0 ? `${meters(fullOutside)} outside` : 'inside'} the first mapped
            perimeter ({stamp(ig.first_observation, tz)}), the area the search is confined to
          </div>
        )}
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
        {e && (
          <div className="mb-2 text-2xs text-muted">
            A separate fit that never saw the withheld perimeters; these are its numbers, not the estimate's above.
          </div>
        )}
        {e ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
            <Stat
              label="Hold-out fit's estimate to reported point"
              value={meters(e.backtrace_distance_m)}
              sub={`baseline ${meters(e.baseline_distance_m)} (first-footprint centroid)`}
            />
            <Stat
              label="Hold-out fit's start-time error"
              value={signedHours(e.backtrace_time_error_min)}
              sub={
                startsAfterHeldOut
                  ? 'its start is later than the withheld perimeters, which it predicts unburned: not a credible start'
                  : `hold-out fit − reported · baseline ${signedHours(e.baseline_time_error_min)} (area backcast)`
              }
            />
            <Stat
              label={`Reported point within its 90% radius${holdout.uncertainty_calibrated === false ? ' (uncalibrated)' : ''}`}
              value={yesNo(e.reference_within_r90)}
              sub={
                outside != null
                  ? `CAL FIRE's point is ${outside > 0 ? `${meters(outside)} outside` : 'inside'} the hold-out fit's first footprint${
                      fitFirst ? ` (perimeter ${stamp(fitFirst, tz)})` : ''
                    }, which its search is confined to`
                  : undefined
              }
            />
            <Stat label="Reported time in its 90% interval" value={yesNo(e.reference_within_t90)} />
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

      <WindTable fire={fire} ig={ig} />

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
