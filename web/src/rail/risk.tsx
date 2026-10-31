/**
 * Risk tab rail: post-fire debris-flow likelihood. The model and design-storm controls drive the
 * map, the dock and the side list; below them, how each model compares with USGS's assessment on
 * this fire, the selected segment's inputs, and the models' scores on USGS's observed inventory.
 */
import {useMemo} from 'react';
import type {FireData} from '../data/fire';
import type {DebrisFlowStats, DebrisModelEval} from '../data/files';
import {DESIGN_I15, useUi} from '../state/ui';
import {
  accumulationMm,
  classOf,
  evalShort,
  LIKELIHOOD_CLASSES,
  likelihood,
  likelihoodText,
  MODEL_EVAL_URL,
  modelForKey,
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

const HAZARD = {1: 'Low', 2: 'Moderate', 3: 'High'} as const;
const fixed = (v: number | null | undefined, d: number) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
/** A share that the file may write as 0–1 or as a percentage. */
const share = (v: number) => (v <= 1 ? pct(v) : `${Math.round(v)}%`);
/** A debris-flow base rate with one decimal: 9.8% and 12.5% read as different, 10% and 13% overstate it. */
const rate = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
/** Why a model_eval.json row has no Station Fire score (model_eval.json's notes give M1's reason). */
const noStation = (id: string) =>
  id === 'm1_published'
    ? 'No Station Fire score: its records are in the Staley et al. (2016) inventory M1 was fitted on'
    : 'No Station Fire score in model_eval.json';
/** m1_check's largest difference, in likelihood units: tiny values in scientific notation. */
const tiny = (v: number) => (v === 0 ? '0' : v < 0.001 ? v.toExponential(1) : v.toFixed(3));

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
        <div className="grid grid-cols-2 gap-1">
          {RISK_MODELS.map(m => (
            <button
              key={m.id}
              onClick={() => setRisk({model: m.id})}
              className={`rounded-md px-2 py-1 text-left text-sm ${model === m.id ? on : off}`}
            >
              {m.label}
            </button>
          ))}
        </div>
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

/** This fire: each model's agreement with USGS at 24 mm/h, the M1 implementation check and the ML scenario. */
function Agreement({stats, error}: {stats: DebrisFlowStats | null; error: string | null}) {
  const head = <SubHead>Compared with USGS on this fire</SubHead>;
  if (!stats)
    return (
      <>
        {head}
        <Missing file="debris_flow_stats.json" error={error} />
      </>
    );
  const rows = Object.entries(stats.agreement);
  const sc = stats.scenario;
  const th = stats.usgs_median_thresholds_mm_h;
  return (
    <>
      {head}
      <div className="px-3 py-2 text-xs">
        {rows.length ? (
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 tabular-nums">
            <span className="text-muted">Model vs USGS, I15 24 mm/h</span>
            <span className="text-right text-muted" title="Spearman rank correlation of segment likelihoods with USGS's">
              Spearman
            </span>
            <span className="text-right text-muted" title="Share of segments in the same likelihood class as USGS's">
              Same class
            </span>
            {rows.map(([key, a]) => [
              <span key={`${key}-n`}>{modelForKey(key)?.label ?? key}</span>,
              <span key={`${key}-r`} className="text-right">
                {fixed(a.spearman_vs_usgs_24, 2)}
              </span>,
              <span key={`${key}-c`} className="text-right">
                {Number.isFinite(a.class_agreement_24) ? share(a.class_agreement_24) : '—'}
              </span>
            ])}
          </div>
        ) : (
          <div className="text-muted">debris_flow_stats.json lists no agreement figures.</div>
        )}
        <div className="mt-1.5 text-muted">
          Implementation check, not a validation: our M1 reproduces USGS's likelihoods to within{' '}
          <span className="text-ink">{tiny(stats.m1_check.max_abs_diff_vs_usgs)}</span> (largest absolute difference,
          likelihood 0–1) over {stats.segments.toLocaleString('en-US')} segments.
        </div>
        <div className="mt-1.5 text-muted">
          RF and MLP also need the storm's timing and soil wetness, so their columns use one scenario:{' '}
          <span className="text-ink">
            {sc.date}, {sc.days_since_fire} days after the fire, soil moisture (0–7 cm){' '}
            {sc.soil_moisture_0_7cm === null ? 'not available' : `${sc.soil_moisture_0_7cm.toFixed(3)} m³/m³`}
          </span>{' '}
          ({sc.soil_moisture_source}).
        </div>
        <div className="mt-1.5 text-muted">
          USGS's median rainfall thresholds across segments: 50% likelihood at I15{' '}
          <span className="text-ink">{fixed(th.I15_50, 1)} mm/h</span>, 75% at{' '}
          <span className="text-ink">{fixed(th.I15_75, 1)} mm/h</span>.
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

/** model_eval.json: every model scored leave-one-fire-out on USGS's observed inventory. */
function ModelComparison({ev, error}: {ev: DebrisModelEval | null; error: string | null}) {
  const model = useUi(s => s.risk.model);
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
  const mapped = (id: string) => RISK_MODELS.filter(m => m.evalId === id).map(m => m.short);
  const m1 = ev.models.find(m => m.id === 'm1_published');
  // The trained models' records and base rate, to say how M1 published's row differs from theirs.
  const rest = ev.models.filter(m => m.id !== 'm1_published');
  const restN = [...new Set(rest.map(m => m.n.toLocaleString('en-US')))].join(' / ');
  const restRate = [...new Set(rest.map(m => rate(m.pooled.base_rate)))].join(' / ');
  const unlike = m1 && rest.some(m => m.n !== m1.n || m.pooled.base_rate !== m1.pooled.base_rate);
  // A note that scores the trained models on M1's own records (it names their count).
  const sameRecords = m1 && ev.notes.some(n => n.includes(m1.n.toLocaleString('en-US')) && rest.some(m => n.includes(m.id)));
  const analogue = ev.models.find(m => m.analogue)?.analogue ?? null;
  const cell = 'text-right';
  return (
    <>
      {head}
      <div className="px-3 py-2 text-xs">
        <div className="grid grid-cols-[minmax(0,1fr)_repeat(5,auto)] gap-x-1.5 tabular-nums">
          <span className="text-muted">Model</span>
          <span className={`${cell} text-muted`} title="Pooled ROC AUC: all held-out predictions together (higher is better; 0.5 is chance)">
            AUC
          </span>
          <span className={`${cell} text-muted`} title="Pooled precision-recall AUC (higher is better; a no-skill model scores the base rate)">
            PR
          </span>
          <span className={`${cell} text-muted`} title="Pooled Brier score (lower is better)">
            Brier
          </span>
          <span className={`${cell} text-muted`} title="Median of the per-fire ROC AUCs">
            Fire
          </span>
          <span className={`${cell} text-muted`} title="ROC AUC on the held-out Station Fire">
            Station
          </span>
          {ev.models.map(m => {
            const bold = m.id === shown ? 'font-semibold' : '';
            const on = mapped(m.id);
            const title =
              `${m.label} (${m.id})\nFeatures: ${m.features.join(', ')}\n${m.n.toLocaleString('en-US')} records, ` +
              `${m.flows.toLocaleString('en-US')} debris flows, base rate ${rate(m.pooled.base_rate)}\n` +
              `Per-fire ROC AUC over ${m.per_fire.fires} fires: median ${fixed(m.per_fire.median_roc_auc, 2)}, IQR ` +
              `${fixed(m.per_fire.iqr[0], 2)}–${fixed(m.per_fire.iqr[1], 2)}` +
              (m.analogue
                ? `\nStation Fire: ${m.analogue.n} records, ${m.analogue.flows} flows, Brier ${fixed(m.analogue.brier, 3)}`
                : `\n${noStation(m.id)}`);
            return [
              <span key={`${m.id}-n`} className={`min-w-0 ${bold}`} title={title}>
                <span className="block truncate">{evalShort(m.id)}</span>
                {on.length > 0 && <span className="block truncate text-2xs font-normal text-muted">on the map: {on.join(', ')}</span>}
              </span>,
              <span key={`${m.id}-a`} className={`${cell} ${bold}`}>
                {fixed(m.pooled.roc_auc, 2)}
              </span>,
              <span key={`${m.id}-p`} className={`${cell} ${bold}`}>
                {fixed(m.pooled.pr_auc, 2)}
              </span>,
              <span key={`${m.id}-b`} className={`${cell} ${bold}`}>
                {fixed(m.pooled.brier, 3)}
              </span>,
              <span key={`${m.id}-f`} className={`${cell} ${bold}`}>
                {fixed(m.per_fire.median_roc_auc, 2)}
              </span>,
              <span key={`${m.id}-s`} className={`${cell} ${bold}`} title={m.analogue ? undefined : noStation(m.id)}>
                {m.analogue ? fixed(m.analogue.roc_auc, 2) : '—'}
              </span>
            ];
          })}
        </div>
        <div className="mt-1.5 space-y-1 text-2xs text-muted">
          <p>
            AUC: pooled ROC AUC (0.5 is chance) · PR: pooled precision-recall AUC · Brier: pooled, lower is better · Fire:
            median of the per-fire ROC AUCs · Station: ROC AUC on the held-out Station Fire. Bold: the row behind the map's
            colours.
          </p>
          <p>
            {ev.cv.scheme === 'leave-one-fire-out' ? 'Leave-one-fire-out' : ev.cv.scheme} ({ev.cv.folds} folds): each fire's
            records are scored by a model fitted without that fire. {inv.used_records.toLocaleString('en-US')} records from{' '}
            {inv.used_fires} fires ({inv.used_flows.toLocaleString('en-US')} debris flows) of the inventory's{' '}
            {inv.records.toLocaleString('en-US')} records from {inv.fires} fires.
          </p>
          {m1 && (
            <p>
              {m1.label} uses USGS's published coefficients and is scored only on the {m1.n.toLocaleString('en-US')} records (
              {m1.flows.toLocaleString('en-US')} flows) outside the 2016 inventory it was fitted on. USGS's assessment and our
              implementation both apply it.
              {unlike && (
                <>
                  {' '}
                  Its row is therefore on other records and another base rate ({rate(m1.pooled.base_rate)} debris flows, against{' '}
                  {restRate} on the others' {restN} records), so it is not like-for-like with the other rows: PR AUC and Brier
                  depend on the base rate.{sameRecords ? ' The caveats give the trained models’ ROC AUCs on its records.' : ''}
                </>
              )}
              {!m1.analogue && ' It has no Station score: that fire’s records are in the inventory it was fitted on.'}
            </p>
          )}
          {analogue && (
            <p>
              Station: the {/fire$/i.test(analogue.fire) ? analogue.fire : `${analogue.fire} Fire`} ({analogue.year}, San Gabriel
              front), held out as its own fold:{' '}
              {analogue.n.toLocaleString('en-US')} records, {analogue.flows.toLocaleString('en-US')} flows.
            </p>
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
  return (
    <Card title="Post-fire debris flows" aside={<Chip tone="modeled">MODELED</Chip>}>
      <div className="space-y-1 px-3 pt-2 text-xs">
        <p>
          <span className="font-medium">Likelihood</span> is the modeled chance that a debris flow starts from a stream
          segment's upstream area if a storm with the chosen peak 15-minute rainfall falls on the burn scar.
        </p>
        <p className="text-muted">
          USGS's assessment (M1 model, Staley et al. 2017) is the reference; our M1 implementation, random forest and MLP
          are compared with it.
        </p>
      </div>
      <Controls />
      {segments.error && <Missing file="debris_flow.geojson" error={segments.error} />}
      <Agreement stats={stats.data} error={stats.error} />
      <SegmentDetail seg={seg} missingId={selected !== null && segments.data && !seg ? selected : null} />
      <ModelComparison ev={ev.data} error={ev.error} />
      <Caveats stats={stats.data} ev={ev.data} />
    </Card>
  );
}
