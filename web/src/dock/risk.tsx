/**
 * Risk tab dock: one segment's likelihood across USGS's design storms, the models' scores on
 * USGS's observed inventory, and this fire's segments by likelihood class under the selected
 * storm. The side list ranks the segments by the selected model at the selected storm.
 */
import {useMemo, type ReactNode} from 'react';
import {FIRE_ID, type FireData} from '../data/fire';
import type {DebrisFlowSegments, DebrisModelEval} from '../data/files';
import {DESIGN_I15, useUi, type RiskModel} from '../state/ui';
import {
  accumulationMm,
  classOf,
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
  // Markers: the selected model last, so the current storm's hollow marker keeps its colour. Lines:
  // the selected model over the others, and a dashed line over everything: our M1 equals USGS's
  // likelihoods by construction, and under USGS's solid line it would not show at all.
  const rest = lines.filter(l => l.m.id !== model);
  const markerOrder = [...rest, ...lines.filter(l => l.m.id === model)];
  const lineOrder = [
    ...rest.filter(l => !l.m.dashed),
    ...lines.filter(l => l.m.id === model),
    ...rest.filter(l => l.m.dashed)
  ];
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
      {lineOrder.map(({m, d}) => (
        <path
          key={m.id}
          d={d}
          fill="none"
          stroke={m.color}
          strokeWidth={m.id === model ? 2.2 : 1.5}
          strokeDasharray={m.dashed ? '4 3' : undefined}
          strokeLinejoin="round"
        />
      ))}
      {markerOrder.map(({m, pts}) => (
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

function StormChart({segments, base}: {segments: Loaded<DebrisFlowSegments>; base: string}) {
  const {model, i15, segment} = useUi(s => s.risk);
  const fc = segments.data;
  const m = riskModel(model);
  const picked = useMemo(() => {
    if (!fc) return null;
    const own = segment === null ? undefined : fc.features.find(f => f.properties.id === segment);
    return own ? {seg: own, median: false} : {seg: medianSegment(fc, model, i15), median: true};
  }, [fc, segment, model, i15]);
  const seg = picked?.seg ?? null;
  const which = seg && (picked!.median ? `median segment #${seg.properties.id} by ${m.short} at ${i15} mm/h` : `segment #${seg.properties.id}`);
  // Our M1 and USGS's assessment coincide (to rounding) when both apply M1's published coefficients.
  const same =
    seg !== null &&
    DESIGN_I15.every(v => {
      const [a, b] = [likelihood(seg.properties, 'usgs', v), likelihood(seg.properties, 'm1', v)];
      return a !== null && b !== null && Math.abs(a - b) < 1e-6;
    });
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
              <span style={{color: r.color}}>{r.dashed ? '┅' : '━'}</span> {r.short}
            </span>
          ))}
          {same && <span className="mr-2 whitespace-nowrap">M1 (ours) = USGS here</span>}
          {which && <span className="text-muted">· {which}</span>}
        </>
      }
      footTitle={
        `${which ? `Showing ${which}. ` : ''}` +
        (same ? "Our M1 line lies on USGS's at every storm (dashed over solid): both apply M1's published coefficients. " : '') +
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

/** Fits the longest short row name ("MLP · M1 inputs", 15 characters at CHAR_PX). */
const SKILL_LABEL_PX = 96;
/** A debris-flow base rate with one decimal (9.8% against 12.5%). */
const rate = (v: number) => (finite(v) ? `${(v * 100).toFixed(1)}%` : '—');

/** Pooled ROC AUC per model as bars, the per-fire IQR as a whisker, the Station Fire as a diamond. */
function SkillPlot({ev, w, h}: {ev: DebrisModelEval; w: number; h: number}) {
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
        const a = m.analogue;
        return (
          <g key={m.id}>
            <title>
              {`${m.label} (${m.id})\nPooled ROC AUC ${fixed(m.pooled.roc_auc, 2)} (${m.n.toLocaleString('en-US')} records, ` +
                `${m.flows.toLocaleString('en-US')} flows, base rate ${rate(m.pooled.base_rate)})\nPer-fire ROC AUC over ` +
                `${m.per_fire.fires} fires: median ${fixed(m.per_fire.median_roc_auc, 2)}, IQR ${fixed(q1, 2)}–${fixed(q3, 2)}` +
                (a
                  ? `\n${a.fire} (${a.year}, held out): ROC AUC ${fixed(a.roc_auc, 2)}, ${a.n} records, ${a.flows} flows`
                  : m.id === 'm1_published'
                    ? "\nNo Station Fire score: its records are in the Staley et al. (2016) inventory M1 was fitted on"
                    : '\nNo Station Fire score in model_eval.json')}
            </title>
            <text
              x={SKILL_LABEL_PX - 6}
              y={cy}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={10}
              fontWeight={on ? 600 : 400}
              fill={on ? 'var(--text)' : 'var(--text-muted)'}
            >
              {fit(evalShort(m.id), SKILL_LABEL_PX - 8)}
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

function SkillChart({ev}: {ev: Loaded<DebrisModelEval>}) {
  const shown = riskModel(useUi(s => s.risk.model));
  const row = ev.data?.models.find(m => m.id === shown.evalId);
  const station = ev.data?.models.find(m => m.analogue)?.analogue;
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
      value={row && `${shown.short} ${fixed(row.pooled.roc_auc, 2)}`}
      valueTitle={row ? `${row.label}: pooled ROC AUC (the eval row behind the map's ${shown.label} colours)` : undefined}
      foot={
        <>
          bar pooled · ⊢⊣ per-fire IQR
          {station && (
            <>
              {' '}
              · <span className="text-accent">◆</span> {station.fire} ({station.year}, held out)
            </>
          )}
        </>
      }
      footTitle={
        'Bar: ROC AUC of all held-out predictions pooled. Whisker: interquartile range of the per-fire ROC AUCs. Diamond: the ' +
        'held-out Station Fire on the San Gabriel front. Each fire is scored by a model fitted without it; M1 published is ' +
        'scored only on records outside its 2016 training inventory, so its bar is not like-for-like with the others.' +
        perRow +
        ' These are past fires, not this one.'
      }
      files={[{name: 'model_eval.json', href: MODEL_EVAL_URL}]}
    >
      {empty('model_eval.json', ev) ??
        (ev.data!.models.length ? (
          <Plot>{(w, h) => <SkillPlot ev={ev.data!} w={w} h={h} />}</Plot>
        ) : (
          <ChartEmpty>model_eval.json lists no models</ChartEmpty>
        ))}
    </ChartFrame>
  );
}

const CLASS_LABEL_PX = 62;

/** Each map model's segments split into the five likelihood classes (and no value) at the selected storm. */
function ClassPlot({fc, w, h}: {fc: DebrisFlowSegments; w: number; h: number}) {
  const {model, i15} = useUi(s => s.risk);
  const rows = useMemo(
    () =>
      RISK_MODELS.map(m => {
        const counts = [0, 0, 0, 0, 0, 0];
        for (const f of fc.features) {
          const p = likelihood(f.properties, m.id, i15);
          counts[p === null ? 5 : classOf(p)]++;
        }
        return {m, counts};
      }),
    [fc, i15]
  );
  const n = fc.features.length;
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
              {m.short}
            </text>
            {counts.map((c, k) => {
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
            })}
          </g>
        );
      })}
    </>
  );
}

function ClassChart({segments, base}: {segments: Loaded<DebrisFlowSegments>; base: string}) {
  const i15 = useUi(s => s.risk.i15);
  return (
    <ChartFrame
      title="Segments by likelihood class"
      unit={`I15 ${i15} mm/h`}
      modeled="Counts of this fire's USGS stream segments in each modeled likelihood class, per model"
      value={segments.data && `${segments.data.features.length.toLocaleString('en-US')} segments`}
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
      footTitle={`Likelihood classes at I15 ${i15} mm/h (${accumulationMm(i15)} mm in 15 min); grey: no value in the file. Hover a bar for its count.`}
      files={[{name: 'debris_flow.geojson', href: `${base}/debris_flow.geojson`}]}
    >
      {empty('debris_flow.geojson', segments) ??
        (segments.data!.features.length ? (
          <Plot>{(w, h) => <ClassPlot fc={segments.data!} w={w} h={h} />}</Plot>
        ) : (
          <ChartEmpty>debris_flow.geojson has no segments</ChartEmpty>
        ))}
    </ChartFrame>
  );
}

export function RiskCharts({fire}: {fire: FireData}) {
  const {segments} = useRiskFiles(fire.base);
  const ev = useDebrisJson<DebrisModelEval>(MODEL_EVAL_URL);
  return (
    <>
      <StormChart segments={segments} base={fire.base} />
      <SkillChart ev={ev} />
      <ClassChart segments={segments} base={fire.base} />
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
