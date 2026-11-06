import {useEffect, useMemo, useState} from 'react';
import type {Layer} from '@deck.gl/core';
import {PathLayer} from '@deck.gl/layers';
import type {FireData} from '../data/fire';
import {loadFireJson} from '../data/files';
import {useUi} from '../state/ui';
import type {Dem} from './dem';
import {drapeDense, ringsOf} from './drape';
import {dashExtension, NO_PART, type StagePart} from './evidence-layers';
import {forecastTimes, leadLabel, METHOD_LABEL, parseIndex, pickEntry, pickForecast, type ForecastCollection, type IndexEntry, type IssuedForecast} from './forecast';
import {stamp, type MapLabel} from './labels';
import type {StageNote} from './overlays';

type RGBA = [number, number, number, number];
const COLORS: Record<string, RGBA> = {physics: [126, 87, 255, 255], muse: [36, 196, 230, 255]};
const OTHER: RGBA = [255, 255, 255, 255];
/** A Muse reply the validator rejected: the file holds a no-growth stand-in, drawn grey, never as a forecast. */
const REJECTED: RGBA = [150, 146, 136, 230];
const css = ([r, g, b]: number[]) => `rgb(${r}, ${g}, ${b})`;

const INDEX = 'forecast/index.json';
/** The Muse export log: which issue times' replies were rejected (scored and exported as no growth). */
const MUSE_LOG = 'forecast/muse_export_log.json';
type MuseLog = {forecasts?: {issued_utc?: string; rejected?: string | null}[]};

/**
 * The forecast in force at t (forecast.ts pickForecast), drawn as a dashed outline per method. When
 * index.json is missing the layer disables its chip and draws nothing.
 */
export function useForecastPart(fire: FireData, dem: Dem | null, t: number, on: boolean): StagePart {
  const [index, setIndex] = useState<IndexEntry[] | null>(null);
  const [loaded, setLoaded] = useState<IssuedForecast[]>([]);
  // Issue time (ms) → the validator's reason, for Muse replies that were rejected.
  const [rejected, setRejected] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    let live = true;
    loadFireJson<MuseLog>(fire, MUSE_LOG).then(
      log => {
        if (!live) return;
        const m = new Map<number, string>();
        for (const f of log.forecasts ?? []) {
          const ms = Date.parse(f.issued_utc ?? '');
          if (f.rejected && Number.isFinite(ms)) m.set(ms, String(f.rejected));
        }
        setRejected(m);
      },
      () => {
        // No log: nothing is known to be rejected.
      }
    );
    return () => {
      live = false;
    };
  }, [fire]);

  useEffect(() => {
    let live = true;
    loadFireJson<unknown>(fire, INDEX).then(
      json => {
        if (!live) return;
        const entries = parseIndex(json);
        setIndex(entries);
        if (!entries.length) markMissing('no forecast issued yet');
      },
      () => live && markMissing('forecast not exported yet')
    );
    return () => {
      live = false;
    };
  }, [fire]);

  // Without issue times in the index every file is read once; with them only the one in force at t.
  const lazy = !!index?.length && index.every(e => e.issuedMs !== null);
  const wanted = useMemo(() => {
    if (!index) return [];
    if (!lazy) return index.map(e => e.file);
    const e = pickEntry(index, t);
    return e ? [e.file] : [];
  }, [index, lazy, t]);

  useEffect(() => {
    let live = true;
    const missing = wanted.filter(f => !loaded.some(l => l.file === f));
    if (!missing.length) return;
    Promise.allSettled(missing.map(f => loadFireJson<ForecastCollection>(fire, `forecast/${f}`).then(fc => ({f, fc})))).then(rs => {
      if (!live) return;
      const add: IssuedForecast[] = [];
      for (const r of rs) {
        if (r.status !== 'fulfilled') continue;
        const times = forecastTimes(r.value.fc);
        if (times) add.push({file: r.value.f, fc: r.value.fc, ...times});
      }
      if (add.length) setLoaded(prev => [...prev, ...add]);
    });
    return () => {
      live = false;
    };
  }, [fire, wanted, loaded]);

  const current = pickForecast(loaded, t);

  const draped = useMemo(() => {
    if (!dem || !current) return null;
    return current.fc.features.map(f => {
      const rings = ringsOf(f.geometry).map(r => drapeDense(dem, r, 14, 60));
      let top = rings[0]?.[0];
      for (const r of rings) for (const p of r) if (!top || p[1]! > top[1]!) top = p;
      const issued = Date.parse(f.properties.issued_utc);
      const fallback = f.properties.method === 'muse' && rejected.has(issued);
      return {rings, top, method: f.properties.method, fallback, why: fallback ? rejected.get(issued)! : null};
    });
  }, [dem, current, rejected]);

  return useMemo(() => {
    if (!on || !current || !draped) return NO_PART;
    const lead = leadLabel(current.issuedMs, current.validMs);
    const tz = fire.aoi.timezone;
    const methods = [...new Set(draped.filter(d => !d.fallback).map(d => d.method))];
    const fallbacks = draped.filter(d => d.fallback);
    const layers: Layer[] = [
      new PathLayer<{path: number[][]; method: string}, {getDashArray: [number, number]; dashJustified: boolean}>({
        id: 'forecast-outline',
        data: draped.flatMap(d => d.rings.map(path => ({path, method: d.fallback ? 'rejected' : d.method}))),
        getPath: d => d.path as any,
        getColor: d => (d.method === 'rejected' ? REJECTED : COLORS[d.method] ?? OTHER),
        getWidth: 2.5,
        widthUnits: 'pixels',
        getDashArray: [8, 5],
        dashJustified: true,
        extensions: [dashExtension],
        parameters: {depthCompare: 'always', depthWriteEnabled: false}
      })
    ];
    const labels: MapLabel[] = draped
      .filter(d => d.top)
      .map((d, i) => ({
        id: `forecast-${i}`,
        position: d.top!,
        text: d.fallback
          ? `MUSE REJECTED: no-growth fallback, not a forecast`
          : `FORECAST ${lead} · ${METHOD_LABEL(d.method)} · valid ${stamp(current.validMs, tz)}`,
        style: 'chip',
        priority: 75
      }));
    const notes: StageNote[] = [
      {
        id: 'forecast',
        tag: 'FORECAST',
        title: `Forecast ${lead} · ${methods.map(METHOD_LABEL).join(' + ') || 'none usable'}`,
        detail: [
          `Issued ${stamp(current.issuedMs, tz)}, valid ${stamp(current.validMs, tz)}: the latest forecast issued at or before t`,
          'A model projection of where the fire may be, not an observation',
          ...fallbacks.map(
            d =>
              `Muse's reply for this hour was rejected by the validator (${d.why}); the grey outline is the no-growth fallback the scorer assumes, not a forecast of no growth`
          ),
          `forecast/${current.file}`
        ].join('\n'),
        swatches: [
          ...methods.map(m => ({color: css(COLORS[m] ?? OTHER), label: `${METHOD_LABEL(m)} forecast`, shape: 'dash' as const})),
          ...(fallbacks.length ? [{color: css(REJECTED), label: 'Muse rejected · no-growth fallback', shape: 'dash' as const}] : [])
        ]
      }
    ];
    return {layers, labels, notes};
  }, [on, current, draped, fire]);
}

function markMissing(pending: string) {
  const l = useUi.getState().layers.forecast;
  if (l.ready) useUi.setState(s => ({layers: {...s.layers, forecast: {...s.layers.forecast, ready: false, pending}}}));
}
