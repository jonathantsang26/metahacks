import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { readAppStateForCurrentTab } from "@agent-native/core/application-state";
import { z } from "zod";

import {
  FIRES,
  fireWindow,
  isoUtc,
  mapCommandOutput,
  parseUtc,
  tInput,
  writeMapCommand,
  type FireId,
} from "../server/fire/actions-support.js";

const errors = defineActionErrors("bad_argument", "out_of_window", "data_missing");

export default defineAction({
  description:
    "Move the map's replay clock to time t (ISO UTC, e.g. 2025-01-08T23:30:00Z). t is rounded to the nearest minute and must lie inside the fire's replay window (aoi.json window_utc; Eaton 2025-01-08T00:00Z to 2025-01-13T00:00Z). " +
    "Checks against `fire` when given, else the fire on screen, else eaton. Writes a map-command the UI applies.",
  schema: z.object({
    t: tInput,
    fire: z
      .enum(FIRES)
      .optional()
      .describe('Fire whose window to check t against: "eaton" or "palisades"; defaults to the fire on screen.'),
  }),
  outputSchema: mapCommandOutput,
  errors,
  http: false,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  run: async ({ t, fire }) => {
    let onScreen: FireId | undefined;
    if (!fire) {
      const nav = await readAppStateForCurrentTab("navigation", { fallbackToGlobal: true }).catch(() => null);
      const f = nav?.fire;
      if (typeof f === "string" && (FIRES as readonly string[]).includes(f)) onScreen = f as FireId;
    }
    const which: FireId = fire ?? onScreen ?? "eaton";
    const ms = Math.round(parseUtc(t) / 60_000) * 60_000;
    const win = fireWindow(which);
    if (ms < win.startMs || ms > win.endMs) {
      errors.noWrite(
        `${isoUtc(ms)} is outside the ${which} replay window (${win.start} to ${win.end}).`,
        "out_of_window",
        { details: { fire: which, start: win.start, end: win.end } },
      );
    }
    const command = { kind: "set-time" as const, t: isoUtc(ms) };
    const writeId = await writeMapCommand(command);
    return { ok: true as const, command, writeId, message: `Map time set to ${command.t} (${which}).` };
  },
});
