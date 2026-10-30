import type {Ignition} from '../data/files';
import {formatLatLon} from '../lib/format';
import {meters, stamp} from './fmt';

type HoldoutErrors = Ignition['holdout']['errors'] & {
  /** How far CAL FIRE's point lies outside the hold-out fit's first footprint (0 = inside). */
  reference_outside_first_fit_footprint_m?: number;
};

/**
 * ignition.json plus the fields the shared type leaves out. step 11 writes `holdout.errors` only
 * when the fire has a CAL FIRE incident, so it is optional here.
 */
export type IgnitionFile = Omit<Ignition, 'holdout' | 'calibration'> & {
  candidates_evaluated?: number;
  calibration: Ignition['calibration'] & {target?: number};
  holdout: {held_out: Ignition['holdout']['held_out']; errors?: HoldoutErrors; uncertainty_calibrated?: boolean};
  /** Same shape as synthetic_summary, for the hold-out setup. */
  synthetic_summary_holdout?: Ignition['synthetic_summary'];
};

/** "34°11.74'N 118°05.68'W ± 2.2 km (90%)" */
export function EstimatedPlace({ig}: {ig: IgnitionFile}) {
  return (
    <>
      {formatLatLon(ig.map.lat, ig.map.lon)}{' '}
      <span className="text-muted">
        ± {meters(ig.r90_m)} (90%{ig.uncertainty_calibrated === false ? ', uncalibrated' : ''})
      </span>
    </>
  );
}

/**
 * The one place the estimated start time is rendered. It is shown only when the pipeline says the
 * timing is identifiable (WORKSTREAMS.md §1); otherwise the reasons it was withheld are shown instead.
 */
export function EstimatedStart({ig, tz, showWidth = false}: {ig: IgnitionFile; tz: string; showWidth?: boolean}) {
  const {identifiable, reasons, interval90_width_h} = ig.timing;
  if (identifiable) {
    return (
      <>
        <div>Start {stamp(ig.map.t, tz)}</div>
        <div className="text-xs text-muted">
          90% interval {stamp(ig.t90[0], tz)} – {stamp(ig.t90[1], tz)}
        </div>
      </>
    );
  }
  // Skip the width when a reason already states it, so it is not printed twice.
  const width = showWidth && !reasons.some(r => /interval/i.test(r));
  return (
    <div className="text-muted">
      <span className="text-ink">Start time withheld</span>
      {width && <> (90% interval {interval90_width_h.toFixed(1)} h wide)</>}
      {reasons.length > 0 && <>: {reasons.join('; ')}</>}
    </div>
  );
}
