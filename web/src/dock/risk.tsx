import type {FireData} from '../data/fire';

/** Risk tab charts (debris-flow likelihood vs design storm, model comparison). Filled by the Risk build. */
export function RiskCharts(_: {fire: FireData}) {
  return <div className="flex flex-1 items-center justify-center text-sm text-muted">Debris-flow models are not computed yet.</div>;
}

export function RiskSide() {
  return <div className="px-3 py-6 text-center text-sm text-muted">Debris-flow models are not computed yet.</div>;
}
