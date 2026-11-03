import {useEffect, useRef, useState} from 'react';
import type {FireData} from '../../data/fire';
import {useFireJson} from '../../data/files';
import {useUi} from '../../state/ui';
import {Icon} from '../../ui/Icon';
import {fmtPct, type DetectorEval} from '../footage';
import {fmtStreamClock} from './decode';
import {createDetector, type Backend, type Detector} from './detector';
import {runLive, useLive, type LiveSource} from './live';
import {useLiveGeo} from './useLiveGeo';

/** One detector per backend, loaded on first use and kept for the session. */
const detectors = new Map<Backend, Promise<Detector>>();
export function getDetector(backend: Backend) {
  let d = detectors.get(backend);
  if (!d) {
    d = createDetector(backend);
    d.catch(() => detectors.delete(backend));
    detectors.set(backend, d);
  }
  return d;
}

export const SOURCE_LABEL: Record<LiveSource['kind'], string> = {
  camera: 'CAMERA · getUserMedia',
  screen: 'SCREEN CAPTURE · getDisplayMedia',
  file: 'FILE PLAYED AS LIVE STREAM · NOT LIVE DRONE FOOTAGE'
};

const ms = (v: number | null) => (v === null ? '–' : `${Math.round(v)} ms`);
const fps = (v: number | null) => (v === null ? '–' : v.toFixed(1));

/** Smoke recall from the Detector Evaluation (eval/sentinel.json), so the caveat quotes the measured number. */
export function useSmokeCaveat(fire: FireData) {
  const s = useFireJson<DetectorEval>(fire, 'eval/sentinel.json').data;
  if (!s) return 'Misses smoke-only frames (see Detector Evaluation)';
  return `Misses smoke-only frames: smoke recall ${fmtPct(s.smoke.recall)} on the ${s.dataset.name}`;
}

/**
 * The LIVE camera view, in the same place as the recorded-clip PiP: the source video, Sentinel's boxes
 * from in-browser inference drawn on a canvas over it, and the measured performance of that loop.
 */
export function LivePlayer({fire}: {fire: FireData}) {
  const tab = useUi(s => s.tab);
  const {source, status, error, backend, model, stats, showBoxes, expanded, set, close} = useLive();
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  /** performance.now() of the source's first decoded frame: the stream start. */
  const [ready, setReady] = useState<number | null>(null);
  const caveat = useSmokeCaveat(fire);
  useLiveGeo(fire, video);

  // Attach the source to the video element.
  useEffect(() => {
    const v = video.current;
    setReady(null);
    if (!v || !source) return;
    const onReady = () => setReady(r => r ?? performance.now());
    v.addEventListener('loadeddata', onReady);
    if (source.stream) {
      v.srcObject = source.stream;
      source.stream.getVideoTracks()[0]?.addEventListener('ended', () => useLive.getState().set({status: 'ended'}));
    } else if (source.url) {
      v.srcObject = null;
      v.src = source.url;
    }
    v.play().catch(e => set({status: 'error', error: `video would not play: ${e.message ?? e}`}));
    return () => {
      v.removeEventListener('loadeddata', onReady);
      v.pause();
      v.srcObject = null;
      v.removeAttribute('src');
      v.load();
    };
  }, [source, set]);

  // Load the detector, then run the loop on the source.
  useEffect(() => {
    if (!source || ready === null || !video.current || !overlay.current) return;
    let stop: (() => void) | null = null;
    let live = true;
    set({status: 'loading'});
    getDetector(backend).then(
      d => {
        if (!live) return;
        set({
          status: 'running',
          model: {arch: d.meta.arch ?? 'YOLOv8n', imgsz: d.meta.imgsz, conf: d.meta.conf, iou: d.meta.iou, classes: d.meta.classes, threads: d.threads, loadMs: d.loadMs}
        });
        stop = runLive(video.current!, overlay.current!, d, ready);
      },
      e => live && set({status: 'error', error: `detector failed to load: ${e.message ?? e}`})
    );
    return () => {
      live = false;
      stop?.();
    };
  }, [source, ready, backend, set]);

  // Kept mounted on other tabs (just hidden) so the stream and the loop keep their element.
  if (!source) return null;
  const box = expanded ? 'inset-0 rounded-none' : 'right-3 top-3 w-[min(700px,62%)] rounded-md';
  const aspect = stats.frameW && stats.frameH ? `${stats.frameW} / ${stats.frameH}` : '16 / 9';
  const statusText =
    status === 'starting' ? 'Waiting for the first frame…' : status === 'loading' ? 'Loading Sentinel (ONNX) …' : status === 'ended' ? 'Stream ended' : null;

  return (
    <div data-testid="live-player" className={`absolute z-20 flex flex-col overflow-hidden bg-black shadow-[0_8px_30px_rgba(0,0,0,0.35)] ${box} ${tab === 'drones' ? '' : 'hidden'}`}>
      <div className="relative min-h-0 flex-1" style={expanded ? undefined : {aspectRatio: '16 / 10'}}>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative h-full max-w-full" style={{aspectRatio: aspect}}>
            <video ref={video} className="absolute inset-0 h-full w-full" muted playsInline autoPlay loop={source.kind === 'file'} />
            <canvas ref={overlay} className={`pointer-events-none absolute inset-0 h-full w-full ${showBoxes ? '' : 'hidden'}`} />
          </div>
        </div>
        {(statusText || error) && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center font-mono text-2xs text-white/80">
            <span className="rounded bg-black/60 px-2 py-1">{error ?? statusText}</span>
          </div>
        )}
        <div className="pointer-events-none absolute inset-3">
          {['left-0 top-0 border-l-2 border-t-2', 'right-0 top-0 border-r-2 border-t-2', 'bottom-0 left-0 border-b-2 border-l-2', 'bottom-0 right-0 border-b-2 border-r-2'].map(
            c => (
              <span key={c} className={`absolute h-5 w-5 border-white/80 ${c}`} />
            )
          )}
        </div>
        <div className="pointer-events-none absolute left-5 top-4 max-w-[52%] font-mono text-2xs leading-4 text-white [text-shadow:0_0_3px_#000]">
          <div>
            <span className={`text-live ${status === 'running' ? 'animate-pulse' : ''}`}>●</span> LIVE {fmtStreamClock(stats.streamS)}
          </div>
          <div className="truncate">{source.name.toUpperCase()}</div>
          <div className="text-white/70">{SOURCE_LABEL[source.kind]}</div>
          {source.note && <div className="text-white/70">{source.note.toUpperCase()}</div>}
        </div>
        <div className="pointer-events-none absolute right-5 top-4 max-w-[45%] text-right font-mono text-2xs leading-4 text-white [text-shadow:0_0_3px_#000]">
          <div>SENTINEL {(model?.arch ?? 'YOLOv8n').toUpperCase()} · ONNX · {backend.toUpperCase()}</div>
          <div className="text-white/70">
            CONF ≥ {model?.conf ?? '–'} · NMS IOU {model?.iou ?? '–'} · {model?.imgsz ?? '–'} PX
          </div>
          <div className="text-white/70">IN-BROWSER · THIS DEVICE</div>
        </div>
        <div
          data-testid="live-stats"
          className="pointer-events-none absolute bottom-4 left-5 grid grid-cols-[auto_auto] gap-x-2 font-mono text-2xs leading-4 text-white [text-shadow:0_0_3px_#000]"
        >
          <span className="text-white/70">INFER</span>
          <span data-k="infer">{ms(stats.inferMs)} median</span>
          <span className="text-white/70">PROCESSED</span>
          <span data-k="proc">{fps(stats.procFps)} fps</span>
          <span className="text-white/70">SOURCE</span>
          <span data-k="src">{fps(stats.srcFps)} fps</span>
          <span className="text-white/70">LATENCY</span>
          <span data-k="e2e">
            {ms(stats.e2eMs)} {stats.e2eBasis === 'capture' ? 'capture→boxes' : 'frame shown→boxes'}
          </span>
          <span className="text-white/70">FIRST DET</span>
          <span data-k="first">{stats.firstDetS === null ? 'none yet' : `${fmtStreamClock(stats.firstDetS)} after stream start`}</span>
        </div>
        <div className="pointer-events-none absolute bottom-4 right-5 max-w-[40%] text-right font-mono text-2xs leading-4 text-white/80 [text-shadow:0_0_3px_#000]">
          <div>
            {stats.frameW}×{stats.frameH} · {stats.dets.length} BOX{stats.dets.length === 1 ? '' : 'ES'}
          </div>
          <div className="text-white/60">{caveat}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 bg-hud px-2 py-1.5 text-xs text-white">
        <span className="flex items-center gap-1.5 rounded bg-white/10 px-1.5 font-mono text-2xs">
          <span className="text-live">●</span> LIVE
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-white/70">
          {stats.framesProcessed.toLocaleString()} of {stats.framesSeen.toLocaleString()} frames run · newest frame only, never queued
        </span>
        <button
          onClick={() => set({showBoxes: !showBoxes})}
          className={`rounded px-1.5 font-mono text-2xs ${showBoxes ? 'bg-white/20' : 'text-white/50'}`}
          title="Sentinel YOLOv8n boxes, run in this browser"
        >
          Boxes: Sentinel
        </button>
        <button onClick={() => set({expanded: !expanded})} title={expanded ? 'Back to PiP' : 'Full camera view'} className="flex h-6 w-6 items-center justify-center">
          <Icon name="expand" size={13} />
        </button>
        <button onClick={close} title="Stop and close" className="flex h-6 w-6 items-center justify-center text-sm">
          ✕
        </button>
      </div>
    </div>
  );
}
