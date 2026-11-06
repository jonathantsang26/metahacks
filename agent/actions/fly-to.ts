import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { latInput, lonInput, mapCommandOutput, writeMapCommand } from "../server/fire/actions-support.js";

export default defineAction({
  description:
    "Fly the map camera to a point (lon, lat; get coordinates from place-lookup or a drone assignment). zoom is optional: 12 shows a whole neighborhood, 15 a few streets. Writes a map-command the UI applies.",
  schema: z.object({
    lon: lonInput,
    lat: latInput,
    zoom: z.coerce.number().min(3).max(20).optional().describe("Map zoom, 3 to 20; omit to keep the current zoom."),
  }),
  outputSchema: mapCommandOutput,
  http: false,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  run: async ({ lon, lat, zoom }) => {
    const command = { kind: "fly-to" as const, lon, lat, ...(zoom !== undefined ? { zoom } : {}) };
    const writeId = await writeMapCommand(command);
    return { ok: true as const, command, writeId, message: `Flying to ${lon.toFixed(5)}, ${lat.toFixed(5)}${zoom !== undefined ? ` at zoom ${zoom}` : ""}.` };
  },
});
