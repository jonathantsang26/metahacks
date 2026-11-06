import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { z } from "zod";

import { FIRES, SAM_ERROR_CODES, SAM_MAX_IMAGE_BYTES, samOutline } from "../server/fire/actions-support.js";

const errors = defineActionErrors(...SAM_ERROR_CODES);

/** Port of the Meta build's POST /api/sam (web/api/sam.ts), with the same spend cap and rate limits. */
export default defineAction({
  description:
    "SAM 3.1 fire outlines for one live drone frame (Meta Model API). Input: a JPEG frame as base64 (or a data URL), optional width/height (read from the JPEG when omitted) and optional detector boxes [x1, y1, x2, y2] in frame pixels as object prompts; without boxes the text prompt is \"fire\". " +
    "Returns {outlines: [{id, bounds, conf, polygons}], width, height, ms, prompt, status: \"LIVE\"} in frame pixels. Spend is capped per UTC day (SAM_DAILY_BUDGET_USD, default $5, max $25) and rate-limited (40 frames/min per user, 160/min overall). Fails with no_key when the server has no MODEL_API_KEY.",
  schema: z.object({
    fire: z.enum(FIRES).default("eaton").describe('Fire the frame belongs to: "eaton" or "palisades"; defaults to "eaton".'),
    imageBase64: z
      .string()
      .min(8)
      .max(Math.ceil((SAM_MAX_IMAGE_BYTES * 4) / 3) + 64)
      .describe("The frame as JPEG base64, or a data:image/jpeg;base64,… URL; at most 1 MB, 16–1280 px a side."),
    width: z.coerce.number().int().min(16).max(1280).optional().describe("Frame width in pixels; read from the JPEG when omitted."),
    height: z.coerce.number().int().min(16).max(1280).optional().describe("Frame height in pixels; read from the JPEG when omitted."),
    boxes: z
      .array(z.array(z.number()).length(4))
      .max(32)
      .optional()
      .describe("Optional detector boxes [x1, y1, x2, y2] in frame pixels; up to 6 are sent as SAM object prompts."),
  }),
  outputSchema: z.object({
    outlines: z.array(
      z.object({ id: z.string(), bounds: z.array(z.number()), conf: z.number().nullable(), polygons: z.array(z.array(z.number())) }),
    ),
    width: z.number(),
    height: z.number(),
    ms: z.number(),
    prompt: z.string(),
    status: z.literal("LIVE"),
    diagnostics: z.array(z.string()).optional(),
  }),
  errors,
  http: { method: "POST" },
  readOnly: true,
  maxBodyBytes: Math.ceil((SAM_MAX_IMAGE_BYTES * 4) / 3) + 16 * 1024,
  // Images are sent by the live-footage UI; the agent has no frame bytes to pass.
  agentTool: false,
  mcpTool: false,
  timeoutMs: 30_000,
  run: async ({ imageBase64, width, height, boxes }, ctx) =>
    samOutline({ imageBase64, width, height, boxes }, process.env, { client: ctx?.userEmail ?? "anonymous" }),
});
