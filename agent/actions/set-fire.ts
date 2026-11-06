import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { z } from "zod";

import { FIRES, fireStore, mapCommandOutput, writeMapCommand } from "../server/fire/actions-support.js";

const errors = defineActionErrors("data_missing");

export default defineAction({
  description:
    'Switch the map to another fire: "eaton" (Altadena, Jan 2025) or "palisades". The UI resets time to that fire\'s window. Writes a map-command the UI applies.',
  schema: z.object({
    fire: z.enum(FIRES).describe('The fire to show: "eaton" or "palisades".'),
  }),
  outputSchema: mapCommandOutput,
  errors,
  http: false,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  run: async ({ fire }) => {
    const name = fireStore(fire).aoi().name;
    const command = { kind: "set-fire" as const, fire };
    const writeId = await writeMapCommand(command);
    return { ok: true as const, command, writeId, message: `Switched the map to the ${name}.` };
  },
});
