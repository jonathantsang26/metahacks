# What changed: prior work vs this hackathon

This file is for Builder.io's Agent-Native Hackathon (started Oct 27 2026, closes Nov 9 2026, 11:59 PM PT).
The rules ask every entry to "identify pre-existing work, templates, libraries, third-party assets, and
what changed during the event." This is that list.

Short version:

- **Before Oct 27 2026:** Ben's open-source fire-detection app, Sentinel. We used only its model file.
- **Oct 30 to Nov 4 2026 (Meta hackathon):** the team built Sentinel Ember: the web app in `web/`, the data
  pipeline in `pipeline/`, the fire detector, the Muse Spark forecaster, swarm and analyst, and the MuJoCo
  drone simulation. That was a separate hackathon, so we count all of it as **prior work** for this entry.
- **From Nov 6 2026 (this hackathon):** a new Agent-Native app in `agent/` where a person and an agent plan
  the next hour of drone coverage on the same plan, through the same actions. See section C.

Paths below are from the repo root (`jonathantsang26/metahacks`).

---

## A. What already existed

### A1. Before this hackathon: Sentinel (Ben)

| What | Where | What we used |
| --- | --- | --- |
| Sentinel, Ben's open-source fire-detection app | https://github.com/benjaminxie1/sentinel-app | Only its model file: a stock YOLOv8n trained on COCO, which has no fire class. It was the starting point for our fire detector. |

### A2. Meta hackathon build, Oct 30 to Nov 4 2026 (Sentinel Ember)

The repo was created on Oct 30 2026 (first commit 04:35 UTC), after this hackathon began, but all of this was
built for the Meta Global AI Developer Hackathon. We list it here as prior work so nobody mistakes it for
work done for this entry.

**Web app** (`web/`, React 18 + deck.gl + Vite)

| Feature | Where |
| --- | --- |
| 3D map of the real terrain with the fire's spread, burn scar, perimeters, start-location estimate, wind, roads, homes and labels | `web/src/stage/` |
| Timeline you can drag through the fire, with charts and key events | `web/src/dock/` |
| Right-hand rail: overview, weather, homes, start location, analysis, risk, swarm, analyst | `web/src/rail/` |
| Spread Forecast (+1 h) layer showing the cached Muse Spark forecasts | `web/src/stage/forecast-layer.ts`, `web/src/stage/forecast.ts` |
| Drones tab: bundled clips with cached detector boxes and SAM 3.1 masks; Live mode runs the detector on a camera, shared screen or video URL; detections placed on the map from a DJI `.SRT` track or a typed-in pose | `web/src/drones/`, `web/src/lib/dji-srt.ts`, `web/src/lib/dronegeo.ts`, `web/src/stage/live-layer.ts` |
| Swarm view: replays the saved simulation logs and a graph of each agent's decisions | `web/src/rail/swarm.tsx`, `web/src/stage/swarm-layer.ts`, `web/src/swarm/` |
| Risk tab: post-fire debris-flow likelihood per stream segment | `web/src/rail/risk.tsx`, `web/src/stage/debris-layer.ts`, `web/src/dock/risk.tsx` |
| Evidence tab listing every data source with a REAL / MODELED / SIM status | each fire's `manifest.json` |
| Server routes: `POST /api/sam` (SAM 3.1 with spend caps) and `POST /api/analyst` (Muse Spark analyst with read-only tools and a citation check) | `web/api/sam.ts`, `web/api/analyst.ts`, `web/api/_lib/` (`tools.ts`, `verify.ts`, `data.ts`, `budget.ts`, `ratelimit.ts`) |

**Pipeline** (`pipeline/`, Python)

| Part | Where |
| --- | --- |
| Data steps: area, terrain, land cover, hot spots, perimeters, arrival times, weather, burn severity, vectors, home exposure, events, start-location back-trace, footage, debris-flow models | `pipeline/steps/s01_aoi.py` to `s17_risk_model.py` |
| Fire-spread and back-trace model | `pipeline/ember/` |
| Outputs the app reads | `web/public/data/<fire>/` (Eaton and Palisades) |

**Models and AI**

| Part | What it does | Status in the Meta build | Where |
| --- | --- | --- | --- |
| Fire detector | YOLOv8n fine-tuned on FireNET, exported to ONNX, runs in the browser (onnxruntime-web, WebAssembly) | LIVE | `pipeline/steps/s12a_sentinel_train.py`, `pipeline/models/sentinel_fire.pt`, `web/public/models/` |
| SAM 3.1 (Meta Model API `sam-3.1`) | Traces a fire mask from the one-word prompt "fire" | LIVE in the Drones tab; CACHED on the bundled clips | `web/api/sam.ts`, `pipeline/steps/s12c_sam_video.py` |
| Muse Spark forecaster (`muse-spark-1.3`) | Draws where the fire's front will be in one hour | CACHED from one live run (67 calls, 23 replies rejected). Did not beat simply carrying the recent spread rate forward. | `pipeline/sim/forecast.py`, `web/public/data/eaton/forecast/`, `docs/FORECAST.md` |
| Muse Spark swarm (`muse-spark-1.3`) | A commander and three squad agents give six simulated drones waypoints | SIMULATED. Real model calls, drones simulated. Did not beat simple rule-based policies. | `pipeline/sim/muse.py`, `pipeline/sim/policies.py`, `docs/SWARM.md` |
| Muse Spark analyst (`muse-spark-1.3`) | Answers questions about the fire with read-only tool calls and must cite a tool result | LIVE | `web/api/analyst.ts`, `web/api/_lib/tools.ts`, `web/api/_lib/verify.ts` |
| MuJoCo drone simulation (also a Gymnasium environment) | Six simulated drones over the real Eaton terrain, with thrust, wind drag, gust limits, batteries, camera coverage and line of sight | SIMULATED | `pipeline/sim/env.py`, `pipeline/sim/world.py`, `pipeline/sim/run.py` |

---

## B. Templates, libraries and third-party assets

### B1. Agent-Native

| What | Version | How we use it |
| --- | --- | --- |
| Agent-Native core (`@agent-native/core`) and the **Chat** template | 0.225.1 (`agent/package.json` → `agent-native.scaffold`: template `chat`, `templateRef @agent-native/core@0.225.1`, bundled) | The app shell, agent sidebar, actions (`defineAction`), application state, database plumbing, settings and auth screens all come from the template. |
| `@agent-native/agentkit`, `@agent-native/toolkit` | 0.225.1 | Installed with the template. |
| `@agent-native/otel` | 0.1.34 | Installed with the template. |

### B2. Libraries (main ones)

| Library | Version (from `agent/package.json`) | Used for |
| --- | --- | --- |
| React, React DOM | ^19.2.7 | UI |
| React Router | 8.1.0 | Routes |
| deck.gl (`@deck.gl/*`), luma.gl | ^9.4.1, ^9.4.2 | 3D fire map and drone plan layers |
| onnxruntime-web | 1.30.0 | Fire detector in the browser (from the Meta build) |
| Drizzle ORM | ^0.45.3 | Database tables for plans and briefings |
| PGlite (`@electric-sql/pglite`) | ^0.5.8 | Local Postgres for development |
| zod | ^4.4.3 | Action input schemas |
| zustand | ^5.0.15 | UI state |
| Tailwind CSS | ^4.2.4 | Styles |
| Vite | 8.1.0 | Build |
| AI SDK (`ai`, `@ai-sdk/anthropic` and others) | 6.0.258 | Agent model calls (installed with the template) |
| openai (client) | ^7.53.0 | Calls to the Meta Model API, which is OpenAI-compatible |

The Meta build also used Vite 6, React 18, zustand 4 and Tailwind 3 (`web/package.json`), and in the pipeline
numpy, rasterio, shapely, scikit-learn, the openai client, Ultralytics (training only), MuJoCo and Gymnasium
(`pipeline/pyproject.toml`).

### B3. Models and APIs

| Model or API | Used for | Live in this app? |
| --- | --- | --- |
| Meta Model API `muse-spark-1.3` | Made the +1 h forecasts the plan is built on (in the Meta build) | No. The forecasts are **cached**. |
| Meta Model API `sam-3.1` | Fire outlines from video (`sam-outline` action, ported from the Meta build) | Live only when used, needs `MODEL_API_KEY` |
| LLM that runs the agent | Plans, edits, briefings, answers in the agent sidebar | **Claude via Anthropic API (pending)**: the team is still deciding |

### B4. Data sets (all public; from each fire's `manifest.json` and the README)

| Data | Source |
| --- | --- |
| Fire perimeters over time | NIFC Operational Data Archive 2025 |
| Final perimeter, official acres, official start | CAL FIRE 2025 California Fire Perimeters; CAL FIRE incidents API |
| Damaged and destroyed buildings | CAL FIRE DINS (damage inspection). Addresses are never shown. |
| Hourly wind and weather | NOAA HRRR (3 km) via the Open-Meteo historical forecast archive (CC BY 4.0); ERA5 kept for comparison |
| Weather station | Iowa Environmental Mesonet ASOS (Burbank) |
| Daily fire danger | gridMET (Abatzoglou 2013) |
| Terrain | AWS Terrain Tiles (elevation from USGS 3DEP, SRTM and others) |
| Land cover | ESA WorldCover 2021 v200 (CC BY 4.0) |
| Burn severity | NASA JPL AVIRIS-3 provisional dNBR |
| Roads, peaks, places | OpenStreetMap via Overpass (ODbL) |
| Debris flows | USGS post-wildfire debris-flow hazard assessments (doi:10.5066/P14EWYME, CC0) and USGS debris-flow inventory (Graber et al. 2026, doi:10.5066/P1R9VXC4, CC0) |
| Detector training images | FireNET |
| Detector and SAM checks | DeepQuest images |
| Bundled drone clips | Two BLM Oregon & Washington wildfire clips via Wikimedia Commons, public domain. Not Eaton footage. |

### B5. Design inspiration

The map layout follows Dilum Sanjaya's "FireTrace" wildfire-analysis concept, shared on X. We do not use its
name or logo.

---

## C. Built or changed for this hackathon (from Nov 6 2026)

A living list. Each line is keyed to `agent/docs/CONTRACTS.md`. **planned** means not yet confirmed shipped
by the lead. **in repo** means it is in commit `63e79d0` on branch `agent-native/rebuild`.

### C1. Setup and porting

| Item | Status |
| --- | --- |
| New Agent-Native app in `agent/` from the Chat template (core 0.225.1) | in repo |
| `agent/scripts/sync-fire-data.mjs`: copies the Meta build's fire data and detector model into `agent/public/` (no second copy in git) | in repo |
| `agent/server/fire/`: the Meta build's server code (`web/api/_lib`) ported so actions can reuse it: data store, tools, citation checker, SAM and spend caps | in repo |
| `agent/docs/CONTRACTS.md`: shared build plan (product loop, actions, tables, honesty labels) | in repo |
| `/incident` as the home screen, with the agent sidebar | planned |

### C2. Actions (the agent and the UI call the same ones)

| Action | Plain words | Status |
| --- | --- | --- |
| `place-lookup`, `arrival-at`, `street-fire-timeline`, `fire-state-at`, `weather-at`, `fire-events`, `structures-near`, `ignition-summary`, `exposure-stats` | The Meta analyst's read-only tools, now actions with sources the agent can cite | planned |
| `get-forecast-front` | Gets the cached +1 h forecast and the edge the fire is expected to push into | planned |
| `set-time`, `set-fire`, `set-tab`, `set-layers`, `fly-to` | Let the agent move the map and timeline for you | planned |
| `sam-outline` | SAM 3.1 fire outline, ported with its spend caps | planned |
| `get-drone-plan`, `create-drone-plan` | Read or make a plan of up to six drones (D1 to D6) for one hour; locked drones are kept | planned |
| `update-drone-assignment` | Move, resize, lock or remove one drone (dragging on the map uses this too) | planned |
| `score-plan` | Simple geometry: how much of the forecast edge the drones can see, homes near the edge, homes watched, drones grounded by wind | planned |
| `save-briefing`, `edit-briefing-paragraph` | Agent writes the crew briefing with a source for each paragraph; the server re-runs each source and drops paragraphs whose numbers don't match; the person can edit a paragraph | planned |
| `approve-plan` | Locks the plan and moves the replay to the next hour | planned |
| `hindsight-check` | After the fact: how much of the real next-hour burn fell inside the drones' view | planned |
| `log-detection`, `list-detections` | Save and list live detector hits | planned |
| `view-screen` | Tells the agent what you see and what you selected | planned |

### C3. Data, UI and agent

| Item | Status |
| --- | --- |
| Database tables `drone_plans`, `drone_assignments`, `briefings`, `detections`, each write marked "agent" or "person" | planned |
| Shared app state: `navigation`, `selection` (so the agent sees the selected drone), `map-command` (so the agent can drive the map) | planned |
| Plan panel: score, drone list, lock and remove, Auto-plan button, Approve | planned |
| Draggable drones and watch circles on the map, front coverage drawn on the edge | planned |
| Briefing panel with sources and inline edits | planned |
| Hindsight card | planned |
| "Start here" numbered guide on first load | planned |
| Briefing check reuses the Meta analyst's citation checker (`server/fire/verify.ts`) | planned |
| Agent instructions (`AGENTS.md`) and a drone-planning skill (`.agents/skills/drone-planning/`) | planned |

### C4. What did not change

The fire data, the cached forecasts, the detector and the swarm results are the Meta build's. We did not
re-run or retune them for this entry. The plan is for a **replay** of the Eaton Fire (Jan 8 2025); no drone
flies, and the score is simple geometry on a cached forecast, not the MuJoCo simulation.
