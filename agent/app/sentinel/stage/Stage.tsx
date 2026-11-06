import {useEffect, useMemo, useRef, useState} from 'react';
import DeckGL from '@deck.gl/react';
import {LinearInterpolator, type Layer, type MapViewState} from '@deck.gl/core';
import {TerrainLayer} from '@deck.gl/geo-layers';
import {PathLayer} from '@deck.gl/layers';
// The loaders.gl worker that decodes dem.png into the terrain mesh: a vendored copy of
// @loaders.gl/terrain 4.5.4's dist/terrain-worker.js (the version @deck.gl/geo-layers depends on;
// pnpm does not hoist it for app imports). Vite copies it into the build as a hashed asset, so it is
// served from this site. Without workerUrl, loaders.gl fetches the worker from unpkg.com at run
// time, and wherever unpkg is blocked the terrain, and the fire layers drawn on it, never appear.
import terrainWorkerUrl from './vendor/terrain-worker.js?url';

import type {FireData} from '../data/fire';
import {perimeterRings} from '../data/fire';
import {useFireJson} from '../data/files';
import {useRaster} from '../data/raster';
import {useTime} from '../state/time';
import {useUi} from '../state/ui';
import {Dem} from './dem';
import {CHAR, FireExtension, FRONT, SCAR_RAMP, type FireExtensionProps} from './fire-extension';
import {syntheticArrival} from './synthetic-arrival';
import {useFireImage, type ArrivalMeta, type SeverityStats} from './load';
import {declutter, groupByStyle, labelLayers, stamp, type LabelStyle, type MapLabel} from './labels';
import {dashExtension, manifestRow, useIgnitionPart, usePerimeterPart, useSpinePart} from './evidence-layers';
import {distanceM} from './drape';
import {usePlaceLabels, useRoadPart, useStructurePart, useTreePart, useWindPart} from './context-layers';
import {useHighlightPart} from './highlight';
import {useDebrisPart} from './debris-layer';
import {useSwarmPart} from './swarm-layer';
import {useRollout, useSwarmUi} from '../swarm/data';
import {useForecastPart} from './forecast-layer';
import {useLiveHitsPart} from './live-layer';
import {Compass, HoverInspector, MapControls, MapNotes, SyntheticChip, type KeySummaryItem, type StageNote} from './overlays';
import {usePlanData, usePlanLayers, usePlanMapControls} from '@/plan';
import {useSearchParams} from 'react-router';
import {setMapCenter} from './map-center';
import {clearSelection, selectMapPoint, useIncidentNav} from '../agent/context';

const PITCH_3D = 58;
const TERRAIN_LOAD_OPTIONS = {terrain: {workerUrl: terrainWorkerUrl}};
const fireExtension = new FireExtension();
const transition = new LinearInterpolator(['pitch', 'bearing', 'zoom', 'longitude', 'latitude']);

const VIEW_KEYS = ['longitude', 'latitude', 'zoom', 'pitch', 'bearing', 'transitionDuration', 'transitionInterpolator', 'width', 'height'] as const;
/** Same camera (and the same pending transition): a no-op view-state update. */
function sameView(a: MapViewState, b: MapViewState): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return VIEW_KEYS.every(k => x[k] === y[k]);
}
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/** severity.png red code for a dNBR value (step 08: dnbr = −0.1 + (R − 1) / 254 · 1.1). */
const severityCode = (dnbr: number) => 1 + ((dnbr + 0.1) / 1.1) * 254;
/** Key & Benson low and high class edges, the step 08 contract, if severity_stats.json is missing. */
const DEFAULT_EDGES = [0.1, 0.66];
const css = ([r, g, b]: number[]) => `rgb(${r}, ${g}, ${b})`;
/** Key colours of the plan layer's front (app/plan/layers.ts): unwatched = accent, watched = green. */
const ACCENT = 'rgb(209, 101, 75)';
const WATCHED = 'rgb(92, 214, 140)';

export function Stage({fire}: {fire: FireData}) {
  const t = useTime(s => s.t);
  // Narrow selectors: hover changes on every pointer move and must not re-render the stage.
  const viewMode = useUi(s => s.viewMode);
  const layers = useUi(s => s.layers);
  const flyTo = useUi(s => s.flyTo);
  const selectedStructure = useUi(s => s.selectedStructure);
  const highlight = useUi(s => s.highlight);
  const setBearing = useUi(s => s.setBearing);
  const setHover = useUi(s => s.setHover);
  const selectStructure = useUi(s => s.selectStructure);
  const risk = useUi(s => s.risk);
  const setRisk = useUi(s => s.setRisk);
  const [dem, setDem] = useState<Dem | null>(null);
  const [viewState, setViewState] = useState<MapViewState>(() => ({
    longitude: fire.aoi.center[0],
    latitude: fire.aoi.center[1] - 0.035,
    zoom: 12.3,
    pitch: PITCH_3D,
    bearing: -18,
    maxPitch: 75
  }));
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({width: 0, height: 0});

  useEffect(() => {
    Dem.load(`${fire.base}/dem.png`, fire.dem).then(setDem);
  }, [fire]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({width: e!.contentRect.width, height: e!.contentRect.height}));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 2D/3D toggle eases pitch and bearing like the reference.
  useEffect(() => {
    setViewState(v => ({
      ...v,
      pitch: viewMode === '3d' ? PITCH_3D : 0,
      bearing: viewMode === '3d' ? v.bearing || -18 : 0,
      transitionDuration: 900,
      transitionInterpolator: transition
    }));
  }, [viewMode]);

  // Fly-to requests from the rail and dock (a new seq each time).
  useEffect(() => {
    if (!flyTo) return;
    setViewState(v => ({
      ...v,
      longitude: flyTo.lon,
      latitude: flyTo.lat,
      zoom: flyTo.zoom ?? v.zoom,
      transitionDuration: 1500,
      transitionEasing: easeInOut,
      transitionInterpolator: transition
    }));
  }, [flyTo]);

  // Fire layer: arrival.png, read nearest-texel in the shader. The synthetic pattern is only a
  // fallback for a missing file, and then a note on the map says so. The image props go null → image
  // once and never back (deck's image transform cannot take null after a texture); layer
  // switches use the opacity/visible props instead.
  const arrivalImage = useFireImage(fire, 'arrival.png');
  const severityImage = useFireImage(fire, 'severity.png');
  const ignitionImage = useFireImage(fire, 'ignition_posterior.png');
  const arrivalRaster = useRaster(fire, 'arrival.png');
  const arrivalMeta = useFireJson<ArrivalMeta>(fire, 'arrival_meta.json').data;
  const severityStats = useFireJson<SeverityStats>(fire, 'severity_stats.json').data;
  const simulated = arrivalImage.status === 'error';
  const synthetic = useMemo(
    () => (simulated ? syntheticArrival(fire.perimeter, fire.dem.bounds) : null),
    [simulated, fire]
  );

  // Arrival codes are fractions of arrival_meta.window_utc; step 06 keeps it equal to
  // aoi.window_utc, but the shader time is computed against the arrival's own window so a
  // mismatch cannot shift the fire.
  const arrivalWindow = useMemo<[number, number]>(() => {
    const [a, b] = arrivalMeta?.window_utc ?? fire.aoi.window_utc;
    return [Date.parse(a), Date.parse(b)];
  }, [arrivalMeta, fire]);
  useEffect(() => {
    if (!arrivalMeta) return;
    const [a, b] = fire.aoi.window_utc;
    if (Date.parse(a) !== arrivalWindow[0] || Date.parse(b) !== arrivalWindow[1])
      console.warn('arrival_meta.json window_utc differs from aoi.window_utc; using the arrival window for the fire.');
  }, [arrivalMeta, arrivalWindow, fire]);

  const [aoiStart, aoiEnd] = useMemo(() => fire.aoi.window_utc.map(Date.parse), [fire]);
  const fireTime = simulated
    ? (t - aoiStart!) / (aoiEnd! - aoiStart!)
    : (t - arrivalWindow[0]) / (arrivalWindow[1] - arrivalWindow[0]);

  const severityRange = useMemo<[number, number]>(() => {
    const edges = severityStats?.encoding.class_edges?.length ? severityStats.encoding.class_edges : DEFAULT_EDGES;
    return [severityCode(edges[0]!), severityCode(edges[edges.length - 1]!)];
  }, [severityStats]);

  const perimeterPaths = useMemo(() => {
    if (!dem) return [];
    return perimeterRings(fire.perimeter).map(ring =>
      ring.map(([lon, lat]) => [lon, lat, dem.heightAt(lon!, lat!) + 12])
    );
  }, [dem, fire]);

  const terrain = layers.terrain;
  const spread = layers.fireSpread;
  const scar = layers.burnScar;
  const ignition = layers.ignition;

  const perimeterPart = usePerimeterPart(fire, dem, t, layers.perimeters.visible);
  const spinePart = useSpinePart(fire, dem, t, layers.spine.visible);
  const ignitionPart = useIgnitionPart(fire, dem, ignition.visible, ignitionImage.status === 'ok');
  const windPart = useWindPart(fire, dem, t, layers.wind);
  const roadPart = useRoadPart(fire, dem, layers.roads.visible);
  const structurePart = useStructurePart(
    fire,
    dem,
    t,
    layers.structures.visible,
    arrivalRaster,
    arrivalWindow,
    selectedStructure,
    selectStructure
  );
  const placeLabels = usePlaceLabels(fire, dem, layers.labels.visible);
  const treePart = useTreePart(fire, dem, t, terrain.visible, arrivalRaster, arrivalWindow);
  const highlightPart = useHighlightPart(dem, highlight);
  const debrisPart = useDebrisPart(fire, dem, layers.debrisFlow, risk, setRisk);
  const swarmUi = useSwarmUi();
  const {data: swarmRollout} = useRollout(fire, swarmUi.policy);
  const swarmPart = useSwarmPart(fire, dem, t, swarmRollout, swarmUi.show);
  // The next hour's drone plan (app/plan): watch points, footprints, front coverage. The plan UI
  // owns the layers. It reads the URL's `t` (written by IncidentSync, debounced), the same hour the
  // plan panel reads, so playback does not rebuild them per frame.
  const [searchParams] = useSearchParams();
  const planT = searchParams.get('t') ?? new Date(Math.floor(t / 60_000) * 60_000).toISOString().replace('.000Z', 'Z');
  // Same get-drone-plan query as the plan panel (shared per hour). With a plan on the map, its
  // front (watched / unwatched) is the one forecast line, so the stage's own outlines step aside.
  const planData = usePlanData(fire.id, planT);
  const planOnMap = layers.dronePlan.visible && !!planData.plan;
  const forecastPart = useForecastPart(fire, dem, t, layers.forecast.visible && layers.forecast.ready && !planOnMap);
  const livePart = useLiveHitsPart(dem, layers.liveHits.visible);
  const zAt = useMemo(() => (dem ? (lon: number, lat: number) => dem.heightAt(lon, lat) : undefined), [dem]);
  const planCtx = useMemo(
    () => ({fire: fire.id, t: planT, zAt, visible: layers.dronePlan.visible}),
    [fire.id, planT, zAt, layers.dronePlan.visible]
  );
  const planLayers = usePlanLayers(planCtx) as Layer[];
  const planControls = usePlanMapControls(planCtx);
  useEffect(() => setMapCenter(viewState.longitude, viewState.latitude), [viewState.longitude, viewState.latitude]);

  // Labels from every layer compete for space; the survivors depend on the camera.
  const labels = useMemo<MapLabel[]>(
    () => [
      ...highlightPart.labels,
      ...livePart.labels,
      ...forecastPart.labels,
      ...ignitionPart.labels,
      ...perimeterPart.labels,
      ...spinePart.labels,
      ...placeLabels
    ],
    [highlightPart.labels, livePart.labels, forecastPart.labels, ignitionPart.labels, perimeterPart.labels, spinePart.labels, placeLabels]
  );
  // The surviving ids and their placements, as a string so the text layers rebuild only when they change.
  const keepKey = [...declutter(labels, viewState, size.width, size.height)]
    .map(([id, style]) => `${id}\t${style}`)
    .sort()
    .join('\n');
  const textLayers = useMemo(() => {
    const keep = new Map<string, LabelStyle>();
    for (const row of keepKey ? keepKey.split('\n') : []) {
      const [id, style] = row.split('\t');
      keep.set(id!, style as LabelStyle);
    }
    return labelLayers(groupByStyle(labels, keep));
  }, [labels, keepKey]);

  // Before the first mapped perimeter the arrival grows from step 06's seed, CAL FIRE's report;
  // the key says so, since the spread then starts at that seed rather than at the estimate.
  const tz = fire.aoi.timezone;
  const seedNote = useMemo(() => {
    const first = arrivalMeta?.intervals?.[0];
    const seed = arrivalMeta?.seed;
    if (!first || !seed) return undefined;
    const reported = fire.aoi.official.incident?.reported_location;
    const moved = reported ? distanceM(seed.lonlat[0], seed.lonlat[1], reported[0], reported[1]) : 0;
    const snapped = moved > 100 ? `; its seed sits inside that perimeter, ${(moved / 1000).toFixed(1)} km from the reported point` : '';
    return `Before the first mapped perimeter (${stamp(Date.parse(first.to), tz)}), the progression grows from the ${seed.source} (${stamp(
      Date.parse(seed.t),
      tz
    )}), a report, not an investigated origin${snapped}`;
  }, [arrivalMeta, fire, tz]);

  const notes: StageNote[] = [];
  const baseRow = manifestRow(fire, 'Base texture');
  if (terrain.visible && baseRow) {
    const land = manifestRow(fire, 'Land cover / fuels')?.source;
    const elevation = manifestRow(fire, 'Terrain')?.source;
    notes.push({
      id: 'terrain',
      title: 'Base texture · stylized land cover',
      detail: [
        `${baseRow.source}${elevation ? `, on ${elevation} elevation` : ''}`,
        treePart.count
          ? `Trees are illustrative: ${treePart.count.toLocaleString()} cones scattered over the ${land ?? 'land-cover'} tree and shrub cells, not mapped trees. They darken once the fire progression reaches their cell`
          : ''
      ]
        .filter(Boolean)
        .join('\n')
    });
  }
  if (spread.visible && arrivalImage.status === 'ok')
    notes.push({
      id: 'spread',
      title: 'Fire Progression (Interpolated)',
      detail: [
        "Interpolated between mapped perimeters: each cell's burn time lies between the perimeters that bracket it. Hover the map for a cell's interval",
        seedNote
      ]
        .filter(Boolean)
        .join('\n'),
      swatches: [
        {color: css(FRONT), label: 'Front at t'},
        {color: css(CHAR), label: 'Burned before t'}
      ]
    });
  if (scar.visible) {
    if (severityImage.status === 'error')
      notes.push({id: 'scar', title: 'Burn scar unavailable', detail: 'severity.png did not load'});
    else if (severityStats) {
      const edges = severityStats.encoding.class_edges;
      const src = severityStats.source;
      const coverage = Math.round(severityStats.perimeter.coverage * 100);
      notes.push({
        id: 'scar',
        title: `Burn scar (dNBR) · ${coverage}% coverage`,
        detail: [
          `${src.product}${src.provisional && !/provisional/i.test(src.product) ? ' (provisional)' : ''}${src.pre_date && src.post_date ? `, ${src.pre_date} to ${src.post_date}` : ''}`,
          `The imagery covers ${coverage}% of the final perimeter; the rest has no burn-scar data`,
          simulated ? '' : 'Shown only where the interpolated fire progression has reached by t'
        ]
          .filter(Boolean)
          .join('\n'),
        swatches: edges?.length
          ? [
              {color: css(SCAR_RAMP[0]), label: `Low (dNBR ${edges[0]})`},
              {color: css(SCAR_RAMP[1]), label: `High (dNBR ≥ ${edges[edges.length - 1]})`}
            ]
          : undefined
      });
    }
  }
  if (ignition.visible && ignitionImage.status === 'error')
    notes.push({id: 'posterior', title: 'Ignition heat map unavailable', detail: 'ignition_posterior.png did not load'});
  notes.push(...perimeterPart.notes);
  // The final perimeter is always drawn; roads and place names share one OpenStreetMap source.
  const finalRow = manifestRow(fire, 'Final perimeter');
  if (finalRow)
    notes.push({
      id: 'final',
      title: 'Final perimeter',
      detail: finalRow.source,
      swatches: [{color: '#ffffff', label: 'Final perimeter', shape: 'dash'}]
    });
  notes.push(
    ...livePart.notes,
    ...forecastPart.notes,
    ...ignitionPart.notes,
    ...spinePart.notes,
    ...windPart.notes,
    ...structurePart.notes,
    ...roadPart.notes,
    ...debrisPart.notes,
    ...swarmPart.notes
  );
  const osmRow = manifestRow(fire, 'Roads, peaks & places');
  if (osmRow && (layers.roads.visible || layers.labels.visible))
    notes.push({
      id: 'osm',
      title: layers.roads.visible && layers.labels.visible ? 'Roads and place names' : layers.roads.visible ? 'Roads' : 'Place names',
      detail: osmRow.source
    });

  if (planOnMap)
    notes.push({
      id: 'plan-front',
      title: 'Forecast front +1 h · drone plan',
      detail:
        "The +1 h forecast front for this hour, drawn by the drone plan: green where it falls inside a flying drone's view, orange where it does not. This is a replay; the drones are a plan",
      swatches: [
        {color: ACCENT, label: 'Front, not watched', shape: 'line'},
        {color: WATCHED, label: 'Front, watched', shape: 'line'},
        {color: '#ffffff', label: 'Drone view', shape: 'ring'}
      ]
    });

  // The default one-line key: only what the planning loop reads. Everything else is in "All layers".
  const summary: KeySummaryItem[] = [];
  if (planOnMap) {
    summary.push(
      {id: 'front', label: 'Forecast front +1 h', swatch: {color: ACCENT, label: 'Forecast front', shape: 'line'}, title: '+1 h forecast front for this hour'},
      {id: 'watched', label: 'watched', swatch: {color: WATCHED, label: 'Watched', shape: 'line'}, title: "Stretch of the front inside a flying drone's view"},
      {id: 'view', label: 'Drone view', swatch: {color: '#ffffff', label: 'Drone view', shape: 'ring'}, title: 'Planned drone view; this is a replay'}
    );
  } else {
    const fc = forecastPart.notes[0];
    if (fc)
      summary.push({
        id: 'front',
        label: 'Forecast +1 h',
        swatch: fc.swatches?.[0] ?? {color: '#ffffff', label: 'Forecast', shape: 'dash'},
        title: fc.title
      });
  }
  if (layers.structures.visible && structurePart.notes.some(n => n.id === 'structures'))
    summary.push({id: 'homes', label: 'Homes', swatch: {color: '#eeeade', label: 'Homes', shape: 'square'}, title: 'Structures from the damage inspection (DINS)'});

  // The terrain mesh is always drawn: the fire layers live in its shader. The Terrain layer's
  // switch and slider blend only its stylized texture toward a flat neutral ground.
  const deckLayers: Layer[] = [
    new TerrainLayer<FireExtensionProps>({
      id: 'terrain',
      elevationData: `${fire.base}/dem.png`,
      texture: `${fire.base}/base_stylized.jpg`,
      bounds: fire.dem.bounds,
      elevationDecoder: fire.dem.decoder,
      meshMaxError: 2,
      loadOptions: TERRAIN_LOAD_OPTIONS,
      material: {ambient: 0.72, diffuse: 0.4, shininess: 4, specularColor: [20, 20, 20]},
      // '3d' picks the terrain surface under the cursor; plain picking unprojects onto sea level,
      // which at this pitch reads a point 1–3 km beyond the cursor.
      pickable: '3d',
      extensions: [fireExtension],
      fireBase: terrain.visible ? terrain.opacity ?? 1 : 0,
      fireArrival: arrivalImage.image ?? synthetic,
      fireTime,
      fireGlow: 0.012,
      fireVisible: spread.visible,
      fireOpacity: spread.opacity ?? 1,
      // Post-fire imagery only shows where the front has been; the synthetic pattern cannot gate it.
      fireGateScar: !simulated,
      fireSeverity: severityImage.image,
      fireSeverityOpacity: scar.visible ? scar.opacity ?? 1 : 0,
      fireSeverityRange: severityRange,
      fireIgnition: ignitionImage.image,
      fireIgnitionOpacity: ignition.visible ? ignition.opacity ?? 1 : 0
    }),
    ...treePart.layers,
    ...roadPart.layers,
    ...debrisPart.layers,
    new PathLayer<number[][], {getDashArray: [number, number]; dashJustified: boolean}>({
      id: 'final-perimeter',
      data: perimeterPaths,
      getPath: d => d as any,
      getColor: [255, 255, 255, 230],
      getWidth: 2,
      widthUnits: 'pixels',
      getDashArray: [6, 4],
      dashJustified: true,
      extensions: [dashExtension]
    }),
    ...perimeterPart.layers,
    ...structurePart.layers,
    ...spinePart.layers,
    ...windPart.layers,
    ...ignitionPart.layers,
    ...swarmPart.layers,
    ...forecastPart.layers,
    ...livePart.layers,
    ...planLayers,
    ...highlightPart.layers,
    ...textLayers
  ];

  return (
    <div
      ref={box}
      className="relative h-full w-full overflow-hidden"
      style={{background: 'linear-gradient(#c9cfcf 0%, #dcd8cc 45%, #d8cfbd 100%)'}}
    >
      <DeckGL
        viewState={viewState}
        onViewStateChange={({viewState: next}) => {
          // deck.gl's React wrapper replays view-state changes raised while it applies props from
          // its layout effect, so these are synchronous nested updates. Ignore repeats of the
          // current view so a re-emitted state cannot chain renders (React's update-depth limit).
          const nv = next as MapViewState;
          setViewState(v => (sameView(v, nv) ? v : nv));
          const bearing = nv.bearing ?? 0;
          if (useUi.getState().bearing !== bearing) setBearing(bearing);
        }}
        // The plan UI turns panning off while the pointer is on (or dragging) a drone marker.
        controller={{dragRotate: true, inertia: 300, dragPan: planControls.dragPan}}
        layers={deckLayers}
        onHover={info => {
          const c = info.coordinate;
          setHover(c && info.layer?.id.startsWith('terrain') ? {x: info.x, y: info.y, lon: c[0]!, lat: c[1]!} : null);
        }}
        onClick={info => {
          // A plan "Move" armed by the drone row takes the click first.
          if (planControls.onMapClick(info)) return;
          // A click on the ground is the agent's "this point" (selection app state); clicks on
          // other layers (structures, plan watch points) are handled by those layers.
          const c = info.coordinate;
          if (c && info.layer?.id.startsWith('terrain')) selectMapPoint(c[0]!, c[1]!);
          // A click on empty map (nothing picked) drops a selected drone too.
          else if (!info.layer && useIncidentNav.getState().selectedDroneId) clearSelection();
        }}
        getCursor={({isDragging}) => planControls.cursor ?? (isDragging ? 'grabbing' : 'crosshair')}
      />
      <Compass
        onReset={() =>
          setViewState(v => ({...v, bearing: 0, transitionDuration: 600, transitionInterpolator: transition}))
        }
      />
      <SyntheticChip visible={simulated && spread.visible} />
      <MapNotes notes={notes} summary={notes.length ? summary : undefined} />
      <MapControls />
      <HoverInspector dem={dem} fire={fire} arrivalWindow={arrivalWindow} arrivalMeta={arrivalMeta} />
    </div>
  );
}
