import { describe, expect, it } from "vitest";

import type { Cite } from "./types.js";
import { ungroundedNumbers } from "./verify.js";

const cite = (id: string): Cite => ({ id, layer: "plan", label: "Drone plan" });

describe("percent grounding", () => {
  // A plan result where an unrelated count (homes) happens to be 45.
  const evidence = new Map<string, unknown>([
    ["c1", { result: { homes: 45, front_km: 3.2, drones: 4, coverage_pct: 38, seen_fraction: 0.38 } }],
    ["c2", { result: { destroyed: 686, destroyed_rate: 0.4412, rh_pct: 12 } }],
    ["c3", { result: { note: "about 45% of the front is in view", homes: 45 } }],
  ]);
  const check = (text: string, ids: string[]) => ungroundedNumbers(text, ids.map(cite), { evidence });

  it("refuses a percentage that only matches an unrelated count", () => {
    expect(check("The drones see 45% of the front.", ["c1"])).toEqual(["45%"]);
    expect(check("The drones see 45 percent of the front.", ["c1"])).toEqual(["45 percent"]);
  });

  it("keeps a percentage from a percent field, a fraction ×100, or a number written with %", () => {
    expect(check("The drones see 38% of the front.", ["c1"])).toEqual([]);
    expect(check("44% of inspected structures were destroyed.", ["c2"])).toEqual([]);
    expect(check("Relative humidity was 12 percent.", ["c2"])).toEqual([]);
    expect(check("The drones see 45% of the front.", ["c3"])).toEqual([]);
  });

  it("keeps plain numbers matching any cited value, as before", () => {
    expect(check("45 homes lie ahead of the front.", ["c1"])).toEqual([]);
    expect(check("686 structures were destroyed.", ["c2"])).toEqual([]);
    expect(check("38 homes lie ahead of the front.", ["c1"])).toEqual([]);
    expect(check("51 homes lie ahead of the front.", ["c1"])).toEqual(["51"]);
  });
});
