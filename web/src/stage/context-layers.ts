/**
 * Context around the fire: HRRR wind arrows for the hour at t, DINS structures by damage class,
 * OSM roads and place labels. Structures and roads are big files, fetched the first time their
 * layer is switched on; everything is draped once per dataset.
 */
import {useMemo} from 'react';
import type {Layer} from '@deck.gl/core';
import {PathLayer, ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import {DataFilterExtension} from '@deck.gl/extensions';
import type {FireData} from '../data/fire';
import {indexAtOrBefore, useFireJson, type PlaceLabel, type Roads, type Structures, type WindField} from '../data/files';
import {decodeArrival, type Raster} from '../data/raster';
import type {LayerDef} from '../state/ui';
import type {Dem} from './dem';
import {distanceM, drapeDense, offsetM} from './drape';
import {stamp, type MapLabel} from './labels';
import {useFireJsonWhen} from './load';
import {NO_PART, type StagePart} from './evidence-layers';

type RGBA = [number, number, number, number];
const filterExtension = new DataFilterExtension({filterSize: 1});

/** Wind arrows centered on each grid point, length ∝ speed, pointing where the air moves. */
export function useWindPart(fire: FireData, dem: Dem | null, t: number, layer: LayerDef): StagePart {
  const wind = useFireJsonWhen<WindField>(fire, 'wind_field.json', layer.visible);
  const tz = fire.aoi.timezone;

  // The strongest wind anywhere in the file spans 85% of the grid spacing.
  const metersPerMph = useMemo(() => {
    const w = wind.data;
    if (!w || w.points.length < 2) return null;
    let max = 0;
    for (let i = 0; i < w.points.length; i++)
      for (let k = 0; k < w.t.length; k++) max = Math.max(max, Math.hypot(w.u_mph[i][k], w.v_mph[i][k]));
    const gap = (a: [number, number], b: [number, number]) => distanceM(a[0], a[1], b[0], b[1]);
    const spacings = [
      w.cols > 1 ? gap(w.points[0], w.points[1]) : Infinity,
      w.rows > 1 && w.points[w.cols] ? gap(w.points[0], w.points[w.cols]) : Infinity
    ];
    const spacing = Math.min(...spacings);
    return max > 0 && Number.isFinite(spacing) ? (0.85 * spacing) / max : null;
  }, [wind.data]);

  const hour = wind.data ? indexAtOrBefore(wind.data.t, t) : -1;

  const arrows = useMemo(() => {
    const w = wind.data;
    if (!w || !dem || !metersPerMph || hour < 0) return null;
    const paths: number[][][] = [];
    const labels: {position: number[]; text: string}[] = [];
    w.points.forEach(([lon, lat], i) => {
      const u = w.u_mph[i][hour];
      const v = w.v_mph[i][hour];
      const mph = Math.hypot(u, v);
      if (!Number.isFinite(mph)) return;
      labels.push({position: [lon, lat, dem.heightAt(lon, lat) + 60], text: `${Math.round(mph)} mph`});
      if (mph < 0.5) return;
      const len = mph * metersPerMph;
      const [ex, ny] = [u / mph, v / mph];
      const tail = offsetM(lon, lat, (-ex * len) / 2, (-ny * len) / 2);
      const tip = offsetM(lon, lat, (ex * len) / 2, (ny * len) / 2);
      // Arrowhead barbs: the backward direction turned ±28°.
      const head = len * 0.3;
      const barb = (a: number) =>
        offsetM(tip[0], tip[1], (-ex * Math.cos(a) + ny * Math.sin(a)) * head, (-ny * Math.cos(a) - ex * Math.sin(a)) * head);
      paths.push(drapeDense(dem, [tail, tip], 60, 150));
      paths.push(drapeDense(dem, [barb(0.49), tip, barb(-0.49)], 60, 150));
    });
    return {paths, labels, t: Date.parse(w.t[hour])};
  }, [wind.data, dem, metersPerMph, hour]);

  return useMemo(() => {
    if (!layer.visible) return NO_PART;
    const name = wind.data?.model.toLowerCase().includes('hrrr') ? 'HRRR' : wind.data?.model ?? 'model';
    if (wind.error) return {...NO_PART, notes: [{id: 'wind', title: 'Wind field unavailable', detail: wind.error}]};
    if (!wind.data) return NO_PART;
    const opacity = layer.opacity ?? 1;
    const layers: Layer[] = arrows
      ? [
          new PathLayer<number[][]>({
            id: 'wind-shadow',
            data: arrows.paths,
            getPath: d => d as any,
            getColor: [39, 35, 26, 110],
            getWidth: 4,
            widthUnits: 'pixels',
            capRounded: true,
            jointRounded: true,
            opacity
          }),
          new PathLayer<number[][]>({
            id: 'wind-arrows',
            data: arrows.paths,
            getPath: d => d as any,
            getColor: [255, 255, 255, 240],
            getWidth: 2,
            widthUnits: 'pixels',
            capRounded: true,
            jointRounded: true,
            opacity
          }),
          new TextLayer<(typeof arrows.labels)[number]>({
            id: 'wind-speed',
            data: arrows.labels,
            getPosition: d => d.position as [number, number, number],
            getText: d => d.text,
            getSize: 10,
            getColor: [255, 255, 255, 255],
            getPixelOffset: [0, 14],
            fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
            characterSet: 'auto',
            fontSettings: {sdf: true},
            outlineWidth: 0.5,
            outlineColor: [39, 35, 26, 190],
            parameters: {depthCompare: 'always', depthWriteEnabled: false},
            opacity
          })
        ]
      : [];
    const title = arrows ? `Wind · ${name} model · ${stamp(arrows.t, tz)}` : `Wind · ${name} model · no hour at or before t`;
    return {
      layers,
      labels: [],
      notes: [{id: 'wind', tag: name.toUpperCase(), title, detail: 'Arrows point where the air moves; length is proportional to speed'}]
    };
  }, [layer.visible, layer.opacity, wind.data, wind.error, arrows, tz]);
}

type Damage = Structures['features'][number]['properties']['damage'];

/** DINS damage classes, in the app's palette. */
export const DAMAGE_COLORS: Record<Damage, RGBA> = {
  Destroyed: [181, 53, 54, 255],
  Major: [209, 101, 75, 255],
  Minor: [226, 150, 70, 255],
  Affected: [222, 196, 104, 255],
  'No Damage': [103, 131, 82, 255],
  Inaccessible: [133, 126, 110, 255]
};
const PENDING: RGBA = [238, 234, 222, 255];
const OUTLINE: RGBA = [39, 35, 26, 150];
const HIGHLIGHT: RGBA = [255, 255, 255, 200];
const css = ([r, g, b]: RGBA) => `rgb(${r}, ${g}, ${b})`;

type House = {id: number; position: number[]; color: RGBA};

/**
 * Structures, coloured by DINS outcome once the modeled front reaches them (pale before).
 * Structures the arrival raster never reaches, or reaches only in the final perimeter, take
 * their colour at the window's end. The reveal is a GPU filter, so scrubbing costs no upload.
 */
export function useStructurePart(
  fire: FireData,
  dem: Dem | null,
  t: number,
  on: boolean,
  arrival: Raster | null,
  arrivalWindow: [number, number],
  selected: number | null,
  onSelect: (id: number) => void
): StagePart {
  const structures = useFireJsonWhen<Structures>(fire, 'structures.geojson', on);

  const houses = useMemo<House[] | null>(() => {
    if (!dem || !structures.data) return null;
    return structures.data.features.map(f => {
      const [lon, lat] = f.geometry.coordinates;
      return {
        id: f.properties.id,
        position: [lon, lat, dem.heightAt(lon, lat) + 6],
        color: DAMAGE_COLORS[f.properties.damage] ?? DAMAGE_COLORS.Inaccessible
      };
    });
  }, [dem, structures.data]);

  // Hours after the window start when the modeled front reaches each structure.
  const reachH = useMemo(() => {
    if (!houses || !arrival) return null;
    const [w0, w1] = arrivalWindow;
    const endH = (w1 - w0) / 3_600_000;
    const out = new Float32Array(houses.length);
    houses.forEach((h, i) => {
      const px = arrival.pixel(h.position[0], h.position[1]);
      const k = px ? (px.row * arrival.width + px.col) * 4 : -1;
      const late = k >= 0 && arrival.data[k + 1] === 32;
      const ms = k >= 0 && !late ? decodeArrival(arrival.data[k], w0, w1) : null;
      out[i] = ms === null ? endH : (ms - w0) / 3_600_000;
    });
    return out;
  }, [houses, arrival, arrivalWindow]);

  const byId = useMemo(() => new Map((houses ?? []).map(h => [h.id, h])), [houses]);
  const tH = (t - arrivalWindow[0]) / 3_600_000;

  if (!on) return NO_PART;
  if (structures.error) return {...NO_PART, notes: [{id: 'structures', title: 'Structures unavailable', detail: structures.error}]};
  if (!houses) return NO_PART;

  const gated = Boolean(reachH);
  const common = {
    data: houses,
    getPosition: (d: House) => d.position as [number, number, number],
    getRadius: 7,
    radiusMinPixels: 2,
    radiusMaxPixels: 7,
    billboard: true,
    stroked: true,
    getLineColor: OUTLINE,
    lineWidthMinPixels: 0.5,
    pickable: true,
    autoHighlight: true,
    highlightColor: HIGHLIGHT,
    onClick: ({object}: {object?: House}) => {
      if (object) onSelect(object.id);
      return true;
    }
  };
  const pick = selected !== null ? byId.get(selected) : undefined;
  const layers: Layer[] = [
    ...(gated ? [new ScatterplotLayer<House>({...common, id: 'structures-pending', getFillColor: PENDING})] : []),
    new ScatterplotLayer<House, {getFilterValue: (d: House, info: {index: number}) => number; filterRange: [number, number]; filterEnabled: boolean}>({
      ...common,
      id: 'structures',
      getFillColor: d => d.color,
      extensions: [filterExtension],
      getFilterValue: (_d, {index}) => (reachH ? reachH[index] : 0),
      filterRange: [-1e6, tH + 1e-3],
      filterEnabled: gated,
      updateTriggers: {getFilterValue: reachH}
    }),
    ...(pick
      ? [
          new ScatterplotLayer<House>({
            id: 'structure-selected',
            data: [pick],
            getPosition: d => d.position as [number, number, number],
            getRadius: 11,
            radiusUnits: 'pixels',
            billboard: true,
            stroked: true,
            filled: false,
            getLineColor: [209, 101, 75, 255],
            getLineWidth: 2.5,
            lineWidthUnits: 'pixels',
            parameters: {depthCompare: 'always', depthWriteEnabled: false}
          })
        ]
      : [])
  ];
  const swatches: {color: string; label: string}[] = (Object.keys(DAMAGE_COLORS) as Damage[]).map(k => ({
    color: css(DAMAGE_COLORS[k]),
    label: k
  }));
  if (gated) swatches.push({color: css(PENDING), label: 'Not yet reached (modeled)'});
  return {
    layers,
    labels: [],
    notes: [
      {
        id: 'structures',
        tag: 'DINS',
        title: 'Structures by damage inspection outcome',
        detail: gated
          ? "Outcome colour appears when the modeled front reaches each structure, or at the window's end where it never does"
          : undefined,
        swatches
      }
    ]
  };
}

const ROAD_WIDTH: Record<string, number> = {
  motorway: 2.6,
  trunk: 2.4,
  primary: 2,
  secondary: 1.7,
  tertiary: 1.4,
  residential: 1,
  unclassified: 1,
  living_street: 1
};

/** OSM roads as pale ribbons; tracks and paths thinner and fainter. */
export function useRoadPart(fire: FireData, dem: Dem | null, on: boolean): StagePart {
  const roads = useFireJsonWhen<Roads>(fire, 'roads.geojson', on);
  const paths = useMemo(() => {
    if (!dem || !roads.data) return null;
    return roads.data.features.map(f => {
      const w = ROAD_WIDTH[f.properties.highway];
      return {path: drapeDense(dem, f.geometry.coordinates, 5, 80), width: w ?? 0.8, minor: w === undefined};
    });
  }, [dem, roads.data]);

  return useMemo(() => {
    if (!on) return NO_PART;
    if (roads.error) return {...NO_PART, notes: [{id: 'roads', title: 'Roads unavailable', detail: roads.error}]};
    if (!paths) return NO_PART;
    return {
      ...NO_PART,
      layers: [
        new PathLayer<(typeof paths)[number]>({
          id: 'roads',
          data: paths,
          getPath: d => d.path as any,
          getWidth: d => d.width,
          getColor: (d): RGBA => (d.minor ? [247, 243, 233, 130] : [247, 243, 233, 215]),
          widthUnits: 'pixels',
          jointRounded: true
        })
      ]
    };
  }, [on, paths, roads.error]);
}

/** labels.json: peaks (▲ name and elevation), places and water, decluttered with the other labels. */
export function usePlaceLabels(fire: FireData, dem: Dem | null, on: boolean): MapLabel[] {
  const places = useFireJson<PlaceLabel[]>(fire, 'labels.json');
  const all = useMemo<MapLabel[]>(() => {
    if (!dem || !places.data) return [];
    return places.data.map((p, i) => ({
      id: `place-${i}`,
      position: [p.lon, p.lat, dem.heightAt(p.lon, p.lat) + 30],
      text:
        p.kind === 'peak'
          ? `▲ ${p.name}${p.ele_m != null ? ` ${Math.round(p.ele_m).toLocaleString()} m` : ''}`
          : p.name,
      style: p.kind === 'water' ? 'water' : 'place',
      // Places first, then peaks by height, then water.
      priority: p.kind === 'place' ? 30 : p.kind === 'peak' ? 20 + (p.ele_m ?? 0) / 1000 : 10
    }));
  }, [dem, places.data]);
  return on ? all : NO_PART.labels;
}
