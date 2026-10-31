import {useEffect, useMemo, useRef, useState} from 'react';
import type {FireData} from '../data/fire';
import {ChartEmpty, ChartFrame} from '../dock/charts';
import {buildTracks, CLASS_LABEL, fmtClock, useClipOverlays, useFootage, useSelectedClip, type Clip, type Detection, type Mask} from './footage';

/** Per-second bins over the clip: boxes per second, Sentinel's max confidence, SAM mask cover. */
function useBins(clip: Clip | null, detections: Detection[] | null, masks: Mask[] | null) {
  return useMemo(() => {
    if (!clip || !detections) return null;
    const last = Math.max(0, ...detections.map(d => d.frame), ...(masks ?? []).map(m => m.frame));
    const n = Math.max(1, Math.ceil((clip.window_s ? clip.window_s[1] - clip.window_s[0] : last / clip.fps) || 1));
    const boxes = new Array<number>(n).fill(0);
    const conf = new Array<number>(n).fill(0);
    const area = new Array<number>(n).fill(0);
    const sampled = new Array<Set<number>>(n).fill(null as never).map(() => new Set<number>());
    for (const d of detections) {
      const i = Math.min(n - 1, Math.floor(d.frame / clip.fps));
      boxes[i]++;
      conf[i] = Math.max(conf[i], d.conf);
    }
    // Detections per second = boxes ÷ the number of frames Sentinel sampled in that second.
    const perSec = clip.sentinel?.fps ?? 5;
    const rate = boxes.map(b => b / perSec);
    // Mask cover: sum of mask areas on a frame, averaged over the frames SAM returned in that second.
    const frameArea = new Map<number, number>();
    for (const m of masks ?? []) frameArea.set(m.frame, (frameArea.get(m.frame) ?? 0) + (m.area_frac ?? 0));
    for (const [f, a] of frameArea) {
      const i = Math.min(n - 1, Math.floor(f / clip.fps));
      area[i] += a;
      sampled[i].add(f);
    }
    const cover = area.map((a, i) => (sampled[i].size ? (100 * a) / sampled[i].size : 0));
    return {n, rate, conf, cover, hasArea: (masks ?? []).some(m => m.area_frac !== undefined)};
  }, [clip, detections, masks]);
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({w: 0, h: 0});
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({w: e.contentRect.width, h: e.contentRect.height}));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** A per-second step series with the playhead; past solid, future faded (DESIGN.md §6.2). */
function SeriesPlot({values, max, color, time, unit}: {values: number[]; max: number; color: string; time: number; unit: string}) {
  const [ref, {w, h}] = useSize<HTMLDivElement>();
  const L = 30;
  const B = 14;
  const x = (s: number) => L + (s / values.length) * (w - L - 4);
  const y = (v: number) => 4 + (1 - Math.min(v, max) / max) * (h - B - 4);
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(v)}H${x(i + 1)}`).join('');
  const area = `${d}V${y(0)}H${x(0)}Z`;
  const ticks = [0, Math.floor(values.length / 2), values.length];
  return (
    <div ref={ref} className="absolute inset-0">
      {w > 0 && (
        <svg width={w} height={h} className="block overflow-visible">
          <defs>
            <clipPath id={`past-${unit}`}>
              <rect x={0} y={0} width={x(time)} height={h} />
            </clipPath>
          </defs>
          {[0, max].map(v => (
            <g key={v}>
              <line x1={L} x2={w - 4} y1={y(v)} y2={y(v)} stroke="var(--text)" strokeOpacity={v ? 0.1 : 0.25} strokeDasharray={v ? '2 3' : undefined} />
              <text x={L - 4} y={y(v)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="var(--text-muted)">
                {v}
                {v ? ` ${unit}` : ''}
              </text>
            </g>
          ))}
          {ticks.map(s => (
            <text key={s} x={x(s)} y={h - 2} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
              {fmtClock(s)}
            </text>
          ))}
          <path d={area} fill={color} fillOpacity={0.12} />
          <path d={d} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={1.25} />
          <g clipPath={`url(#past-${unit})`}>
            <path d={area} fill={color} fillOpacity={0.3} />
            <path d={d} fill="none" stroke={color} strokeWidth={1.75} />
          </g>
          <line x1={x(time)} x2={x(time)} y1={0} y2={h - B} stroke="var(--text)" strokeOpacity={0.6} />
        </svg>
      )}
    </div>
  );
}

/** Drones tab charts: all three run on the selected clip's own clock, not the incident timeline. */
export function DronesCharts({fire}: {fire: FireData}) {
  const clip = useSelectedClip(fire);
  const {detections, masks} = useClipOverlays(fire, clip);
  const bins = useBins(clip, detections, masks);
  const time = useFootage(s => s.time);
  const sec = bins ? Math.min(bins.n - 1, Math.floor(time)) : 0;
  const empty = clip ? 'Loading detections…' : 'Select a clip';
  const charts = [
    {title: 'Sentinel Detections', unit: 'per frame', values: bins?.rate, max: Math.max(1, Math.ceil(Math.max(0, ...(bins?.rate ?? [0])))), color: 'var(--chart-rate)', fmt: (v: number) => v.toFixed(1), u: '/fr'},
    {title: 'Sentinel Confidence', unit: 'max', values: bins?.conf, max: 1, color: 'var(--chart-area-stroke)', fmt: (v: number) => v.toFixed(2), u: ''},
    {
      title: 'SAM 3.1 Mask Cover',
      unit: '% of frame',
      values: bins?.hasArea ? bins.cover : undefined,
      max: Math.max(5, Math.ceil(Math.max(0, ...(bins?.cover ?? [0])) / 5) * 5),
      color: 'var(--chart-elev-stroke)',
      fmt: (v: number) => `${v.toFixed(1)}%`,
      u: '%'
    }
  ];
  return (
    <>
      {charts.map(c => (
        <ChartFrame
          key={c.title}
          title={c.title}
          unit={c.unit}
          value={c.values ? c.fmt(c.values[sec]) : undefined}
          foot={clip ? `${clip.title} · ${fmtClock(time)}` : 'Drone footage · Sentinel + SAM 3.1'}
        >
          {c.values ? (
            <SeriesPlot values={c.values} max={c.max} color={c.color} time={time} unit={c.u} />
          ) : (
            <ChartEmpty>{bins && !bins.hasArea && c.title.startsWith('SAM') ? 'No SAM 3.1 masks for this clip yet' : empty}</ChartEmpty>
          )}
        </ChartFrame>
      ))}
    </>
  );
}

/** Dock side list: Sentinel detection runs and SAM 3.1 objects; click a row to jump the clip there. */
export function DronesSide({fire}: {fire: FireData}) {
  const clip = useSelectedClip(fire);
  const {detections, masks} = useClipOverlays(fire, clip);
  const {time, requestSeek} = useFootage();
  const tracks = useMemo(() => (clip && detections ? buildTracks(clip, detections, masks ?? []) : null), [clip, detections, masks]);
  if (!clip) return <div className="px-3 py-6 text-center text-sm text-muted">Select a clip in the rail to list its detections.</div>;
  if (!tracks) return <div className="px-3 py-6 text-center text-sm text-muted">Loading detections…</div>;
  if (!tracks.length) return <div className="px-3 py-6 text-center text-sm text-muted">Nothing detected in this clip.</div>;
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto">
      {tracks.map(t => {
        const active = time >= t.start && time <= t.end + 0.5;
        return (
          <li key={t.key}>
            <button
              onClick={() => requestSeek(t.start)}
              className={`flex w-full items-start gap-2 border-l-2 px-3 py-1.5 text-left ${active ? 'border-accent bg-selected' : 'border-transparent hover:bg-tabgroup'}`}
            >
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${t.kind === 'sam' ? 'bg-[#4fb8c4]' : 'bg-accent'}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {CLASS_LABEL[t.label] ?? t.label}
                  {t.conf !== null && ` · ${t.conf.toFixed(2)}`}
                </span>
                <span className="block truncate text-xs text-muted">
                  {t.kind === 'sam' ? 'SAM 3.1 object' : 'Sentinel'} · {t.count} {t.kind === 'sam' ? 'masks' : 'boxes'}
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted">{fmtClock(t.start)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
