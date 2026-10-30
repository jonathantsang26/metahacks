/**
 * Vectors sit on the terrain by sampling the CPU heightmap once per dataset; layers then reuse
 * the draped arrays so nothing is re-sampled per frame.
 */
import type {Dem} from './dem';

type Polygonal = {type: 'Polygon'; coordinates: number[][][]} | {type: 'MultiPolygon'; coordinates: number[][][][]};

const M_PER_DEG = 111_320;

/** Every ring (outer and holes) of a Polygon or MultiPolygon. */
export function ringsOf(g: Polygonal): number[][][] {
  return g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
}

/** [lon, lat] vertices lifted to `lift` meters above the terrain. */
export function drape(dem: Dem, coords: number[][], lift: number): number[][] {
  return coords.map(([lon, lat]) => [lon, lat, dem.heightAt(lon, lat) + lift]);
}

/** Like drape, but splits segments longer than `stepM` so long lines follow ridges and valleys. */
export function drapeDense(dem: Dem, coords: number[][], lift: number, stepM: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    if (i > 0) {
      const [lon0, lat0] = coords[i - 1];
      const n = Math.ceil(distanceM(lon0, lat0, lon, lat) / stepM);
      for (let k = 1; k < n; k++) {
        const x = lon0 + ((lon - lon0) * k) / n;
        const y = lat0 + ((lat - lat0) * k) / n;
        out.push([x, y, dem.heightAt(x, y) + lift]);
      }
    }
    out.push([lon, lat, dem.heightAt(lon, lat) + lift]);
  }
  return out;
}

/** Equirectangular distance in meters; fine at fire scale. */
export function distanceM(lon0: number, lat0: number, lon1: number, lat1: number): number {
  const kx = M_PER_DEG * Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
  return Math.hypot((lon1 - lon0) * kx, (lat1 - lat0) * M_PER_DEG);
}

/** Moves (lon, lat) by east/north meters. */
export function offsetM(lon: number, lat: number, east: number, north: number): [number, number] {
  return [lon + east / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)), lat + north / M_PER_DEG];
}
