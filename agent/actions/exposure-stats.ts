import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { z } from "zod";

import {
  DATA_ERROR_CODES,
  fireInput,
  runDataTool,
  toolDescription,
  toolOutputSchema,
} from "../server/fire/actions-support.js";

const errors = defineActionErrors(...DATA_ERROR_CODES);

/** Port of the Meta analyst tool `exposure_stats` (server/fire/tools.ts). */
export default defineAction({
  description: toolDescription("exposure_stats"),
  schema: z.object({
    fire: fireInput,
    feature: z.string().max(80).optional().describe('Optional feature, e.g. "vents" or "roof". Omit for all.'),
  }),
  outputSchema: toolOutputSchema,
  errors,
  http: { method: "GET" },
  readOnly: true,
  run: async ({ fire, feature }) => {
    return runDataTool(fire, "exposure_stats", { ...(feature ? { feature } : {}) });
  },
});
