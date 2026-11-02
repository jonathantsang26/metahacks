/**
 * Risk tab dock: one segment's likelihood across USGS's design storms (every map column rises
 * with rainfall), the models' scores on USGS's observed inventory, and this fire's segments by
 * likelihood class under the selected storm (debris_flow_stats.json's counts). The side list
 * ranks the segments by the selected model at the selected storm.
 */
import {useMemo, useState, type ReactNode} from 'react';
import {FIRE_ID, type FireData} from '../data/fire';
import type {DebrisFlowSegments, DebrisFlowStats, DebrisModelEval, WithinStorm} from '../data/files';
import {DESIGN_I15, useUi, type RiskModel} from '../state/ui';
import {
  accumulationMm,
  analogueShown,
  classKey,
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
import {ChartEmpty, ChartFrame} from './charts';
import {useSize} from './scale';

/** Plot margins and axis text as in charts.tsx. */
const M = {l: 40, r: 8, t: 7, b: 14};
const AXIS_TEXT = {fontSize: 10, fill: 'var(--text-muted)'} as const;
/** Rough advance of 10px Inter, for trimming row labels to their column. */
const CHAR_PX = 5.2;
const [I_LO, I_HI] = [DESIGN_I15[0], DESIGN_I15[DESIGN_I15.length - 1]];

type Loaded<T> = {data: T | null; error: string | null};

/** Sizes the plot to its frame; renders nothing until the frame has been measured. */
function Plot({children}: {children: (w: number, h: number) => ReactNode}) {
  const [ref, {width, height}] = useSize<HTMLDivElement>();
  return (
    <div ref={ref} className="absolute inset-0">
      {width > 0 && height > 0 && (
        <svg width={width} height={height} className="block overflow-visible">
          {children(width, height)}
        </svg>
      )}
    </div>
  );
}

function empty<T>(file: string, s: Loaded<T>): ReactNode | null {
  if (s.error) return <ChartEmpty>{file} unavailable</ChartEmpty>;
  if (!s.data) return <ChartEmpty>Loading…</ChartEmpty>;
  return null;
}

const fixed = (v: number | null | undefined, d: number) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

const fit = (text: string, px: number) => {
  const n = Math.floor(px / CHAR_PX);
  return text.length <= n ? text : `${text.slice(0, Math.max(1, n - 1))}…`;
};

/** The segment at the median of a model's likelihoods under a storm (the lower one of an even count). */
function medianSegment(fc: DebrisFlowSegments, model: RiskModel, i15: number): Segment | null {
  const ranked = fc.features
    .map(f => ({f, p: likelihood(f.properties, model, i15)}))
    .filter((r): r is {f: Segment; p: number} => r.p !== null)
    .sort((a, b) => a.p - b.p);
  return ranked.length ? ranked[(ranked.length - 1) >> 1].f : null;
}

/** Segments with a value, ranked by a model's likelihood under a storm, ties to the larger upstream area. */
function ranked(fc: DebrisFlowSegments, model: RiskModel, i15: number) {
  return fc.features
    .map(f => ({f, p: likelihood(f.properties, model, i15)}))
    .filter((r): r is {f: Segment; p: number} => r.p !== null)
    .sort((a, b) => b.p - a.p || b.f.properties.area_km2 - a.f.properties.area_km2);
}

/** Likelihood (0–100%) against I15 for one segment, a line per model; a click on a storm selects it. */
function StormPlot({seg, w, h}: {seg: Segment; w: number; h: number}) {
  const {model, i15} = useUi(s => s.risk);
  const setRisk = useUi(s => s.setRisk);
  const x = (v: number) => M.l + ((v - I_LO) / (I_HI - I_LO)) * (w - M.l - M.r);
  const y = (p: number) => M.t + (1 - p) * (h - M.t - M.b);
  const lines = RISK_MODELS.map(m => {
    const pts = DESIGN_I15.map(v => ({v, p: likelihood(seg.properties, m.id, v)}));
    let d = '';
    let pen = false;
    for (const {v, p} of pts) {
      if (p === null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(v).toFixed(1)},${y(p).toFixed(1)}`;
      pen = true;
    }
    return {m, pts, d};
  });
  // The selected model's line and markers last, over the others, so the current storm's hollow
  // marker keeps its colour.
  const order = [...lines.filter(l => l.m.id !== model), ...lines.filter(l => l.m.id === model)];
  const col = (w - M.l - M.r) / (DESIGN_I15.length - 1);
  return (
    <>
      {[0, 0.5, 1].map((v, i) => (
        <g key={v}>
          <line
            x1={M.l}
            x2={w - M.r}
            y1={y(v)}
            y2={y(v)}
            stroke="var(--text)"
            strokeOpacity={i === 0 ? 0.25 : 0.1}
            strokeDasharray={i === 0 ? undefined : '2 3'}
          />
          <text x={M.l - 4} y={y(v)} textAnchor="end" dominantBaseline="middle" {...AXIS_TEXT}>
            {v * 100}
            {i === 2 ? '%' : ''}
          </text>
        </g>
      ))}
      {DESIGN_I15.map((v, i) => (
        <text key={v} x={x(v)} y={h - 2} textAnchor={i === 0 ? 'start' : i === DESIGN_I15.length - 1 ? 'end' : 'middle'} {...AXIS_TEXT}>
          {v}
        </text>
      ))}
      <line x1={x(i15)} x2={x(i15)} y1={M.t} y2={h - M.b} stroke="var(--text)" strokeOpacity={0.6} />
      {order.map(({m, d}) => (
        <path key={m.id} d={d} fill="none" stroke={m.color} strokeWidth={m.id === model ? 2.2 : 1.5} strokeLinejoin="round" />
      ))}
      {order.map(({m, pts}) => (
        <g key={m.id}>
          {pts.map(
            ({v, p}) =>
              p !== null && (
                <circle
                  key={v}
                  cx={x(v)}
                  cy={y(p)}
                  r={v === i15 ? 3.2 : 2}
                  fill={v === i15 ? 'var(--bg-chrome)' : m.color}
                  stroke={m.color}
                  strokeWidth={1.4}
                />
              )
          )}
        </g>
      ))}
      {/* Hit targets wider than the marks: one column per storm. */}
      {DESIGN_I15.map(v => (
        <rect
          key={v}
          x={x(v) - col / 2}
          y={M.t}
          width={col}
          height={h - M.t - M.b}
          fill="transparent"
          className="cursor-pointer"
          onClick={() => setRisk({i15: v})}
        >
          <title>
            {`I15 ${v} mm/h (${accumulationMm(v)} mm in 15 min)\n` +
              RISK_MODELS.map(m => `${m.label}: ${likelihoodText(likelihood(seg.properties, m.id, v))}`).join('\n')}
          </title>
        </rect>
      ))}
    </>
  );
}

/**
 * Segments of this fire on which M1 recalibrated's slope in R, Ct·T + Cf·F + Cs·S, is positive (it rises with
 * rainfall exactly there). Its form does not guarantee this once a refitted coefficient is negative.
 */
function m1Rising(fc: DebrisFlowSegments, stats: DebrisFlowStats | null): {up: number; n: number} | null {
  const c = stats?.m1_recalibrated;
  if (!c) return null;
  const up = fc.features.filter(({properties: p}) => c.Ct * p.T + c.Cf * p.F + c.Cs * p.S > 0).length;
  return {up, n: fc.features.length};
}

function StormChart({segments, stats, base}: {segments: Loaded<DebrisFlowSegments>; stats: DebrisFlowStats | null; base: string}) {
  const {model, i15, segment} = useUi(s => s.risk);
  const fc = segments.data;
  const m = riskModel(model);
  const m1 = useMemo(() => (fc ? m1Rising(fc, stats) : null), [fc, stats]);
  const picked = useMemo(() => {
    if (!fc) return null;
    const own = segment === null ? undefined : fc.features.find(f => f.properties.id === segment);
    return own ? {seg: own, median: false} : {seg: medianSegment(fc, model, i15), median: true};
  }, [fc, segment, model, i15]);
  const seg = picked?.seg ?? null;
  const which = seg && (picked!.median ? `median segment #${seg.properties.id} by ${m.short} at ${i15} mm/h` : `segment #${seg.properties.id}`);
  return (
    <ChartFrame
      title="Likelihood vs design storm"
      unit="I15, mm/h"
      modeled="Modeled debris-flow likelihood for one stream segment at each of USGS's design storms"
      value={seg && `#${seg.properties.id} · ${m.short} ${likelihoodText(likelihood(seg.properties, model, i15))}`}
      valueTitle={which ?? undefined}
      foot={
        <>
          {RISK_MODELS.map(r => (
            <span key={r.id} className="mr-2 whitespace-nowrap">
              <span style={{color: r.color}}>━</span> {r.short}
            </span>
          ))}
          {which && <span className="text-muted">· {which}</span>}
        </>
      }
      footTitle={
        `${which ? `Showing ${which}. ` : ''}` +
        (m1 && m1.up === m1.n
          ? `No line falls as rainfall rises on this fire: USGS’s by M1’s form with its published positive coefficients, M1 ` +
            `recalibrated because its rainfall slope (Ct·T + Cf·F + Cs·S) is positive on all ${m1.n.toLocaleString('en-US')} ` +
            'segments here (its form alone does not guarantee that; step 15 checks it), and the random forest by its constraint. '
          : 'USGS’s line never falls as rainfall rises, by M1’s form with its published positive coefficients, nor the random ' +
            'forest’s, by its constraint; M1 recalibrated rises only where its rainfall slope (Ct·T + Cf·F + Cs·S) is positive' +
            (m1 ? `: ${m1.up.toLocaleString('en-US')} of ${m1.n.toLocaleString('en-US')} segments here. ` : '. ')) +
        'M1 recalibrated and the random forest are calibrated to USGS’s observed inventory, so their levels sit apart from ' +
        'USGS’s partly because of the records each was fitted on; the random forest also depends on the scenario date and ' +
        'one soil-moisture value. The MLPs are not plotted: nothing constrains them to rise with rainfall. ' +
        "No segment selected shows the segment at the median of the selected model's " +
        'likelihoods under the selected storm. Click a storm column to select that storm; click a segment on the map to plot it.'
      }
      files={[{name: 'debris_flow.geojson', href: `${base}/debris_flow.geojson`}]}
    >
      {empty('debris_flow.geojson', segments) ??
        (seg ? (
          <Plot>{(w, h) => <StormPlot seg={seg} w={w} h={h} />}</Plot>
        ) : (
          <ChartEmpty>No {m.short} likelihoods in debris_flow.geojson</ChartEmpty>
        ))}
    </ChartFrame>
  );
}

/** Fits the longest short row name ("M1 recalibrated", 15 characters at CHAR_PX) after a 6 px swatch. */
const SKILL_LABEL_PX = 104;
/** A debris-flow base rate with one decimal (9.8% against 12.5%). */
const rate = (v: number) => (finite(v) ? `${(v * 100).toFixed(1)}%` : '—');

/**
 * Which records the within-storm marks are on: each row's own (M1 published on the fewer outside
 * the inventory it was fitted on), or M1 published's for every row, like for like.
 */
type StormBasis = 'own' | 'm1';
const stormOf = (m: DebrisModelEval['models'][number], basis: StormBasis): WithinStorm | undefined =>
  basis === 'm1' ? m.within_storm_on_m1_records : m.within_storm;
const interval = (c: [number, number] | undefined) => (c ? ` [${fixed(c[0], 2)}–${fixed(c[1], 2)}]` : '');

/**
 * A 95% interval as an open box around the row's centre line: a box, not lines above and below the
 * bar, because the rows sit a few pixels apart and a line between two rows reads as either's.
 */
function Interval({x0, x1, cy, hh}: {x0: number; x1: number; cy: number; hh: number}) {
  return (
    <rect
      x={x0}
      y={cy - hh}
      width={Math.max(1, x1 - x0)}
      height={2 * hh}
      rx={1.5}
      fill="none"
      stroke="var(--text)"
      strokeOpacity={0.55}
      strokeWidth={1}
    />
  );
}

/**
 * Pooled ROC AUC per model as bars, the per-fire IQR as a whisker, the within-storm median as a
 * ring, with its 95% interval as an open box, and its record-weighted mean as a dot (its interval
 * in the tooltip), and (on a fire whose analogue it is) the held-out Station Fire as a diamond. A
 * swatch in the storm chart's colour marks the rows behind the map's columns.
 */
function SkillPlot({ev, station, basis, w, h}: {ev: DebrisModelEval; station: boolean; basis: StormBasis; w: number; h: number}) {
  const shown = riskModel(useUi(s => s.risk.model)).evalId;
  const x = (v: number) => SKILL_LABEL_PX + v * (w - SKILL_LABEL_PX - M.r);
  const rowH = (h - M.t - M.b) / ev.models.length;
  const barH = Math.max(3, Math.min(9, rowH - 4));
  return (
    <>
      {[0, 0.5, 1].map((v, i) => (
        <g key={v}>
          <line
            x1={x(v)}
            x2={x(v)}
            y1={M.t}
            y2={h - M.b}
            stroke="var(--text)"
            strokeOpacity={i === 0 ? 0.25 : 0.12}
            strokeDasharray={i === 0 ? undefined : '2 3'}
          />
          <text x={x(v)} y={h - 2} textAnchor={i === 2 ? 'end' : 'middle'} {...AXIS_TEXT}>
            {i === 1 ? '0.5 chance' : v}
          </text>
        </g>
      ))}
      {ev.models.map((m, i) => {
        const cy = M.t + rowH * (i + 0.5);
        const on = m.id === shown;
        const [q1, q3] = m.per_fire.iqr;
        const a = station ? m.analogue : null;
        const ws = stormOf(m, basis);
        const [cm, cw] = [ws?.ci95_median, ws?.ci95_weighted];
        const col = columnForEval(m.id);
        const role = m.on_map
          ? `\nOn the map as ${col?.label ?? 'one of our columns'}`
          : col?.id === 'usgs'
            ? "\nThe published coefficients behind USGS's own column (the reference); not cross-validated"
            : m.features.some(f => f.startsWith('ctx_'))
              ? '\nSpatial-context variant: scored, not mapped'
              : '\nScored, not mapped';
        return (
          <g key={m.id}>
            <title>
              {`${m.label} (${m.id})${role}\nPooled ROC AUC ${fixed(m.pooled.roc_auc, 2)} (${m.n.toLocaleString('en-US')} records, ` +
                `${m.flows.toLocaleString('en-US')} flows, base rate ${rate(m.pooled.base_rate)})\nPer-fire ROC AUC over ` +
                `${m.per_fire.fires} fires: median ${fixed(m.per_fire.median_roc_auc, 2)}, IQR ${fixed(q1, 2)}–${fixed(q3, 2)}` +
                (ws
                  ? `\nWithin one fire and storm (${ws.groups} groups, ${ws.records.toLocaleString('en-US')} records` +
                    `${basis === 'm1' ? ", M1 published's" : ''}): median ${fixed(ws.median_roc_auc, 2)}${interval(cm)}, ` +
                    `record-weighted ${fixed(ws.weighted_roc_auc, 2)}${interval(cw)} (95% intervals)`
                  : '') +
                (!station
                  ? ''
                  : a
                    ? `\n${a.fire} (${a.year}, held out): ROC AUC ${fixed(a.roc_auc, 2)}, ${a.n} records, ${a.flows} flows`
                    : m.id === 'm1_published'
                      ? '\nNo Station Fire score: its records are in the Staley et al. (2016) inventory M1 was fitted on'
                      : '\nNo Station Fire score in model_eval.json')}
            </title>
            {col && <rect x={2} y={cy - 3} width={6} height={6} rx={1} fill={col.color} />}
            <text
              x={SKILL_LABEL_PX - 6}
              y={cy}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={10}
              fontWeight={on ? 600 : 400}
              fill={on || m.on_map ? 'var(--text)' : 'var(--text-muted)'}
            >
              {fit(evalShort(m.id), SKILL_LABEL_PX - 18)}
            </text>
            {finite(m.pooled.roc_auc) && (
              <rect
                x={x(0)}
                y={cy - barH / 2}
                width={Math.max(0, x(m.pooled.roc_auc) - x(0))}
                height={barH}
                rx={2}
                fill="var(--chart-elev-stroke)"
                fillOpacity={on ? 0.6 : 0.32}
              />
            )}
            {finite(q1) && finite(q3) && (
              <g stroke="var(--text)" strokeWidth={1.2}>
                <line x1={x(q1)} x2={x(q3)} y1={cy} y2={cy} />
                <line x1={x(q1)} x2={x(q1)} y1={cy - 3} y2={cy + 3} />
                <line x1={x(q3)} x2={x(q3)} y1={cy - 3} y2={cy + 3} />
              </g>
            )}
            {cm && finite(cm[0]) && finite(cm[1]) && <Interval x0={x(cm[0])} x1={x(cm[1])} cy={cy} hh={barH / 2 + 1} />}
            {ws && finite(ws.median_roc_auc) && (
              <circle cx={x(ws.median_roc_auc)} cy={cy} r={3} fill="var(--bg-chrome)" stroke="var(--text)" strokeWidth={1.4} />
            )}
            {/* Over the ring, so both show where they coincide; haloed like the diamond, so it stands off the whisker. */}
            {ws && finite(ws.weighted_roc_auc) && (
              <circle cx={x(ws.weighted_roc_auc)} cy={cy} r={2} fill="var(--text)" stroke="var(--bg-chrome)" strokeWidth={1} />
            )}
            {a && finite(a.roc_auc) && (
              <path
                d={`M${x(a.roc_auc)},${cy - 4.5}l4,4.5l-4,4.5l-4,-4.5Z`}
                fill="var(--accent)"
                stroke="var(--bg-chrome)"
                strokeWidth={1}
              />
            )}
          </g>
        );
      })}
    </>
  );
}

function SkillChart({ev, stats}: {ev: Loaded<DebrisModelEval>; stats: DebrisFlowStats | null}) {
  const shown = riskModel(useUi(s => s.risk.model));
  const row = ev.data?.models.find(m => m.id === shown.evalId);
  const station = analogueShown(stats, ev.data);
  const analogue = station ? ev.data?.models.find(m => m.analogue)?.analogue : undefined;
  // Each row's records and base rate, for the foot: M1 published is scored on fewer records.
  const sets = ev.data
    ? [...new Set(ev.data.models.map(m => `${m.n.toLocaleString('en-US')} records at ${rate(m.pooled.base_rate)}`))]
    : [];
  const perRow =
    ev.data && sets.length > 1
      ? ' The rows are not all on the same records: ' +
        ev.data.models.map(m => `${evalShort(m.id)} ${m.n.toLocaleString('en-US')} records, base rate ${rate(m.pooled.base_rate)}`).join('; ') +
        '.'
      : '';
  const analogueNote = stats?.analogue && !stats.analogue.fire ? ` No Station Fire marker for this fire: ${stats.analogue.note}` : '';
  // The within-storm marks on each row's records, or every row on M1 published's (like for like).
  const [basisPicked, setBasis] = useState<StormBasis>('own');
  const m1 = ev.data?.models.find(m => m.id === 'm1_published');
  const others = [...new Set(ev.data?.models.filter(m => m !== m1).map(m => m.within_storm.groups))].join(' / ');
  const likeForLike = !!m1 && !!ev.data?.models.every(m => m.within_storm_on_m1_records);
  const basis: StormBasis = likeForLike ? basisPicked : 'own';
  const ws = row && stormOf(row, basis);
  return (
    <ChartFrame
      title="Skill on past fires"
      unit="ROC AUC"
      modeled={
        ev.data
          ? `${ev.data.cv.scheme} cross-validation on USGS's observed postfire debris-flow inventory: ` +
            `${ev.data.inventory.used_records.toLocaleString('en-US')} records from ${ev.data.inventory.used_fires} fires`
          : 'Cross-validation on USGS’s observed postfire debris-flow inventory'
      }
      value={
        row &&
        `${shown.short} ${fixed(row.pooled.roc_auc, 2)} · storm ${fixed(ws?.median_roc_auc, 2)} / ${fixed(ws?.weighted_roc_auc, 2)}`
      }
      valueTitle={
        row
          ? `${row.label}: pooled ROC AUC, then ROC AUC within one fire and storm, median${interval(ws?.ci95_median)} / ` +
            `record-weighted mean${interval(ws?.ci95_weighted)} over ${ws?.groups ?? ''} groups` +
            `${basis === 'm1' ? " (M1 published's)" : ''}, with 95% intervals (the eval row behind the map's ${shown.label} colours)`
          : undefined
      }
      foot={
        <>
          {likeForLike && (
            <button
              onClick={() => setBasis(basis === 'm1' ? 'own' : 'm1')}
              title={
                basis === 'm1'
                  ? `Within-storm marks: every row on M1 published's ${m1!.within_storm.groups} groups, like for like. Click for each row's own records`
                  : `Within-storm marks: each row's own records (M1 published's ${m1!.within_storm.groups} groups, the others' ` +
                    `${others}). Click to put every row on M1 published's`
              }
              className="mr-1 rounded bg-card px-1 text-ink shadow-[0_0_0_1px_var(--hairline)]"
            >
              storm: {basis === 'm1' ? `M1’s ${m1!.within_storm.groups} groups` : 'own records'}
            </button>
          )}
          bar pooled · ⊢⊣ per-fire IQR · ○ within-storm median, ▭ its 95% interval · ● record-weighted
          {analogue ? (
            <>
              {' '}
              · <span className="text-accent">◆</span> {analogue.fire} ({analogue.year}, held out)
            </>
          ) : (
            stats?.analogue && !stats.analogue.fire && ' · no inventory analogue for this fire'
          )}
        </>
      }
      footTitle={
        'Bar: ROC AUC of all held-out predictions pooled, which mostly ranks records of different storms against each other. ' +
        'Whisker: interquartile range of the per-fire ROC AUCs. Ring: median ROC AUC within one fire and storm, the ranking a ' +
        'design-storm map shows; dot: the record-weighted mean of the same. Most groups are small, so a median lands on ' +
        'fractions with small denominators; the record-weighted mean is less coarse but leans on the largest storms. Read ' +
        'the two together (model_eval.json’s notes give the group sizes). Box: the median’s 95% interval, from a cluster ' +
        'bootstrap that redraws whole fire-storm groups (each row’s tooltip gives both intervals; the notes say which paired ' +
        'differences from M1 exclude 0). The storm button puts every row’s within-storm marks on M1 published’s records, ' +
        'like for like (the bar and whisker stay on each row’s own).' +
        (analogue ? ` Diamond: the held-out ${analogue.fire} Fire (${analogue.year}), this fire's inventory analogue.` : '') +
        ' Swatch: the rows behind the map’s columns, in the storm chart’s colours (M1 published: the coefficients behind ' +
        'USGS’s own column). Each fire is scored by a model fitted without it; M1 published is not cross-validated and is ' +
        'scored only on records outside the Staley et al. (2016) inventory it was fitted on, so its bar is not like-for-like ' +
        'with the others.' +
        perRow +
        analogueNote +
        ' These are past fires, not this one.'
      }
      files={[{name: 'model_eval.json', href: MODEL_EVAL_URL}]}
    >
      {empty('model_eval.json', ev) ??
        (ev.data!.models.length ? (
          <Plot>{(w, h) => <SkillPlot ev={ev.data!} station={station} basis={basis} w={w} h={h} />}</Plot>
        ) : (
          <ChartEmpty>model_eval.json lists no models</ChartEmpty>
        ))}
    </ChartFrame>
  );
}

/** Fits the longest short column name ("M1 recalibrated", 15 characters at CHAR_PX). */
const CLASS_LABEL_PX = 92;

/** Each map column's segments by likelihood class at the selected storm (debris_flow_stats.json's counts). */
function ClassPlot({stats, w, h}: {stats: DebrisFlowStats; w: number; h: number}) {
  const {model, i15} = useUi(s => s.risk);
  const rows = useMemo(() => {
    const at = stats.likelihood_class_counts?.[String(i15)] ?? {};
    return RISK_MODELS.map(m => {
      const c = at[m.id];
      const counts = c ? LIKELIHOOD_CLASSES.map((_, k) => c[classKey(k)] ?? 0) : null;
      // Segments the file's counts leave out (none when every segment has a value): grey.
      if (counts) counts.push(Math.max(0, stats.segments - counts.reduce((a, b) => a + b, 0)));
      return {m, counts};
    });
  }, [stats, i15]);
  const means = stats.mean_likelihood?.[String(i15)] ?? {};
  const n = stats.segments;
  const x = (k: number) => CLASS_LABEL_PX + (k / n) * (w - CLASS_LABEL_PX - M.r);
  const rowH = (h - M.t - M.b) / rows.length;
  const barH = Math.max(4, Math.min(12, rowH - 4));
  const pieces = [...LIKELIHOOD_CLASSES, NO_VALUE];
  return (
    <>
      {[0, n].map((v, i) => (
        <text key={v} x={x(v)} y={h - 2} textAnchor={i ? 'end' : 'start'} {...AXIS_TEXT}>
          {i ? `${n.toLocaleString('en-US')} segments` : 0}
        </text>
      ))}
      {rows.map(({m, counts}, i) => {
        const cy = M.t + rowH * (i + 0.5);
        const mean = means[m.id];
        let at = 0;
        return (
          <g key={m.id}>
            <text
              x={CLASS_LABEL_PX - 6}
              y={cy}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={10}
              fontWeight={m.id === model ? 600 : 400}
              fill={m.id === model ? 'var(--text)' : 'var(--text-muted)'}
            >
              {fit(m.short, CLASS_LABEL_PX - 8)}
              <title>{`${m.label}${finite(mean) ? ` · mean likelihood ${likelihoodText(mean)}` : ''}`}</title>
            </text>
            {!counts ? (
              <text x={x(0)} y={cy} dominantBaseline="middle" {...AXIS_TEXT}>
                no counts in debris_flow_stats.json
              </text>
            ) : (
              counts.map((c, k) => {
                const x0 = x(at);
                at += c;
                if (!c) return null;
                // A 2px surface gap after every piece but the last.
                const wPx = Math.max(1, x(at) - x0 - (at < n ? 2 : 0));
                return (
                  <g key={k}>
                    <rect x={x0} y={cy - barH / 2} width={wPx} height={barH} rx={1.5} fill={pieces[k].css}>
                      <title>{`${m.label} at I15 ${i15} mm/h · ${pieces[k].label}: ${c.toLocaleString('en-US')} of ${n.toLocaleString('en-US')} segments`}</title>
                    </rect>
                    {wPx >= 26 && barH >= 10 && (
                      <text
                        x={x0 + wPx / 2}
                        y={cy}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={9}
                        fill={k === 0 || k === 5 ? 'var(--text)' : '#ffffff'}
                        pointerEvents="none"
                      >
                        {c}
                      </text>
                    )}
                  </g>
                );
              })
            )}
          </g>
        );
      })}
    </>
  );
}

function ClassChart({stats, base}: {stats: Loaded<DebrisFlowStats>; base: string}) {
  const i15 = useUi(s => s.risk.i15);
  const counted = !!stats.data?.likelihood_class_counts?.[String(i15)];
  return (
    <ChartFrame
      title="Segments by likelihood class"
      unit={`I15 ${i15} mm/h`}
      modeled="Counts of this fire's USGS stream segments in each modeled likelihood class, per map column"
      value={stats.data && `${stats.data.segments.toLocaleString('en-US')} segments`}
      foot={
        <>
          {LIKELIHOOD_CLASSES.map(c => (
            <span key={c.label} className="mr-1.5 whitespace-nowrap">
              <span className="mr-0.5 inline-block h-2 w-2 rounded-sm align-[-1px]" style={{background: c.css}} />
              {c.label}
            </span>
          ))}
        </>
      }
      footTitle={
        `Likelihood classes at I15 ${i15} mm/h (${accumulationMm(i15)} mm in 15 min), from debris_flow_stats.json's ` +
        'likelihood_class_counts for this storm. M1 recalibrated and the random forest are calibrated to USGS’s observed ' +
        'inventory, so their classes differ from USGS’s partly because of the records each was fitted on. ' +
        'Hover a bar for its count, a row name for its mean likelihood.'
      }
      files={[{name: 'debris_flow_stats.json', href: `${base}/debris_flow_stats.json`}]}
    >
      {empty('debris_flow_stats.json', stats) ??
        (counted && stats.data!.segments > 0 ? (
          <Plot>{(w, h) => <ClassPlot stats={stats.data!} w={w} h={h} />}</Plot>
        ) : (
          <ChartEmpty>debris_flow_stats.json has no class counts at I15 {i15} mm/h</ChartEmpty>
        ))}
    </ChartFrame>
  );
}

export function RiskCharts({fire}: {fire: FireData}) {
  const {segments, stats} = useRiskFiles(fire.base);
  const ev = useDebrisJson<DebrisModelEval>(MODEL_EVAL_URL);
  return (
    <>
      <StormChart segments={segments} stats={stats.data} base={fire.base} />
      <SkillChart ev={ev} stats={stats.data} />
      <ClassChart stats={stats} base={fire.base} />
    </>
  );
}

const TOP = 10;

/**
 * Top segments under the selected model and storm; a click selects one and flies to it. Dock
 * renders this without props, so the fire falls back to the page's `?fire=` one (the same base
 * useFireData loads from).
 */
export function RiskSide({fire}: {fire?: FireData}) {
  const {segments} = useRiskFiles(fire?.base ?? `/data/${FIRE_ID}`);
  const {model, i15, segment} = useUi(s => s.risk);
  const setRisk = useUi(s => s.setRisk);
  const requestFlyTo = useUi(s => s.requestFlyTo);
  const fc = segments.data;
  const all = useMemo(() => (fc ? ranked(fc, model, i15) : []), [fc, model, i15]);
  const m = riskModel(model);
  if (segments.error) return <div className="px-3 py-6 text-center text-sm text-muted">debris_flow.geojson unavailable</div>;
  if (!fc) return <div className="px-3 py-6 text-center text-sm text-muted">Loading…</div>;
  if (!all.length)
    return <div className="px-3 py-6 text-center text-sm text-muted">No {m.short} likelihoods at I15 {i15} mm/h in debris_flow.geojson</div>;
  return (
    <>
      <div className="px-3 pt-1.5 text-2xs text-muted">
        Top {Math.min(TOP, all.length)} of {all.length.toLocaleString('en-US')} by {m.short} at I15 {i15} mm/h
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {all.slice(0, TOP).map(({f, p}, i) => {
          const id = f.properties.id;
          const on = id === segment;
          return (
            <li key={id}>
              <button
                onClick={() => {
                  setRisk({segment: id});
                  const [lon, lat] = segmentMidpoint(f.geometry.coordinates);
                  requestFlyTo(lon, lat, 14);
                }}
                title={`Segment #${id}: ${m.label} ${likelihoodText(p)} at I15 ${i15} mm/h, upstream area ${f.properties.area_km2.toFixed(2)} km²`}
                className={`flex w-full items-center gap-2 px-3 py-1 text-left ${on ? 'bg-selected' : 'hover:bg-tabgroup'}`}
              >
                <span className="w-4 shrink-0 text-right text-2xs tabular-nums text-muted">{i + 1}</span>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{background: LIKELIHOOD_CLASSES[classOf(p)].css}} />
                <span className={`flex-1 text-xs ${on ? 'font-semibold' : 'font-medium'}`}>#{id}</span>
                <span className="text-2xs tabular-nums text-muted">{f.properties.area_km2.toFixed(2)} km²</span>
                <span className="w-8 shrink-0 text-right text-xs font-medium tabular-nums">{likelihoodText(p)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
