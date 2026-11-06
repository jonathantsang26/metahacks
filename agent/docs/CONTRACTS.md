# Sentinel Ember on Agent-Native: build contracts

Shared agreements for everyone working in `agent/` at once. Change this file only through the lead.

## The product in one paragraph

The agent has one job: **plan the next hour of drone coverage on a fire, and write the crew briefing.**
The person and the agent edit the same plan through the same actions. The judged flow is one replay hour
of the Eaton Fire: 2025-01-08T16:00Z (8 AM PST). 18Z has every drone grounded by wind; 22-23Z have no accepted Muse forecast. Every step can be done by clicking or by asking the
agent. Honesty labels from the Meta build stay: LIVE, CACHED, SIMULATED, MODELED. The plan is for a replay
of a past fire, no drone flies, and the score is simple geometry, not the MuJoCo sim.

## File ownership (shared checkout: never edit another worker's files)

| Owner | Files |
| --- | --- |
| lead | `package.json`, `pnpm-lock.yaml`, `server/plugins/agent-chat.ts`, `AGENTS.md`, `agent-native.config.ts`, `docs/CONTRACTS.md`, `server/fire/` (ported lib; workers may read, ask lead to change) |
| ui-port | `app/` except `app/plan/`; `server/plugins/agent-native-email-branding.ts` (homePath) |
| data-actions | `actions/` files listed under data-actions below; `server/fire/actions-support.ts` (new helpers) |
| plan-domain | `server/db/`, `server/plugins/db.ts`, `server/plan/`, `actions/` files listed under plan-domain, `actions/view-screen.ts`, `.agents/skills/drone-planning/` |
| plan-ui | `app/plan/` |
| docs | `CHANGES.md` (repo root of agent/), `docs/clips-script.md`, `docs/submission.md` |

Do not run `pnpm add`/`pnpm install`. If you need a dependency, say so in your final report.
Dev servers: use your own port and your own database, e.g.
`DATABASE_URL=pglite:./data/pglite-<you> PORT=<yours> AUTH_DISABLED=true pnpm dev` (ports: ui-port 8101,
data-actions 8102, plan-domain 8103, plan-ui 8104). Stop what you start.

## Data

Static fire data is synced from `../web/public` into `public/data/<fire>/` and `public/models/`
(`pnpm sync-data`, gitignored). Fires: `eaton`, `palisades`. Server code reads them with
`server/fire/data.ts` (`FireStore`, root = `process.cwd()` + `public/data`). Cached +1 h forecasts:
`public/data/<fire>/forecast/<YYYY-MM-DDTHHZ>.geojson`.

## Application state keys

- `navigation` (UI writes on every change): `{view: "incident", fire: "eaton"|"palisades", t: ISO UTC,
  tab: "incident"|"drones"|"risk", planId?: string|null, selectedDroneId?: string|null, visibleLayers: LayerId[]}`.
  URL query params `fire`, `t`, `tab` stay the shareable source of truth (same as the Meta build).
- `selection` (UI writes): `{kind: "drone", planId, droneId, label, lon, lat, capturedAt}` or
  `{kind: "map-point", lon, lat, label, capturedAt}` or null.
- `map-command` (agent actions write with `writeAppStateForCurrentTab`, UI applies then deletes; include a
  unique `_writeId`): one of
  `{kind:"set-time", t}` · `{kind:"set-fire", fire}` · `{kind:"set-tab", tab}` ·
  `{kind:"set-layers", show?: LayerId[], hide?: LayerId[]}` · `{kind:"fly-to", lon, lat, zoom?}` ·
  `{kind:"select-drone", planId, droneId}`.

LayerId (from the Meta build): terrain, burnScar, fireSpread, perimeters, ignition, spine, wind,
structures, roads, labels, debrisFlow, forecast, liveHits, plus new `dronePlan`.

## Actions

All in `actions/<name>.ts`, `defineAction` from `@agent-native/core/action`, zod schema, a clear
`description` written for the agent. Read actions: `readOnly: true`, `http: {method: "GET"}`.
Writes: `http: {method: "POST"}`. Times are ISO UTC strings. Fire is `"eaton" | "palisades"`, default eaton.

### data-actions
Data actions return the Meta tool shape `{result, cites}` (`ToolOutput` in `server/fire/types.ts`), so the
agent can cite them and `save-briefing` can re-run them.

| Action | Input | Notes |
| --- | --- | --- |
| `place-lookup` | `{fire, name}` | port of tool `place_lookup` |
| `arrival-at` | `{fire, lon, lat}` | `arrival_at` |
| `street-fire-timeline` | `{fire, name}` | `street_fire_timeline` |
| `fire-state-at` | `{fire, t}` | `fire_state_at` |
| `weather-at` | `{fire, t}` | `weather_at` |
| `fire-events` | `{fire}` | `events` |
| `structures-near` | `{fire, lon, lat, radiusM?}` | `structures_near` |
| `ignition-summary` | `{fire}` | `ignition_summary` |
| `exposure-stats` | `{fire, feature?}` | `exposure_stats` |
| `get-forecast-front` | `{fire, t}` | nearest cached forecast at or before t: `{forecastFor, issuedAt, polygon, front (LineString/MultiLineString coords of the advancing edge), status:"CACHED", source}` |
| `set-time` / `set-fire` / `set-tab` / `set-layers` / `fly-to` | see map-command | write `map-command`; validate (time inside the fire's window, known layers) |
| `sam-outline` | `{fire, imageBase64}` POST | port of `api/sam.ts`, keep spend caps |

### plan-domain
| Action | Input | Output |
| --- | --- | --- |
| `get-drone-plan` (read) | `{fire, t}` or `{planId}` | `{plan, assignments[], score, briefing}` or `{plan:null}` |
| `create-drone-plan` | `{fire, t, drones:[{droneId, lon, lat, radiusM?, reason}], keepLocked?: true}` | replaces unlocked drones, max 6 drones `D1`..`D6`, returns plan + score |
| `update-drone-assignment` | `{planId, droneId, lon?, lat?, radiusM?, locked?, reason?, remove?}` | upsert/remove one drone, returns new score |
| `flyable-cells` (read) | `{fire, t}` | 24 HRRR wind cells with bbox, gust at 120 m, flyable (<= 12 m/s) |
| `score-plan` (read) | `{planId}` | `{frontKm, coveredKm, frontCoveragePct, groundedCount, homesNearFront, homesWatched, perDrone:[...], label}` |
| `save-briefing` | `{planId, paragraphs:[{text, cites:[{action, args}]}]}` | re-runs each cited data action through `server/fire/tools.ts`, checks numbers with `server/fire/verify.ts`, keeps verified paragraphs, reports dropped ones |
| `edit-briefing-paragraph` | `{briefingId, index, text}` | person's inline edit, marked "edited by person" |
| `approve-plan` | `{planId}` | locks, writes `map-command` set-time t+1h, returns next t |
| `hindsight-check` (read) | `{planId}` | share of the real next-hour burned area (arrival raster) inside drone footprints |
| `log-detection` / `list-detections` | `{fire, t, lon, lat, confidence, source}` / `{fire}` | live detector hits |
| `view-screen` (read, http false) | `{}` | navigation + selection + current plan summary + score |

Every person-made change goes through these same actions (UI) so the agent sees it, and vice versa.

DB tables (Drizzle pg-core in `server/db/schema.ts`): `drone_plans`, `drone_assignments`, `briefings`,
`detections`. Columns are up to plan-domain; record `updated_by: "agent" | "person"` on writes
(use the action run context to tell agent calls from UI calls if the framework exposes it; else an
optional `by` input defaulting to "person").

## UI (ui-port + plan-ui)

- Route `/incident` is home (`app.homePath`). The agent sidebar stays.
- `app/plan/index.ts` exports: `PlanPanel` (score, drone list, lock/remove, Auto-plan button that sends a
  prompt with `sendToAgentChat`, Approve), `BriefingPanel`, `HindsightCard`, `GuideSteps` (a numbered
  "Start here" guide shown on first load), and `usePlanLayers(ctx)` returning deck.gl layers (draggable watch
  points + footprint circles + front coverage) whose edits call `update-drone-assignment`.
- ui-port mounts these: a "Plan" section in the right rail, plan layers in the map stage, the guide overlay.
