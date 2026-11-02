# WORKSTREAMS.md: three parallel streams

The build is split three ways so three people (and their Claude Code sessions) can work at once without blocking each other:

- **A** and **B** are the heavy streams, with long agentic coding sessions and lots of iteration. They fit the **Claude Max 20x** plans.
- **C** is the lighter stream. Its work is mostly running scripts, API calls and evals, plus writing. It fits the **5x** plan.

Sentinel is Ben's detector, so C is the natural stream for him. If Ben is on a 20x plan, he can take A or B instead, and whoever has the 5x plan takes C.

| Stream | Plan | Owns | One-line goal |
|---|---|---|---|
| **A: Data & forensics** | 20x | `pipeline/` (except vision steps), `web/api/` | Turn public data into every file the app reads; the ignition back-trace; the analyst's backend |
| **B: Web app** | 20x | `web/src/` | Everything rendered in the browser: map, fire, panels, charts, analyst chat, footage player |
| **C: Vision & story** | 5x | `pipeline/steps/s12*.py`, `s09c_*.py`, `pipeline/tools/`, `footage/`, submission text | Sentinel + SAM 3.1 on drone footage with eval numbers; the demo video and submission |

**Start a session** in any stream with: *"Read docs/spec/BUILD.md §0, then docs/spec/WORKSTREAMS.md §<A|B|C>, then do today's row for my stream."*

**Git**: each stream works on its own branch (`a/data`, `b/web`, `c/vision`). Merge to `main` once a day, after `cd web && npm run build` passes. Change a contract (§1) only by editing this file in the same commit, and tell the other two.

---

## 1. Contracts between streams

These are what let the streams work in parallel. The producer writes files to `web/public/data/<fire>/`. The consumer codes against the shape below, using a hand-written sample file until the real one lands. All times are **UTC ISO-8601** strings, and all coordinates are `[lon, lat]`.

### Already exists (steps 01–02)
`aoi.json`, `dem.json`, `dem.png`, `base_stylized.jpg`, `hillshade.png`, `final_perimeter.geojson`, `manifest.json`. Their shapes are in `web/src/data/fire.ts`.

### A → B (data files)

| File | Shape |
|---|---|
| `arrival.png` | Same bounds as `dem.png`, row 0 = north. Red channel: 1–254 → `(code−1)/253` of `aoi.window_utc`, 255 → never burned (BUILD.md §3). If step 06 changes the window, it rewrites `aoi.json` too. |
| *(isochrones)* | Not produced. B contours `arrival.png` at time t client-side (d3-contour), which is cheaper than shipping hundreds of lines. |
| `perimeters.geojson` | Polygons, `properties: {t, acres, source}`. The observed perimeters, for the Evidence tab. |
| `hotspots.geojson` | Points, `properties: {t, frp, confidence, satellite}` |
| `series.json` | `{t: string[], area_acres: number[], ros_chains_hr: number[]}`, hourly. Feeds the Fire Area and Rate of Spread charts. |
| `spine.geojson` | One LineString from the ignition point to the head, plus Point waypoints with `properties: {t, label}` |
| `profile.json` | `{distance_km: number[], elevation_m: number[], t: (string\|null)[]}` along the spine. Feeds the Elevation Profile chart. |
| `weather.json` | `{hourly: [{t, wind_mph, wind_dir_deg, gust_mph, temp_c, rh_pct}], daily: [{date, erc, bi, fm100}], source, model}` (HRRR at the AOI center) |
| `wind_field.json` | `{rows, cols, points: [[lon, lat]], t: string[], u_mph: number[][], v_mph: number[][], gust_mph: number[][]}`: hourly HRRR wind on a ~3 km grid over the AOI, one series per point (row-major, north row first). `u`/`v` point where the air moves. B can draw it as wind arrows. |
| `severity.png` | Same bounds as `dem.png`. Red channel = dNBR scaled to 0–255; 0 = no data. |
| `fuel.png` + `fuel_classes.json` | Class index per pixel, and `{index: label}` for the hover readout |
| `trees.json` | `[[lon, lat, height_m], ...]`, ≤ 40k entries. B samples `arrival.png` per tree to char it. |
| `structures.geojson` | Points, `properties: {id, damage, structure_type, roof, eaves, vents, siding}`. **No address, APN, year built or owner fields.** |
| `exposure.json` / `exposure_stats.json` | `exposure.json` is columnar: `{fields, id[], arrival_t[], arrival_imputed[], gust_mph[], dist_wildland_m[], slope_deg[], exposed[]}`. `exposure_stats.json` is `{n, destroyed, gust_split_mph, gust_source, arrival_imputed: {n}, strata: [{stratum, n, destroyed, rate, ci95}], contrasts: [{feature, label, n, or, ci95, unknown_rate, by_stratum}], regression: {n, terms, dropped_constant}, caveat, wildland_definition}`. |
| `events.json` | `[{id, kind, label, t, lon, lat, source, date_only?, interval?}]`, sorted by `t`. `kind` is one of `reported_start`, `ignition_estimate` (only when the start time is identifiable), `rapid_growth` (the fastest average growth between mapped perimeters, with `interval: [from, to]`), `spot_fire`, `ridge_crossing`, `peak_gust` or `containment`. |
| `ignition.json` + `ignition_posterior.png` | `{map: {lon, lat, t, k, lb_max}, r90_m, t90: [t, t], timing: {identifiable, reasons[], interval90_width_h}, region90: GeoJSON Polygon, calibration: {tau_h, test_coverage}, holdout: {held_out[], errors}, modeled_vs_observed_iou[], model_card}`. When `timing.identifiable` is false, show the location and its 90% radius but not a start time; `events.json` then has no `ignition_estimate`. The PNG's red channel = posterior, 0–255. |

### A → B (analyst API): `POST /api/analyst`
- **Request**: `{question: string, history?: {role, content}[], mode?: "answer" | "report"}`
- **Response**: `{paragraphs: [{text: string, cites: [{layer, t, lon, lat, label}]}], tool_calls: [{name, args}]}`
- **Rules**:
  - A paragraph with no cite is dropped before it is returned.
  - The model is `muse-spark-1.3` on `https://api.meta.ai/v1`, and the key stays server-side.
  - The response never states a cause and never includes addresses.

### A → B (post-fire debris flows, Risk tab)

Steps `s14_debris_models.py` (shared across fires) and `s15_debris_fire.py` (per fire). The per-fire segments, their M1 inputs and USGS's own likelihoods come from the USGS postfire debris-flow hazard assessments for Eaton (doi:10.5066/P14EWYME) and Palisades (Palisades item on ScienceBase), CC0. Design storms are USGS's: peak 15-minute intensity I15 = 16, 20, 24, 28, 32, 36, 40 mm/h.

| File | Shape |
|---|---|
| `debris_flow/model_eval.json` (shared, not per fire) | `{inventory: {title, doi, url, records, fires, debris_flows, used_records, used_fires, used_flows, filters[]}, cv: {scheme: "leave-one-fire-out", folds}, features: {name: description}, models: [{id, label, features[], cv, n, flows, pooled: {roc_auc, pr_auc, brier, base_rate}, per_fire: {fires, median_roc_auc, iqr[2]}, within_storm: {groups, records, median_roc_auc, weighted_roc_auc}, analogue: {fire, year, n, flows, roc_auc, brier} \| null, on_map: bool}], importance: {model_id: [{feature, drop_in_auc}]}, notes[]}`. Model ids: `m1_published` (USGS M1, Staley 2017, published coefficients, scored only on records outside its 2016 training inventory), `m1_refit` (M1's form refitted per fold), `rf_m1vars` / `mlp_m1vars` (M1's four inputs), `rf_extended` / `mlp_extended` (plus log upstream area, days since fire and antecedent soil moisture), `mlp_context` (`mlp_extended` plus spatial context: an evaluated variant, not mapped). Random forests are constrained to be non-decreasing in rainfall (R15). `within_storm` is ROC AUC within each fire and storm with both outcomes, the ranking a design-storm map shows. Optional, added after the contract was set: `within_storm.ci95_median` and `within_storm.ci95_weighted` (`[lo, hi]`, 95% percentile intervals of the median and the record-weighted mean from a cluster bootstrap that resamples whole fire-storm groups with replacement, 1,000 resamples, fixed seed, on the out-of-fold predictions as made); `within_storm_on_m1_records` (same shape as `within_storm`, every model on `m1_published`'s records and groups, like for like; for `m1_published` it equals `within_storm`); `vs_m1: {published, refit} | null` (null for `m1_published`), each `{groups, median_diff, ci95, weighted_diff, ci95_weighted, ci95_check, ci95_weighted_check} | null`: the model's within-storm median and record-weighted mean minus M1's on the same groups (the difference of the two figures), with 95% intervals from resamples that draw the same groups for both, and `ci95_check` / `ci95_weighted_check` the same intervals from a larger draw (20,000 resamples, same seed): an interval counts as excluding zero only when both draws exclude it, and is borderline when just one does; `published` on `m1_published`'s records, `refit` minus `m1_refit` on every record (null for `m1_refit` itself); and on `m1_refit` only, `coefficients: {B, Ct, Cf, Cs}`, its coefficients refitted on every usable record (the per-fire `m1_recalibrated`). `analogue` is the held-out Station Fire (2009, San Gabriel front). `on_map` marks the models behind the map's columns. |
| `<fire>/debris_flow.geojson` | LineStrings (USGS stream segments, lon/lat), `properties: {id, area_km2, T, F, S, usgs_hazard_24, usgs_p_<I>, m1_p_<I>, rf_p_<I>}` for each design I15 `<I>`. T = proportion of the upstream area burned at moderate/high severity and steeper than 23°, F = mean dNBR / 1000, S = mean soil KF-factor. `usgs_hazard_24` is USGS's combined hazard class at I15 = 24 mm/h (1 low, 2 moderate, 3 high). `usgs_p_*` is USGS's published M1; `m1_p_*` is M1 recalibrated (M1's form refitted on every usable inventory record); `rf_p_*` is `rf_extended` (monotone in rainfall) under the scenario in the stats file. The MLP is evaluated but not mapped: nothing constrains it to rise with rainfall. |
| `<fire>/debris_flow_stats.json` | `{source: {title, doi, url, license}, design_i15_mm_h[], scenario: {date, days_since_fire, soil_moisture_0_7cm, soil_moisture_source}, segments, m1_check: {max_abs_diff_vs_usgs}, m1_recalibrated: {B, Ct, Cf, Cs, records}, agreement_by_i15: {"<I>": {model: {spearman_vs_usgs, class_agreement}}}, likelihood_class_counts: {"<I>": {model: {"0-20%": n, ...}}}, mean_likelihood: {"<I>": {model: p}}, analogue: {fire, note}, usgs_median_thresholds_mm_h: {I15_50, I15_75}, notes[]}` with models `usgs`, `m1`, `rf`. `m1_check` is an implementation check (our published-coefficient M1 reproduces USGS's numbers), not a validation. `analogue` names the inventory fire that stands in for this one, or says there is none. |

### C → B (footage files): `web/public/data/<fire>/footage/`

| File | Shape |
|---|---|
| `clips.json` | `[{id, title, src, fps, width, height, source, note}]`. `note` is shown in the PiP, e.g. `"FLAME 2 · prescribed burn · not this fire"`. |
| `detections/<id>.json` | Sentinel boxes: `[{frame, box: [x1, y1, x2, y2], cls: "fire"\|"smoke", conf}]` in source pixels |
| `masks/<id>.json` | SAM 3.1: `[{frame, object_id, prompt, bounds: [left, top, right, bottom], size: [w, h], path, conf}]`. `path` comes from `meta_sam_parser.decode_mask_to_svg_path` and is in the mask raster's own coordinates (`size`), not source pixels. `bounds` is the record's `SegmentationMaskBounds` in source pixels. B draws it with `translate(left, top) scale((right−left)/w, (bottom−top)/h)`. |
| `../eval/*.json` | `sentinel.json`, `sam_video.json`, `sam_structures.json`, `analyst.json`: `{metric: value, n, method, date}` |

**Footage licensing**: FLAME 2 has no stated license. Don't commit its clips to this public repo until that's checked. Until then, `src` can point to a local file, and the team's own drone footage is safe to publish.

---

## 2. Stream A: Data & forensics (20x)

**You own** `pipeline/` (except `s12*`, `s09c`, `tools/`) and `web/api/`. **You deliver** every A → B file in §1, plus the analyst endpoint.

| Day | Do | Done when |
|---|---|---|
| Thu | Request the FIRMS MAP_KEY; submit the LANDFIRE LFPS job (FBFM40 + EVT, pre-fire). Steps 01–02 are already done. | Both requests sent |
| Fri | Step 05 perimeters (NIFC 2025 archive, keyed on `DateCurrent`), 07 weather, 08 severity, 09 structures/roads/labels (dropping the private fields), and 04 FIRMS once the key arrives. Step 03 when LANDFIRE returns. Commit **sample** versions of `arrival.png`, `series.json` and `events.json` early, so B can build against real shapes. | `make all` produces those files for Eaton |
| Sat | Step 06 arrival + isochrones, then `series.json`, `spine.geojson`, `profile.json`; step 10 events | B's map burns with real arrival times |
| Sun | Step 11 ignition back-trace + temporal hold-out; step 09b exposure join + stats; `web/api/analyst.ts` with tools reading `public/data` | `curl` to `/api/analyst` returns cited paragraphs |
| Mon | Step 15: 15 questions with answers computed by the pipeline, scored through the endpoint. Fix data bugs B finds. Complete `manifest.json` for the Evidence tab. | All eval numbers in `eval/` |
| Tue | Numbers into the README; bug fixes only | — |

**Watch for**: sparse perimeters on the first night (lean on FIRMS); keeping `arrival.png` and `aoi.json` in sync; DINS privacy.

## 3. Stream B: Web app (20x)

**You own** `web/src/`. **You consume** A's files and API, and C's footage files. Build against sample files first, and never wait on a real one.

| Day | Do | Done when |
|---|---|---|
| Thu | Shell done (header, rail, dock, timeline, hover readout, fire shader path A). | Done |
| Fri | Replace the synthetic arrival with a `arrival.png` loader (fall back to the synthetic one if missing); add tree instances, peak/place labels, a structures layer, and wire the layer toggles to real layers | Layers panel toggles real layers |
| Sat | Perimeter at time t (contour or isochrones), spine + waypoints + spread arrows, the three Incident charts from `series.json`/`profile.json` with past-solid/future-faded styling, Key Events from `events.json` that highlight as t passes | Scrubbing moves map, charts and events together |
| Sun | Notes tab: the analyst chat with citation chips that fly the camera and set t (DESIGN §9). Analysis tab: ignition heatmap and hold-out stat, plus the Homes panel. Weather card from `weather.json`. 2D polish. | Click a citation and the camera flies to it |
| Mon | Drones tab as a footage player: clip list, PiP with HUD, Sentinel boxes + SAM mask paths in sync with video time, the Detections list, Full camera view. **Feature freeze 11 pm.** | 3-minute run-through works end to end |
| Tue | Polish; help C record the demo | — |

**Watch for**: `fireTime` is normalized to `aoi.window_utc`, so re-read `aoi.json` whenever A changes it; keep every simulated element labelled `SIM`; times are computed in `America/Los_Angeles` (PST in January).

## 4. Stream C: Vision & story (5x)

**You own** `pipeline/steps/s12_sentinel.py`, `s12c_sam_video.py`, `s09c_sam_structures.py`, `pipeline/tools/`, `footage/` (gitignored), and the submission text. **You deliver** C → B footage files, the eval numbers, the demo video and the README/submission write-up.

This stream is light on Claude usage by design. Most of the time goes to downloads, API runs, evals and editing. Keep sessions short and scoped to one step.

| Day | Do | Done when |
|---|---|---|
| Thu | Get the Meta Model API key, put it in `.env`, and run `make smoke-meta ARGS="--image <fire photo>"`. Request SAM 3 Hugging Face access (fallback only). Start the FLAME 2 download (13.6 GB). | **Both Meta models answered a real request** |
| Fri | Step 12/12b: Sentinel (`vendor/sentinel-app`, `fire_yolov8n.pt`) on a FLAME 2 sample, scored against its fire/smoke frame labels. Step 12c: SAM 3.1 on the same sample, using the hosted API. Go/no-go on post-fire aerial imagery for 9c. | Two precision/recall numbers in `eval/` |
| Sat | Trim 3–4 clips to ≤ 30 s (MP4, H.264). Produce `clips.json`, `detections/`, `masks/`. Shoot your own drone b-roll (TRUST/Part 107, B4UFLY, never over people). | B can load the footage files |
| Sun | Step 9c if it's a go (SAM `destroyed building` vs DINS); otherwise draft the analyst eval questions with A. Write the demo script (BUILD.md §10). | Script and shot list ready |
| Mon | Rehearse with B; draft the README's Real-vs-Sim table and eval section, and the submission form text | Draft README reviewed |
| Tue | Record and edit the demo video; finalize the README and submission; **submit by 6 pm** | Submitted |

**Watch for**: SAM video calls are billed per frame (≥ 50 frames per request), so cache every response and never call it live in the demo. If Sentinel scores poorly on top-down footage, say so, pick clips where it works, and consider a quick fine-tune with Sentinel's `model_trainer.py` on FLAME 2 frames.
