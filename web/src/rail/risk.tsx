/**
 * Risk tab rail: post-fire debris-flow likelihood. The model and design-storm controls drive the
 * map, the dock and the side list; below them, how our two map columns compare with USGS's
 * assessment on this fire under the selected storm, the selected segment's inputs, and the
 * models' scores on USGS's observed inventory.
 */
import {useMemo, useState} from 'react';
import type {FireData} from '../data/fire';
import type {DebrisFlowStats, DebrisModelEval, WithinStorm, WithinStormDiff} from '../data/files';
import {DESIGN_I15, useUi} from '../state/ui';
import {
  accumulationMm,
  analogueShown,
  classOf,
  columnForEval,
  evalShort,
  LIKELIHOOD_CLASSES,
  likelihood,
  likelihoodText,
  MODEL_EVAL_URL,
  NO_VALUE,
  riskModel,
  RISK_MODELS,
  segmentMidpoint,
  useDebrisJson,
  useRiskFiles,
  type Segment
} from '../stage/debris-layer';
import {pct} from './fmt';
import {Button, Card, Chip, Missing, Stat, SubHead} from './ui';

type EvalRow = DebrisModelEval['models'][number];

const HAZARD = {1: 'Low', 2: 'Moderate', 3: 'High'} as const;
const fixed = (v: number | null | undefined, d: number) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const count = (v: number) => v.toLocaleString('en-US');
/** A share that the file may write as 0–1 or as a percentage. */
const share = (v: number) => (v <= 1 ? pct(v) : `${Math.round(v)}%`);
/** A debris-flow base rate with one decimal: 9.8% and 12.5% read as different, 10% and 13% overstate it. */
const rate = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
/** Distinct values of one field across rows, joined (the trained models share theirs). */
const distinct = (rows: EvalRow[], f: (m: EvalRow) => string) => [...new Set(rows.map(f))].join(' / ');
/** Why a model_eval.json row has no Station Fire score (model_eval.json's notes give M1's reason). */
const noStation = (id: string) =>
  id === 'm1_published'
    ? 'No Station Fire score: its records are in the Staley et al. (2016) inventory M1 was fitted on'
    : 'No Station Fire score in model_eval.json';
/** m1_check's largest difference, in likelihood units: tiny values in scientific notation. */
const tiny = (v: number) => (v === 0 ? '0' : v < 0.001 ? v.toExponential(1) : v.toFixed(3));
/** A 95% interval of ROC AUCs, "[0.69–0.86]"; empty when the file has none. */
const interval = (c: [number, number] | undefined, d = 2) => (c ? `[${fixed(c[0], d)}–${fixed(c[1], d)}]` : '');
/**
 * A difference with its sign (true minus), "+0.05" / "−0.05". A nonzero value that would round to
 * 0 gets more decimals, up to the file's 4, so −0.0015 reads "−0.002", not "−0.00" beside a mark
 * that says its interval excludes 0.
 */
const signedFixed = (v: number, d = 2): string => {
  if (!Number.isFinite(v)) return '—';
  if (v !== 0 && d < 4 && Number(Math.abs(v).toFixed(d)) === 0) return signedFixed(v, d + 1);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;
};
const span = (c: [number, number], d = 2) => `[${signedFixed(c[0], d)}, ${signedFixed(c[1], d)}]`;
const diffText = (v: number, c: [number, number], d = 2) => `${signedFixed(v, d)} ${span(c, d)}`;
const excludesZero = (c: [number, number]) => c[0] > 0 || c[1] < 0;
/**
 * '*' when a paired interval excludes 0 in the stored draw and again in the file's larger check
 * draw (vs_m1's *_check), '†' when only one of them does (borderline: an end within resampling
 * noise of 0), '' otherwise. Without a check draw, the stored interval decides.
 */
const zeroMark = (c: [number, number], check?: [number, number]) => {
  const [a, b] = [excludesZero(c), check ? excludesZero(check) : excludesZero(c)];
  return a && b ? '*' : a !== b ? '†' : '';
};
const marks = (d: WithinStormDiff) => [zeroMark(d.ci95, d.ci95_check), zeroMark(d.ci95_weighted, d.ci95_weighted_check)] as const;

/**
 * Which records the Storm figures are on: each model's own (the trained models on every usable
 * record, M1 published on the fewer outside the inventory it was fitted on), or M1 published's for
 * every row, like for like.
 */
type StormBasis = 'own' | 'm1';
const stormOf = (m: EvalRow, basis: StormBasis): WithinStorm | undefined =>
  basis === 'm1' ? m.within_storm_on_m1_records : m.within_storm;
/** The row minus M1 on the same groups: M1 published on its records, M1 recalibrated on every record. */
const diffOf = (m: EvalRow, basis: StormBasis): WithinStormDiff | null | undefined =>
  basis === 'm1' ? m.vs_m1?.published : m.vs_m1?.refit;
const stormTitle = (ws: WithinStorm | undefined) =>
  ws
    ? `Median ${fixed(ws.median_roc_auc, 3)} ${interval(ws.ci95_median, 3)}, record-weighted ${fixed(ws.weighted_roc_auc, 3)} ` +
      `${interval(ws.ci95_weighted, 3)}, over ${ws.groups} groups (${count(ws.records)} records; 95% cluster-bootstrap intervals)`
    : undefined;

function Dot({p}: {p: number | null}) {
  const c = p === null ? NO_VALUE.css : LIKELIHOOD_CLASSES[classOf(p)].css;
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{background: c}} />;
}

function Controls() {
  const {model, i15} = useUi(s => s.risk);
  const setRisk = useUi(s => s.setRisk);
  const on = 'bg-btndark text-white';
  const off = 'bg-card shadow-[0_0_0_1px_var(--hairline)]';
  return (
    <div className="space-y-2.5 px-3 py-2">
      <div>
        <div className="mb-1 text-xs text-muted">Model</div>
        <div className="grid grid-cols-1 gap-1">
          {RISK_MODELS.map(m => (
            <button
              key={m.id}
              onClick={() => setRisk({model: m.id})}
              title={m.about}
              className={`rounded-md px-2 py-1 text-left text-sm ${model === m.id ? on : off}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-2xs text-muted">
          The neural networks (MLP) are scored in the table below but not mapped: nothing constrains them to rise with
          rainfall, so a heavier design storm could lower a segment’s likelihood.
        </p>
      </div>
      <div>
        <div className="mb-1 flex justify-between text-xs text-muted">
          <span>Design storm · peak 15-minute rainfall</span>
          <span>mm/h</span>
        </div>
        <div className="flex gap-1">
          {DESIGN_I15.map(v => (
            <button
              key={v}
              onClick={() => setRisk({i15: v})}
              title={`I15 ${v} mm/h: ${accumulationMm(v)} mm of rain in the peak 15 minutes`}
              className={`flex-1 rounded-md py-1 text-sm tabular-nums ${i15 === v ? on : off}`}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="mt-1 text-xs">
          I15 {i15} mm/h ={' '}
          <span className="font-medium">{accumulationMm(i15)} mm of rain in the peak 15 minutes</span>
        </div>
      </div>
      <div>
        <div className="flex h-2 overflow-hidden rounded-sm">
          {LIKELIHOOD_CLASSES.map(c => (
            <span key={c.label} className="flex-1" style={{background: c.css}} />
          ))}
        </div>
        <div className="mt-0.5 flex justify-between text-2xs text-muted">
          <span>0%</span>
          <span>Debris-Flow Likelihood layer · 5 classes</span>
          <span>100%</span>
        </div>
      </div>
    </div>
  );
}

/**
 * This fire under the selected design storm: M1 recalibrated and the RF against USGS (rank and
 * class), each column's mean, the scenario the RF needs, and the M1 implementation check.
 */
function Agreement({stats, error}: {stats: DebrisFlowStats | null; error: string | null}) {
  const i15 = useUi(s => s.risk.i15);
  const head = <SubHead>Compared with USGS on this fire</SubHead>;
  if (!stats)
    return (
      <>
        {head}
        <Missing file="debris_flow_stats.json" error={error} />
      </>
    );
  const at = stats.agreement_by_i15?.[String(i15)] ?? {};
  // USGS against itself is 1 by definition: the file lists it so every storm names every column.
  const rows = RISK_MODELS.filter(m => m.id !== 'usgs').map(m => ({m, a: at[m.id]}));
  const means = stats.mean_likelihood?.[String(i15)] ?? {};
  const meanCols = RISK_MODELS.filter(m => Number.isFinite(means[m.id]));
  const sc = stats.scenario;
  const th = stats.usgs_median_thresholds_mm_h;
  return (
    <>
      {head}
      <div className="px-3 py-2 text-xs">
        {rows.some(r => r.a) ? (
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 tabular-nums">
            <span className="text-muted">Vs USGS at I15 {i15} mm/h</span>
            <span className="text-right text-muted" title="Spearman rank correlation of segment likelihoods with USGS's">
              Spearman
            </span>
            <span className="text-right text-muted" title="Share of segments in the same likelihood class as USGS's">
              Same class
            </span>
            {rows.map(({m, a}) => [
              <span key={`${m.id}-n`} title={m.label}>
                {m.label.split(' (')[0]}
              </span>,
              <span key={`${m.id}-r`} className="text-right">
                {fixed(a?.spearman_vs_usgs, 2)}
              </span>,
              <span key={`${m.id}-c`} className="text-right">
                {a && Number.isFinite(a.class_agreement) ? share(a.class_agreement) : '—'}
              </span>
            ])}
          </div>
        ) : (
          <div className="text-muted">debris_flow_stats.json lists no agreement figures at I15 {i15} mm/h.</div>
        )}
        {meanCols.length > 0 && (
          <div className="mt-1.5 text-muted">
            Mean likelihood over the {count(stats.segments)} segments:{' '}
            {meanCols.map((m, i) => (
              <span key={m.id}>
                {i > 0 && ', '}
                {m.short} <span className="text-ink">{likelihoodText(means[m.id])}</span>
              </span>
            ))}
            . USGS’s M1 was fitted on the Staley et al. (2016) records and our two columns on every usable inventory record,
            whose sub-inventories sampled storms without a debris flow differently, so the levels differ partly for that
            reason (Caveats).
          </div>
        )}
        <div className="mt-1.5 text-muted">
          Only the RF uses a scenario, so its map depends on the date and on one soil-moisture value for every segment:{' '}
          <span className="text-ink">
            {sc.date}, {sc.days_since_fire} days after the fire, soil moisture (0–7 cm){' '}
            {sc.soil_moisture_0_7cm === null ? 'not available' : `${sc.soil_moisture_0_7cm.toFixed(3)} m³/m³`}
          </span>{' '}
          ({sc.soil_moisture_source}). Few inventory storms came this soon after a fire, so the RF’s level under this
          scenario is an extrapolation from little data (Caveats).
        </div>
        <div className="mt-1.5 text-muted">
          USGS's median rainfall thresholds across segments: 50% likelihood at I15{' '}
          <span className="text-ink">{fixed(th.I15_50, 1)} mm/h</span>, 75% at{' '}
          <span className="text-ink">{fixed(th.I15_75, 1)} mm/h</span>.
        </div>
        <div className="mt-1.5 text-2xs text-muted">
          Implementation check of our M1 code, not a result: with the published coefficients it reproduces USGS's
          likelihoods to within {tiny(stats.m1_check.max_abs_diff_vs_usgs)} on {count(stats.segments)} segments. No map
          column uses it.
        </div>
      </div>
    </>
  );
}

function SegmentDetail({seg, missingId}: {seg: Segment | null; missingId: number | null}) {
  const {model, i15} = useUi(s => s.risk);
  const setRisk = useUi(s => s.setRisk);
  const requestFlyTo = useUi(s => s.requestFlyTo);
  const head = <SubHead>Selected segment</SubHead>;
  if (!seg)
    return (
      <>
        {head}
        <div className="px-3 py-2 text-xs text-muted">
          {missingId !== null
            ? `Segment #${missingId} is not in this fire's debris_flow.geojson.`
            : 'Click a stream segment on the map, or a row in the side list, to see its inputs and every model’s likelihood.'}
        </div>
      </>
    );
  const p = seg.properties;
  const hazard = HAZARD[p.usgs_hazard_24 as keyof typeof HAZARD];
  return (
    <>
      {head}
      <div className="px-3 py-2">
        <div className="mb-2 text-sm font-medium">Segment #{p.id}</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Stat label="T · steep, burned" value={fixed(p.T, 2)} sub="share of upstream area burned at moderate/high severity and steeper than 23°" />
          <Stat label="F · burn severity" value={fixed(p.F, 2)} sub="mean dNBR / 1000" />
          <Stat label="S · soil erodibility" value={fixed(p.S, 2)} sub="mean soil KF-factor" />
          <Stat label="Upstream area" value={`${fixed(p.area_km2, 2)} km²`} sub={hazard ? `USGS hazard at 24 mm/h: ${hazard}` : undefined} />
        </div>
        <div className="mt-2.5 text-xs">
          <div className="mb-0.5 text-muted">Likelihood at I15 {i15} mm/h</div>
          {RISK_MODELS.map(m => {
            const v = likelihood(p, m.id, i15);
            return (
              <div key={m.id} className={`flex items-center gap-1.5 tabular-nums ${m.id === model ? 'font-semibold' : ''}`}>
                <Dot p={v} />
                <span className="flex-1">{m.label}</span>
                <span>{likelihoodText(v)}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex gap-1.5">
          <Button
            primary
            onClick={() => {
              const [lon, lat] = segmentMidpoint(seg.geometry.coordinates);
              requestFlyTo(lon, lat, 14);
            }}
          >
            Fly to segment
          </Button>
          <Button onClick={() => setRisk({segment: null})}>Clear</Button>
        </div>
      </div>
    </>
  );
}

/** Under a row's name: what it is to the map (on_map, USGS's reference, or the context variant). */
function rowRole(m: EvalRow): string | null {
  const col = columnForEval(m.id);
  if (m.on_map) return 'on the map';
  if (col?.id === 'usgs') return 'reference: USGS';
  if (m.features.some(f => f.startsWith('ctx_'))) return 'spatial-context variant';
  return null;
}

/**
 * The Storm figures with their 95% intervals, and each row minus M1 on the same groups (paired):
 * M1 recalibrated on every record, or M1 published on its records when the table is like for like.
 */
function StormIntervals({ev, basis, shown, refName}: {ev: DebrisModelEval; basis: StormBasis; shown: string | undefined; refName: string}) {
  const rows = ev.models.map(m => ({m, ws: stormOf(m, basis), d: diffOf(m, basis)}));
  if (!rows.some(r => r.ws?.ci95_median)) return null;
  const refId = basis === 'm1' ? 'm1_published' : 'm1_refit';
  const groups = rows.find(r => r.m.id === refId)?.ws?.groups;
  const shownMarks = new Set(rows.flatMap(r => (r.d ? marks(r.d) : [])));
  const two = (a: string, b: string, strong?: [boolean, boolean]) => (
    <>
      <span className={`block ${strong?.[0] ? 'text-ink' : ''}`}>{a}</span>
      <span className={`block ${strong?.[1] ? 'text-ink' : ''}`}>{b}</span>
    </>
  );
  return (
    <div className="mt-2 text-2xs text-muted">
      <div className="mb-0.5 text-ink">Storm with 95% intervals, and minus {refName} on the same groups</div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-2 tabular-nums">
        <span>Model</span>
        <span className="text-right" title="Median above, record-weighted mean below, each with its 95% interval">
          Storm [95%]
        </span>
        <span
          className="text-right"
          title={`The row's figure minus ${refName}'s on the same ${groups ?? ''} groups and the same bootstrap resamples (paired), with its 95% interval`}
        >
          − M1 [95%]
        </span>
        {rows.map(({m, ws, d}) => {
          const bold = m.id === shown ? 'font-semibold' : '';
          const [mm, mw] = d ? marks(d) : ['', ''];
          return [
            // Wraps onto the row's second line rather than truncating: the figures take two lines anyway.
            <span key={`${m.id}-n`} className={`min-w-0 break-words ${bold}`} title={m.label}>
              {evalShort(m.id)}
            </span>,
            <span key={`${m.id}-c`} className={`text-right ${bold}`} title={stormTitle(ws)}>
              {ws
                ? two(`${fixed(ws.median_roc_auc, 2)} ${interval(ws.ci95_median)}`, `${fixed(ws.weighted_roc_auc, 2)} ${interval(ws.ci95_weighted)}`)
                : '—'}
            </span>,
            <span
              key={`${m.id}-d`}
              className={`text-right ${bold}`}
              title={
                m.id === refId
                  ? 'The reference'
                  : d
                    ? `Minus ${refName} on ${d.groups} groups, paired: median ${diffText(d.median_diff, d.ci95, 3)}, ` +
                      `record-weighted ${diffText(d.weighted_diff, d.ci95_weighted, 3)}` +
                      (d.ci95_check && d.ci95_weighted_check
                        ? `\nWith more resamples (check draw): median ${span(d.ci95_check, 3)}, record-weighted ${span(d.ci95_weighted_check, 3)}`
                        : '')
                    : `Not paired with ${refName}: scored on other records`
              }
            >
              {d
                ? two(`${diffText(d.median_diff, d.ci95)}${mm}`, `${diffText(d.weighted_diff, d.ci95_weighted)}${mw}`,
                      [mm === '*', mw === '*'])
                : m.id === refId ? 'reference' : '—'}
            </span>
          ];
        })}
      </div>
      <p className="mt-1">
        Intervals: a cluster bootstrap that redraws whole fire-storm groups, on the predictions as made, so they show how
        much a figure depends on which storms the inventory holds.{' '}
        {shownMarks.has('*') ? '*: the paired interval excludes 0, and still does with more resamples.' : 'No paired interval here excludes 0.'}{' '}
        {shownMarks.has('†') ? '†: borderline, it excludes 0 with one number of resamples and not the other (an end within resampling noise of 0). ' : ''}
        Not adjusted for multiple comparisons. The caveats say what all the intervals show.
      </p>
    </div>
  );
}

/** model_eval.json: the models scored on USGS's observed inventory. */
function ModelComparison({ev, error, stats}: {ev: DebrisModelEval | null; error: string | null; stats: DebrisFlowStats | null}) {
  const model = useUi(s => s.risk.model);
  const [basisPicked, setBasis] = useState<StormBasis>('own');
  const head = <SubHead aside={<Chip tone="modeled">MODELED</Chip>}>Scored on observed debris flows</SubHead>;
  if (!ev)
    return (
      <>
        {head}
        <Missing file="debris_flow/model_eval.json" error={error} />
      </>
    );
  const inv = ev.inventory;
  const shown = riskModel(model).evalId;
  const m1 = ev.models.find(m => m.id === 'm1_published');
  // The cross-validated rows, to say how M1 published's records, fires and groups differ from theirs.
  const rest = ev.models.filter(m => m.id !== 'm1_published');
  // A note that scores the trained models on M1's own records (it names their count).
  const sameRecords = m1 && ev.notes.some(n => n.includes(count(m1.n)) && rest.some(m => n.includes(m.id)));
  const context = ev.models.find(m => m.features.some(f => f.startsWith('ctx_')));
  // The row the context variant extends: the same kind of model (id prefix) with the same features less ctx_*.
  const plain = context
    ? ev.models.find(m => {
        const base = context.features.filter(f => !f.startsWith('ctx_'));
        return (
          m !== context &&
          m.id.split('_')[0] === context.id.split('_')[0] &&
          m.features.length === base.length &&
          base.every(f => m.features.includes(f))
        );
      })
    : undefined;
  const station = analogueShown(stats, ev);
  const cell = 'text-right';
  const cols = station ? 'grid-cols-[minmax(0,1fr)_repeat(5,auto)]' : 'grid-cols-[minmax(0,1fr)_repeat(4,auto)]';
  // Every row on M1 published's groups, when the file scores every model there.
  const likeForLike = !!m1 && ev.models.every(m => m.within_storm_on_m1_records);
  const basis: StormBasis = likeForLike ? basisPicked : 'own';
  const m1Groups = m1?.within_storm.groups;
  const restGroups = distinct(rest, r => String(r.within_storm.groups));
  const refName = basis === 'm1' ? evalShort('m1_published') : evalShort('m1_refit');
  const on = 'bg-btndark text-white';
  const off = 'bg-card shadow-[0_0_0_1px_var(--hairline)]';
  return (
    <>
      {head}
      <div className="px-3 py-2 text-xs">
        {likeForLike && (
          <div className="mb-1.5 flex items-center gap-1 text-2xs">
            <span className="mr-0.5 text-muted">Storm over</span>
            {(
              [
                ['own', 'each row’s records', `M1 published on its ${m1Groups} groups, the others on their ${restGroups}`],
                ['m1', `M1’s ${m1Groups} groups`, `Every row on M1 published’s ${m1Groups} groups (its records), like for like`]
              ] as const
            ).map(([id, label, title]) => (
              <button
                key={id}
                onClick={() => setBasis(id)}
                title={title}
                className={`rounded-md px-1.5 py-0.5 ${basis === id ? on : off}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className={`grid ${cols} gap-x-1.5 tabular-nums`}>
          <span className="text-muted">Model</span>
          <span className={`${cell} text-muted`} title="Pooled ROC AUC: all held-out predictions together (0.5 is chance). It mostly ranks records of different storms against each other">
            AUC
          </span>
          <span className={`${cell} text-muted`} title="Median of the per-fire ROC AUCs (a fire's storms are still ranked against each other)">
            Fire
          </span>
          <span
            className={`${cell} text-muted`}
            title={
              'ROC AUC within one fire and storm, over the groups with both outcomes (the ranking a design-storm map shows): the ' +
              'median above, the record-weighted mean below. Most groups are small, so the median is coarse; the record-weighted ' +
              'mean leans on the largest storms. ' +
              (basis === 'm1'
                ? `Every row on M1 published’s ${m1Groups} groups, like for like.`
                : `On each row’s own records: M1 published’s ${m1Groups} groups, the others’ ${restGroups}.`)
            }
          >
            Storm
          </span>
          <span className={`${cell} text-muted`} title="Pooled Brier score (lower is better; depends on the base rate)">
            Brier
          </span>
          {station && (
            <span className={`${cell} text-muted`} title="ROC AUC on the held-out Station Fire">
              Station
            </span>
          )}
          {ev.models.map(m => {
            const bold = m.id === shown ? 'font-semibold' : '';
            const role = rowRole(m);
            const ws = stormOf(m, basis);
            const own = m.within_storm;
            const vs = m.vs_m1;
            const title =
              `${m.label} (${m.id})\nFeatures: ${m.features.join(', ')}\nCross-validation: ${m.cv}\n${count(m.n)} records, ` +
              `${count(m.flows)} debris flows, base rate ${rate(m.pooled.base_rate)}; pooled PR AUC ${fixed(m.pooled.pr_auc, 2)}\n` +
              `Per-fire ROC AUC over ${m.per_fire.fires} fires: median ${fixed(m.per_fire.median_roc_auc, 2)}, IQR ` +
              `${fixed(m.per_fire.iqr[0], 2)}–${fixed(m.per_fire.iqr[1], 2)}\n` +
              (own
                ? `Within one fire and storm: ${own.groups} groups, ${count(own.records)} records; median ROC AUC ` +
                  `${fixed(own.median_roc_auc, 2)} ${interval(own.ci95_median)}, record-weighted ${fixed(own.weighted_roc_auc, 2)} ` +
                  interval(own.ci95_weighted)
                : 'No within-storm score in model_eval.json') +
              (vs?.published
                ? `\nMinus M1 published on its ${vs.published.groups} groups (paired): median ` +
                  `${diffText(vs.published.median_diff, vs.published.ci95)}, record-weighted ` +
                  diffText(vs.published.weighted_diff, vs.published.ci95_weighted)
                : '') +
              (vs?.refit
                ? `\nMinus M1 recalibrated on ${vs.refit.groups} groups (paired): median ${diffText(vs.refit.median_diff, vs.refit.ci95)}, ` +
                  `record-weighted ${diffText(vs.refit.weighted_diff, vs.refit.ci95_weighted)}`
                : '') +
              (station ? (m.analogue ? `\nStation Fire: ${m.analogue.n} records, ${m.analogue.flows} flows, Brier ${fixed(m.analogue.brier, 3)}` : `\n${noStation(m.id)}`) : '');
            const row = [
              <span key={`${m.id}-n`} className={`min-w-0 ${bold}`} title={title}>
                <span className="block truncate">{evalShort(m.id)}</span>
                {role && <span className="block text-2xs font-normal text-muted">{role}</span>}
              </span>,
              <span key={`${m.id}-a`} className={`${cell} ${bold}`}>
                {fixed(m.pooled.roc_auc, 2)}
              </span>,
              <span key={`${m.id}-f`} className={`${cell} ${bold}`}>
                {fixed(m.per_fire.median_roc_auc, 2)}
              </span>,
              <span key={`${m.id}-w`} className={`${cell} ${bold}`} title={stormTitle(ws)}>
                {/* Stacked, so the name column keeps its width in the rail. */}
                <span className="block">{fixed(ws?.median_roc_auc, 2)}</span>
                <span className="block">{fixed(ws?.weighted_roc_auc, 2)}</span>
              </span>,
              <span key={`${m.id}-b`} className={`${cell} ${bold}`}>
                {fixed(m.pooled.brier, 3)}
              </span>
            ];
            if (station)
              row.push(
                <span key={`${m.id}-s`} className={`${cell} ${bold}`} title={m.analogue ? undefined : noStation(m.id)}>
                  {m.analogue ? fixed(m.analogue.roc_auc, 2) : '—'}
                </span>
              );
            // M1 published is not cross-validated and sits on other records: said beside its score.
            if (m.id === 'm1_published' && rest.length)
              row.push(
                <span key={`${m.id}-why`} className="col-span-full mb-0.5 text-2xs text-muted">
                  Not cross-validated: published coefficients scored on {count(m.n)} other records (base rate{' '}
                  {rate(m.pooled.base_rate)}, against {distinct(rest, r => count(r.n))} at{' '}
                  {distinct(rest, r => rate(r.pooled.base_rate))}); Fire over {m.per_fire.fires} fires (others{' '}
                  {distinct(rest, r => String(r.per_fire.fires))})
                  {basis === 'm1' ? (
                    <>
                      . Storm: every row on these {m.within_storm.groups} groups, like for like; AUC, Fire and Brier are not
                      like-for-like with the rows below.
                    </>
                  ) : (
                    <>
                      , Storm over {m.within_storm.groups} groups (others {restGroups}). Not like-for-like with the rows below
                      {likeForLike ? `: “M1’s ${m.within_storm.groups} groups” puts every Storm figure on its records.` : '.'}
                    </>
                  )}
                </span>
              );
            return row;
          })}
        </div>
        <StormIntervals ev={ev} basis={basis} shown={shown} refName={refName} />
        <div className="mt-1.5 space-y-1 text-2xs text-muted">
          <p>
            AUC: pooled ROC AUC (0.5 is chance), which mostly ranks records of different storms against each other · Fire:
            median of the per-fire ROC AUCs · Storm: ROC AUC within one fire and storm, the ranking a design-storm map shows,
            in two figures, the median over the groups (upper) and their record-weighted mean (lower) · Brier: pooled, lower
            is better
            {station ? ' · Station: ROC AUC on the held-out Station Fire' : ''}. Most within-storm groups are small, so the
            median lands on fractions with small denominators; the record-weighted mean is less coarse but leans on the
            largest storms, so read the two together. PR AUC is in each row’s tooltip. Bold: the row behind the selected
            column.
          </p>
          <p>
            {ev.cv.scheme === 'leave-one-fire-out' ? 'Leave-one-fire-out' : ev.cv.scheme} ({ev.cv.folds} folds): each fire's
            records are scored by a model fitted without that fire. {count(inv.used_records)} records from {inv.used_fires}{' '}
            fires ({count(inv.used_flows)} debris flows) of the inventory's {count(inv.records)} records from {inv.fires} fires.
          </p>
          {m1 && (
            <p>
              {evalShort(m1.id)} is {m1.label}: USGS’s map column applies these coefficients, while our M1 column is M1
              recalibrated, refitted on every usable record.
              {sameRecords ? ' The caveats give the trained models’ ROC AUCs on its records.' : ''}
            </p>
          )}
          {context && (
            <p>
              {evalShort(context.id)}: {context.label}, an evaluated variant that adds the neighbouring watersheds’ inputs
              (spatial context). It is not mapped.
              {plain && context.within_storm && plain.within_storm && (
                <>
                  {' '}
                  Within one storm it scores a median ROC AUC of {fixed(context.within_storm.median_roc_auc, 3)} against{' '}
                  {fixed(plain.within_storm.median_roc_auc, 3)} for {evalShort(plain.id)} without the context (record-weighted{' '}
                  {fixed(context.within_storm.weighted_roc_auc, 3)} against {fixed(plain.within_storm.weighted_roc_auc, 3)}).
                </>
              )}
            </p>
          )}
          {station && stats ? (
            <p>Station: {stats.analogue.note}</p>
          ) : (
            stats?.analogue &&
            !stats.analogue.fire && <p>No Station column for this fire. Inventory analogue: {stats.analogue.note}</p>
          )}
          <p>
            These scores are on past fires. No observed debris-flow records for this fire are in the data used here, so its map
            is compared with USGS's assessment, not checked against outcomes.
          </p>
          <p>
            Source:{' '}
            <a href={inv.url} target="_blank" rel="noreferrer" className="underline decoration-hairline">
              {inv.title}
            </a>{' '}
            ({inv.doi})
          </p>
        </div>
        {inv.filters.length > 0 && (
          <details className="mt-1 text-2xs text-muted">
            <summary className="cursor-pointer">Records used ({inv.filters.length} filters)</summary>
            <ul className="ml-3 mt-0.5 list-disc space-y-0.5">
              {inv.filters.map(f => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </>
  );
}

/** Both files' notes, verbatim. */
function Caveats({stats, ev}: {stats: DebrisFlowStats | null; ev: DebrisModelEval | null}) {
  const groups = [
    {file: 'debris_flow_stats.json', notes: stats?.notes ?? []},
    {file: 'debris_flow/model_eval.json', notes: ev?.notes ?? []}
  ].filter(g => g.notes.length);
  const n = groups.reduce((s, g) => s + g.notes.length, 0);
  const src = stats?.source;
  if (!n && !src) return null;
  return (
    <div className="border-t border-hairline px-3 py-2 text-xs">
      {n > 0 && (
        <details>
          <summary className="cursor-pointer font-medium">Caveats ({n})</summary>
          {groups.map(g => (
            <div key={g.file} className="mt-1">
              <div className="font-mono text-2xs text-muted">{g.file}</div>
              <ul className="ml-3 list-disc space-y-0.5 text-muted">
                {g.notes.map(note => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
      {src && (
        <div className={`text-2xs text-muted ${n ? 'mt-1.5' : ''}`}>
          Segments and USGS's likelihoods:{' '}
          <a href={src.url} target="_blank" rel="noreferrer" className="underline decoration-hairline">
            {src.title}
          </a>{' '}
          ({src.doi}, {src.license})
        </div>
      )}
    </div>
  );
}

export function RiskRail({fire}: {fire: FireData}) {
  const {segments, stats} = useRiskFiles(fire.base);
  const ev = useDebrisJson<DebrisModelEval>(MODEL_EVAL_URL);
  const selected = useUi(s => s.risk.segment);
  const seg = useMemo(
    () => (selected === null ? null : segments.data?.features.find(f => f.properties.id === selected) ?? null),
    [segments.data, selected]
  );
  const sc = stats.data?.scenario;
  return (
    <Card title="Post-fire debris flows" aside={<Chip tone="modeled">MODELED</Chip>}>
      <div className="space-y-1 px-3 pt-2 text-xs">
        <p>
          <span className="font-medium">Likelihood</span> is the modeled chance that a debris flow starts from a stream
          segment's upstream area if a storm with the chosen peak 15-minute rainfall falls on the burn scar.
        </p>
        <p className="text-muted">
          USGS's assessment (M1, Staley et al. 2017, published coefficients) is the reference. M1 recalibrated and the random
          forest are fitted on USGS's observed debris-flow inventory and give likelihoods under a design storm, so their levels
          depend on how its sub-inventories sampled storms without a debris flow. The random forest also depends on the
          scenario date and one soil-moisture value for the whole fire
          {sc ? ` (${sc.date}, ${sc.days_since_fire} days after the fire)` : ''}.
        </p>
      </div>
      <Controls />
      {segments.error && <Missing file="debris_flow.geojson" error={segments.error} />}
      <Agreement stats={stats.data} error={stats.error} />
      <SegmentDetail seg={seg} missingId={selected !== null && segments.data && !seg ? selected : null} />
      <ModelComparison ev={ev.data} error={ev.error} stats={stats.data} />
      <Caveats stats={stats.data} ev={ev.data} />
    </Card>
  );
}
