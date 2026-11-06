import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { z } from "zod";

import { LAYER_IDS, mapCommandOutput, writeMapCommand } from "../server/fire/actions-support.js";

const errors = defineActionErrors("bad_argument");
const layerList = z.array(z.enum(LAYER_IDS)).max(LAYER_IDS.length);

export default defineAction({
  description:
    `Show and/or hide map layers. Layer ids: ${LAYER_IDS.join(", ")}. ` +
    "Layers not named keep their current visibility. Writes a map-command the UI applies.",
  schema: z.object({
    show: layerList.optional().describe("Layer ids to turn on."),
    hide: layerList.optional().describe("Layer ids to turn off."),
  }),
  outputSchema: mapCommandOutput,
  errors,
  http: false,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  run: async ({ show, hide }) => {
    const on = [...new Set(show ?? [])];
    const off = [...new Set(hide ?? [])];
    if (!on.length && !off.length) errors.noWrite("Name at least one layer in show or hide.", "bad_argument");
    const both = on.filter((l) => off.includes(l));
    if (both.length) errors.noWrite(`A layer cannot be both shown and hidden: ${both.join(", ")}.`, "bad_argument");
    const command = { kind: "set-layers" as const, ...(on.length ? { show: on } : {}), ...(off.length ? { hide: off } : {}) };
    const writeId = await writeMapCommand(command);
    const parts = [on.length ? `showing ${on.join(", ")}` : "", off.length ? `hiding ${off.join(", ")}` : ""].filter(Boolean);
    return { ok: true as const, command, writeId, message: `Layers updated: ${parts.join("; ")}.` };
  },
});
