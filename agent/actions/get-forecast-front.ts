import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { z } from "zod";

import { fireInput, getForecastFront, parseUtc, tInput } from "../server/fire/actions-support.js";

const errors = defineActionErrors("no_forecast", "data_missing", "bad_argument");

const lonLat = z.array(z.number());
const polygon = z.union([
  z.object({ type: z.literal("Polygon"), coordinates: z.array(z.array(lonLat)) }),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(z.array(z.array(lonLat))) }),
]);

export default defineAction({
  description:
    "The saved +1 h fire-spread forecast issued at the top of the hour at or before t (Muse Spark; the physics forecast from the same file when Muse's reply for that hour was rejected, and `method` says which). " +
    "Returns {forecastFor (valid time, issue + 1 h), issuedAt, method, polygon (whole expected burned footprint at forecastFor), front (MultiLineString of the advancing edge), frontKm, frontPieces (stretches >= 0.2 km, longest first, each with maxAdvanceM = how far it runs past the burned edge and headLonLat = its farthest point), status: \"saved\", source, note}. " +
    "front is derived, not stored: the part of the forecast polygon's edge more than ~30 m (2 arrival-raster cells) from ground already burned at issuedAt in arrival.png, i.e. where the forecaster expects the fire to move. " +
    "Use it to place drone watch points on the front. Fails with no_forecast (listing the nearest forecast hours) when that hour has no forecast.",
  schema: z.object({
    fire: fireInput,
    t: tInput,
  }),
  outputSchema: z.object({
    fire: z.enum(["eaton", "palisades"]),
    asked: z.string(),
    forecastFor: z.string(),
    issuedAt: z.string(),
    method: z.enum(["muse", "physics"]),
    polygon,
    front: z.object({ type: z.literal("MultiLineString"), coordinates: z.array(z.array(lonLat)) }),
    frontKm: z.number(),
    frontPieces: z.array(
      z.object({ km: z.number(), maxAdvanceM: z.number(), headLonLat: z.tuple([z.number(), z.number()]) }),
    ),
    status: z.literal("saved"),
    source: z.string(),
    note: z.string(),
  }),
  errors,
  http: { method: "GET" },
  readOnly: true,
  run: async ({ fire, t }) => getForecastFront(fire, parseUtc(t)),
});
