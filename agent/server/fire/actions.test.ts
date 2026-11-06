import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import arrivalAt from "../../actions/arrival-at.js";
import exposureStats from "../../actions/exposure-stats.js";
import fireEvents from "../../actions/fire-events.js";
import fireStateAt from "../../actions/fire-state-at.js";
import getForecastFront from "../../actions/get-forecast-front.js";
import ignitionSummary from "../../actions/ignition-summary.js";
import placeLookup from "../../actions/place-lookup.js";
import setLayers from "../../actions/set-layers.js";
import setTime from "../../actions/set-time.js";
import streetFireTimeline from "../../actions/street-fire-timeline.js";
import structuresNear from "../../actions/structures-near.js";
import weatherAt from "../../actions/weather-at.js";
import { advancingEdge, fireStore, linesKm, samOutline } from "./actions-support.js";
import { memoryStore } from "./budget.js";
import { FireStore } from "./data.js";
import { createLimiter } from "./ratelimit.js";
import { createToolRunner } from "./tools.js";

// Real data: agent/public/data (pnpm sync-data). The reference is the Meta build itself: the same
// tool code run over the Meta app's own files in ../web/public/data.
const ALTADENA = { lon: -118.13166, lat: 34.18986 };
const T = "2025-01-08T23:30:00Z";
const metaRoot = path.resolve("../web");
const haveMeta = existsSync(path.join(metaRoot, "public/data/eaton/aoi.json"));

function meta(name: string, args: Record<string, unknown>) {
  const out = createToolRunner(new FireStore("eaton", metaRoot)).run(name, JSON.stringify(args));
  expect(out.ok).toBe(true);
  const parsed = JSON.parse(out.content) as { result: unknown; cites: { id?: string }[] };
  return { result: parsed.result, cites: parsed.cites.map(({ id: _id, ...c }) => c) };
}

async function code(p: unknown): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { errorCode?: string }).errorCode;
  }
  return "no error";
}

describe.skipIf(!haveMeta)("data actions return exactly what the Meta tools return", () => {
  const cases: [string, { run: (a: never) => unknown }, Record<string, unknown>, string, Record<string, unknown>][] = [
    ["place-lookup", placeLookup, { name: "Lake Ave" }, "place_lookup", { name: "Lake Ave" }],
    ["arrival-at", arrivalAt, ALTADENA, "arrival_at", ALTADENA],
    ["street-fire-timeline", streetFireTimeline, { name: "Lake Ave" }, "street_fire_timeline", { name: "Lake Ave" }],
    ["fire-state-at", fireStateAt, { t: T }, "fire_state_at", { t: T }],
    ["weather-at", weatherAt, { t: T }, "weather_at", { t: T }],
    ["fire-events", fireEvents, {}, "events", {}],
    ["structures-near", structuresNear, { ...ALTADENA, radiusM: 300 }, "structures_near", { ...ALTADENA, radius_m: 300 }],
    ["ignition-summary", ignitionSummary, {}, "ignition_summary", {}],
    ["exposure-stats", exposureStats, { feature: "vents" }, "exposure_stats", { feature: "vents" }],
  ];
  for (const [action, def, args, tool, toolArgs] of cases) {
    it(`${action} = ${tool}`, async () => {
      const got = await def.run(args as never);
      expect(got).toEqual(meta(tool, toolArgs));
    });
  }
});

describe("data actions on real Eaton numbers", () => {
  it("fire-state-at 23:30Z: 8,654.8 acres at the 23:00Z hour", async () => {
    const { result } = await fireStateAt.run({ t: T });
    expect(result).toMatchObject({ t: "2025-01-08T23:00:00Z", area_acres: 8654.8, ros_chains_hr: 10.1 });
  });

  it("arrival-at in Altadena: burned 2025-01-08T21:49Z, inside the final perimeter", async () => {
    const { result, cites } = await arrivalAt.run(ALTADENA);
    expect(result).toMatchObject({ burned: true, t: "2025-01-08T21:49:00Z", inside_final_perimeter: true });
    expect(cites[0]).toMatchObject({ layer: "arrival", t: "2025-01-08T21:49:00Z" });
  });

  it("structures-near reports counts by damage", async () => {
    const { result } = await structuresNear.run({ ...ALTADENA, radiusM: 300 });
    expect(result).toMatchObject({ total: 277, by_damage: { Destroyed: 175 } });
  });
});

describe("get-forecast-front", () => {
  it("picks the 23Z forecast for 23:30Z and falls back to physics where Muse was rejected", async () => {
    const f = await getForecastFront.run({ t: T });
    expect(f).toMatchObject({ issuedAt: "2025-01-08T23:00:00Z", forecastFor: "2025-01-09T00:00:00Z", status: "CACHED", method: "physics" });
    expect(f.front.coordinates.length).toBeGreaterThan(0);
    expect(f.frontKm).toBeGreaterThan(10);
    expect(f.frontPieces[0]!.maxAdvanceM).toBeGreaterThan(100);
  });

  it("finds no advancing edge on a no-growth polygon (Muse's rejected 23Z reply is the current footprint)", () => {
    const store = fireStore("eaton");
    const fc = store.json<{ features: { geometry: never; properties: { method: string } }[] }>("forecast/2025-01-08T23Z.geojson");
    const muse = fc.features.find((x) => x.properties.method === "muse")!;
    const { lines } = advancingEdge(store.arrival(), muse.geometry, Date.parse("2025-01-08T23:00:00Z"));
    expect(linesKm(lines)).toBe(0);
  });

  it("uses Muse Spark where its reply was accepted", async () => {
    const f = await getForecastFront.run({ t: "2025-01-09T00:10:00Z" });
    expect(f.method).toBe("muse");
    expect(f.frontKm).toBeGreaterThan(0);
  });

  it("fails with no_forecast outside the cached hours", async () => {
    expect(await code(getForecastFront.run({ t: "2025-01-11T02:00:00Z" }))).toBe("no_forecast");
  });
});

describe("map-command validation (before any write)", () => {
  it("set-time refuses a time outside the window", async () => {
    expect(await code(setTime.run({ t: "2025-02-01T00:00:00Z", fire: "eaton" }))).toBe("out_of_window");
    expect(await code(setTime.run({ t: "2025-01-08 23:30", fire: "eaton" }))).toBe("bad_argument");
  });
  it("set-layers refuses empty or contradictory requests", async () => {
    expect(await code(setLayers.run({}))).toBe("bad_argument");
    expect(await code(setLayers.run({ show: ["wind"], hide: ["wind"] }))).toBe("bad_argument");
  });
});

describe("sam-outline guards", () => {
  // SOI + SOF0 for a 320x240 frame.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 240, 1, 64, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]).toString("base64");
  const limiter = () => createLimiter({ max: 100, windowMs: 60_000 }, { max: 100, windowMs: 60_000 });

  it("fails with no_key without MODEL_API_KEY", async () => {
    expect(await code(samOutline({ imageBase64: jpeg }, {}))).toBe("no_key");
  });
  it("fails with no_store when spend tracking is not configured", async () => {
    expect(await code(samOutline({ imageBase64: jpeg }, { MODEL_API_KEY: "k" }, { limiter: limiter() }))).toBe("no_store");
  });
  it("refuses past the daily cap and refunds a reservation the API refused", async () => {
    const store = memoryStore();
    const refuse = (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
    const env = { MODEL_API_KEY: "k", SAM_DAILY_BUDGET_USD: "0.005" };
    expect(await code(samOutline({ imageBase64: jpeg }, env, { limiter: limiter(), store: () => store, fetch: refuse }))).toBe("upstream");
    expect(await store.spent()).toBe(0);
    await store.adjust(5000);
    expect(await code(samOutline({ imageBase64: jpeg }, env, { limiter: limiter(), store: () => store, fetch: refuse }))).toBe("budget");
  });
  it("rejects a non-JPEG", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString("base64");
    expect(await code(samOutline({ imageBase64: png }, { MODEL_API_KEY: "k" }))).toBe("bad_image");
  });
});
