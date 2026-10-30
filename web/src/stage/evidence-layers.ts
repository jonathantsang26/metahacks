/**
 * The fire's own evidence on the map: mapped perimeters and spot fires (observed), the spread
 * spine (traced on the modeled arrival) and the ignition estimate (a model output) beside CAL
 * FIRE's reported location. Each hook drapes its geometry once per dataset and only re-slices
 * it when an integer key derived from t changes.
 */
import {useMemo} from 'react';
import type {Layer} from '@deck.gl/core';
import {PathLayer, ScatterplotLayer} from '@deck.gl/layers';
import {PathStyleExtension} from '@deck.gl/extensions';
import type {FireData} from '../data/fire';
import {indexAtOrBefore, useFireJson, type Ignition, type Perimeters, type Spine, type Spots} from '../data/files';
import {formatDateTime, zoneLabel} from '../lib/format';
import type {Dem} from './dem';
import {distanceM, drapeDense, ringsOf} from './drape';
import {POSTERIOR_RAMP} from './fire-extension';
import {stamp, type MapLabel} from './labels';
import type {StageNote} from './overlays';

export type StagePart = {layers: Layer[]; labels: MapLabel[]; notes: StageNote[]};
export const NO_PART: StagePart = {layers: [], labels: [], notes: []};

/** The manifest.json row for a layer (its source and REAL / MODELED status), if the pipeline wrote one. */
export function manifestRow(fire: FireData, layer: string) {
  return fire.manifest.sources.find(s => s.layer === layer);
}

const overlay = {depthCompare: 'always' as const, depthWriteEnabled: false};
// Path mode: dashes run continuously along the whole line. Per-segment dashing collapses to a
// solid line once draped segments are shorter on screen than one dash.
export const dashExtension = new PathStyleExtension({dash: true, dashMode: 'path'});
type RGBA = [number, number, number, number];
const css = ([r, g, b]: number[]) => `rgb(${r}, ${g}, ${b})`;
const ESTIMATE: RGBA = [214, 52, 40, 255];
const byTime = <T extends {properties: {t: string}}>(a: T, b: T) => Date.parse(a.properties.t) - Date.parse(b.properties.t);

/** Latest mapped perimeter at or before t (solid line + time chip) and the spot fires mapped by t. */
export function usePerimeterPart(fire: FireData, dem: Dem | null, t: number, on: boolean): StagePart {
  const perims = useFireJson<Perimeters>(fire, 'perimeters.geojson');
  const spots = useFireJson<Spots>(fire, 'spots.geojson');
  const tz = fire.aoi.timezone;

  const mapped = useMemo(() => {
    if (!dem || !perims.data) return null;
    const features = [...perims.data.features].sort(byTime);
    return {
      times: features.map(f => f.properties.t),
      items: features.map(f => {
        // Densified so the line follows ridges between far-apart vertices instead of cutting under them.
        const rings = ringsOf(f.geometry).map(r => drapeDense(dem, r, 12, 60));
        // The chip sits on the northernmost vertex, the far side in the default 3D view.
        let top = rings[0][0];
        for (const r of rings) for (const p of r) if (p[1] > top[1]) top = p;
        return {rings, top, t: Date.parse(f.properties.t), acres: f.properties.acres, source: f.properties.source};
      })
    };
  }, [dem, perims.data]);

  const spotSets = useMemo(() => {
    if (!dem || !spots.data) return null;
    const features = [...spots.data.features].sort(byTime);
    return {
      times: features.map(f => f.properties.t),
      rings: features.map(f => ringsOf(f.geometry).map(r => drapeDense(dem, r, 8, 60)))
    };
  }, [dem, spots.data]);

  const index = mapped ? indexAtOrBefore(mapped.times, t) : -1;
  const spotCount = spotSets ? indexAtOrBefore(spotSets.times, t) + 1 : 0;
  const spotRings = useMemo(() => (spotSets ? spotSets.rings.slice(0, spotCount).flat() : []), [spotSets, spotCount]);

  return useMemo(() => {
    if (!on) return NO_PART;
    const current = mapped && index >= 0 ? mapped.items[index] : null;
    const layers: Layer[] = [
      new PathLayer<number[][]>({
        id: 'mapped-perimeter',
        data: current ? current.rings : [],
        getPath: d => d as any,
        getColor: [255, 247, 236, 240],
        getWidth: 2,
        widthUnits: 'pixels'
      }),
      new PathLayer<number[][]>({
        id: 'spot-fires',
        data: spotRings,
        getPath: d => d as any,
        getColor: [255, 247, 236, 220],
        getWidth: 1.5,
        widthUnits: 'pixels'
      })
    ];
    const labels: MapLabel[] = current
      ? [
          {
            id: 'mapped-perimeter',
            position: current.top,
            text: `Mapped ${stamp(current.t, tz)} · ${Math.round(current.acres).toLocaleString()} ac`,
            style: 'chip',
            priority: 70
          }
        ]
      : [];
    const notes: StageNote[] = [];
    if (perims.error) notes.push({id: 'perimeters', title: 'Mapped perimeters unavailable', detail: perims.error});
    else if (current)
      notes.push({
        id: 'perimeters',
        tag: manifestRow(fire, 'Perimeters (time series)')?.status,
        title: `Mapped perimeter at t (solid)${spotRings.length ? ' and spot fires' : ''}`,
        detail: current.source
      });
    else if (mapped && mapped.items.length)
      notes.push({id: 'perimeters', title: `No perimeter mapped yet · first at ${stamp(mapped.items[0].t, tz)}`});
    return {layers, labels, notes};
  }, [on, mapped, index, spotRings, tz, perims.error, fire]);
}

/** "Jan 8, 00:00 · 02:00 · 04:00 PST" for waypoints where the head held one spot. */
function waypointText(times: number[], tz: string): string {
  const [day0] = formatDateTime(times[0], tz).split(', ');
  const parts = times.map((ms, i) => {
    const full = formatDateTime(ms, tz);
    const [day, clock] = full.split(', ');
    return i > 0 && day === day0 ? clock : full;
  });
  return `${parts.join(' · ')} ${zoneLabel(times[times.length - 1], tz)}`;
}

/** Spine: a yellow dashed path with ring markers and time chips; waypoints after t are muted. */
export function useSpinePart(fire: FireData, dem: Dem | null, t: number, on: boolean): StagePart {
  const spine = useFireJson<Spine>(fire, 'spine.geojson');
  const tz = fire.aoi.timezone;

  const drawn = useMemo(() => {
    if (!dem || !spine.data) return null;
    const paths: number[][][] = [];
    // Waypoints sharing a position (the head held still) collapse into one marker.
    const groups = new Map<string, {lon: number; lat: number; times: number[]}>();
    for (const f of spine.data.features) {
      const g = f.geometry;
      if (g.type === 'LineString') paths.push(drapeDense(dem, g.coordinates, 16, 60));
      else if (f.properties.kind === 'waypoint') {
        const [lon, lat] = g.coordinates;
        const key = `${lon},${lat}`;
        const group = groups.get(key) ?? {lon, lat, times: []};
        group.times.push(Date.parse(f.properties.t));
        groups.set(key, group);
      }
    }
    const waypoints = [...groups.values()]
      .map(w => {
        const times = [...w.times].sort((a, b) => a - b);
        return {position: [w.lon, w.lat, dem.heightAt(w.lon, w.lat) + 16], times, text: waypointText(times, tz)};
      })
      .sort((a, b) => a.times[0] - b.times[0]);
    return {paths, waypoints};
  }, [dem, spine.data, tz]);

  const reached = drawn ? drawn.waypoints.filter(w => w.times[0] <= t).length : 0;

  return useMemo(() => {
    if (!on || !drawn) {
      return on && spine.error ? {...NO_PART, notes: [{id: 'spine', title: 'Spread spine unavailable', detail: spine.error}]} : NO_PART;
    }
    const markers = drawn.waypoints.map((w, i) => ({position: w.position, reached: i < reached}));
    const layers: Layer[] = [
      new PathLayer<number[][], {getDashArray: [number, number]; dashJustified: boolean}>({
        id: 'spine',
        data: drawn.paths,
        getPath: d => d as any,
        getColor: [242, 178, 51, 255],
        getWidth: 3,
        widthUnits: 'pixels',
        getDashArray: [5, 3],
        dashJustified: true,
        extensions: [dashExtension]
      }),
      new ScatterplotLayer<(typeof markers)[number]>({
        id: 'spine-waypoints',
        data: markers,
        getPosition: d => d.position as [number, number, number],
        getRadius: 6,
        radiusUnits: 'pixels',
        billboard: true,
        stroked: true,
        filled: true,
        getFillColor: (d): RGBA => (d.reached ? [39, 35, 26, 220] : [39, 35, 26, 110]),
        getLineColor: (d): RGBA => (d.reached ? [242, 140, 40, 255] : [242, 178, 51, 120]),
        getLineWidth: 2.5,
        lineWidthUnits: 'pixels',
        parameters: overlay,
        updateTriggers: {getFillColor: reached, getLineColor: reached}
      })
    ];
    // The latest reached waypoint is the current head and wins any collision.
    const labels: MapLabel[] = drawn.waypoints.map((w, i) => ({
      id: `spine-${i}`,
      position: w.position,
      text: w.text,
      style: i < reached ? 'chip' : 'chipMuted',
      priority: i < reached ? 50 + i : 40 - i
    }));
    const notes: StageNote[] = [
      {id: 'spine', tag: 'MODELED', title: 'Spread spine', detail: 'From the first-burned area to the farthest early run, traced on the modeled arrival'}
    ];
    return {layers, labels, notes};
  }, [on, drawn, reached, spine.error]);
}

const fmtKm = (m: number) => `${(m / 1000).toFixed(1)} km`;

/**
 * Ignition: the 90% credible region outline, the estimate (red, rings) and CAL FIRE's reported
 * location (white; a report, kept visibly separate from the model's estimate). The estimate's
 * start time appears only when timing.identifiable; otherwise it is withheld with the file's
 * reasons. `heat` says whether the posterior heat map is on the terrain, for the key's swatches.
 */
export function useIgnitionPart(fire: FireData, dem: Dem | null, on: boolean, heat: boolean): StagePart {
  const ignition = useFireJson<Ignition>(fire, 'ignition.json');
  const tz = fire.aoi.timezone;
  const incident = fire.aoi.official.incident;

  const drawn = useMemo(() => {
    if (!dem) return null;
    const ig = ignition.data;
    const reported = incident?.reported_location;
    return {
      region: ig ? ringsOf(ig.region90).map(r => drapeDense(dem, r, 10, 60)) : [],
      estimate: ig ? [ig.map.lon, ig.map.lat, dem.heightAt(ig.map.lon, ig.map.lat) + 20] : null,
      reported: reported ? [reported[0], reported[1], dem.heightAt(reported[0], reported[1]) + 20] : null
    };
  }, [dem, ignition.data, incident]);

  return useMemo(() => {
    if (!on || !drawn) return NO_PART;
    const ig = ignition.data;
    const identifiable = Boolean(ig?.timing.identifiable);
    const layers: Layer[] = [
      new PathLayer<number[][]>({
        id: 'ignition-region90',
        data: drawn.region,
        getPath: d => d as any,
        getColor: [181, 53, 54, 235],
        getWidth: 1.5,
        widthUnits: 'pixels'
      })
    ];
    const labels: MapLabel[] = [];
    if (drawn.estimate) {
      const rings = [26, 18, 11].map((r, i) => ({position: drawn.estimate!, r, a: 90 + i * 60}));
      layers.push(
        new ScatterplotLayer<(typeof rings)[number]>({
          id: 'ignition-rings',
          data: rings,
          getPosition: d => d.position as [number, number, number],
          getRadius: d => d.r,
          radiusUnits: 'pixels',
          billboard: true,
          stroked: true,
          filled: false,
          getLineColor: (d): RGBA => [214, 52, 40, d.a],
          getLineWidth: 1.5,
          lineWidthUnits: 'pixels',
          parameters: overlay
        }),
        new ScatterplotLayer<number[]>({
          id: 'ignition-estimate',
          data: [drawn.estimate],
          getPosition: d => d as [number, number, number],
          getRadius: 6,
          radiusUnits: 'pixels',
          billboard: true,
          stroked: true,
          getFillColor: ESTIMATE,
          getLineColor: [255, 255, 255, 255],
          getLineWidth: 1.5,
          lineWidthUnits: 'pixels',
          parameters: overlay
        })
      );
      labels.push({
        id: 'ignition-estimate',
        position: drawn.estimate,
        text: `Ignition (est.)\n${identifiable && ig ? stamp(Date.parse(ig.map.t), tz) : 'start time withheld'}`,
        style: 'marker',
        priority: 100
      });
    }
    if (drawn.reported) {
      layers.push(
        new ScatterplotLayer<number[]>({
          id: 'reported-location',
          data: [drawn.reported],
          getPosition: d => d as [number, number, number],
          getRadius: 5,
          radiusUnits: 'pixels',
          billboard: true,
          stroked: true,
          getFillColor: [255, 255, 255, 255],
          getLineColor: [39, 35, 26, 255],
          getLineWidth: 2,
          lineWidthUnits: 'pixels',
          parameters: overlay
        })
      );
      labels.push({
        id: 'reported-location',
        position: drawn.reported,
        text: 'Reported location\nCAL FIRE',
        style: 'marker',
        priority: 95
      });
    }
    const notes: StageNote[] = [];
    if (ig) {
      const timing = identifiable
        ? `start ${stamp(Date.parse(ig.map.t), tz)} (90%: ${stamp(Date.parse(ig.t90[0]), tz)} – ${stamp(Date.parse(ig.t90[1]), tz)})`
        : 'start time withheld';
      // r90_m is a distance quantile around the estimate; region90 is the smaller credible region.
      const detail = [
        `90% of the posterior lies within ${fmtKm(ig.r90_m)} of the estimate · outline: 90% credible region (${ig.region90_km2} km²)`
      ];
      if (!identifiable) detail.push(`Start time withheld: ${ig.timing.reasons.join('; ')}`);
      if (drawn.reported && drawn.estimate) {
        const [a, b] = [drawn.estimate, drawn.reported];
        detail.push(
          `White marker: the location in the CAL FIRE incident report (a report, not an investigated origin), ${fmtKm(distanceM(a[0], a[1], b[0], b[1]))} from the estimate`
        );
      }
      const swatches = [{color: css(ESTIMATE), label: 'Estimate'}];
      if (drawn.reported) swatches.push({color: '#ffffff', label: 'Reported (CAL FIRE)'});
      if (heat)
        swatches.push(
          {color: css(POSTERIOR_RAMP[0]), label: 'Lower posterior'},
          {color: css(POSTERIOR_RAMP[2]), label: 'Higher posterior'}
        );
      notes.push({id: 'ignition', tag: 'MODELED', title: `Ignition estimate · ${timing}`, detail: detail.join('\n'), swatches});
    } else if (ignition.error) {
      notes.push({id: 'ignition', title: 'Ignition estimate unavailable', detail: ignition.error});
    }
    return {layers, labels, notes};
  }, [on, heat, drawn, ignition.data, ignition.error, incident, tz]);
}
