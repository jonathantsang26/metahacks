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

/** Port of the Meta analyst tool `events` (server/fire/tools.ts). */
export default defineAction({
  description: toolDescription("events"),
  schema: z.object({
    fire: fireInput,
  }),
  outputSchema: toolOutputSchema,
  errors,
  http: { method: "GET" },
  readOnly: true,
  run: async ({ fire }) => {
    return runDataTool(fire, "events", {});
  },
});
