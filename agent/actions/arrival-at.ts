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

/** Port of the Meta analyst tool `arrival_at` (server/fire/tools.ts). */
export default defineAction({
  description: toolDescription("arrival_at"),
  schema: z.object({
    fire: fireInput,
    lon: lonInput,
    lat: latInput,
  }),
  outputSchema: toolOutputSchema,
  errors,
  http: { method: "GET" },
  readOnly: true,
  run: async ({ fire, lon, lat }) => {
    return runDataTool(fire, "arrival_at", { lon, lat });
  },
});
