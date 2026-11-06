import {useEffect, useMemo, useState} from 'react';
import type {Layer} from '@deck.gl/core';
import {PathLayer, PolygonLayer, ScatterplotLayer} from '@deck.gl/layers';
import {EDGE_WINDOW_MS, fadeAlpha, fireEdgeNow, useLiveHits, type LiveHit} from '../drones/live/livemap';
import type {LiveMask} from '../drones/live/maskmap';
import type {Dem} from './dem';
import {drapeDense} from './drape';
import {NO_PART, type StagePart} from './evidence-layers';
import type {MapLabel} from './labels';
import type {StageNote} from './overlays';

const HIT: [number, number, number] = [255, 64, 32];
const EDGE: [number, number, number, number] = [255, 214, 64, 255];
/** SAM 3.1 cyan, as on the video. */
const MASK: [number, number, number] = [79, 227, 240];
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
 * "fire edge now", plus each SAM 3.1 mask's outline projected onto the terrain (maskmap.ts), fading
 * the same way. Only hits and masks that land inside this fire's DEM are drawn.
 */
export function useLiveHitsPart(dem: Dem | null, on: boolean): StagePart {
  const all = useLiveHits(s => s.hits);
  const hits = useMemo(() => all.filter(h => h.onMap), [all]);
  const allMasks = useLiveHits(s => s.masks);
  const masks = useMemo(() => allMasks.filter(m => m.onMap), [allMasks]);
  const now = useNow(on && (hits.length > 0 || masks.length > 0));

  const edge = useMemo(() => {
    if (!dem) return null;
    const ring = fireEdgeNow(hits, now);
    return ring ? drapeDense(dem, ring, LIFT + 2, 15) : null;
  }, [dem, hits, now]);

  return useMemo(() => {
    if (!on || (!hits.length && !masks.length)) return NO_PART;
    const newest = hits.length ? hits[hits.length - 1] : null;
    const newestMask = masks.length ? masks[masks.length - 1] : null;
    const recent = hits.filter(h => now - h.tMs <= EDGE_WINDOW_MS);
    const alpha = (h: {tMs: number}) => Math.round(255 * fadeAlpha(now - h.tMs));
    const layers: Layer[] = [
      new PolygonLayer<LiveMask>({
        id: 'live-masks',
        data: masks,
        getPolygon: m => m.ring.map(c => [c[0], c[1], c[2] + LIFT]),
        getFillColor: m => [...MASK, Math.round(alpha(m) * 0.3)],
        getLineColor: m => [...MASK, alpha(m)],
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        updateTriggers: {getFillColor: now, getLineColor: now},
        parameters: overlay
      }),
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
    const placed = [...hits, ...masks];
    const manual = placed.some(h => h.pose === 'manual');
    const srt = placed.some(h => h.pose === 'srt');
    const poseText = manual && srt ? 'SRT + manual pose' : manual ? 'manual pose' : 'SRT pose';
    const labels: MapLabel[] = [];
    if (newest)
      labels.push({
        id: 'live-newest',
        position: [newest.lon, newest.lat, newest.elevM + LIFT],
        text: `${edge ? 'Fire edge now' : 'Hit'} · ${poseText}`,
        style: 'chip',
        priority: 90
      });
    if (newestMask) {
      const [lon, lat, z] = newestMask.ring.reduce((a, c) => [a[0] + c[0], a[1] + c[1], Math.max(a[2], c[2])], [0, 0, -Infinity]);
      labels.push({
        id: 'live-mask-newest',
        position: [lon / newestMask.ring.length, lat / newestMask.ring.length, z + LIFT],
        text: `SAM 3.1 MASK · ${Math.round(newestMask.areaM2).toLocaleString()} m² · ${poseText}`,
        style: 'chip',
        priority: 89
      });
    }
    const sources = [...new Set(placed.map(h => h.sourceName))];
    const notes: StageNote[] = [
      {
        id: 'live',
        title: `Live hits · ${hits.length.toLocaleString()}${masks.length ? ` · ${masks.length.toLocaleString()} SAM 3.1 masks` : ''} · ${poseText}`,
        detail: [
          'Sentinel boxes from the live feed, run in this browser, projected onto the terrain from the drone pose. Dots fade over 2 min; the yellow outline is the hull of the last 20 s ("fire edge now")',
          masks.length
            ? 'Cyan: SAM 3.1 masks of live frames (Meta Model API), each outline ray-cast vertex by vertex onto the terrain with the pose of its frame; holes in a mask are not drawn'
            : '',
          manual ? 'Placed with a pose typed in by hand (manual pose), not recorded telemetry' : '',
          `Source: ${sources.join(', ')}`
        ]
          .filter(Boolean)
          .join('\n'),
        swatches: [
          {color: `rgb(${HIT.join(',')})`, label: 'Live hit (fades with age)'},
          {color: `rgb(${EDGE.slice(0, 3).join(',')})`, label: 'Fire edge now (last 20 s)', shape: 'line'},
          ...(masks.length ? [{color: `rgb(${MASK.join(',')})`, label: 'SAM 3.1 mask on the terrain (fades with age)'}] : [])
        ]
      }
    ];
    return {layers, labels, notes};
  }, [on, hits, masks, now, edge]);
}
