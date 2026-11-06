import {useEffect, type RefObject} from 'react';
import type {FireData} from '../../data/fire';
import {demSampler, type DemSampler} from '../../lib/dronegeo';
import {Dem} from '../../stage/dem';
import {useLive} from './live';
import {nextHitId, projectDets, resolvePose, useLiveHits} from './livemap';
import {projectMasks} from './maskmap';
import {useSam} from './sam';

/** A CPU copy of the fire's DEM for projecting hits, loaded once per fire. */
const dems = new Map<string, Promise<Dem>>();
export function loadDem(fire: FireData): Promise<Dem> {
  let p = dems.get(fire.base);
  if (!p) {
    p = Dem.load(`${fire.base}/dem.png`, fire.dem);
    p.catch(() => dems.delete(fire.base));
    dems.set(fire.base, p);
  }
  return p;
}

/** Default horizontal field of view when the form leaves it empty (a typical DJI wide camera in 16:9 video). */
export const DEFAULT_HFOV = 73;

/**
 * Projects each published set of live boxes, and each SAM 3.1 response's masks, onto the map
 * (useLiveHits). Called once from the live player with its video element, whose currentTime is the
 * video time used to look up SRT telemetry for the boxes; a SAM frame carries its own grab time.
 * Every hit and mask carries frameAt (when its frame was captured or shown) and mappedAt (when it
 * reached the store), both performance.now().
 */
export function useLiveGeo(fire: FireData, video: RefObject<HTMLVideoElement | null>) {
  useEffect(() => {
    let sampler: DemSampler | undefined;
    let dem: Dem | null = null;
    let live = true;
    loadDem(fire).then(
      d => {
        if (!live) return;
        dem = d;
        sampler = demSampler(d);
      },
      () => undefined
    );
    const hfovOf = () => {
      const h = useLiveHits.getState().manual?.hfovDeg;
      return h && Number.isFinite(h) ? h : DEFAULT_HFOV;
    };
    let lastDets: unknown = null;
    const unsub = useLive.subscribe(s => {
      const {stats, status, source, model} = s;
      if (status !== 'running' || !source || stats.dets === lastDets) return;
      lastDets = stats.dets;
      if (!stats.dets.length || !stats.frameW || !stats.frameH) return;
      const geo = useLiveHits.getState();
      if (!dem) {
        geo.set({lastError: 'loading terrain…'});
        return;
      }
      const v = video.current;
      const videoTimeS = source.kind === 'file' && v ? v.currentTime : null;
      const r = resolvePose(geo.mode, geo.manual, geo.srt, videoTimeS, sampler);
      if ('error' in r) {
        if (geo.lastError !== r.error) geo.set({lastError: r.error});
        return;
      }
      const hits = projectDets(stats.dets, model?.classes ?? [], r.pose, {hfovDeg: hfovOf(), width: stats.frameW, height: stats.frameH}, r.ground, {
        tMs: Date.now(),
        videoTimeS,
        pose: geo.mode,
        sourceName: source.name,
        nextId: nextHitId,
        onMap: (lon, lat) => !!dem?.contains(lon, lat),
        ...(stats.detsFrameAt !== null ? {frameAt: stats.detsFrameAt} : {})
      });
      if (hits.length) {
        const mappedAt = performance.now();
        geo.add(hits.map(h => ({...h, mappedAt})));
      } else geo.set({lastError: 'boxes look above the horizon or out of range for this pose'});
    });

    // SAM 3.1 masks: each new response, with the pose at the moment its frame was grabbed.
    let lastFrame: unknown = null;
    const unsubSam = useSam.subscribe(({frame}) => {
      if (!frame || frame === lastFrame) return;
      lastFrame = frame;
      const {source} = useLive.getState();
      if (!frame.outlines.length || !source || !dem) return;
      const geo = useLiveHits.getState();
      const videoTimeS = source.kind === 'file' ? frame.videoTimeS : null;
      const r = resolvePose(geo.mode, geo.manual, geo.srt, videoTimeS, sampler);
      if ('error' in r) return;
      const masks = projectMasks(frame, r.pose, {hfovDeg: hfovOf(), width: frame.width, height: frame.height}, r.ground, {
        tMs: Date.now(),
        videoTimeS,
        pose: geo.mode,
        sourceName: source.name,
        nextId: nextHitId,
        onMap: (lon, lat) => !!dem?.contains(lon, lat)
      });
      const mappedAt = performance.now();
      geo.addMasks(masks.map(m => ({...m, mappedAt})));
    });
    return () => {
      live = false;
      unsub();
      unsubSam();
    };
  }, [fire, video]);
}
