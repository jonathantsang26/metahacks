import {useMemo} from 'react';
import {ChartEmpty, ChartFrame} from '../../dock/charts';
import {SeriesPlot} from '../DronesDock';
import {CLASS_LABEL} from '../footage';
import {fmtStreamClock, median} from './decode';
import {useLive} from './live';

/** Per-second bins of the processed frames: median inference, median latency, max confidence. */
function useLiveBins() {
  const history = useLive(s => s.history);
  return useMemo(() => {
    if (!history.length) return null;
    const n = Math.max(1, Math.ceil(history[history.length - 1].t + 1e-6));
    const infer: number[][] = Array.from({length: n}, () => []);
    const e2e: number[][] = Array.from({length: n}, () => []);
    const conf = new Array<number>(n).fill(0);
    for (const h of history) {
      const i = Math.min(n - 1, Math.max(0, Math.floor(h.t)));
      infer[i].push(h.inferMs);
      e2e[i].push(h.e2eMs);
      conf[i] = Math.max(conf[i], h.maxConf);
    }
    // A second with no processed frame holds the previous value rather than dropping to 0.
    const fill = (xs: number[][]) => xs.map(x => median(x)).map((v, i, a) => v ?? a.slice(0, i).reverse().find(p => p !== null) ?? 0);
    return {n, infer: fill(infer), e2e: fill(e2e), conf};
  }, [history]);
}

const ceil = (xs: number[], step: number) => Math.max(step, Math.ceil(Math.max(0, ...xs) / step) * step);

/** Drones dock in LIVE mode: the loop's own measurements over stream time. */
export function LiveCharts() {
  const bins = useLiveBins();
  const {stats, source} = useLive();
  const t = bins ? bins.n : 0;
  const charts = [
    {title: 'Live Inference Time', unit: 'ms, median per second', values: bins?.infer, max: ceil(bins?.infer ?? [], 50), color: 'var(--chart-rate)', u: 'ms', id: 'live-infer', v: stats.inferMs},
    {title: 'Live Latency', unit: 'ms, frame → boxes drawn', values: bins?.e2e, max: ceil(bins?.e2e ?? [], 50), color: 'var(--chart-elev-stroke)', u: 'ms', id: 'live-e2e', v: stats.e2eMs},
    {title: 'Live Sentinel Confidence', unit: 'max per second', values: bins?.conf, max: 1, color: 'var(--chart-area-stroke)', u: '', id: 'live-conf', v: null}
  ];
  return (
    <>
      {charts.map(c => (
        <ChartFrame
          key={c.title}
          title={c.title}
          unit={c.unit}
          value={c.values ? (c.u ? `${Math.round(c.v ?? c.values[c.values.length - 1])} ms` : c.values[c.values.length - 1].toFixed(2)) : undefined}
          foot={`LIVE · ${source?.name ?? ''} · ${fmtStreamClock(stats.streamS)}`}
        >
          {c.values ? <SeriesPlot values={c.values} max={c.max} color={c.color} time={t} unit={c.u} id={c.id} /> : <ChartEmpty>Waiting for processed frames…</ChartEmpty>}
        </ChartFrame>
      ))}
    </>
  );
}

/** Dock side list in LIVE mode: the boxes on the newest processed frame. */
export function LiveSide() {
  const {stats, model} = useLive();
  if (!stats.dets.length)
    return <div className="px-3 py-6 text-center text-sm text-muted">No boxes on the newest processed frame.</div>;
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto">
      {stats.dets.map((d, i) => {
        const cls = model?.classes[d.cls] ?? String(d.cls);
        const [x1, y1, x2, y2] = d.box.map(Math.round);
        return (
          <li key={i} className="flex items-start gap-2 px-3 py-1.5">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">
                {CLASS_LABEL[cls] ?? cls} · {d.score.toFixed(2)}
              </span>
              <span className="block truncate font-mono text-2xs text-muted">
                Sentinel live · [{x1}, {y1}, {x2}, {y2}] px
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
