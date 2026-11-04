import {useRef, useState} from 'react';
import type {FireData} from '../../data/fire';
import {parseDjiSrt} from '../../lib/dji-srt';
import {Button, Card, Chip, Row} from '../../rail/ui';
import {useLive} from './live';
import {useLiveHits, type ManualPose} from './livemap';
import {DEFAULT_HFOV} from './useLiveGeo';

const FIELDS: {k: keyof ManualPose; label: string; unit: string; hint: string}[] = [
  {k: 'lat', label: 'Latitude', unit: '°', hint: 'WGS84'},
  {k: 'lon', label: 'Longitude', unit: '°', hint: 'WGS84, west negative'},
  {k: 'altAglM', label: 'Altitude AGL', unit: 'm', hint: 'above the ground under the drone'},
  {k: 'headingDeg', label: 'Heading', unit: '°', hint: 'camera, clockwise from true north'},
  {k: 'pitchDeg', label: 'Gimbal pitch', unit: '°', hint: '0 level, −90 straight down'},
  {k: 'hfovDeg', label: 'Horizontal FOV', unit: '°', hint: `of the video as recorded; ${DEFAULT_HFOV}° if empty`}
];

const toForm = (p: ManualPose | null): Record<keyof ManualPose, string> =>
  Object.fromEntries(FIELDS.map(f => [f.k, p ? String(p[f.k]) : f.k === 'hfovDeg' ? String(DEFAULT_HFOV) : ''])) as Record<keyof ManualPose, string>;

/** Drones rail: where the live boxes land on the map, and the drone pose that puts them there. */
export function LiveGeoCard({fire}: {fire: FireData}) {
  const {hits, masks, mode, manual, srt, srtName, lastError, set, clear} = useLiveHits();
  const source = useLive(s => s.source);
  const [form, setForm] = useState(() => toForm(manual));
  const [formErr, setFormErr] = useState<string | null>(null);
  const srtInput = useRef<HTMLInputElement>(null);
  const onMap = hits.filter(h => h.onMap).length;
  const placeName = fire.aoi.name;

  const apply = () => {
    const vals = Object.fromEntries(FIELDS.map(f => [f.k, f.k === 'hfovDeg' && !form[f.k].trim() ? DEFAULT_HFOV : Number(form[f.k])])) as ManualPose;
    const bad = FIELDS.find(f => !form[f.k].trim() && f.k !== 'hfovDeg') ?? FIELDS.find(f => !Number.isFinite(vals[f.k]));
    // In SRT mode only heading, pitch and FOV are fallbacks; position comes from the track.
    if (bad && !(mode === 'srt' && ['lat', 'lon', 'altAglM'].includes(bad.k))) {
      setFormErr(`${bad.label} is missing or not a number`);
      return;
    }
    if (Math.abs(vals.lat) > 90 || Math.abs(vals.lon) > 180) {
      setFormErr('latitude or longitude out of range');
      return;
    }
    setFormErr(null);
    set({manual: vals});
  };

  return (
    <Card title="Live Hits on the Map" aside={<Chip tone="live">LIVE</Chip>}>
      <div className="px-3 pt-2 text-xs text-muted">
        Each live box is projected onto the terrain from the drone's pose: a DJI .SRT telemetry track for the video, or a pose entered here. Without a
        pose nothing is placed. A clip's hits land on this map only if its pose is over {placeName}.
      </div>
      <div className="flex gap-1 px-3 pt-2">
        {(['srt', 'manual'] as const).map(m => (
          <button
            key={m}
            onClick={() => set({mode: m})}
            className={`rounded px-1.5 font-mono text-2xs ${mode === m ? 'bg-accent text-white' : 'bg-tabgroup'}`}
          >
            {m === 'srt' ? 'DJI SRT TELEMETRY' : 'MANUAL POSE'}
          </button>
        ))}
      </div>
      {mode === 'srt' && (
        <div className="px-3 pt-2 text-xs">
          <div className="flex items-center gap-2">
            <Button onClick={() => srtInput.current?.click()}>Load .SRT…</Button>
            <span className="min-w-0 flex-1 truncate text-muted">{srtName ?? 'none loaded'}</span>
          </div>
          <input
            ref={srtInput}
            type="file"
            accept=".srt,.SRT,text/plain"
            className="hidden"
            onChange={async e => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const parsed = parseDjiSrt(await f.text());
              set({srt: parsed, srtName: f.name, lastError: parsed.frames.length ? null : 'no telemetry blocks found in the .SRT'});
            }}
          />
          {srt && (
            <div className="pt-1 text-2xs text-muted">
              {srt.frames.length.toLocaleString()} blocks · {srt.format} format
              {srt.frames.length > 0 && srt.frames[0].gimbalYawDeg === undefined && ' · no gimbal yaw/pitch recorded: heading and pitch come from the form below'}
              {source && source.kind !== 'file' && ' · SRT time needs a video file source'}
            </div>
          )}
        </div>
      )}
      <form
        className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 px-3 pt-2 text-xs"
        onSubmit={e => {
          e.preventDefault();
          apply();
        }}
      >
        {FIELDS.map(f => {
          const fallbackOnly = mode === 'srt' && ['lat', 'lon', 'altAglM'].includes(f.k);
          if (fallbackOnly) return null;
          return (
            <label key={f.k} className="contents" title={f.hint}>
              <span className="text-muted">
                {f.label} ({f.unit})
              </span>
              <input
                inputMode="decimal"
                data-pose={f.k}
                value={form[f.k]}
                placeholder={f.hint}
                onChange={e => setForm({...form, [f.k]: e.target.value})}
                className="min-w-0 rounded bg-card px-1.5 py-0.5 font-mono shadow-[0_0_0_1px_var(--hairline)]"
              />
            </label>
          );
        })}
        <span />
        <span className="flex gap-2 pt-1">
          <button type="submit" className="rounded-md bg-accent px-2.5 py-1 text-sm font-medium text-white">
            {mode === 'srt' ? 'Apply fallbacks' : 'Apply pose'}
          </button>
          {mode === 'manual' && (
            <Button
              title={`Fills the position with the centre of the ${placeName} map; hits are then marked manual pose`}
              onClick={() => setForm({...form, lat: fire.aoi.center[1].toFixed(5), lon: fire.aoi.center[0].toFixed(5)})}
            >
              Map centre
            </Button>
          )}
        </span>
      </form>
      {formErr && <div className="px-3 pt-1 font-mono text-2xs text-live">{formErr}</div>}
      <div className="pt-2">
        <Row k="Pose" v={mode === 'srt' ? (srt ? `SRT · ${srtName}` : 'no SRT loaded') : manual ? `manual pose · ${manual.lat.toFixed(4)}, ${manual.lon.toFixed(4)}, ${manual.altAglM} m AGL` : 'not entered'} />
        <Row k="Hits" v={`${hits.length.toLocaleString()} located · ${onMap.toLocaleString()} on this map${hits.length > onMap ? ` · ${(hits.length - onMap).toLocaleString()} outside it` : ''}`} />
        {masks.length > 0 && (
          <Row
            k="SAM masks"
            v={`${masks.length.toLocaleString()} projected · ${masks.filter(m => m.onMap).length.toLocaleString()} on this map · newest ${masks[masks.length - 1].vertices} vertices${masks[masks.length - 1].dropped ? `, ${masks[masks.length - 1].dropped} above the horizon` : ''}`}
          />
        )}
        {lastError && source && <Row k="Not placed" v={<span className="font-mono text-2xs">{lastError}</span>} />}
      </div>
      <div className="px-3 pb-2 pt-1 text-2xs text-muted">
        Positions assume a pinhole camera, no lens distortion, and the stated pose; the uncertainty ring is a rough 1σ from GNSS, compass, gimbal and
        terrain error, not calibrated. {mode === 'manual' && 'Hits from a typed pose are labelled manual pose.'}
      </div>
      <div className="flex gap-2 px-3 pb-3">
        <Button onClick={clear} disabled={!hits.length && !masks.length}>
          Clear hits
        </Button>
      </div>
    </Card>
  );
}
