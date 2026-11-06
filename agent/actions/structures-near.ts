import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { z } from "zod";

import {
  DATA_ERROR_CODES,
  fireInput,
  latInput,
  lonInput,
  runDataTool,
  toolDescription,
  toolOutputSchema,
} from "../server/fire/actions-support.js";

const errors = defineActionErrors(...DATA_ERROR_CODES);

/** Port of the Meta analyst tool `structures_near` (server/fire/tools.ts). */
export default defineAction({
  description: toolDescription("structures_near"),
  schema: z.object({
    fire: fireInput,
    lon: lonInput,
    lat: latInput,
    radiusM: z.coerce.number().min(25).max(2000).optional().describe("Radius in meters, 25 to 2000; defaults to 500."),
  }),
  outputSchema: toolOutputSchema,
  errors,
  http: { method: "GET" },
  readOnly: true,
  run: async ({ fire, lon, lat, radiusM }) => {
    return runDataTool(fire, "structures_near", { lon, lat, ...(radiusM !== undefined ? { radius_m: radiusM } : {}) });
  },
});
