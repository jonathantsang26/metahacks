# Sentinel Ember

**Live wildfire intelligence from AI-piloted drones, for quicker wildfire suppression.**

In the Palisades Fire, the first public fire map came 26 hours after the fire started. By then about half the fire had already burned (11,543 of 23,449 acres). Firefighters were working from old information.

Sentinel Ember is built to close that gap. Fly a drone over a fire, and it tells firefighters two things:

- **Where the fire is right now.** Each video frame is checked for flames in the browser, outlined, and placed on a 3D map of the real hills.
- **Where it will be in an hour.** A forecaster draws where the fire's front is likely to be one hour later, and a team of AI agents sends drones to watch that edge.

![Eaton Fire replay at Jan 8, 15:30 PST: the fire's spread and burn scar on 3D terrain, the mapped perimeter, the start-location estimate, and the timeline, charts and key events](docs/img/eaton-replay.jpg)

Built by Jonathan, Dhilen and Ben (CS, UC Berkeley) for the **Meta Global AI Developer Hackathon** (2026). The fires covered are the January 2025 **Eaton** and **Palisades** fires in Los Angeles County.

## How it works

1. **Find the flames.** Our fine-tuned YOLOv8 fire detector runs in the browser (ONNX model, WebAssembly). It draws a box around each flame in a frame in about 0.15 s on one CPU thread.
2. **Trace each fire.** Meta's **SAM 3.1** turns each fire into a mask from the one-word prompt "fire". No training needed.
3. **Put it on the map.** Given the drone's position and camera angle (a DJI `.SRT` telemetry track, or typed in), each detection is projected onto a 3D digital twin of the area: real terrain from elevation data and real wind from the HRRR weather model.
<!-- MASKMAP -->
4. **Forecast the next hour.** A **Muse Spark** forecaster looks at the fire's edge, the wind and the slope, and estimates where the front will be in an hour.
5. **Send the drones.** A Muse Spark commander and three Muse Spark squad agents give six simulated drones waypoints to watch that advancing edge. The drones fly in a MuJoCo physics simulation over the real Eaton Fire terrain, with thrust, wind drag, gust limits, batteries, camera coverage and line of sight. The same simulation is also wrapped as a Gymnasium environment for reinforcement learning.

Every agent in the swarm (forecaster, commander and squads) runs on `muse-spark-1.3`.

## Live, cached and simulated

Not everything here runs live. This table says which part is which.

| Part | Status | What that means |
|---|---|---|
| Fire detector (Drones tab → Live) | **LIVE** | The fine-tuned model runs in your browser on a camera, a shared screen or a video URL. Median 154 ms, p90 172 ms per 1280×720 frame on one WASM thread in headless Chrome on a cloud CPU ([`detector-latency.json`](web/bench/detector-latency.json), `npm run bench:detector`). Not yet measured on a laptop. No key needed. |
| SAM 3.1 outlines (Drones tab → Live) | **LIVE** | While the detector sees fire, a frame goes to `POST /api/sam` at most every 2 s, prompt "fire". Needs `MODEL_API_KEY` on the server. |
| Detections on the 3D map | **LIVE** | Needs a drone pose: a DJI `.SRT` track or one typed in. Tested only with synthetic and typed-in poses. Never run on a real drone feed. |
| Analyst (Analyst tab) | **LIVE** | Answers questions about the fire with Muse Spark tool calls through `POST /api/analyst`. Needs `MODEL_API_KEY`. |
| Bundled drone clips | **CACHED** | Two public-domain BLM wildfire clips from Oregon. Their detector boxes and SAM 3.1 masks (real SAM 3.1 output, prompt "fire") were computed once and saved. They are not Eaton footage and have no telemetry, so they do not land on the map. |
| +1 h spread forecast | **CACHED** | Muse Spark made every forecast in one live run (67 calls, 23 replies rejected as malformed). The app shows the saved polygons. Made in hindsight for Eaton. |
| Drone swarm (Swarm tab) | **SIMULATED** | No drones flew this fire. The commander, squad and forecaster decisions were real Muse Spark calls during simulation runs; the app replays the saved logs. |
| Fire reconstruction (arrival times, start estimate, homes, debris flows) | **PRECOMPUTED** | Built from public records by the pipeline and saved. Arrival times between mapped perimeters are interpolated and labelled MODELED. |

The app labels these the same way (SIM, FORECAST, MODELED), and its Evidence tab lists every data source.

## Quick start

Needs Node 20.19+ (`web/.nvmrc`). No key is needed for most of the app.

```bash
cd web && npm ci && npm run dev
```

Then open:

| URL | What you see |
|---|---|
| http://localhost:5173/?fire=eaton&t=2025-01-08T23:30:00Z | The Eaton Fire on 3D terrain. Drag the timeline at the bottom. The **Spread Forecast (+1 h)** layer is under Layers. |
| http://localhost:5173/?fire=eaton&tab=drones | The Drones tab: the bundled clips with their cached boxes and outlines. Switch to **Live** to run the detector on your camera, a shared screen or a video URL (another site's video must allow CORS). Enter a pose or load a `.SRT` file to place hits on the map. |
| http://localhost:5173/?fire=eaton | Right-hand rail → **Swarm**: the simulated drone swarm and a graph of each agent's decisions. |
| http://localhost:5173/?fire=eaton&tab=risk | Post-fire debris-flow likelihood on each stream segment ([screenshot](docs/img/eaton-risk.jpg)). |
| http://localhost:5173/?fire=palisades | The Palisades Fire. |

**What needs `MODEL_API_KEY`:** live SAM 3.1 outlines and the Analyst tab. Copy [`.env.example`](.env.example) to `.env` at the repo root and set `MODEL_API_KEY`. The server also enforces a spend cap: it needs the Upstash store variables in `.env.example`, or `ANALYST_BUDGET_LOCAL=1` for a local run. Without a key, those two features say so and do nothing; everything else works.

## Built at the hackathon vs prior work

- **Prior work:** before the hackathon, Ben built [Sentinel](https://github.com/benjaminxie1/sentinel-app), an open-source fire-detection app. We started from its model file: a stock YOLOv8n trained on COCO, which has no fire class.
- **Built at the hackathon:** everything else.
  - Training the fire detector on FireNET ([`s12a_sentinel_train.py`](pipeline/steps/s12a_sentinel_train.py), output [`sentinel_fire.pt`](pipeline/models/sentinel_fire.pt)), exporting it to ONNX and running it in the browser.
  - SAM 3.1 outlines, live and on the clips, and placing detections on the 3D map.
  - The Muse Spark forecaster, the Muse Spark swarm and the MuJoCo simulation.
  - The Muse Spark analyst, the data pipeline and the web app.
- **Design inspiration:** the layout is inspired by Dilum Sanjaya's "FireTrace" wildfire-analysis concept, shared on X. Its name and logo are not used.

## Meta models used

| Model | What it does here | Status |
|---|---|---|
| `sam-3.1` (Meta Model API) | Traces fire masks in drone video from the text prompt "fire" | LIVE in the Drones tab ([`api/sam.ts`](web/api/sam.ts)); CACHED on the bundled clips ([`s12c_sam_video.py`](pipeline/steps/s12c_sam_video.py)). Frame-level check on DeepQuest images: precision 1.00, recall 0.945 ([`sam_video.json`](web/public/data/eaton/eval/sam_video.json)) |
| `muse-spark-1.3` | +1 h spread forecaster (one `forecast_spread` tool call) | CACHED from one live run: 67 calls, 23 rejected ([FORECAST.md](docs/FORECAST.md)) |
| `muse-spark-1.3` | Swarm commander (`task_squads`) and three squads (`set_waypoints`) | SIMULATED drones, real model calls, replayed in the app ([SWARM.md](docs/SWARM.md)) |
| `muse-spark-1.3` | The analyst: answers questions with read-only tool calls over the fire data, and must cite a tool result | LIVE. Latest eval: 17 of 17 Eaton and 16 of 16 Palisades answers right ([RESULTS.md](docs/RESULTS.md#analyst-eval)) |

## What we found

**The detector.** On DeepQuest frames the fine-tuned detector has precision 0.73 and recall 0.64. It misses frames that show only smoke.

**The forecast.** Against the real official maps, the forecasts catch much of the new burned ground but draw far too much. Neither physics nor Muse Spark beat simply carrying each part of the edge forward at its recent rate. Muse Spark caught 33% of the next hour's new ground against our modeled map, physics 71% and that simple rule 82%. Details in [FORECAST.md](docs/FORECAST.md).

**The swarm.** The Muse Spark swarm did not beat the simple rule-based policies. Over 12 hours of the Eaton Fire (simulated, 3 seeds), its drones saw 13.6% of the fire front within an hour of it arriving. A greedy rule saw 14.0%, and a lawnmower sweep 15.2%. Six drones with realistic cameras see only a small part of a big fire, whoever flies them. A rule that just watches the edge of the latest official map did best (21.1%).

The one run with the Muse Spark forecaster feeding the swarm (1 seed) saw 20.6%. It was a rough run: an API outage from 03:15 to 04:30Z left the drones on their previous plans, 11 of its 39 forecasts failed or were rejected, and it stopped at its $3.50 spend cap at 09:45Z after 39 of 48 decisions ($3.46 spent). No trained reinforcement-learning policy ran; the Gymnasium environment is there for training. Details in [SWARM.md](docs/SWARM.md).

**Wind grounds drones when the fire grows fastest.** Using the HRRR gusts and a real drone's 12 m/s wind rating (DJI Matrice 4TD), no part of the Eaton area was flyable from 6 PM Jan 7 to 6 AM Jan 8 PST, the first night. The simulation grounds or recalls any drone when the gust at its height passes 12 m/s, and the swarm comparison starts on the afternoon of Jan 8.

## The fire reconstruction

Underneath the drones is a reconstruction of the Eaton and Palisades fires from public records: NIFC perimeters, HRRR weather, CAL FIRE's damage inspections (DINS: 9,419 structures destroyed in Eaton, 6,845 in Palisades), USGS debris-flow data and NASA JPL's AVIRIS-3 burn severity. It answers four questions:

- **When did the fire reach each place?** Hover the map for the arrival time of any burned spot, interpolated between mapped perimeters ([method](docs/METHODS.md#arrival-time)).
- **Where and when did it start?** A spread model run backwards from the perimeters gives a location with a calibrated 90% radius ([method](docs/METHODS.md#inversion)). A start time is shown only when the data pin it to within 6 h. For both fires they don't, so it is withheld.
- **Which homes survived?** Destruction odds by construction feature, compared at the same exposure ([method](docs/METHODS.md#house-level-exposure)). Addresses are never shown.
- **Where could debris flows follow?** The Risk tab shows the chance of a debris flow on each stream segment under USGS's design storms, from USGS's model and two models fitted on USGS's observed debris-flow inventory.

### Evidence

The table is generated by `make report` from the committed eval files, and a test fails if it drifts. Full tables are in [`docs/RESULTS.md`](docs/RESULTS.md).

<!-- headline:start (generated by make report; do not edit) -->
| | Eaton Fire | Palisades Fire |
|---|---|---|
| Synthetic fires, location error (median): back-trace vs first-footprint centroid | 588 m vs 449 m | 526 m vs 1,624 m |
| Synthetic fires, start-time error (median): back-trace vs √area back-extrapolation | 78 min vs 21.6 h | 4.6 h vs 37.0 h |
| The same with the first two perimeters held out: location; start time | 924 m vs 1,406 m; 3.1 h vs 52.2 h | 786 m vs 1,744 m; 16.4 h vs 109.7 h |
| 90% radius / interval contains the truth, on synthetic cases the calibration never saw (95% CI) | 87% (62–96%) / 93% (70–99%); radius 1,717 m, interval 10.31 h | 100% (80–100%) / 100% (80–100%); radius 1,681 m, interval 43.25 h; the real fit's k (76.8) lies above every synthetic truth (max 3.6) |
| Unseen synthetic cases where the app would show a start time | 0 of 15 | 0 of 15 |
| Real fire: estimated start time | withheld (not identifiable) | withheld (not identifiable) |
| Real hold-out: distance to CAL FIRE's reported point (baseline: first-footprint centroid) | 2,504 m (2,460 m) | 315 m (3,557 m); the hold-out fit predicts neither held-out perimeter, so this is not a result |
| Real hold-out: start-time error vs CAL FIRE (baseline) | 2.3 h (-30.9 h); withheld as not identifiable | 40.0 h (-707.9 h); the estimate is later than the held-out perimeters, so not a credible start, and withheld as not identifiable |
| CAL FIRE's reported point, distance outside the first mapped footprint | 1,772 m | 0 m |
| Real fit with the HRRR wind field vs the old single ERA5 point (footprint IoU, spread-rate scale k) | IoU 0.45, k 0.424 vs IoU 0.30, k 11.314 | IoU 0.38, k 76.8 (ceiling) vs IoU 0.40, k 76.8 (ceiling) |
| Hourly wind vs the nearest airport station: HRRR vs ERA5 | r 0.90 vs 0.71 | r 0.85 vs 0.75 |
| Odds ratio of destruction, fine-mesh vents vs coarse (95% CI) | 0.35 (0.31–0.40) | 0.50 (0.45–0.56) |
| Odds ratio, tile/metal/concrete roof vs asphalt/wood | 0.59 (0.53–0.66) | 0.58 (0.53–0.64) |
| Analyst live on `muse-spark-1.3`: answers matching the data-derived truth; cited ids a tool returned | 17/17; 23/23 | 16/16; 20/20 |
<!-- headline:end -->

How to read it:
- **Synthetic rows** test fires where the true start is known and the simulated fire's physics differ on purpose from the model's ([benchmark](docs/METHODS.md#synthetic-benchmark)).
- **Real-fire rows** compare with CAL FIRE's *reported* start, which is not an investigated origin. For Eaton the reported point lies outside the first mapped perimeters, which the search can't reach.
- **Odds ratios** are associations, not effects of the features.

What it shows:
- **The start time is where the back-trace beats the simple baseline.** On synthetic fires it is closer in 93% (Eaton) and 83% (Palisades) of cases.
- **Location is mixed.** For Eaton the centre of the first mapped footprint is closer on the median; the back-trace wins when early perimeters are held out, and for Palisades.
- **No start time is shown.** The intervals are wider than 6 h for both real fires.
- **Palisades is beyond the model.** Without ember spotting, the model can't grow that fire as fast as it burned.

### Post-fire debris flows

The Risk tab covers USGS's stream segments (956 for Eaton, 1,864 for Palisades) under seven design storms, from three models:
- **USGS M1 (published):** USGS's hazard assessments for these fires ([doi:10.5066/P14EWYME](https://doi.org/10.5066/P14EWYME)). Our code reproduces its likelihoods to within 5×10⁻¹⁶.
- **M1 recalibrated** on USGS's observed debris-flow inventory ([Graber et al. 2026](https://doi.org/10.5066/P1R9VXC4): 7,639 records from 77 fires).
- **Random forest** on the same inventory, with watershed area, days since the fire and soil moisture added.

Each trained model is scored on fires it never saw ([`model_eval.json`](web/public/data/debris_flow/model_eval.json)):

| Model | ROC AUC, all records | ROC AUC within one fire and storm (median, 95% interval) | Station Fire (2009), held out |
|---|---|---|---|
| USGS M1, published (scored on the 6,319 records it was not fitted on) | 0.881 | 0.809 [0.700, 0.932] (64 storms) | n/a (fitted on it) |
| M1 recalibrated | 0.828 | 0.750 [0.667, 0.800] | 0.825 |
| Random forest, monotone in rainfall | 0.815 | 0.800 [0.688, 0.864] | 0.704 |
| MLP (evaluated, not mapped) | 0.841 | 0.808 [0.700, 0.850] | 0.746 |
| MLP plus neighbouring watersheds (evaluated, not mapped) | 0.848 | 0.750 [0.656, 0.864] | 0.776 |

- **Machine learning did not clearly beat USGS's M1** at ranking watersheds within one storm. Every difference's 95% interval includes zero.
- **USGS's published likelihoods run high on newer records** (mean 0.363 where 9.8% had a debris flow). The recalibrated model keeps USGS's ranking at a much lower level.
- **Nothing here is validated for 2025.** The inventory has no Eaton or Palisades outcomes yet, so the maps are compared with USGS's assessment, not with what happened.

## Limitations

- **Drones:** the detector and SAM 3.1 have run on cameras, screens and video streams, never on a real live drone feed. Map placement has run only with synthetic and typed-in poses. The detector misses smoke-only frames.
- **Speed:** detector timing is from a cloud CPU, not a field laptop. SAM 3.1 needs an internet connection and runs at most once every 2 s.
- **Swarm:** simulated drones as point masses, with HRRR wind at 3 km. It covers Eaton only. The Muse Spark swarm did not beat the rule-based policies, and the forecaster + swarm run is one seed that hit its spend cap.
- **Forecast:** made in hindsight for Eaton, with the HRRR analysis standing in for a weather forecast. It overshoots, and it does not beat carrying the recent rate forward.
- **Reconstruction:** the spread model has no spotting, crown fire or firefighting. HRRR is a model, not observations. CAL FIRE's reported start is not an investigated origin, and the project never guesses a cause. House-level results are associations. Calibration rests on 15 unseen synthetic cases per fire. AVIRIS-3 burn severity covers about half of Eaton and a sliver of Palisades.
- **App:** checked in desktop Chromium only; it needs WebGL2.

## Reproduce

Needs Python 3.11+ with [uv](https://docs.astral.sh/uv/) and Node 20.19+. After `uv sync` and `npm ci`, everything below runs offline on the committed outputs, except `make debris`, which downloads USGS and ERA5-Land data on its first run.

```bash
cd pipeline && uv sync
make test                                        # pipeline tests, including the README headline drift check
make eval EVAL_DIR=/tmp/ember-eval               # re-run both real hold-outs (Eaton 5-15 min, Palisades about 12 min)
make eval QUICK=1 EVAL_DIR=/tmp/ember-eval-quick # recompute 2 synthetic cases per fire (about 8 min per fire)
make report                                      # regenerate docs/RESULTS.md and the README headline table
make debris                                      # debris-flow models and maps (needs network)

uv sync --extra sim
uv run --extra sim pytest -q tests/test_sim.py tests/test_forecast.py   # swarm and forecast tests
uv run --extra sim python -m sim.run --policy greedy --seeds 0 1 2      # a rule-based swarm run (no key)
uv run --extra sim python -m sim.run --summary                          # the swarm results table

cd ../web && npm ci
npm test                                         # web and API tests (no key needed)
npm run build                                    # typecheck and production build
npm run bench:detector                           # detector latency in headless Chrome
```

With network access, `make all` rebuilds every output from the public sources (`make FIRE=palisades all` for Palisades); see [`docs/reproduction/`](docs/reproduction). The Muse Spark swarm and forecast commands, which need `MODEL_API_KEY`, are in [SWARM.md](docs/SWARM.md#reproduce) and [FORECAST.md](docs/FORECAST.md#run-it). With a key, `npm run ask -- "When did the fire reach Lake Avenue?"` asks the analyst one question and `npm run eval:analyst` scores it.

## Docs

- [`docs/SWARM.md`](docs/SWARM.md): the drone-swarm simulation and its results
- [`docs/FORECAST.md`](docs/FORECAST.md): the +1 h spread forecaster and how it is scored
- [`docs/METHODS.md`](docs/METHODS.md): how the reconstruction works: arrival time, wind, spread model, back-trace, homes, analyst, web app
- [`docs/RESULTS.md`](docs/RESULTS.md): every evaluation number, generated from the committed outputs
- [`docs/risk-model.md`](docs/risk-model.md): a prototype per-area fire-risk model (not in the app)
- [`docs/spec/BUILD.md`](docs/spec/BUILD.md), [`docs/spec/DESIGN.md`](docs/spec/DESIGN.md), [`docs/spec/WORKSTREAMS.md`](docs/spec/WORKSTREAMS.md): architecture, UI and team workstreams
- Data sources and licences: each fire's `manifest.json` and the app's Evidence tab; details in [`docs/spec/BUILD.md`](docs/spec/BUILD.md) §5
