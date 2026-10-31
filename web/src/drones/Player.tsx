import {useEffect, useMemo, useRef, useState} from 'react';
import type {FireData} from '../data/fire';
import {useUi} from '../state/ui';
import {Icon} from '../ui/Icon';
import {
  CLASS_LABEL,
  fmtClock,
  itemsAt,
  useClipOverlays,
  useFootage,
  useFrameIndex,
  useSelectedClip,
  type Clip,
  type Detection,
  type Mask
} from './footage';

const CYAN = '#4fe3f0';

/** Corner-bracket target box (DESIGN.md §7.1), the Sentinel box; the SAM mask sits inside it. */
function Brackets({d, scale}: {d: Detection; scale: number}) {
  const [x1, y1, x2, y2] = d.box;
  const l = Math.min(14 / scale, (x2 - x1) / 3, (y2 - y1) / 3);
  const p = (x: number, y: number, dx: number, dy: number) => `M${x + dx * l} ${y}H${x}V${y + dy * l}`;
  return (
    <g>
      <path
        d={[p(x1, y1, 1, 1), p(x2, y1, -1, 1), p(x1, y2, 1, -1), p(x2, y2, -1, -1)].join('')}
        fill="none"
        stroke={CYAN}
        strokeWidth={2 / scale}
      />
      <text x={x1} y={y1 - 4 / scale} fill={CYAN} fontSize={11 / scale} fontFamily="JetBrains Mono, monospace">
        SENTINEL · {CLASS_LABEL[d.cls].toUpperCase()} {d.conf.toFixed(2)}
      </text>
    </g>
  );
}

/** SAM 3.1 mask: path in raster coordinates, placed by its bounds (WORKSTREAMS.md §1, C → B). */
function MaskShape({m, scale}: {m: Mask; scale: number}) {
  const [left, top, right, bottom] = m.bounds;
  const [w, h] = m.size;
  const label = `SAM 3.1 · ${(CLASS_LABEL[m.prompt] ?? m.prompt).toUpperCase()}${m.conf !== null ? ` ${m.conf.toFixed(2)}` : ''}`;
  return (
    <g>
      <g transform={`translate(${left} ${top}) scale(${(right - left) / w} ${(bottom - top) / h})`}>
        <path d={m.path} fill={CYAN} fillOpacity={0.15} fillRule="evenodd" stroke={CYAN} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </g>
      <text x={left + 3 / scale} y={top + 12 / scale} fill="#fff" fontSize={10 / scale} fontFamily="JetBrains Mono, monospace">
        {label}
      </text>
    </g>
  );
}

/** Measures an element so overlay strokes and labels stay a constant on-screen size. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function Overlay({clip, detections, masks, frame}: {clip: Clip; detections: Detection[]; masks: Mask[]; frame: number}) {
  const {showBoxes, showMasks} = useFootage();
  const boxIndex = useFrameIndex(detections);
  const maskIndex = useFrameIndex(masks);
  const [ref, width] = useWidth<HTMLDivElement>();
  const scale = width / clip.width || 1;
  // Hold an overlay for one sampling interval: Sentinel runs at ~5 fps, SAM on every frame it returns.
  const hold = Math.ceil(clip.fps / (clip.sentinel?.fps ?? 5));
  const boxes = showBoxes ? itemsAt(boxIndex, frame, hold) : [];
  const shapes = showMasks ? itemsAt(maskIndex, frame, hold) : [];
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      <svg viewBox={`0 0 ${clip.width} ${clip.height}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
        {shapes.map(m => (
          <MaskShape key={`${m.object_id}-${m.frame}`} m={m} scale={scale} />
        ))}
        {boxes.map((d, i) => (
          <Brackets key={i} d={d} scale={scale} />
        ))}
      </svg>
    </div>
  );
}

/** Corner brackets and crosshair of the camera HUD. */
function HudFrame() {
  const c = 'absolute h-5 w-5 border-white/80';
  return (
    <div className="pointer-events-none absolute inset-3">
      <span className={`${c} left-0 top-0 border-l-2 border-t-2`} />
      <span className={`${c} right-0 top-0 border-r-2 border-t-2`} />
      <span className={`${c} bottom-0 left-0 border-b-2 border-l-2`} />
      <span className={`${c} bottom-0 right-0 border-b-2 border-r-2`} />
      <span className="absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-white/60" />
      <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 bg-white/60" />
    </div>
  );
}

/**
 * The drone camera PiP (DESIGN.md §7.1, §9): the clip with Sentinel's boxes and SAM 3.1's masks drawn
 * in sync with the video. A clip we may not redistribute (FLAME 2) is local-only, so when its video is
 * missing the overlays still play over a dark frame on their own clock.
 */
export function FootagePlayer({fire}: {fire: FireData}) {
  const tab = useUi(s => s.tab);
  const clip = useSelectedClip(fire);
  const {time, playing, expanded, seek, setTime, setPlaying, setExpanded, select, toggle, showBoxes, showMasks} = useFootage();
  const overlays = useClipOverlays(fire, clip);
  const video = useRef<HTMLVideoElement>(null);
  const [missing, setMissing] = useState(false);
  const duration = useMemo(() => {
    if (!clip) return 0;
    if (clip.window_s) return clip.window_s[1] - clip.window_s[0];
    const last = Math.max(0, ...(overlays.detections ?? []).map(d => d.frame), ...(overlays.masks ?? []).map(m => m.frame));
    return last / clip.fps;
  }, [clip, overlays]);

  useEffect(() => setMissing(false), [clip]);

  // Video drives the clock when it plays; otherwise a timer stands in for it.
  useEffect(() => {
    const v = video.current;
    if (!clip) return;
    if (v && !missing) {
      if (playing) v.play().catch(() => setPlaying(false));
      else v.pause();
      let id = 0;
      const tick = () => {
        setTime(v.currentTime);
        id = requestAnimationFrame(tick);
      };
      id = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(id);
    }
    if (!playing) return;
    let last = performance.now();
    let id = 0;
    const tick = (now: number) => {
      const t = useFootage.getState().time + (now - last) / 1000;
      last = now;
      setTime(duration > 0 ? t % duration : 0);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [clip, playing, missing, duration, setTime, setPlaying]);

  useEffect(() => {
    if (seek && video.current && !missing) video.current.currentTime = seek.time;
  }, [seek, missing]);

  if (tab !== 'drones' || !clip) return null;
  const frame = Math.round(time * clip.fps);
  const box = expanded ? 'inset-0 rounded-none' : 'right-3 top-3 w-[min(700px,62%)] rounded-md';

  return (
    <div className={`absolute z-20 flex flex-col overflow-hidden bg-black shadow-[0_8px_30px_rgba(0,0,0,0.35)] ${box}`}>
      <div className="relative min-h-0 flex-1" style={expanded ? undefined : {aspectRatio: '16 / 10'}}>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative h-full max-w-full" style={{aspectRatio: `${clip.width} / ${clip.height}`}}>
            {!missing && (
              <video
                key={clip.id}
                ref={video}
                src={`${fire.base}/footage/${clip.src}`}
                className="absolute inset-0 h-full w-full"
                muted
                playsInline
                loop
                onError={() => setMissing(true)}
              />
            )}
            {missing && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#15130f] px-6 text-center font-mono text-2xs text-white/60">
                Video not in this deployment ({clip.source}; not licensed for redistribution).
                <br />
                Sentinel and SAM 3.1 overlays play on their recorded frame times.
              </div>
            )}
            {overlays.detections && <Overlay clip={clip} detections={overlays.detections} masks={overlays.masks ?? []} frame={frame} />}
          </div>
        </div>
        <HudFrame />
        <div className="pointer-events-none absolute left-5 top-4 font-mono text-2xs leading-4 text-white">
          <div>
            <span className="text-live">●</span> {playing ? 'PLAY' : 'PAUSE'} {fmtClock(time)}
          </div>
          <div>{clip.title.toUpperCase()}</div>
          <div className="text-white/70">EO · RECORDED</div>
        </div>
        <div className="pointer-events-none absolute right-5 top-4 max-w-[45%] text-right font-mono text-2xs leading-4 text-white">
          <div>FRAME {frame}</div>
          <div className="text-white/70">{clip.note.toUpperCase()}</div>
        </div>
        <div className="pointer-events-none absolute bottom-4 left-5 font-mono text-2xs leading-4 text-white/80">
          {clip.width}×{clip.height} · {clip.fps.toFixed(0)} FPS
        </div>
        {overlays.error && (
          <div className="absolute bottom-4 right-5 font-mono text-2xs text-white/70">detections unavailable: {overlays.error}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 bg-hud px-2 py-1.5 text-xs text-white">
        <button onClick={() => setPlaying(!playing)} title={playing ? 'Pause' : 'Play'} className="flex h-6 w-6 items-center justify-center">
          <Icon name={playing ? 'pause' : 'play'} size={13} />
        </button>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.01}
          value={Math.min(time, duration)}
          onChange={e => useFootage.getState().requestSeek(Number(e.target.value))}
          className="slider min-w-0 flex-1"
          aria-label="Clip position"
        />
        <span className="w-20 text-right font-mono text-2xs tabular-nums">
          {fmtClock(time)} / {fmtClock(duration)}
        </span>
        <span className="mx-1 h-4 border-l border-white/20" />
        <button
          onClick={() => toggle('showBoxes')}
          className={`rounded px-1.5 font-mono text-2xs ${showBoxes ? 'bg-white/20' : 'text-white/50'}`}
          title="Sentinel YOLOv8 boxes"
        >
          Boxes: Sentinel
        </button>
        <button
          onClick={() => toggle('showMasks')}
          className={`rounded px-1.5 font-mono text-2xs ${showMasks ? 'bg-white/20' : 'text-white/50'}`}
          title="SAM 3.1 masks (Meta Model API)"
        >
          Masks: SAM 3.1
        </button>
        <button onClick={() => setExpanded(!expanded)} title={expanded ? 'Back to PiP' : 'Full camera view'} className="flex h-6 w-6 items-center justify-center">
          <Icon name="expand" size={13} />
        </button>
        <button onClick={() => select(null)} title="Close" className="flex h-6 w-6 items-center justify-center text-sm">
          ✕
        </button>
      </div>
    </div>
  );
}
