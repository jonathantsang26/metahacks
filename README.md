# Sentinel Ember

**A forensic replay of a real wildfire, rebuilt from public evidence.** It shows minute by minute how the fire spread, estimates where and when it started, and asks which homes survived and under what conditions. Every claim links back to its source.

Built for the **Meta Global AI Developer Hackathon** (2026).

> **Status: planning.** This repo currently holds the design and build spec. Code lands over the hackathon week. Nothing below is claimed as working until it shows up in the code with its evaluation numbers.

## What it does

- **Replays a real fire in 3D and 2D.** The default is the January 2025 Eaton Fire. Terrain, fire progression, weather and burn severity all come from public data (USGS, NIFC, NASA FIRMS, Open-Meteo, gridMET, CAL FIRE). Scrubbing the timeline burns the terrain in sync with the charts.
- **Estimates where and when the fire started.** A slope- and wind-aware spread model is back-traced against the observed fire, and scored on held-out early observations.
- **Looks house by house.** CAL FIRE's damage inspections are joined with each structure's fire exposure, to compare outcomes across construction features. This is association, not causation, and no addresses are shown.
- **Answers questions with citations.** A Muse Spark analyst queries the reconstructed fire through tools, and every sentence links to the layer and moment it came from.
- **Reads drone footage.** A YOLOv8 fire/smoke detector finds fire in frames, and SAM 3.1 segments it, measured on a labelled drone-fire dataset.

## Meta models used

| Model | Via | Role |
|---|---|---|
| `sam-3.1` | Meta Model API | Text-prompted segmentation and tracking of fire, smoke and burned vegetation in drone video; destroyed-building masks in post-fire imagery |
| `muse-spark-1.3` | Meta Model API (OpenAI-compatible) | Analyst agent: tool calls over the reconstructed fire, cited answers, incident report |

## Prior work and credits

- **Sentinel** ([`benjaminxie1/sentinel-app`](https://github.com/benjaminxie1/sentinel-app)) is a team member's earlier open-source fire/smoke detector. Its trained YOLOv8 model is used here as a dependency. Everything else is built during the hackathon.
- **Design inspiration**: the layout and interaction model are inspired by Dilum Sanjaya's "FireTrace" wildfire-analysis concept, shared on X. Its name and logo are not used.
- **Data**: every source is listed in [`docs/spec/BUILD.md`](docs/spec/BUILD.md) §5 and, once built, in the app's Evidence tab. Anything simulated is labelled `SIM` in the UI.

## Docs

- [`docs/spec/BUILD.md`](docs/spec/BUILD.md): architecture, data pipeline, models, evaluation plan, schedule
- [`docs/spec/DESIGN.md`](docs/spec/DESIGN.md): UI specification
