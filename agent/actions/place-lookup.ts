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

/** Port of the Meta analyst tool `place_lookup` (server/fire/tools.ts). */
export default defineAction({
  description: toolDescription("place_lookup"),
  schema: z.object({
    fire: fireInput,
    name: z.string().min(1).max(200).describe('Place or street name, e.g. "Lake Ave" or "Mount Wilson".'),
  }),
  outputSchema: toolOutputSchema,
  errors,
  http: { method: "GET" },
  readOnly: true,
  run: async ({ fire, name }) => {
    return runDataTool(fire, "place_lookup", { name });
  },
});
