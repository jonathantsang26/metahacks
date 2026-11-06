import {useEffect, useRef, useState, type RefObject} from 'react';
import type {FireData} from '../../data/fire';
import {useUi} from '../../state/ui';
import {itemsAt, useClipOverlays, useClips, useFrameIndex, type Clip} from '../footage';
import {useLive} from './live';
import {createSamPoller, grabFrame, MAX_AGE_MS, NEXT_MODE, polygonPath, postSam, useSam, type SamFrame} from './sam';

/**
 * SAM 3.1 outlines over the live video, beside Sentinel's boxes. On a camera, screen or other file,
 * frames go to /api/sam (sam.ts throttles them) and each outline carries its age, since it trails
 * the boxes by a round trip. On a bundled clip, the clip's SAM 3.1 video masks (pipeline step 12c,
 * footage/masks/<id>.json) play in sync with it; if that file is missing, nothing is drawn.
 */

const CYAN = '#4fe3f0';
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The bundled clip this source plays, if it is one. */
function useBundledClip(fire: FireData): Clip | null {
  const url = useLive(s => (s.source?.kind === 'file' ? s.source.url : undefined));
  const clips = useClips(fire).data;
  if (!url || !clips) return null;
  return clips.find(c => url === `${fire.base}/footage/${c.src}`) ?? null;
}

const chip = 'pointer-events-none absolute bottom-[6.5rem] left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded bg-black/60 px-2 py-0.5 font-mono text-2xs text-white';

function Label({x, y, children}: {x: number; y: number; children: string}) {
  return (
    <span
      className="pointer-events-none absolute -translate-y-full whitespace-nowrap font-mono text-[10px] leading-3 text-white [text-shadow:0_0_3px_#000]"
      style={{left: `${x}%`, top: `${y}%`}}
    >
      {children}
    </span>
  );
}

function LiveOutlines({video}: {video: RefObject<HTMLVideoElement | null>}) {
  const {mode, frame, unavailable, error, set} = useSam();
  const source = useLive(s => s.source);
  const [now, setNow] = useState(() => performance.now());
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [inFlight, setInFlight] = useState(false);

  // A new source or mode starts clean: a refusal is retried once, then stops again if it stands.
  useEffect(() => set({frame: null, unavailable: null, error: null, sent: 0, rtts: []}), [source, mode, set]);

  useEffect(() => {
    if (mode === 'off') return;
    const poller = createSamPoller(postSam, e => {
      if (e.kind === 'result') {
        const s = useSam.getState();
        set({frame: e.frame, error: null, sent: poller.stats.sent, rtts: [...s.rtts.slice(-19), e.frame.rttMs]});
      } else if (e.kind === 'unavailable') set({unavailable: e.message, frame: null});
      else set({error: e.message});
    });
    const timer = setInterval(() => {
      setNow(performance.now());
      const live = useLive.getState();
      const v = video.current;
      const visible = useUi.getState().tab === 'drones' && document.visibilityState === 'visible';
      const hasBox = live.status === 'running' && live.stats.dets.length > 0 && visible && !!v;
      const p = poller.tick(hasBox, () => {
        canvas.current ??= document.createElement('canvas');
        return grabFrame(v!, canvas.current, mode === 'boxes' ? live.stats.dets.map(d => d.box) : null);
      });
      setInFlight(poller.stats.inFlight);
      p.then(() => setInFlight(poller.stats.inFlight));
    }, 250);
    return () => clearInterval(timer);
  }, [mode, video, set]);

  if (mode === 'off') return null;
  if (unavailable) return <div className={chip}>{unavailable}</div>;
  const age = frame ? now - frame.capturedAt : null;
  const shown: SamFrame | null = frame && age !== null && age <= MAX_AGE_MS ? frame : null;
  const prompt = mode === 'boxes' ? 'PROMPT: SENTINEL BOXES' : 'PROMPT “FIRE”';
  return (
    <>
      {shown && (
        <>
          <svg viewBox={`0 0 ${shown.width} ${shown.height}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
            {shown.outlines.map(o => (
              <path key={o.id} d={polygonPath(o.polygons)} fill={CYAN} fillOpacity={0.15} fillRule="evenodd" stroke={CYAN} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          {shown.outlines.map(o => (
            <Label key={o.id} x={(o.bounds[0] / shown.width) * 100} y={(o.bounds[3] / shown.height) * 100 + 4}>
              {`SAM 3.1${o.conf !== null ? ` ${o.conf.toFixed(2)}` : ''} · ${sec(age!)} OLD`}
            </Label>
          ))}
        </>
      )}
      <div className={chip} data-testid="sam-status">
        SAM 3.1 · {prompt} ·{' '}
        {error
          ? error
          : shown
            ? `OUTLINE FROM ${sec(age!)} AGO · ROUND TRIP ${sec(shown.rttMs)} · ${shown.outlines.length} OBJECT${shown.outlines.length === 1 ? '' : 'S'}`
            : inFlight
              ? 'TRACING…'
              : 'RUNS WHEN SENTINEL HAS A BOX'}
      </div>
    </>
  );
}

function ClipOutlines({fire, clip, video}: {fire: FireData; clip: Clip; video: RefObject<HTMLVideoElement | null>}) {
  const {masks} = useClipOverlays(fire, clip);
  const index = useFrameIndex(masks);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    let id = 0;
    const loop = () => {
      const v = video.current;
      if (v) setFrame(Math.floor(v.currentTime * clip.fps));
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [clip, video]);
  if (!masks?.length) return null;
  const shapes = itemsAt(index, frame, 2);
  return (
    <>
      <svg viewBox={`0 0 ${clip.width} ${clip.height}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
        {shapes.map(m => {
          const [left, top, right, bottom] = m.bounds;
          return (
            <g key={m.object_id} transform={`translate(${left} ${top}) scale(${(right - left) / m.size[0]} ${(bottom - top) / m.size[1]})`}>
              <path d={m.path} fill={CYAN} fillOpacity={0.15} fillRule="evenodd" stroke={CYAN} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>
      {shapes.map(m => (
        <Label key={m.object_id} x={(m.bounds[0] / clip.width) * 100} y={(m.bounds[3] / clip.height) * 100 + 4}>
          {`SAM 3.1${m.conf !== null ? ` ${m.conf.toFixed(2)}` : ''}`}
        </Label>
      ))}
    </>
  );
}

/** Goes inside the video's aspect-ratio box, after the Sentinel canvas. */
export function SamOverlay({fire, video}: {fire: FireData; video: RefObject<HTMLVideoElement | null>}) {
  const clip = useBundledClip(fire);
  const mode = useSam(s => s.mode);
  if (mode === 'off') return null;
  return clip ? <ClipOutlines fire={fire} clip={clip} video={video} /> : <LiveOutlines video={video} />;
}

/** Toolbar toggle. Cycles prompt "fire" → Sentinel boxes → off on a live feed; on/off on a bundled clip. */
export function SamToggle({fire}: {fire: FireData}) {
  const {mode, set} = useSam();
  const clip = useBundledClip(fire);
  const label = mode === 'off' ? 'Outlines: off' : clip || mode === 'text' ? 'Outlines: SAM 3.1' : 'Outlines: SAM 3.1 · boxes';
  const next = clip ? (mode === 'off' ? 'text' : 'off') : NEXT_MODE[mode];
  return (
    <button
      onClick={() => set({mode: next})}
      className={`rounded px-1.5 font-mono text-2xs ${mode === 'off' ? 'text-white/50' : 'bg-white/20'}`}
      title={
        clip
          ? 'SAM 3.1 video masks for this clip (Meta Model API, prompt "fire"), computed ahead of time and played in sync'
          : 'SAM 3.1 on the Meta Model API: one frame at most every 2 s while Sentinel has a box. Click to switch between the prompt "fire", Sentinel\'s boxes as prompts, and off.'
      }
    >
      {label}
    </button>
  );
}
