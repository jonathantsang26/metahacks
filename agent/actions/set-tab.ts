import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { TABS, mapCommandOutput, writeMapCommand } from "../server/fire/actions-support.js";

export default defineAction({
  description:
    'Open a tab of the incident view: "incident" (fire timeline, analyst), "drones" (drone plan and footage) or "risk" (debris-flow risk). Writes a map-command the UI applies.',
  schema: z.object({
    tab: z.enum(TABS).describe('The tab: "incident", "drones" or "risk".'),
  }),
  outputSchema: mapCommandOutput,
  http: false,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  run: async ({ tab }) => {
    const command = { kind: "set-tab" as const, tab };
    const writeId = await writeMapCommand(command);
    return { ok: true as const, command, writeId, message: `Opened the ${tab} tab.` };
  },
});
