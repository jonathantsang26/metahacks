/**
 * Map layers for the drone plan: the forecast front (covered vs uncovered when the score says),
 * footprint circles, and draggable watch-point markers.
 *
 * Dragging: the marker layer is pickable and uses deck.gl's onDragStart/onDrag/onDragEnd. deck.gl's
 * map controller pans on the same pointer gesture, so `usePlanMapControls()` reports
 * `dragPan: false` while the pointer is over a marker or a drag is running; the map owner puts that
 * in its `controller` prop. Fallback when that is not wired or dragging fights the camera: the Move
 * button on a drone row arms click-to-move, and the next map click (`onMapClick`) places the drone.
 * Either way the drop calls update-drone-assignment with an optimistic position.
 */
import type {Layer, PickingInfo} from '@deck.gl/core';
import {PathLayer, PolygonLayer, ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import {useEffect, useMemo} from 'react';
import {selectPlanDrone, usePlanBridge, usePlanUi} from './store';
import type {Assignment, LonLat, WindCell} from './types';
import {useForecastFront, useUpdateDrone, usePlanData, useWindCells} from './data';
import {ACCENT_RGB} from './ui';

export type PlanLayerContext = {
  fire: string;
  t: string;
  /** Ground elevation in metres at a point, so markers sit on a 3D terrain. Default: sea level. */
  zAt?: ((lon: number, lat: number) => number) | undefined;
  /** False hides every plan layer (the `dronePlan` layer toggle). Default true. */
  visible?: boolean | undefined;
};

type RGBA = [number, number, number, number];
const COVERED: RGBA = [92, 214, 140, 255];
const UNCOVERED: RGBA = [...ACCENT_RGB, 255];
const PLAIN: RGBA = [255, 170, 120, 235];
const GREY: RGBA = [150, 146, 136, 200];
const INK: RGBA = [41, 37, 26, 255];
const MARKER_LIFT_M = 25;

const noDepth = {depthCompare: 'always' as const, depthWriteEnabled: false};

type DragInfo = PickingInfo<Assignment>;
type FrontPiece = {path: LonLat[]; covered: boolean | null};

/**
 * Split the front into covered / uncovered runs against the footprints of drones that can fly.
 * Same rule as server/plan/score.ts (a front point is covered when inside any flying drone's
 * circle), computed here so the colours follow a marker while it is dragged.
 */
export function splitFront(paths: LonLat[][], drones: Pick<Assignment, 'lon' | 'lat' | 'radiusM' | 'grounded'>[], stepM = 20): FrontPiece[] {
  const flying = drones.filter(d => !d.grounded);
  if (!paths.length) return [];
  const lat0 = paths[0]![0]![1];
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_540;
  const inside = (p: LonLat) => flying.some(d => Math.hypot((p[0] - d.lon) * kx, (p[1] - d.lat) * ky) <= d.radiusM);
  const out: FrontPiece[] = [];
  for (const path of paths) {
    let run: LonLat[] = [];
    let state: boolean | null = null;
    const push = (p: LonLat) => {
      const c = inside(p);
      if (state === null) state = c;
      if (c !== state) {
        run.push(p);
        out.push({path: run, covered: state});
        run = [p];
        state = c;
      } else run.push(p);
    };
    for (let i = 0; i < path.length; i++) {
      const b = path[i]!;
      if (i === 0) {
        push(b);
        continue;
      }
      const a = path[i - 1]!;
      const n = Math.max(1, Math.ceil(Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky) / stepM));
      for (let k = 1; k <= n; k++) push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    if (run.length >= 2 && state !== null) out.push({path: run, covered: state});
  }
  return out;
}

/** The cached front, coloured by coverage when there is a plan (plain otherwise). */
function usePlanFront(fire: string, t: string | null, segments: {path: LonLat[]; covered: boolean}[] | null, drones: Assignment[], hasPlan: boolean): FrontPiece[] {
  const front = useForecastFront(fire, t);
  return useMemo(() => {
    const paths = front?.paths.length ? front.paths : (segments?.map(s => s.path) ?? []);
    if (!hasPlan) return paths.map(path => ({path, covered: null}));
    return splitFront(paths, drones);
  }, [front, segments, drones, hasPlan]);
}

function unprojectAt(info: DragInfo, zAt: ((lon: number, lat: number) => number) | undefined, near: LonLat): LonLat | null {
  const vp = info.viewport;
  if (vp && Number.isFinite(info.x) && Number.isFinite(info.y)) {
    // Unproject onto the ground height near the drone, not sea level; a pitched view over hills
    // would otherwise put the drop point kilometres off.
    const targetZ = zAt ? zAt(near[0], near[1]) : 0;
    const p = vp.unproject([info.x, info.y], {targetZ});
    if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) return [p[0]!, p[1]!];
  }
  const c = info.coordinate;
  return c && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? [c[0]!, c[1]!] : null;
}

/** deck.gl layers for the plan at (fire, t). Spread them into the map's layer list. */
export function usePlanLayers(ctx: PlanLayerContext): Layer[] {
  const {fire, t, zAt, visible = true} = ctx;
  const iso = Number.isFinite(Date.parse(t)) ? new Date(Date.parse(t)).toISOString() : null;
  const data = usePlanData(fire, iso);
  const frontSegments = usePlanFront(fire, iso, data.score?.segments ?? null, data.assignments, !!data.plan);
  const selected = usePlanUi(s => s.selected);
  const dragging = usePlanUi(s => s.dragging);
  const hover = usePlanUi(s => s.hoverDroneId);
  const update = useUpdateDrone();
  const planId = data.plan?.id ?? null;
  const approved = data.plan?.status === 'approved';
  const drones = data.assignments;
  usePlanBridge(planId, drones);
  const noFly = useWindCells(fire, iso, data.score?.windCells);

  return useMemo(() => {
    if (!visible) return [];
    const z = (lon: number, lat: number) => (zAt ? zAt(lon, lat) : 0);
    const pos = (a: Assignment): [number, number, number] => [a.lon, a.lat, z(a.lon, a.lat) + MARKER_LIFT_M];
    const isSel = (a: Assignment) => selected?.planId === planId && selected?.droneId === a.droneId;
    const editable = !!planId && !approved;
    const layers: Layer[] = [];

    // No-fly wind cells: a light hatch-free wash so the front and drones stay readable on top.
    const blocked = noFly.filter(c => !c.flyable);
    if (blocked.length) {
      layers.push(
        new PolygonLayer<WindCell>({
          id: 'plan-nofly',
          data: blocked,
          getPolygon: c => {
            const [w, s, e, n] = c.bbox;
            const cz = z((w + e) / 2, (s + n) / 2) + 2;
            return [[w, s, cz], [e, s, cz], [e, n, cz], [w, n, cz], [w, s, cz]] as never;
          },
          getFillColor: [120, 112, 100, 46],
          getLineColor: [90, 84, 74, 120],
          getLineWidth: 1,
          lineWidthUnits: 'pixels',
          stroked: true,
          filled: true,
          pickable: false,
          parameters: noDepth,
          updateTriggers: {getPolygon: [zAt]}
        })
      );
    }

    layers.push(
      new PathLayer<FrontPiece>({
        id: 'plan-front',
        data: frontSegments,
        getPath: d => d.path.map(p => [p[0], p[1], z(p[0], p[1]) + 8]) as never,
        getColor: d => (d.covered === null ? PLAIN : d.covered ? COVERED : UNCOVERED),
        getWidth: d => (d.covered ? 5 : 3.5),
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        parameters: noDepth,
        updateTriggers: {getPath: [zAt]}
      })
    );

    if (!drones.length) return layers;

    layers.push(
      new ScatterplotLayer<Assignment>({
        id: 'plan-footprints',
        data: drones,
        getPosition: a => [a.lon, a.lat, z(a.lon, a.lat) + 4],
        getRadius: a => a.radiusM,
        radiusUnits: 'meters',
        stroked: true,
        filled: true,
        getFillColor: a => (a.grounded ? [GREY[0], GREY[1], GREY[2], 40] : isSel(a) ? [...ACCENT_RGB, 70] : [255, 255, 255, 46]),
        getLineColor: a => (a.grounded ? GREY : isSel(a) ? [...ACCENT_RGB, 255] : [255, 255, 255, 220]),
        getLineWidth: a => (isSel(a) ? 2.5 : 1.5),
        lineWidthUnits: 'pixels',
        parameters: noDepth,
        updateTriggers: {getFillColor: [selected, planId], getLineColor: [selected, planId], getLineWidth: [selected, planId], getPosition: [zAt]}
      }),
      new ScatterplotLayer<Assignment>({
        id: 'plan-markers',
        data: drones,
        pickable: true,
        getPosition: pos,
        getRadius: a => (isSel(a) || hover === a.droneId || dragging?.droneId === a.droneId ? 11 : 9),
        radiusUnits: 'pixels',
        stroked: true,
        getFillColor: a => (a.grounded ? GREY : isSel(a) || dragging?.droneId === a.droneId ? [...ACCENT_RGB, 255] : INK),
        getLineColor: [255, 255, 255, 255],
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        parameters: noDepth,
        updateTriggers: {getRadius: [selected, hover, dragging?.droneId, planId], getFillColor: [selected, dragging?.droneId, planId], getPosition: [zAt]},
        onHover: (info: DragInfo) => {
          const id = editable ? (info.object?.droneId ?? null) : null;
          if (usePlanUi.getState().hoverDroneId !== id) usePlanUi.setState({hoverDroneId: id});
          return false;
        },
        onClick: (info: DragInfo) => {
          const a = info.object;
          if (!a || !planId) return false;
          selectPlanDrone(planId, isSel(a) ? null : a, {fly: false});
          return true;
        },
        onDragStart: (info: DragInfo) => {
          const a = info.object;
          if (!a || !editable) return false;
          usePlanUi.setState({dragging: {droneId: a.droneId, lon: a.lon, lat: a.lat}});
          return true;
        },
        onDrag: (info: DragInfo) => {
          const d = usePlanUi.getState().dragging;
          if (!d) return false;
          const p = unprojectAt(info, zAt, [d.lon, d.lat]);
          if (p) usePlanUi.setState({dragging: {...d, lon: p[0], lat: p[1]}});
          return true;
        },
        onDragEnd: (info: DragInfo) => {
          const d = usePlanUi.getState().dragging;
          if (!d || !planId) return false;
          const p = unprojectAt(info, zAt, [d.lon, d.lat]) ?? [d.lon, d.lat];
          usePlanUi.setState({dragging: null, movedByHand: true});
          const start = drones.find(a => a.droneId === d.droneId);
          if (start && Math.abs(start.lon - p[0]) < 1e-7 && Math.abs(start.lat - p[1]) < 1e-7) return true;
          void update({planId, droneId: d.droneId, lon: p[0], lat: p[1]}, {lon: p[0], lat: p[1]});
          return true;
        }
      }),
      new TextLayer<Assignment>({
        id: 'plan-labels',
        data: drones,
        getPosition: pos,
        getText: a => (a.grounded ? `${a.droneId} · ${a.gustMs !== null ? `${a.gustMs.toFixed(0)} m/s` : 'grounded'}` : a.droneId),
        getSize: 11,
        getColor: [255, 255, 255, 255],
        fontWeight: 700,
        fontFamily: 'Inter, system-ui, sans-serif',
        getPixelOffset: [0, -20],
        outlineWidth: 3,
        outlineColor: [41, 37, 26, 230],
        fontSettings: {sdf: true},
        parameters: noDepth,
        updateTriggers: {getPosition: [zAt], getText: [drones]}
      })
    );
    return layers;
  }, [visible, zAt, noFly, frontSegments, drones, selected, dragging?.droneId, hover, planId, approved, update]);
}

/**
 * What the map owner wires into its DeckGL so dragging and click-to-move work:
 *   controller={{...yours, dragPan: plan.dragPan}}
 *   onClick={(info) => plan.onMapClick(info) || yourOnClick(info)}
 *   getCursor={(s) => plan.cursor ?? yourCursor(s)}
 */
export function usePlanMapControls(ctx: Pick<PlanLayerContext, 'fire' | 't'>) {
  const iso = Number.isFinite(Date.parse(ctx.t)) ? new Date(Date.parse(ctx.t)).toISOString() : null;
  const data = usePlanData(ctx.fire, iso);
  const hover = usePlanUi(s => s.hoverDroneId);
  const dragging = usePlanUi(s => s.dragging);
  const armed = usePlanUi(s => s.moveArmed);
  const update = useUpdateDrone();
  const planId = data.plan?.id ?? null;
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') usePlanUi.setState({moveArmed: null});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed]);
  return useMemo(
    () => ({
      dragPan: !hover && !dragging,
      cursor: dragging ? 'grabbing' : hover ? 'grab' : armed ? 'copy' : null,
      /** Returns true when it used the click (a move was armed). */
      onMapClick: (info: Pick<PickingInfo, 'coordinate'>): boolean => {
        const id = usePlanUi.getState().moveArmed;
        const c = info.coordinate;
        if (!id || !planId || !c) return false;
        usePlanUi.setState({moveArmed: null, movedByHand: true});
        void update({planId, droneId: id, lon: c[0]!, lat: c[1]!}, {lon: c[0]!, lat: c[1]!});
        return true;
      },
      cancelMove: () => usePlanUi.setState({moveArmed: null})
    }),
    [hover, dragging, armed, planId, update]
  );
}
