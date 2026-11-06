export type LonLat = [number, number];

type Polygonal = {type: 'Polygon'; coordinates: number[][][]} | {type: 'MultiPolygon'; coordinates: number[][][][]};
export type PolygonCollection = {features: {geometry: Polygonal | null}[]};

const EARTH_R = 6_371_008.8;

export function metersPerDegree(lat: number): [number, number] {
  const k = (Math.PI / 180) * EARTH_R;
  return [k * Math.cos((lat * Math.PI) / 180), k];
}

/** Equirectangular distance: exact enough at the scale of one fire (< 0.1% over 20 km). */
export function distanceM(a: LonLat, b: LonLat): number {
  const [mx, my] = metersPerDegree((a[1] + b[1]) / 2);
  return Math.hypot((a[0] - b[0]) * mx, (a[1] - b[1]) * my);
}

/** Every ring (outer and holes) of every polygon, for even-odd hit-testing. */
export function polygonRings(fc: PolygonCollection): number[][][] {
  const rings: number[][][] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') rings.push(...g.coordinates);
    else for (const poly of g.coordinates) rings.push(...poly);
  }
  return rings;
}

export function insideRings(rings: number[][][], lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Points along a polyline, about stepM apart, always including both ends. */
export function densify(coords: number[][], stepM: number): LonLat[] {
  const out: LonLat[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a: LonLat = [coords[i][0], coords[i][1]];
    const b: LonLat = [coords[i + 1][0], coords[i + 1][1]];
    const n = Math.max(1, Math.ceil(distanceM(a, b) / stepM));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  const last = coords[coords.length - 1];
  if (last) out.push([last[0], last[1]]);
  return out;
}

export function bboxCenter([w, s, e, n]: number[]): LonLat {
  return [(w + e) / 2, (s + n) / 2];
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}
