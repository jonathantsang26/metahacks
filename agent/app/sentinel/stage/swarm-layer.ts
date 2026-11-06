/**
 * The drone-swarm replay on the map: each simulated drone at time t, its last 20 minutes of
 * track, its camera footprint while airborne, and the squads' tasked areas from the latest decision.
 * Positions come from the precomputed rollout (pipeline/sim); nothing here is live.
 */
import {useMemo} from 'react';
import {PathLayer, ScatterplotLayer} from '@deck.gl/layers';
import type {FireData} from '../data/fire';
import {decisionAt, dronesAt, kmToLonLat, type Rollout} from '../swarm/data';
import type {Dem} from './dem';
import {NO_PART, type StagePart} from './evidence-layers';

type RGBA = [number, number, number, number];
const MODE_COLOR: Record<string, RGBA> = {
  fly: [36, 168, 214, 255],
  rtb: [242, 178, 51, 255],
  swap: [143, 138, 124, 255],
  base: [143, 138, 124, 255],
  lost: [200, 40, 40, 255]
};
const SQUAD_COLOR: RGBA[] = [
  [36, 168, 214, 200],
  [120, 90, 200, 200],
  [60, 160, 110, 200]
];
const TRAIL_S = 20 * 60;

export function useSwarmPart(fire: FireData, dem: Dem | null, t: number, rollout: Rollout | null, visible: boolean): StagePart {
  return useMemo(() => {
    if (!visible || !rollout || !dem) return NO_PART;
    const t0 = Date.parse(rollout.t0);
    const t1 = Date.parse(rollout.t_end);
    const notes = [
      {
        id: 'swarm',
        title: t < t0 || t > t1 ? 'Drone swarm: outside the replay window' : 'Drone swarm',
        detail: rollout.disclaimer
      }
    ];
    if (t < t0 || t > t1) return {layers: [], labels: [], notes};
    const drones = dronesAt(rollout, t).filter((d): d is NonNullable<typeof d> => !!d);
    const s = (t - t0) / 1000;
    const trails = drones.map(d => {
      const track = rollout.tracks[d.id];
      const pts: number[][] = [];
      for (let k = d.index; k >= 0 && track![k]![0] >= s - TRAIL_S; k--) {
        if (track![k]![4] === 1 || track![k]![4] === 2) pts.unshift([track![k]![1], track![k]![2], track![k]![3]]);
        else break;
      }
      if (pts.length && (d.mode === 'fly' || d.mode === 'rtb')) pts.push([d.lon, d.lat, d.alt]);
      return {id: d.id, path: pts, color: MODE_COLOR[d.mode] ?? MODE_COLOR.fly};
    });
    const airborne = drones.filter(d => d.mode === 'fly' || d.mode === 'rtb');
    const range = rollout.drone_spec.sensor_range_m ?? 600;
    const decision = decisionAt(rollout, t);
    const tasks = (decision?.tasks ?? []).map(task => {
      const [lon, lat] = kmToLonLat(fire, task.center_km);
      return {...task, position: [lon, lat, dem.heightAt(lon, lat) + 30] as [number, number, number]};
    });
    const layers = [
      new ScatterplotLayer<(typeof tasks)[number]>({
        id: 'swarm-tasks',
        data: tasks,
        getPosition: d => d.position,
        getRadius: d => d.radius_km * 1000,
        radiusUnits: 'meters',
        stroked: true,
        filled: false,
        getLineColor: d => SQUAD_COLOR[d.squad % SQUAD_COLOR.length]!,
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        parameters: {depthCompare: 'always', depthWriteEnabled: false},
        updateTriggers: {getPosition: t}
      }),
      new ScatterplotLayer<(typeof airborne)[number]>({
        id: 'swarm-footprints',
        data: airborne,
        getPosition: d => [d.lon, d.lat, dem.heightAt(d.lon, d.lat) + 15],
        getRadius: range,
        radiusUnits: 'meters',
        filled: true,
        getFillColor: [36, 168, 214, 40],
        stroked: true,
        getLineColor: [36, 168, 214, 120],
        getLineWidth: 1,
        lineWidthUnits: 'pixels',
        parameters: {depthCompare: 'always', depthWriteEnabled: false},
        updateTriggers: {getPosition: t}
      }),
      new PathLayer<(typeof trails)[number]>({
        id: 'swarm-trails',
        data: trails.filter(d => d.path.length > 1),
        getPath: d => d.path as [number, number, number][],
        getColor: d => [d.color![0], d.color![1], d.color![2], 170],
        getWidth: 2,
        widthUnits: 'pixels',
        updateTriggers: {getPath: t}
      }),
      new ScatterplotLayer<(typeof drones)[number]>({
        id: 'swarm-drones',
        data: drones,
        getPosition: d => [d.lon, d.lat, d.mode === 'fly' || d.mode === 'rtb' ? d.alt : dem.heightAt(d.lon, d.lat) + 5],
        getRadius: 5,
        radiusUnits: 'pixels',
        billboard: true,
        stroked: true,
        getFillColor: d => (MODE_COLOR[d.mode] ?? MODE_COLOR.fly)!,
        getLineColor: [255, 255, 255, 255],
        getLineWidth: 1.5,
        lineWidthUnits: 'pixels',
        parameters: {depthCompare: 'always', depthWriteEnabled: false},
        updateTriggers: {getPosition: t, getFillColor: t}
      })
    ];
    return {layers, labels: [], notes};
  }, [fire, dem, t, rollout, visible]);
}
