import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { z } from "zod";

import {
  DATA_ERROR_CODES,
  fireInput,
  runDataTool,
  tInput,
  toolDescription,
  toolOutputSchema,
} from "../server/fire/actions-support.js";

const errors = defineActionErrors(...DATA_ERROR_CODES);

/** Port of the Meta analyst tool `fire_state_at` (server/fire/tools.ts). */
export default defineAction({
  description: toolDescription("fire_state_at"),
  schema: z.object({
    fire: fireInput,
    t: tInput,
  }),
  outputSchema: toolOutputSchema,
  errors,
  http: { method: "GET" },
  readOnly: true,
  run: async ({ fire, t }) => {
    return runDataTool(fire, "fire_state_at", { t });
  },
});
