# Sentinel Ember

**A forensic reconstruction of a real wildfire from public records.** It shows when the fire reached each street, estimates where and when it started with a stated uncertainty, and compares which homes survived at the same exposure. Every number traces back to a public source or to a committed evaluation file.

Built for the **Meta Global AI Developer Hackathon** (2026). The two fires covered are the January 2025 **Eaton** and **Palisades** fires in Los Angeles County.

## Who it's for, and why now

**The user:** the analyst who has to explain a fire afterwards. That includes after-action review teams, county recovery and rebuild planners, insurance and legal investigators, and journalists. Today they rebuild the timeline by hand, from a dozen agency services that don't line up.

**The problem:** a fire's public record is scattered and sparse.
- **Perimeters** are snapshots taken hours apart, and the first one comes late. Eaton's first mapped perimeter is 4.8 h after the reported start; Palisades' is 26 h after.
- **Wind** comes from a few stations or a coarse reanalysis.
- **Damage inspections** are a separate table of about 30,000 structures across these two fires.

No public tool joins these into one timeline, gives a defensible estimate of where and when the fire started, and compares structure outcomes at equal exposure.

**Why now:** for the January 2025 fires, every input is public and machine-readable:
- NIFC's 2025 operational perimeter archive.
- CAL FIRE's damage inspections (DINS), with construction attributes for each structure.
- NASA JPL's AVIRIS-3 burn-severity flights.
- Hourly ERA5 wind.

On the model side, Meta's Muse Spark (`muse-spark-1.3`) does tool calling over an OpenAI-compatible API. That is what makes a cited analyst practical: every sentence is checked against the data it came from before it is shown.

## What works today

| Part | Status | Code |
|---|---|---|
| Data pipeline: 12 steps that turn 11 public data sources into per-fire files, for Eaton and Palisades | **Working.** Outputs are committed in `web/public/data/<fire>/` | [`pipeline/steps/`](pipeline/steps) |
| Arrival time (when each place burned), area and spread-rate series, key events | **Working** | [`s06_arrival.py`](pipeline/steps/s06_arrival.py), [`s10_events.py`](pipeline/steps/s10_events.py) |
| Ignition back-trace: where and when it started, with calibrated uncertainty | **Working and benchmarked** (see Evidence) | [`ember/spread.py`](pipeline/ember/spread.py), [`s11_ignition.py`](pipeline/steps/s11_ignition.py) |
| House-level exposure: destruction odds by construction feature, at matched exposure | **Working** | [`s09b_exposure.py`](pipeline/steps/s09b_exposure.py) |
| Analyst (`muse-spark-1.3`): tool calls over the fire data, server-side citation checks | **Built, with 60 offline tests. Not yet run against the live API**, which needs `MODEL_API_KEY` | [`web/api/`](web/api) |
| Web app: 3D terrain, timeline, hover inspector, Evidence tab | **Shell working.** The fire layer is still a synthetic pattern labelled `SIM`; stream B is switching it to `arrival.png` | [`web/src/`](web/src) |
| Drone footage: Sentinel YOLOv8 + SAM 3.1 segmentation | **Not started** (stream C). Only the API smoke test exists | [`tools/smoke_meta.py`](pipeline/tools/smoke_meta.py) |
| NASA FIRMS hotspots | **Code done**, gated on `FIRMS_MAP_KEY`; not used in the committed outputs | [`s04_firms.py`](pipeline/steps/s04_firms.py) |

The build is split into three streams ([`WORKSTREAMS.md`](docs/spec/WORKSTREAMS.md)). This branch is stream A: the data, the forensics and the analyst backend.

## How the hard part works

**Arrival time.** Timed NIFC perimeters are cleaned:
- Re-saves are dropped.
- Placeholder triangles from the incident-reporting system are removed.
- Cumulative footprints are clipped to the final perimeter.

Each cell's arrival is then interpolated by distance between consecutive footprints. These times are *observed* only at the perimeter times; everything in between is labelled modeled.

**Spread model** ([`ember/spread.py`](pipeline/ember/spread.py)):
- **Rate of spread:** elliptical, from a per-fuel base rate (ESA WorldCover classes) times a power-law wind term and a tan²-slope term.
- **Fire shape:** set by Anderson's length-to-breadth ratio.
- **Arrival:** a time-dependent Dijkstra over a 16-neighbour stencil, with hourly ERA5 wind interpolated to 15 minutes. It never cuts across non-burnable corners.
- **Speed:** compiled with numba and evaluated in parallel.

**Inversion** ([`s11_ignition.py`](pipeline/steps/s11_ignition.py)). The search runs over (ignition cell, start time, spread-rate scale k):
- **Candidates:**
  - Cells on a lattice inside the first observed footprint.
  - Up to 16 start times, log-spaced from 0.5 h to 90 h before that footprint, and never before the weather record begins.
  - 15 values of k.
- **Scoring:** each candidate is simulated forward and scored against every observed footprint with a weighted hinge loss. Cells inside a footprint should have burned by then; a band outside it should not have. Earlier footprints weigh more.
- **Refinement:** a second stage refines the best eight candidates.
- **Cost:** about 30,000 to 45,000 forward simulations per fit (`candidates_evaluated` in `ignition.json`).

**Calibrated uncertainty.** The relative likelihood over all candidates gives a posterior heatmap, a 90% radius and a 90% start-time interval. Their temperature is not hand-tuned: each fire's synthetic benchmark picks it on half the cases and reports coverage on the other half. When the interval is wider than 6 h, or k sits at the model's ceiling, the start time is marked *not identifiable*. The timeline and the analyst then show the location only. These checks use the fit alone, never CAL FIRE's reference.

**House-level exposure.** Residences within about 100 m of the burn are joined with three things: the arrival time, the gust at arrival, and the distance to wildland. Wildland means tree, shrub or grass cover where under 20% of a 500 m window is built up.
- **Odds ratios:** each construction feature gets a Mantel–Haenszel odds ratio of destruction, stratified by gust × distance, with a Robins–Breslow–Greenland confidence interval.
- **Regression:** a logistic regression fits all features together.
- **Observability check:** the share of "unknown" answers among destroyed versus surviving homes, because inspectors record a destroyed home's features after the fire.

**Analyst** ([`web/api/_lib/`](web/api/_lib)):
- **Tools:** Muse Spark gets 9 read-only tools over the fire files (arrival at a point, street burn times, fire state at a time, weather, structures, events, the ignition back-trace, exposure statistics, place lookup) plus a `final_answer` call.
- **Checks before anything is returned:**
  - A paragraph is dropped if it states a cause or an address.
  - A paragraph is dropped if its citations don't match a tool result from the same conversation.
- **Eval:** an independent ground truth for a 15-question eval is computed from the data files by separate code ([`scripts/eval-analyst.ts`](web/scripts/eval-analyst.ts)).

## Evidence

Every number below is generated from committed files into [`docs/RESULTS.md`](docs/RESULTS.md) by `make report`.

**1. Ignition back-trace: synthetic recovery benchmark.** Each fire gets 20 synthetic fires on its real terrain, fuels and hourly wind, observed on its real perimeter schedule.
- **Model error:** the truth is simulated with different physics from the model that inverts it: per-fuel rates ±25–30%, wind ±15%, ±1-cell mapping noise.
- **Held out:** the first two perimeters.
- **Baselines:** for location, the centroid of the first footprint the fit sees; for time, a linear back-extrapolation of √area.

| | Eaton | Palisades |
|---|---|---|
| Location error, median (p90) | **134 m** (448 m) vs baseline 1,806 m (3,621 m) | **433 m** (1,340 m) vs 2,518 m (4,892 m) |
| Start-time error, median (p90) | **108 min** (6.6 h) vs 10.9 h (52.0 h) | **2.6 h** (14.5 h) vs 9.4 h (125.1 h) |
| Cases where the back-trace beats the baseline | 100% location, 100% time | 100% location, 80% time |
| 90% radius / 90% start interval contains the truth, on the 10 calibration-free cases | 10/10 / 10/10 (median radius 2.6 km, interval 21.9 h) | 10/10 / 10/10 (median radius 1.2 km, interval 31.8 h) |

**2. Real hold-out.** The fit never sees the first two perimeters or CAL FIRE's reference. CAL FIRE's start is a reported time and location, not an investigated origin.
- **Eaton:** the estimated start is 4.0 h after the official start, where the area baseline is 30.9 h before it. The location is 2.26 km from the reported location (baseline 2.46 km). Both the reported time and place fall inside the 90% interval and radius.
- **Palisades:** the first fitted perimeter is 52 h after the reported start. The estimate is 47 h late and 2.75 km away (baseline 3.56 km), and neither the time nor the place is inside the 90% region. This is the regime the back-trace can't handle: one reanalysis wind point can't grow the fire fast enough.
- **Little skill on the earliest footprints:** forward predictions of the held-out first footprints score IoU 0.02 and 0.01 for Eaton, and 0.00 for Palisades.

**3. Full fit (what the app shows).** For Eaton, the most likely start is 2025-01-08 02:36Z, 18 minutes after CAL FIRE's reported 02:18Z. But the calibrated 90% interval is 15.5 h wide, so the timeline withholds it and shows only the location and its 90% radius. For Palisades, the spread-rate scale hits the model's ceiling, so its start time is withheld as well.

**4. House-level associations.**
- **Eaton:** 11,150 exposed residences, 6,115 destroyed.
- **Palisades:** 9,581 exposed residences, 5,564 destroyed.

Mantel–Haenszel odds ratios of destruction, with 95% confidence intervals:

| Contrast | Eaton | Palisades |
|---|---|---|
| Fine-mesh or no vents vs coarse/unscreened | 0.35 (0.31–0.40) | 0.51 (0.46–0.56) |
| Tile, metal or concrete roof vs asphalt or wood | 0.60 (0.54–0.67) | 0.61 (0.56–0.68) |
| Multi-pane vs single-pane windows | 0.49 (0.44–0.54) | 0.64 (0.58–0.70) |

The full table, with all eight contrasts, is in `RESULTS.md`. Read it with the observability check: inspectors leave far more answers "unknown" on destroyed homes (vents: 44% vs 3% in Eaton).

**5. Data checks.**
- **Burned area:** the reconstructed arrival raster burns 14,147 acres for Eaton against CAL FIRE's official 14,056 (+0.6%), and 23,820 against 23,449 for Palisades (+1.6%).
- **Wind:** hourly reanalysis wind tracks the nearest airport station at r = 0.67 (Eaton) and 0.75 (Palisades). Peak gusts are far lower: 46 vs 83 mph, and 36 vs 55 mph.

**6. Analyst.**
- **Offline tests:** 60 tests cover tool outputs on the real Eaton files, citation verification, the cause and address guardrails, and the loop's deadline and forced final answer.
- **Live eval:** the 15-question eval has not been run, because it needs a key.

## Limitations

- **Wind.** One reanalysis point per fire. ERA5 peaks at 46 mph for Eaton, while the Burbank station recorded 83 mph gusts. That is why the fitted spread-rate scale is large (k ≈ 11 for Eaton), and why Palisades hits the model's ceiling.
- **Physics left out.** No spotting, crown fire, suppression or spatially varying wind.
- **Reference point.** CAL FIRE's start is a *reported incident location*, not an investigated origin. Distance to it is a sanity check, not ground truth. The project never states or guesses a cause.
- **House-level results are associations.** They are not effects of the features. Destroyed homes have far more "unknown" answers, so features that burn away are recorded unevenly. Three contrasts (siding, attached fence, elevated deck) run opposite to building-code expectations, and one (eaves) does not replicate across the two fires. We report them, not explain them away.
- **Burn severity coverage.** AVIRIS-3 dNBR covers 56% of the Eaton perimeter and 2% of Palisades.
- **Not yet verified:** the analyst has not been run live against the Meta API. The web app's fire layer is still synthetic. The drone footage stream has not started.

## Reproduce

Requires Python 3.11+ with [uv](https://docs.astral.sh/uv/), and Node 20.19+ (`web/.nvmrc`). Everything below runs offline from a clean clone, against the committed outputs.

```bash
cd pipeline && uv sync
make test                                  # pipeline tests on Eaton and Palisades outputs
make eval QUICK=1 EVAL_DIR=/tmp/ember-eval # re-run the first 5 synthetic cases + the real hold-out for Eaton (~5–10 min);
                                           # the 5 cases match the first 5 in web/public/data/eaton/eval/ignition_synthetic.json
make report                                # regenerate docs/RESULTS.md from the committed outputs

cd ../web && npm ci
npm test                                   # analyst tests (no key needed)
npm run build                              # typecheck app + API, production build
npm run eval:analyst -- --truth            # print the analyst eval's ground truth (no key needed)
```

With network access, `make all` rebuilds every output from the public sources (`make FIRE=palisades all` for Palisades). With a Meta key in `.env` (`cp .env.example .env`):
- `npm run ask -- "When did the fire reach Lake Avenue?"` asks the analyst one question.
- `npm run eval:analyst` scores it.
- `npm run dev` serves the app and `POST /api/analyst` at http://localhost:5173.

## Meta models

| Model | Role | Status |
|---|---|---|
| `muse-spark-1.3` (Meta Model API, OpenAI-compatible) | The analyst: a tool-calling loop over the reconstructed fire, with citations verified server-side and an independent 15-question eval | Built and unit-tested offline; live run pending a key |
| `sam-3.1` (Meta Model API, Responses API) | Fire and smoke masks in drone video; destroyed-building masks in post-fire imagery | Smoke test only ([`tools/smoke_meta.py`](pipeline/tools/smoke_meta.py)); stream C |

## Prior work and credits

- **Sentinel** ([`benjaminxie1/sentinel-app`](https://github.com/benjaminxie1/sentinel-app)) is a team member's earlier open-source fire/smoke detector. Its trained YOLOv8 model is planned as a dependency for stream C. Everything else is built during the hackathon.
- **Design inspiration**: the layout and interaction model are inspired by Dilum Sanjaya's "FireTrace" wildfire-analysis concept, shared on X. Its name and logo are not used.
- **Data**: every source, with its licence note and status (REAL, MODELED or SIM), is in each fire's `manifest.json` and the app's Evidence tab. Source details are in [`docs/spec/BUILD.md`](docs/spec/BUILD.md) §5.

## Docs

- [`docs/RESULTS.md`](docs/RESULTS.md): every evaluation number, generated from the committed outputs
- [`docs/spec/BUILD.md`](docs/spec/BUILD.md): architecture, data pipeline, models, evaluation plan, schedule
- [`docs/spec/DESIGN.md`](docs/spec/DESIGN.md): UI specification
- [`docs/spec/WORKSTREAMS.md`](docs/spec/WORKSTREAMS.md): the three workstreams and their file and API contracts
- [`docs/judge/RUBRIC.md`](docs/judge/RUBRIC.md): the fixed rubric this repo is judged against each round
