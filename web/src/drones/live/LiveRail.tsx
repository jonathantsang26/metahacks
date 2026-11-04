import {useEffect, useRef, useState} from 'react';
import type {FireData} from '../../data/fire';
import {Button, Card, Chip, Row, Stat} from '../../rail/ui';
import {useClips, useFootage} from '../footage';
import {fmtStreamClock} from './decode';
import {openCamera, openScreen, useLive, type LiveSource} from './live';
import {SOURCE_LABEL, useSmokeCaveat} from './LivePlayer';

/** The bundled test source: public-domain BLM footage from Oregon, not these fires. */
const TEST_CLIP = 'blm-north-bank';

const ms = (v: number | null) => (v === null ? '–' : `${Math.round(v)}`);

/** Drones rail "Live" card: pick a source, then Sentinel runs on it in this browser. */
export function LiveCard({fire}: {fire: FireData}) {
  const {source, status, error, backend, model, stats, open, close, set} = useLive();
  const clips = useClips(fire).data;
  const select = useFootage(s => s.select);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [cam, setCam] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const caveat = useSmokeCaveat(fire);
  const testClip = clips?.find(c => c.id === TEST_CLIP);
  const gpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

  const refreshCams = () =>
    navigator.mediaDevices
      ?.enumerateDevices()
      .then(ds => setCams(ds.filter(d => d.kind === 'videoinput')))
      .catch(() => undefined);
  useEffect(() => {
    refreshCams();
  }, [source]);

  const start = async (get: () => Promise<LiveSource> | LiveSource) => {
    setErr(null);
    try {
      const s = await get();
      select(null);
      open(s);
    } catch (e) {
      setErr((e as Error).message || String(e));
    }
  };

  return (
    <Card
      title="Live Detection"
      aside={source ? <Chip tone="live">● LIVE</Chip> : <span className="text-xs text-muted">Sentinel in this browser</span>}
    >
      <div className="px-3 pt-2 text-xs text-muted">
        Runs Sentinel (YOLOv8n, ONNX) on a live video source, in this browser, on each newest frame. A phone or drone controller can feed in as a webcam
        or capture card, or share the drone app's window.
      </div>
      <div className="flex flex-wrap gap-2 px-3 pt-2">
        <Button primary onClick={() => start(() => openCamera(cam || undefined))}>
          Camera
        </Button>
        <Button onClick={() => start(openScreen)} disabled={!navigator.mediaDevices?.getDisplayMedia}>
          Screen / window
        </Button>
        <Button onClick={() => fileInput.current?.click()}>Video file…</Button>
        {testClip && (
          <Button
            onClick={() =>
              start(() => ({kind: 'file', name: `${testClip.title} (test clip)`, url: `${fire.base}/footage/${testClip.src}`, note: testClip.note}))
            }
            title="Bundled public-domain BLM clip, played in real time as a stream"
          >
            Test clip
          </Button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) start(() => ({kind: 'file', name: f.name, url: URL.createObjectURL(f)}));
            e.target.value = '';
          }}
        />
      </div>
      <form
        className="flex gap-2 px-3 pt-2"
        onSubmit={e => {
          e.preventDefault();
          if (url.trim()) start(() => ({kind: 'file', name: url.trim().split('/').pop() || url.trim(), url: url.trim()}));
        }}
      >
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="Video URL (played as a stream)"
          className="min-w-0 flex-1 rounded-md bg-card px-2 py-1 text-sm shadow-[0_0_0_1px_var(--hairline)]"
        />
        <Button onClick={() => url.trim() && start(() => ({kind: 'file', name: url.trim().split('/').pop() || url.trim(), url: url.trim()}))}>Play</Button>
      </form>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 px-3 pt-2 text-xs">
        {cams.length > 1 && (
          <>
            <span className="text-muted">Camera</span>
            <select value={cam} onChange={e => setCam(e.target.value)} className="min-w-0 rounded bg-card px-1 py-0.5 shadow-[0_0_0_1px_var(--hairline)]">
              <option value="">Default</option>
              {cams.map((c, i) => (
                <option key={c.deviceId || i} value={c.deviceId}>
                  {c.label || `Camera ${i + 1}`}
                </option>
              ))}
            </select>
          </>
        )}
        <span className="text-muted">Runtime</span>
        <span className="flex gap-1">
          {(['wasm', 'webgpu'] as const).map(b => (
            <button
              key={b}
              onClick={() => set({backend: b})}
              disabled={b === 'webgpu' && !gpu}
              title={b === 'webgpu' && !gpu ? 'WebGPU is not available in this browser' : `onnxruntime-web ${b}`}
              className={`rounded px-1.5 font-mono text-2xs disabled:opacity-40 ${backend === b ? 'bg-accent text-white' : 'bg-tabgroup'}`}
            >
              {b === 'wasm' ? 'WASM (CPU)' : 'WebGPU'}
            </button>
          ))}
        </span>
      </div>
      {(err || error) && <div className="px-3 pt-2 font-mono text-2xs text-live">{err ?? error}</div>}
      {source && (
        <>
          <div className="pt-2">
            <Row k="Source" v={<span className="block truncate" title={source.name}>{source.name}</span>} />
            <Row k="Kind" v={<span className="font-mono text-2xs">{SOURCE_LABEL[source.kind]}</span>} />
            {source.note && <Row k="Provenance" v={source.note} />}
            {model && <Row k="Model load" v={`${(model.loadMs / 1000).toFixed(1)} s, once per session (counts toward first detection)`} />}
            <Row
              k="Detector"
              v={model ? `Sentinel ${model.arch} · ${model.imgsz} px · conf ≥ ${model.conf} · ${backend.toUpperCase()}${backend === 'wasm' ? ` · ${model.threads} thread${model.threads > 1 ? 's' : ''}` : ''}` : status}
            />
          </div>
          <div className="grid grid-cols-3 gap-x-3 gap-y-2 px-3 py-2">
            <Stat label="Inference" value={ms(stats.inferMs)} sub="ms, median of 30" />
            <Stat label="Processed" value={stats.procFps === null ? '–' : stats.procFps.toFixed(1)} sub="fps" />
            <Stat label="Source" value={stats.srcFps === null ? '–' : stats.srcFps.toFixed(1)} sub="fps" />
            <Stat label="Latency" value={ms(stats.e2eMs)} sub={stats.e2eBasis === 'capture' ? 'ms, capture → boxes' : 'ms, frame shown → boxes'} />
            <Stat
              label="First detection"
              tone={stats.firstDetS !== null ? 'live' : undefined}
              value={stats.firstDetS === null ? '–' : fmtStreamClock(stats.firstDetS)}
              sub="after stream start"
            />
            <Stat label="Boxes now" value={stats.dets.length} sub={`${stats.framesProcessed.toLocaleString()} frames run`} />
          </div>
          <div className="px-3 pb-2 text-2xs text-muted">
            Measured on this device. Frames that arrive while a frame is in inference are dropped, never queued. {caveat}.
          </div>
          <div className="flex gap-2 px-3 pb-3">
            <Button onClick={close}>Stop</Button>
          </div>
        </>
      )}
      {!source && <div className="px-3 py-2 text-2xs text-muted">{caveat}.</div>}
    </Card>
  );
}
