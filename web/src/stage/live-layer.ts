import {useEffect, useMemo, useState} from 'react';
import type {Layer} from '@deck.gl/core';
import {PathLayer, PolygonLayer, ScatterplotLayer} from '@deck.gl/layers';
import {EDGE_WINDOW_MS, fadeAlpha, fireEdgeNow, useLiveHits, type LiveHit} from '../drones/live/livemap';
import type {Dem} from './dem';
import {drapeDense} from './drape';
import {NO_PART, type StagePart} from './evidence-layers';
import type {MapLabel} from './labels';
import type {StageNote} from './overlays';

const HIT: [number, number, number] = [255, 64, 32];
const EDGE: [number, number, number, number] = [255, 214, 64, 255];
const overlay = {depthCompare: 'always' as const, depthWriteEnabled: false};
const LIFT = 6;

/** Re-renders once a second while there are hits, so their fade follows wall time. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * LIVE detections on the map: each projected box as a dot (fading with age) over its ground
 * footprint, an uncertainty ring on the recent ones, and the hull of the last EDGE_WINDOW_MS as
 * "fire edge now". Only hits that land inside this fire's DEM are drawn.
 */
export function useLiveHitsPart(dem: Dem | null, on: boolean): StagePart {
  const all = useLiveHits(s => s.hits);
  const hits = useMemo(() => all.filter(h => h.onMap), [all]);
  const now = useNow(on && hits.length > 0);

  const edge = useMemo(() => {
    if (!dem) return null;
    const ring = fireEdgeNow(hits, now);
    return ring ? drapeDense(dem, ring, LIFT + 2, 15) : null;
  }, [dem, hits, now]);

  return useMemo(() => {
    if (!on || !hits.length) return NO_PART;
    const newest = hits[hits.length - 1];
    const recent = hits.filter(h => now - h.tMs <= EDGE_WINDOW_MS);
    const alpha = (h: LiveHit) => Math.round(255 * fadeAlpha(now - h.tMs));
    const layers: Layer[] = [
      new PolygonLayer<LiveHit>({
        id: 'live-footprints',
        data: hits.filter(h => h.corners.length >= 3),
        getPolygon: h => h.corners.map(c => [c[0], c[1], c[2] + LIFT]),
        getFillColor: h => [...HIT, Math.round(alpha(h) * 0.25)],
        stroked: false,
        updateTriggers: {getFillColor: now},
        parameters: overlay
      }),
      new ScatterplotLayer<LiveHit>({
        id: 'live-uncertainty',
        data: recent,
        getPosition: h => [h.lon, h.lat, h.elevM + LIFT],
        getRadius: h => h.radiusM,
        radiusUnits: 'meters',
        filled: false,
        stroked: true,
        getLineColor: [...HIT, 120],
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        parameters: overlay
      }),
      new ScatterplotLayer<LiveHit>({
        id: 'live-hits',
        data: hits,
        getPosition: h => [h.lon, h.lat, h.elevM + LIFT],
        getRadius: 4,
        radiusUnits: 'pixels',
        getFillColor: h => [...HIT, alpha(h)],
        stroked: true,
        getLineColor: h => [255, 255, 255, alpha(h)],
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        updateTriggers: {getFillColor: now, getLineColor: now},
        parameters: overlay
      })
    ];
    if (edge)
      layers.push(
        new PathLayer<number[][]>({
          id: 'live-edge',
          data: [edge],
          getPath: d => d as any,
          getColor: EDGE,
          getWidth: 3,
          widthUnits: 'pixels',
          parameters: overlay
        })
      );
    const manual = hits.some(h => h.pose === 'manual');
    const srt = hits.some(h => h.pose === 'srt');
    const poseText = manual && srt ? 'SRT + manual pose' : manual ? 'manual pose' : 'SRT pose';
    const labels: MapLabel[] = [
      {
        id: 'live-newest',
        position: [newest.lon, newest.lat, newest.elevM + LIFT],
        text: `LIVE · ${edge ? 'FIRE EDGE NOW' : 'HIT'} · ${poseText}`,
        style: 'chip',
        priority: 90
      }
    ];
    const sources = [...new Set(hits.map(h => h.sourceName))];
    const notes: StageNote[] = [
      {
        id: 'live',
        tag: 'LIVE',
        title: `Live hits · ${hits.length.toLocaleString()} · ${poseText}`,
        detail: [
          'Sentinel boxes from the live feed, run in this browser, projected onto the terrain from the drone pose. Dots fade over 2 min; the yellow outline is the hull of the last 20 s ("fire edge now")',
          manual ? 'Placed with a pose typed in by hand (manual pose), not recorded telemetry' : '',
          `Source: ${sources.join(', ')}`
        ]
          .filter(Boolean)
          .join('\n'),
        swatches: [
          {color: `rgb(${HIT.join(',')})`, label: 'Live hit (fades with age)'},
          {color: `rgb(${EDGE.slice(0, 3).join(',')})`, label: 'Fire edge now (last 20 s)', shape: 'line'}
        ]
      }
    ];
    return {layers, labels, notes};
  }, [on, hits, now, edge]);
}
