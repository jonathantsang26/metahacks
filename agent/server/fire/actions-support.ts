import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { fail } from "@agent-native/core/action";
import { writeAppStateForCurrentTab } from "@agent-native/core/application-state";
import { z } from "zod";

import { memoryStore, storeFromEnv, type BudgetStore } from "./budget.js";
import { FireStore, MissingDataError, type ArrivalRaster } from "./data.js";
import { distanceM, metersPerDegree, type LonLat } from "./geo.js";
import { createLimiter, type Limit, type Limiter } from "./ratelimit.js";
import { PRICE_PER_IMAGE_USD, SamApiError, TEXT_PROMPT, requestBody, segmentFrame, type Box, type SamResult } from "./sam.js";
import { localLabel } from "./time.js";
import { DATA_TOOLS, ToolArgError, runTool, type DataToolName } from "./tools.js";
import type { ToolCite, ToolOutput } from "./types.js";

/**
 * Glue between the agent-native actions in actions/ and the Meta build's fire lib in this folder.
 *
 * Data root: FireStore reads `<root>/public/data/<fire>/`. The root is FIRE_DATA_ROOT when set
 * (absolute, or relative to the process cwd), else the cwd. `pnpm dev`, `pnpm action` and vitest all
 * run from agent/, where `pnpm sync-data` puts the files. On a serverless host public/ may be served
 * from a CDN and not be on the function's disk: point FIRE_DATA_ROOT at a folder that ships with the
 * function and holds public/data/.
 */

// ---------------------------------------------------------------- fires and stores

export const FIRES = ["eaton", "palisades"] as const;
export type FireId = (typeof FIRES)[number];

export const fireInput = z
  .enum(FIRES)
  .default("eaton")
  .describe('Which fire: "eaton" (Altadena, Jan 2025) or "palisades"; defaults to "eaton".');

export const tInput = z
  .string()
  .describe("ISO-8601 UTC time, e.g. 2025-01-08T23:30:00Z.");

export const lonInput = z.coerce
  .number()
  .min(-180)
  .max(180)
  .describe("Longitude, decimal degrees (negative west), e.g. -118.13166.");
export const latInput = z.coerce
  .number()
  .min(-90)
  .max(90)
  .describe("Latitude, decimal degrees, e.g. 34.18986.");

export function dataRoot(): string {
  // guard:allow-env-credential — FIRE_DATA_ROOT is a deploy-level data path, not a credential.
  const env = process.env.FIRE_DATA_ROOT?.trim();
  return env ? path.resolve(env) : process.cwd();
}

const stores = new Map<string, FireStore>();

/** The FireStore for a fire, or a clear `data_missing` failure that says how to get the files. */
export function fireStore(fire: FireId): FireStore {
  const root = dataRoot();
  const key = `${root}\0${fire}`;
  let store = stores.get(key);
  if (!store) {
    store = new FireStore(fire, root);
    stores.set(key, store);
  }
  if (!store.exists()) {
    const where = path.join(root, "public", "data", fire);
    fail(
      `No data for fire "${fire}": ${where}/aoi.json is missing. Run \`pnpm sync-data\` in agent/, or set FIRE_DATA_ROOT to the folder that holds public/data/.`,
      { errorCode: "data_missing", statusCode: 503, details: { fire } },
    );
  }
  return store;
}

export function fireTz(fire: FireId): string {
  return fireStore(fire).aoi().timezone;
}

/** The fire's replay window from aoi.json window_utc, epoch ms. */
export function fireWindow(fire: FireId): { startMs: number; endMs: number; start: string; end: string } {
  const [start, end] = fireStore(fire).aoi().window_utc;
  return { startMs: Date.parse(start), endMs: Date.parse(end), start, end };
}

/** Parses an ISO time; a time without a zone is refused rather than guessed. */
export function parseUtc(t: string, field = "t"): number {
  const s = t.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    fail(`${field} must be an ISO-8601 time with a zone, e.g. 2025-01-08T23:30:00Z (got ${JSON.stringify(t)}).`, {
      errorCode: "bad_argument",
      details: { field },
    });
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) fail(`${field} is not a valid time: ${JSON.stringify(t)}.`, { errorCode: "bad_argument", details: { field } });
  return ms;
}

export const isoUtc = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");

// ---------------------------------------------------------------- the nine Meta analyst tools

export const DATA_ERROR_CODES = ["data_missing", "bad_argument", "tool_failed"] as const;

export const citeSchema = z.object({
  layer: z.string(),
  label: z.string(),
  t: z.string().optional(),
  t_local: z.string().optional(),
  lon: z.number().optional(),
  lat: z.number().optional(),
});

/** The Meta tool shape: the tool's result object and the cites the agent can quote. */
export const toolOutputSchema = z.object({
  result: z.record(z.string(), z.unknown()),
  cites: z.array(citeSchema),
});
export type ActionToolOutput = z.infer<typeof toolOutputSchema>;
export type ActionCite = ToolCite & { t_local?: string };

export type { DataToolName };

/** The Meta tool's own description (server/fire/tools.ts DATA_TOOLS), so the two never drift. */
export function toolDescription(name: DataToolName, extra = ""): string {
  const tool = DATA_TOOLS.find((t) => t.function.name === name);
  if (!tool?.function.description) throw new Error(`no Meta tool named ${name}`);
  return `${tool.function.description} Returns {result, cites}; quote the cites when you state a number.${extra ? ` ${extra}` : ""}`;
}

/**
 * Runs one Meta analyst tool exactly as the Meta analyst does (the same implementation, via runTool,
 * over the same FireStore), and returns its {result, cites}. Cites keep `t_local`; the runner's
 * per-request ids are not added. A tool error becomes a typed failure, never an empty value: the
 * error's class (MissingDataError, ToolArgError) picks the code.
 */
export function runDataTool(fire: FireId, name: DataToolName, args: Record<string, unknown>): ActionToolOutput {
  const store = fireStore(fire);
  const tz = store.aoi().timezone;
  // The Meta runner takes its arguments as JSON and returns JSON, so both go through the same round
  // trip here (undefined dropped, NaN to null) to keep the output identical to it.
  const input = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
  let out: ToolOutput;
  try {
    out = runTool(name, input, { store, tz });
  } catch (e) {
    const msg = (e instanceof Error ? e.message : undefined) ?? "unknown error";
    if (e instanceof MissingDataError) {
      fail(`The ${fire} data needed for ${name} is missing (${msg}). Run \`pnpm sync-data\` in agent/.`, {
        errorCode: "data_missing",
        statusCode: 503,
        details: { fire, tool: name },
      });
    }
    if (e instanceof ToolArgError) {
      fail(`${name}: ${msg}.`, { errorCode: "bad_argument", details: { tool: name } });
    }
    console.error(`[analyst] tool ${name} failed`, e);
    fail(`${name} failed for ${fire}: ${msg}`, { errorCode: "tool_failed", statusCode: 500, details: { tool: name } });
  }
  // Cites carry t_local as the Meta runner shows them; its per-request ids are not added.
  const shown = out.cites.map((c) => (c.t ? { ...c, t_local: localLabel(Date.parse(c.t), tz) } : c));
  const parsed = JSON.parse(JSON.stringify({ result: out.result, cites: shown })) as { result?: unknown; cites: ActionCite[] };
  if (!parsed.result || typeof parsed.result !== "object" || Array.isArray(parsed.result)) {
    fail(`${name} returned no result for ${fire}.`, { errorCode: "tool_failed", statusCode: 500 });
  }
  return { result: parsed.result as Record<string, unknown>, cites: parsed.cites };
}

// ---------------------------------------------------------------- map commands (UI control)

export const LAYER_IDS = [
  "terrain",
  "burnScar",
  "fireSpread",
  "perimeters",
  "ignition",
  "spine",
  "wind",
  "structures",
  "roads",
  "labels",
  "debrisFlow",
  "forecast",
  "liveHits",
  "dronePlan",
] as const;
export type LayerId = (typeof LAYER_IDS)[number];

export const TABS = ["incident", "drones", "risk"] as const;

export type MapCommand =
  | { kind: "set-time"; t: string }
  | { kind: "set-fire"; fire: FireId }
  | { kind: "set-tab"; tab: (typeof TABS)[number] }
  | { kind: "set-layers"; show?: LayerId[]; hide?: LayerId[] }
  | { kind: "fly-to"; lon: number; lat: number; zoom?: number };

/** Writes the `map-command` app-state key for the current browser tab; the UI applies it and deletes it. */
export async function writeMapCommand(cmd: MapCommand): Promise<string> {
  const _writeId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeAppStateForCurrentTab("map-command", { ...cmd, _writeId });
  return _writeId;
}

export const mapCommandOutput = z.object({
  ok: z.literal(true),
  command: z.record(z.string(), z.unknown()),
  writeId: z.string(),
  message: z.string(),
});

// ---------------------------------------------------------------- cached +1 h forecasts

type Polygonal = { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };
type ForecastFeature = { geometry: Polygonal; properties: { issued_utc: string; valid_utc: string; method: string; status: string } };
type ForecastFile = { features: ForecastFeature[] };
type MuseLog = { model?: string; forecasts?: { issued_utc: string; rejected?: string | null }[] };

const HOUR = 3_600_000;
/** "2025-01-08T23Z.geojson" for an issue hour, as pipeline/sim/forecast.py fname() writes it. */
export const forecastFile = (hourMs: number) => `${isoUtc(hourMs).slice(0, 13)}Z.geojson`;

/** Issue hours (epoch ms) that have a cached forecast file, sorted. */
export function forecastHours(fire: FireId): number[] {
  const dir = path.join(fireStore(fire).dir, "forecast");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => f.match(/^(\d{4}-\d{2}-\d{2}T\d{2})Z\.geojson$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => Date.parse(`${m[1]}:00:00Z`))
    .sort((a, b) => a - b);
}

/** Distance (m) from each arrival cell to the nearest cell burned by `issuedMs`: a two-pass chamfer
 * transform over arrival.png, cached per raster and issue time. */
const distCache = new WeakMap<ArrivalRaster, Map<number, Float32Array>>();

function burnedDistance(r: ArrivalRaster, issuedMs: number): { dist: Float32Array; cellM: number } {
  const [w, s, e, n] = r.bounds;
  const [mx, my] = metersPerDegree((s + n) / 2);
  const cx = ((e - w) / r.width) * mx;
  const cy = ((n - s) / r.height) * my;
  const cellM = Math.max(cx, cy);
  let byT = distCache.get(r);
  if (!byT) distCache.set(r, (byT = new Map()));
  const hit = byT.get(issuedMs);
  if (hit) return { dist: hit, cellM };
  const W = r.width;
  const H = r.height;
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    // Same decoding as data.ts sampleArrival: red 1..254 → (code−1)/253 of the window, 255 → never.
    const c = r.rgba[i * 4]!;
    d[i] = c >= 1 && c <= 254 && r.startMs + ((c - 1) / 253) * r.windowMs <= issuedMs ? 0 : Infinity;
  }
  const cd = Math.hypot(cx, cy);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + cx);
      if (y > 0) {
        v = Math.min(v, d[i - W]! + cy);
        if (x > 0) v = Math.min(v, d[i - W - 1]! + cd);
        if (x < W - 1) v = Math.min(v, d[i - W + 1]! + cd);
      }
      d[i] = v;
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let v = d[i]!;
      if (x < W - 1) v = Math.min(v, d[i + 1]! + cx);
      if (y < H - 1) {
        v = Math.min(v, d[i + W]! + cy);
        if (x < W - 1) v = Math.min(v, d[i + W + 1]! + cd);
        if (x > 0) v = Math.min(v, d[i + W - 1]! + cd);
      }
      d[i] = v;
    }
  if (byT.size >= 8) byT.delete(byT.keys().next().value!);
  byT.set(issuedMs, d);
  return { dist: d, cellM };
}

export type FrontPiece = {
  /** Length of this stretch of advancing edge. */
  km: number;
  /** Largest distance from this stretch to ground already burned at issue time: how far the forecast expects it to run. */
  maxAdvanceM: number;
  /** The point of this stretch farthest from burned ground, [lon, lat]. */
  headLonLat: [number, number];
};

/**
 * The advancing edge: the parts of the forecast polygon's boundary (outer rings and holes) that lie
 * more than 2 arrival cells (~30 m) from ground already burned at issue time, per arrival.png. Each
 * ring is walked at half a cell; runs of "new" points become lines that keep the ring's own vertices
 * plus the first and last new point of each run.
 */
export function advancingEdge(r: ArrivalRaster, polygon: Polygonal, issuedMs: number): { lines: number[][][]; pieces: FrontPiece[] } {
  const { dist, cellM } = burnedDistance(r, issuedMs);
  const heldM = 2 * cellM;
  const [w, s, e, n] = r.bounds;
  const advanceAt = ([lon, lat]: number[]) => {
    const col = Math.floor(((lon! - w) / (e - w)) * r.width);
    const row = Math.floor(((n - lat!) / (n - s)) * r.height);
    if (col < 0 || row < 0 || col >= r.width || row >= r.height) return Infinity;
    return dist[row * r.width + col]!;
  };
  const stepM = cellM / 2;
  const rings = polygon.type === "Polygon" ? polygon.coordinates : polygon.coordinates.flat();
  const lines: number[][][] = [];
  const pieces: FrontPiece[] = [];
  const r5 = (c: number) => Math.round(c * 1e5) / 1e5;
  type Pt = { p: number[]; v: boolean; adv: number };
  const emit = (run: Pt[], closed: boolean) => {
    const kept = run.filter((x, i) => x.v || i === 0 || i === run.length - 1).map((x) => x.p.map(r5));
    if (closed) kept.push(kept[0]!);
    if (kept.length < 2) return;
    lines.push(kept);
    const head = run.reduce((a, b) => (Number.isFinite(b.adv) && b.adv > a.adv ? b : a), run[0]!);
    pieces.push({
      km: linesKm([kept]),
      maxAdvanceM: Number.isFinite(head.adv) ? Math.round(head.adv) : -1,
      headLonLat: [r5(head.p[0]!), r5(head.p[1]!)],
    });
  };
  for (const ring of rings) {
    const pts: Pt[] = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i]!;
      const b = ring[i + 1]!;
      const k = Math.max(1, Math.ceil(distanceM(a as LonLat, b as LonLat) / stepM));
      for (let j = 0; j < k; j++) {
        const p = j === 0 ? [a[0]!, a[1]!] : [a[0]! + ((b[0]! - a[0]!) * j) / k, a[1]! + ((b[1]! - a[1]!) * j) / k];
        pts.push({ p, v: j === 0, adv: advanceAt(p) });
      }
    }
    if (!pts.length) continue;
    const fresh = (x: Pt) => x.adv > heldM;
    if (pts.every(fresh)) {
      emit(pts, true);
      continue;
    }
    // Start just after a held point so no run wraps around the ring's seam.
    const start = pts.findIndex((x) => !fresh(x));
    let run: Pt[] = [];
    for (const x of [...pts.slice(start + 1), ...pts.slice(0, start + 1)]) {
      if (fresh(x)) run.push(x);
      else {
        if (run.length >= 2) emit(run, false);
        run = [];
      }
    }
    if (run.length >= 2) emit(run, false);
  }
  pieces.sort((a, b) => b.km - a.km);
  return { lines, pieces };
}

export function linesKm(lines: number[][][]): number {
  let m = 0;
  for (const l of lines) for (let i = 1; i < l.length; i++) m += distanceM(l[i - 1] as LonLat, l[i] as LonLat);
  return Math.round(m / 100) / 10;
}

export type ForecastFront = {
  fire: FireId;
  asked: string;
  forecastFor: string;
  issuedAt: string;
  method: "muse" | "physics";
  polygon: Polygonal;
  front: { type: "MultiLineString"; coordinates: number[][][] };
  frontKm: number;
  /** Stretches of the front of at least 0.2 km, longest first (at most 12). */
  frontPieces: FrontPiece[];
  status: "saved";
  source: string;
  note: string;
};

/**
 * The cached +1 h forecast issued at the top of the hour at or before t. Muse Spark's polygon is
 * used when it exists and was not rejected; when the pipeline rejected Muse's reply for that hour
 * (it then exported "no growth"), the physics forecast from the same file is used and `method` says so.
 */
export function getForecastFront(fire: FireId, tMs: number): ForecastFront {
  const store = fireStore(fire);
  const issuedMs = Math.floor(tMs / HOUR) * HOUR;
  const file = forecastFile(issuedMs);
  const hours = forecastHours(fire);
  if (!hours.includes(issuedMs)) {
    const nearest = [...hours].sort((a, b) => Math.abs(a - tMs) - Math.abs(b - tMs)).slice(0, 4).sort((a, b) => a - b).map(isoUtc);
    const range = hours.length ? ` Forecast issue hours run ${isoUtc(hours[0]!)} to ${isoUtc(hours[hours.length - 1]!)}.` : "";
    fail(
      hours.length
        ? `No +1 h forecast for ${fire} issued at ${isoUtc(issuedMs)} (the hour at or before ${isoUtc(tMs)}). Nearest issue hours: ${nearest.join(", ")}.${range}`
        : `No forecasts exist for ${fire} (no ${fire}/forecast/ folder).`,
      { errorCode: "no_forecast", statusCode: 404, details: { fire, issuedAt: isoUtc(issuedMs), nearest } },
    );
  }
  const fc = store.json<ForecastFile>(`forecast/${file}`);
  const log = store.optionalJson<MuseLog>("forecast/muse_export_log.json");
  const museEntry = log?.forecasts?.find((f) => Date.parse(f.issued_utc) === issuedMs);
  const muse = fc.features.find((f) => f.properties.method === "muse");
  const physics = fc.features.find((f) => f.properties.method === "physics");
  const museRejected = !!museEntry?.rejected;
  const pick = muse && !museRejected ? muse : physics;
  if (!pick) {
    fail(`The ${fire} forecast file ${file} has no usable muse or physics polygon.`, { errorCode: "no_forecast", statusCode: 404 });
  }
  const method = pick.properties.method === "muse" ? "muse" : "physics";
  const { lines: coordinates, pieces } = advancingEdge(store.arrival(), pick.geometry, issuedMs);
  const why = museRejected
    ? `Muse Spark's reply for this hour was rejected by the pipeline (${museEntry!.rejected}), so its exported polygon is just the current footprint; this is the physics forecast from the same file.`
    : !muse
      ? "This file has no Muse Spark polygon; this is the physics forecast."
      : `Muse Spark (${log?.model ?? "muse-spark"}) per-sector spread distances, bounded by the pipeline.`;
  return {
    fire,
    asked: isoUtc(tMs),
    forecastFor: pick.properties.valid_utc,
    issuedAt: pick.properties.issued_utc,
    method,
    polygon: pick.geometry,
    front: { type: "MultiLineString", coordinates },
    frontKm: linesKm(coordinates),
    frontPieces: pieces.filter((p) => p.km >= 0.2).slice(0, 12),
    status: "saved",
    source: `public/data/${fire}/forecast/${file} (${method} feature), precomputed by pipeline/sim/forecast.py; a hindsight forecast, not an operational product.`,
    note: `${why} The polygon is the whole expected burned footprint at forecastFor. front is the part of its edge more than ~30 m from ground already burned at issuedAt (arrival.png), i.e. where the fire is expected to advance. frontPieces lists its longer stretches with maxAdvanceM, how far each is expected to run past the burned edge; the biggest values are the head.${coordinates.length ? "" : " No edge advances in this forecast."}`,
  };
}

// ---------------------------------------------------------------- SAM 3.1 outlines (port of web/api/sam.ts)

export const SAM_MAX_IMAGE_BYTES = 1_000_000;
const SAM_MAX_SIDE = 1280;
const SAM_MAX_BOXES = 6;
export const SAM_DEFAULT_DAILY_USD = 5;
export const SAM_MAX_DAILY_USD = 25;
/** The client sends at most one frame per ~2 s, so 40 a minute leaves room and stops a runaway loop. */
export const SAM_PER_VISITOR: Limit = { max: 40, windowMs: 60_000 };
export const SAM_GLOBAL: Limit = { max: 160, windowMs: 60_000 };

export const SAM_ERROR_CODES = [
  "no_key",
  "bad_image",
  "rate_limited",
  "no_store",
  "budget",
  "upstream",
  "upstream_rate_limited",
] as const;
type SamCode = (typeof SAM_ERROR_CODES)[number];

type Env = Record<string, string | undefined>;
export type SamDeps = {
  limiter?: Limiter;
  client?: string;
  /** The day's budget store; defaults to Upstash, or memory with ANALYST_BUDGET_LOCAL=1 / SAM_BUDGET_LOCAL=1. */
  store?: (day: string) => BudgetStore | null;
  fetch?: typeof fetch;
  now?: () => number;
};

const samLimiter = createLimiter(SAM_PER_VISITOR, SAM_GLOBAL);
const samLocalDays = new Map<string, BudgetStore>();

export function samDailyCapUsd(env: Env): number {
  const v = Number(env.SAM_DAILY_BUDGET_USD);
  return Math.min(Number.isFinite(v) && v > 0 ? v : SAM_DEFAULT_DAILY_USD, SAM_MAX_DAILY_USD);
}

function samDefaultStore(env: Env) {
  return (day: string): BudgetStore | null => {
    const shared = storeFromEnv(env, `sam:spent_micro_usd:${day}`);
    if (shared) return shared;
    if (env.ANALYST_BUDGET_LOCAL !== "1" && env.SAM_BUDGET_LOCAL !== "1") return null;
    let s = samLocalDays.get(day);
    if (!s) {
      samLocalDays.clear();
      samLocalDays.set(day, (s = memoryStore()));
    }
    return s;
  };
}

const samFail = (message: string, code: SamCode, statusCode: number, details?: Record<string, unknown>): never =>
  fail(message, { errorCode: code, statusCode, ...(details ? { details } : {}) });

/** Width and height from a JPEG's first SOF marker, or null. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xff) {
      i += 1;
      continue;
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    }
    i += 2 + len;
  }
  return null;
}

export type SamInput = {
  imageBase64: string;
  width?: number | undefined;
  height?: number | undefined;
  boxes?: number[][] | undefined;
};
export type SamOutput = {
  outlines: { id: string; bounds: number[]; conf: number | null; polygons: number[][] }[];
  width: number;
  height: number;
  ms: number;
  prompt: string;
  status: "LIVE";
  diagnostics?: string[];
};

/** Validates the frame: a JPEG (raw base64 or a data URL) of at most 1 MB and 16–1280 px a side. */
export function parseSamInput(input: SamInput): { image: string; width: number; height: number; boxes: Box[] } {
  const raw = input.imageBase64.trim();
  const m = raw.match(/^(?:data:image\/jpeg;base64,)?([A-Za-z0-9+/]+={0,2})$/);
  const b64 = m?.[1];
  if (!b64) return samFail("imageBase64 must be a JPEG as base64 or a data:image/jpeg;base64,… URL.", "bad_image", 400);
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > SAM_MAX_IMAGE_BYTES) samFail(`The image is larger than ${SAM_MAX_IMAGE_BYTES / 1e6} MB; send a downscaled frame.`, "bad_image", 400);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) samFail("The image is not a JPEG.", "bad_image", 400);
  const size = input.width && input.height ? { width: input.width, height: input.height } : jpegSize(bytes);
  if (!size) return samFail("Could not read the JPEG's size; pass width and height.", "bad_image", 400);
  const { width: w, height: h } = size;
  const side = (v: number) => Number.isInteger(v) && v >= 16 && v <= SAM_MAX_SIDE;
  if (!side(w) || !side(h)) samFail(`The frame must be 16–${SAM_MAX_SIDE} px a side (got ${w}×${h}); downscale it.`, "bad_image", 400);
  const boxes: Box[] = [];
  for (const x of input.boxes ?? []) {
    if (x.length !== 4 || !x.every((v) => Number.isFinite(v))) samFail("Each box must be [x1, y1, x2, y2] numbers.", "bad_image", 400);
    const [x1, y1, x2, y2] = x as Box;
    if (x2 <= x1 || y2 <= y1 || x2 <= 0 || y2 <= 0 || x1 >= w || y1 >= h) continue; // empty or off-frame
    boxes.push([x1, y1, x2, y2]);
    if (boxes.length === SAM_MAX_BOXES) break;
  }
  return { image: `data:image/jpeg;base64,${b64}`, width: w, height: h, boxes };
}

/** Never let the key into a message, whatever the upstream echoed. */
const redact = (s: string, key: string) => (key ? s.split(key).join("[redacted]") : s);

/**
 * SAM 3.1 outlines for one frame, with web/api/sam.ts's guards in the same order: key, input,
 * per-visitor and global rate limit, then a reservation against the daily spend cap
 * (SAM_DAILY_BUDGET_USD, default $5, never above $25) in Upstash or, locally, memory. A refusal up
 * front by the Model API returns the reservation. The key is never logged or returned.
 */
export async function samOutline(input: SamInput, env: Env = process.env, deps: SamDeps = {}): Promise<SamOutput> {
  const key = env.MODEL_API_KEY?.trim();
  if (!key) {
    return samFail(
      "SAM 3.1 outlines are unavailable: the server has no Model API key (set MODEL_API_KEY in the deployment environment).",
      "no_key",
      503,
    );
  }
  const req = parseSamInput(input);
  const now = deps.now ?? Date.now;
  const v = (deps.limiter ?? samLimiter).take(deps.client ?? "unknown");
  if (!v.ok) {
    const per = `${v.limit.max} frames per ${v.limit.windowMs / 1000} s`;
    samFail(
      `SAM 3.1 is limited to ${per} ${v.scope === "visitor" ? "per visitor" : "across all visitors"}. Retry in ${v.retryAfterS} s.`,
      "rate_limited",
      429,
      { retryAfterS: v.retryAfterS },
    );
  }
  const day = new Date(now()).toISOString().slice(0, 10);
  const store = (deps.store ?? samDefaultStore(env))(day);
  if (!store) {
    return samFail(
      "Spend tracking is not configured (no Upstash Redis store, and neither ANALYST_BUDGET_LOCAL=1 nor SAM_BUDGET_LOCAL=1), so SAM 3.1 outlines are paused rather than spending untracked.",
      "no_store",
      503,
    );
  }
  const cap = samDailyCapUsd(env);
  const cost = Math.ceil(PRICE_PER_IMAGE_USD * 1e6);
  let reserved: boolean;
  try {
    reserved = await store.reserve(cost, Math.ceil(cap * 1e6));
  } catch (e) {
    console.error("[sam] budget store failed:", redact(String((e as Error).message ?? e), key));
    return samFail("Spend tracking is unavailable, so SAM 3.1 outlines are paused.", "no_store", 503);
  }
  if (!reserved) samFail(`SAM 3.1 outlines have used today's $${cap} budget, so they are paused until 00:00 UTC.`, "budget", 503);
  const prompt = req.boxes.length ? { boxes: req.boxes, width: req.width, height: req.height } : { text: TEXT_PROMPT };
  const t0 = now();
  let result: SamResult;
  try {
    result = await segmentFrame(key, requestBody(req.image, prompt), req, deps.fetch);
  } catch (e) {
    const status = e instanceof SamApiError ? e.status : 0;
    // Refused up front (4xx other than a timeout): nothing was billed, so the reservation comes back.
    if (status >= 400 && status < 500 && status !== 408) await store.adjust(-cost).catch(() => undefined);
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    const msg = redact(`${(e as Error).message ?? e}${cause ? ` (${cause})` : ""}`, key);
    console.error(`[sam] request failed: ${msg}`);
    const timeout = (e as Error).name === "TimeoutError";
    return samFail(timeout ? "SAM 3.1 did not answer in time." : msg, status === 429 ? "upstream_rate_limited" : "upstream", 502);
  }
  return {
    outlines: result.outlines,
    width: result.width,
    height: result.height,
    ms: now() - t0,
    prompt: req.boxes.length ? "boxes" : TEXT_PROMPT,
    status: "LIVE",
    ...(result.diagnostics.length ? { diagnostics: result.diagnostics } : {}),
  };
}
