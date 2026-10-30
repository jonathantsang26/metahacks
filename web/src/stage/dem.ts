import type {DemMeta} from '../data/fire';

/** CPU copy of the heightmap: drapes vectors on the terrain and feeds the hover inspector. */
export class Dem {
  constructor(
    readonly meta: DemMeta,
    private readonly elev: Float32Array
  ) {}

  static async load(url: string, meta: DemMeta): Promise<Dem> {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', {willReadFrequently: true})!;
    ctx.drawImage(img, 0, 0);
    const {data} = ctx.getImageData(0, 0, img.width, img.height);
    const {rScaler, gScaler, bScaler, offset} = meta.decoder;
    const elev = new Float32Array(img.width * img.height);
    for (let i = 0; i < elev.length; i++) {
      elev[i] = data[i * 4] * rScaler + data[i * 4 + 1] * gScaler + data[i * 4 + 2] * bScaler + offset;
    }
    return new Dem({...meta, width: img.width, height: img.height}, elev);
  }

  private px(lon: number, lat: number): [number, number] {
    const [w, s, e, n] = this.meta.bounds;
    return [((lon - w) / (e - w)) * (this.meta.width - 1), ((n - lat) / (n - s)) * (this.meta.height - 1)];
  }

  private at(col: number, row: number): number {
    const c = Math.min(this.meta.width - 1, Math.max(0, col));
    const r = Math.min(this.meta.height - 1, Math.max(0, row));
    return this.elev[r * this.meta.width + c];
  }

  contains(lon: number, lat: number): boolean {
    const [w, s, e, n] = this.meta.bounds;
    return lon >= w && lon <= e && lat >= s && lat <= n;
  }

  /** Bilinear elevation in meters. */
  heightAt(lon: number, lat: number): number {
    const [x, y] = this.px(lon, lat);
    const c0 = Math.floor(x);
    const r0 = Math.floor(y);
    const fx = x - c0;
    const fy = y - r0;
    const top = this.at(c0, r0) * (1 - fx) + this.at(c0 + 1, r0) * fx;
    const bottom = this.at(c0, r0 + 1) * (1 - fx) + this.at(c0 + 1, r0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  }

  /** Slope in degrees and downslope aspect in degrees clockwise from north. */
  slopeAspect(lon: number, lat: number): {slope: number; aspect: number} {
    const [x, y] = this.px(lon, lat);
    const c = Math.round(x);
    const r = Math.round(y);
    const [mx, my] = this.meta.pixel_m;
    const dzEast = (this.at(c + 1, r) - this.at(c - 1, r)) / (2 * mx);
    const dzNorth = (this.at(c, r - 1) - this.at(c, r + 1)) / (2 * my);
    const slope = (Math.atan(Math.hypot(dzEast, dzNorth)) * 180) / Math.PI;
    const aspect = ((Math.atan2(-dzEast, -dzNorth) * 180) / Math.PI + 360) % 360;
    return {slope, aspect};
  }
}
