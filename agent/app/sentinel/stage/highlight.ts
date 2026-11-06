/**
 * The place a citation points at, marked while the pointer is over its chip in the rail
 * (useUi().highlight): a bold ring draped on the terrain and the citation's own label.
 */
import {useMemo} from 'react';
import {ScatterplotLayer} from '@deck.gl/layers';
import type {Highlight} from '../state/ui';
import type {Dem} from './dem';
import {NO_PART, type StagePart} from './evidence-layers';
import type {MapLabel} from './labels';

type RGBA = [number, number, number, number];
type Ring = {r: number; width: number; color: RGBA; fill?: RGBA};

// White halo under the accent ring keeps it readable on the char, the scar and the heat map.
const RINGS: Ring[] = [
  {r: 18, width: 6, color: [255, 255, 255, 220]},
  {r: 18, width: 3, color: [209, 101, 75, 255]},
  {r: 4, width: 1.5, color: [255, 255, 255, 255], fill: [209, 101, 75, 255]}
];
const MAX_LABEL = 60;

export function useHighlightPart(dem: Dem | null, highlight: Highlight): StagePart {
  return useMemo(() => {
    if (!dem || !highlight || !dem.contains(highlight.lon, highlight.lat)) return NO_PART;
    const position = [highlight.lon, highlight.lat, dem.heightAt(highlight.lon, highlight.lat) + 20];
    // The position travels in the data: deck ignores a new accessor function, and the pointer can
    // move from one chip to the next without a null highlight in between.
    const rings = RINGS.map(r => ({...r, position: position as [number, number, number]}));
    const layer = new ScatterplotLayer<(typeof rings)[number]>({
      id: 'highlight',
      data: rings,
      getPosition: d => d.position,
      getRadius: d => d.r,
      radiusUnits: 'pixels',
      billboard: true,
      stroked: true,
      filled: true,
      getFillColor: d => d.fill ?? [0, 0, 0, 0],
      getLineColor: d => d.color,
      getLineWidth: d => d.width,
      lineWidthUnits: 'pixels',
      parameters: {depthCompare: 'always', depthWriteEnabled: false}
    });
    const text = highlight.label?.trim();
    const labels: MapLabel[] = text
      ? [
          {
            id: 'highlight',
            position,
            text: text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text,
            style: 'callout',
            // Above every other label: it is what the reader is pointing at.
            priority: 1000
          }
        ]
      : [];
    return {layers: [layer], labels, notes: []};
  }, [dem, highlight]);
}
