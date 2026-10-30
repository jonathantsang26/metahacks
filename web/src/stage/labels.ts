/**
 * Every text on the map (chips, markers, place names) goes through one list so labels from
 * different layers can be decluttered against each other in screen space: the higher priority
 * label keeps its spot and anything it would overlap is hidden until the camera separates them.
 */
import {WebMercatorViewport, type MapViewState} from '@deck.gl/core';
import {TextLayer} from '@deck.gl/layers';
import {formatDateTime, zoneLabel} from '../lib/format';

export type LabelStyle = 'chip' | 'chipMuted' | 'marker' | 'markerLeft' | 'markerBelow' | 'place' | 'water';

export type MapLabel = {
  id: string;
  /** Draped [lon, lat, z]. */
  position: number[];
  text: string;
  style: LabelStyle;
  /** Higher wins when two labels collide. */
  priority: number;
};

type StyleDef = {
  size: number;
  /** Average glyph advance as a fraction of size, for the screen-space box estimate. */
  advance: number;
  /** Pixel offset of the text anchor from the point; chips sit to the right of their marker. */
  offset: [number, number];
  anchor: 'start' | 'middle' | 'end';
  pad: [number, number];
};

const MONO = '"JetBrains Mono", "SF Mono", ui-monospace, monospace';
const SANS = 'Inter, system-ui, sans-serif';

const STYLES: Record<LabelStyle, StyleDef> = {
  chip: {size: 11, advance: 0.62, offset: [12, 0], anchor: 'start', pad: [6, 3]},
  chipMuted: {size: 11, advance: 0.62, offset: [12, 0], anchor: 'start', pad: [6, 3]},
  marker: {size: 12, advance: 0.6, offset: [14, 0], anchor: 'start', pad: [2, 2]},
  markerLeft: {size: 12, advance: 0.6, offset: [-14, 0], anchor: 'end', pad: [2, 2]},
  markerBelow: {size: 12, advance: 0.6, offset: [0, 26], anchor: 'middle', pad: [2, 2]},
  place: {size: 12, advance: 0.58, offset: [0, 0], anchor: 'middle', pad: [3, 2]},
  water: {size: 11, advance: 0.58, offset: [0, 0], anchor: 'middle', pad: [3, 2]}
};

/** "Jan 8, 03:12 PST": the incident's zone, computed per instant. */
export function stamp(ms: number, timeZone: string): string {
  return `${formatDateTime(ms, timeZone)} ${zoneLabel(ms, timeZone)}`;
}

/** "5 h 10 min", "42 min". */
export function span(ms: number): string {
  const mins = Math.round(Math.abs(ms) / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Where a label may go, in order of preference. A marker (the ignition estimate, CAL FIRE's
 * reported point) flips to the left or below before it gives up its text, so two nearby markers
 * both stay labelled; it is dropped only when the markers themselves overlap on screen.
 */
const PLACEMENTS: Partial<Record<LabelStyle, LabelStyle[]>> = {marker: ['marker', 'markerLeft', 'markerBelow']};

/** The labels that survive, each with the style (placement) it won, given the camera and stage size in CSS pixels. */
export function declutter(labels: MapLabel[], viewState: MapViewState, width: number, height: number): Map<string, LabelStyle> {
  const keep = new Map<string, LabelStyle>();
  if (!width || !height) {
    for (const l of labels) keep.set(l.id, l.style);
    return keep;
  }
  const viewport = new WebMercatorViewport({...viewState, width, height});
  const taken: [number, number, number, number][] = [];
  const order = [...labels].sort((a, b) => b.priority - a.priority);
  for (const l of order) {
    const [x, y] = viewport.project(l.position);
    if (!Number.isFinite(x) || x < -200 || y < -100 || x > width + 200 || y > height + 100) continue;
    const lines = l.text.split('\n');
    for (const style of PLACEMENTS[l.style] ?? [l.style]) {
      const s = STYLES[style];
      const w = Math.max(...lines.map(t => t.length)) * s.size * s.advance + 2 * s.pad[0];
      const h = lines.length * s.size * 1.25 + 2 * s.pad[1];
      const x0 = x + s.offset[0] - (s.anchor === 'middle' ? w / 2 : s.anchor === 'end' ? w - s.pad[0] : s.pad[0]);
      const y0 = y + s.offset[1] - h / 2;
      const box: [number, number, number, number] = [x0, y0, x0 + w, y0 + h];
      if (taken.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      taken.push(box);
      keep.set(l.id, style);
      break;
    }
  }
  return keep;
}

const textBase = {
  characterSet: 'auto' as const,
  sizeUnits: 'pixels' as const,
  getPosition: (d: MapLabel) => d.position as [number, number, number],
  getText: (d: MapLabel) => d.text,
  getAlignmentBaseline: 'center' as const,
  lineHeight: 1.25,
  // Labels stay readable when a ridge sits between them and the camera.
  parameters: {depthCompare: 'always' as const, depthWriteEnabled: false}
};

/** One TextLayer per style, over the labels that survived declutter. */
export function labelLayers(byStyle: Record<LabelStyle, MapLabel[]>): TextLayer<MapLabel>[] {
  const chip = (id: LabelStyle, color: [number, number, number, number], bg: [number, number, number, number]) =>
    new TextLayer<MapLabel>({
      ...textBase,
      id: `labels-${id}`,
      data: byStyle[id],
      fontFamily: MONO,
      getSize: STYLES[id].size,
      getColor: color,
      getTextAnchor: 'start',
      getPixelOffset: STYLES[id].offset,
      background: true,
      getBackgroundColor: bg,
      backgroundPadding: STYLES[id].pad,
      backgroundBorderRadius: 4
    });
  const halo = (id: LabelStyle, color: [number, number, number, number], weight: number) =>
    new TextLayer<MapLabel>({
      ...textBase,
      id: `labels-${id}`,
      data: byStyle[id],
      fontFamily: SANS,
      fontWeight: weight,
      getSize: STYLES[id].size,
      getColor: color,
      getTextAnchor: STYLES[id].anchor,
      getPixelOffset: STYLES[id].offset,
      fontSettings: {sdf: true},
      outlineWidth: 0.5,
      outlineColor: [39, 35, 26, 170]
    });
  return [
    halo('water', [214, 230, 240, 255], 500),
    halo('place', [255, 255, 255, 255], 600),
    halo('marker', [255, 255, 255, 255], 600),
    halo('markerLeft', [255, 255, 255, 255], 600),
    halo('markerBelow', [255, 255, 255, 255], 600),
    chip('chipMuted', [255, 255, 255, 150], [39, 35, 26, 150]),
    chip('chip', [255, 255, 255, 255], [39, 35, 26, 235])
  ];
}

export function groupByStyle(labels: MapLabel[], keep: Map<string, LabelStyle>): Record<LabelStyle, MapLabel[]> {
  const out: Record<LabelStyle, MapLabel[]> = {
    chip: [],
    chipMuted: [],
    marker: [],
    markerLeft: [],
    markerBelow: [],
    place: [],
    water: []
  };
  for (const l of labels) {
    const style = keep.get(l.id);
    if (style) out[style].push(l);
  }
  return out;
}
