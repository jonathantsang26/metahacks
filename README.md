# Sentinel Ember

**A forensic reconstruction of a real wildfire from public records**, for the analysts who have to explain a fire afterwards: after-action reviewers, rebuild planners, insurance and legal investigators, and journalists.
- **When the fire reached each street:** an arrival time for every burned cell, interpolated between mapped perimeters and labelled MODELED; hover the map for any point.
- **Where and when it started:** a location estimate with a calibrated 90% radius. A start time is shown only when the data pin it to within 6 h; for both fires they don't, so it is withheld.
- **Which homes survived:** outcomes compared at the same exposure.
- **Where debris flows could follow:** post-fire debris-flow likelihood on every stream segment under USGS's design storms, with USGS's model and two models fitted on USGS's observed debris-flow inventory.

![Eaton Fire replay at Jan 8, 15:30 PST: the interpolated fire progression and burn scar on 3D terrain, the mapped perimeter, the ignition estimate with its start time withheld, and the timeline, charts and key events](docs/img/eaton-replay.jpg)

Run it (Node 20.19+, no key needed):

```bash
cd web && npm ci && npm run dev
```

Then open http://localhost:5173/?fire=eaton&t=2025-01-08T23:30:00Z for this view; `&tab=risk` opens the post-fire debris-flow view ([screenshot](docs/img/eaton-risk.jpg)), and `?fire=palisades` switches fires.

A one-minute tour, one stop per point above:
1. **Streets:** drag the timeline at the bottom. The progression, the mapped perimeter, the charts and the key events follow it; hover any point for when it burned.
2. **Start:** the right-hand rail's Analysis tab shows the back-trace, its 90% region beside CAL FIRE's reported point, and why the start time is withheld.
3. **Homes:** under Analysis, Homes compares destruction odds by construction feature at matched exposure. Turn on Structures under Layers and click one to see its inspection outcome; addresses and parcels are never shown.
4. **Debris flows:** the header's Risk tab colours each stream segment by likelihood; pick the model and the design storm.
5. **Sources and questions:** the rail's Evidence tab lists every source as real, modeled or simulated. The Analyst tab (needs `MODEL_API_KEY`) answers questions such as "When did the fire reach Lake Avenue?"; its citation chips move the map and the clock.
6. **Palisades:** switch fires in the header. The same views load; its back-trace sits at the spread-rate ceiling, so its start is withheld too.

Every number traces back to a public source or a committed evaluation file. The README's headline table below is generated from those files, and a test fails if it drifts.

Built for the **Meta Global AI Developer Hackathon** (2026). The two fires covered are the January 2025 **Eaton** and **Palisades** fires in Los Angeles County.

## Who it's for, and why now

**The user:** the analyst who has to explain a fire afterwards. That includes after-action review teams, county recovery and rebuild planners, insurance and legal investigators, and journalists. Today they rebuild the timeline by hand, from a dozen agency services that don't line up.

**The problem:** a fire's public record is scattered and sparse.
- **Perimeters** are snapshots taken hours apart, and the first one comes late. Eaton's first mapped perimeter is 4.8 h after the reported start; Palisades' is 26 h after.
- **Wind** comes from a few airport stations or a coarse reanalysis.
- **Damage inspections** are a separate table of about 30,000 structures across these two fires.

This project joins them into one timeline, estimates where and when each fire started with checked uncertainty, and compares structure outcomes at equal exposure.

**Why now:** the burn scars face their first winters now, and the evidence to reconstruct these fires only recently became public in machine-readable form:
- USGS's observed post-fire debris-flow inventory for the western US was published in 2026 (Graber et al.), and USGS's debris-flow hazard assessments for Eaton and Palisades in 2025. Together they let the Risk tab test models against observed outcomes and against USGS's own assessment.
- NIFC's 2025 operational perimeter archive keeps each fire's timed perimeters.
- CAL FIRE's damage inspections (DINS) give construction attributes for every inspected structure.
- NASA JPL's AVIRIS-3 flew burn-severity imagery over these fires.
- NOAA's HRRR 3 km weather model is in Open-Meteo's historical archive.

The analyst runs on Meta's Muse Spark (`muse-spark-1.3`), whose tool calling lets every paragraph cite a tool result. It has been run live on both fires (see the Analyst row below).

## What works today

| Part | Status | Code |
|---|---|---|
| Data pipeline: 12 steps that turn public data sources into per-fire files, for Eaton and Palisades | **Working.** Outputs are committed in `web/public/data/<fire>/` | [`pipeline/steps/`](pipeline/steps) |
| Arrival time (when each place burned), area and spread-rate series, key events | **Working** | [`s06_arrival.py`](pipeline/steps/s06_arrival.py), [`s10_events.py`](pipeline/steps/s10_events.py) |
| Wind field: HRRR 3 km wind on a grid over each fire, checked against airport stations and ERA5 | **Working** | [`s07_weather.py`](pipeline/steps/s07_weather.py) |
| Ignition back-trace: where and when it started, with calibrated uncertainty and an identifiability rule | **Working and benchmarked** (see Evidence) | [`ember/spread.py`](pipeline/ember/spread.py), [`s11_ignition.py`](pipeline/steps/s11_ignition.py) |
| House-level exposure: destruction odds by construction feature, at matched exposure | **Working** | [`s09b_exposure.py`](pipeline/steps/s09b_exposure.py) |
| Post-fire debris flows (Risk tab): USGS M1 against M1 recalibrated, a random forest and an MLP, scored leaving one fire out on USGS's observed inventory, and mapped on USGS's stream segments | **Working**; compared with USGS's assessment, not validated (no 2025 outcomes) | [`s14_debris_models.py`](pipeline/steps/s14_debris_models.py), [`s15_debris_fire.py`](pipeline/steps/s15_debris_fire.py), [`rail/risk.tsx`](web/src/rail/risk.tsx) |
| Analyst (`muse-spark-1.3`): tool calls over the fire data, with citation, number and guardrail checks on the server, and a chat in the app whose citation chips move the map and the clock | **Working; run live** on both fires (2026-10-31): 13 of 14 Eaton and 12 of 13 Palisades answers match the data-derived truth, and all 37 cited ids came from a tool result. Both misses were the street tool's sampling, since fixed (see Analyst below). Without `MODEL_API_KEY` the chat shows the server's message, never an answer | [`web/api/`](web/api), [`rail/analyst.tsx`](web/src/rail/analyst.tsx) |
| Web app: replays each fire on 3D terrain from the pipeline's files. The map shows the interpolated progression from `arrival.png`, the burn scar (AVIRIS-3 dNBR, the differenced Normalized Burn Ratio, a standard burn-severity index), the mapped perimeter at the current time, the ignition estimate and its 90% region beside CAL FIRE's reported point, structures, roads and HRRR wind arrows (a layer toggle, off by default). Charts, key events, weather at the current time, the back-trace and house-level analysis, and the source manifest all follow one timeline | **Working** on Eaton and Palisades (switch fires from the header). The Drones tab is disabled (no drone data in this build); the Risk tab takes the place of the Resources tab in the original design | [`web/src/`](web/src) |
| Drone footage: Sentinel YOLOv8 + SAM 3.1 segmentation | **Not in this branch** (a teammate's part of the build). The live API smoke test passes: SAM 3.1 masks smoke in a public-domain photo ([log](pipeline/logs/smoke-meta.log)) | [`tools/smoke_meta.py`](pipeline/tools/smoke_meta.py) |
| NASA FIRMS hotspots | **Code done**, gated on `FIRMS_MAP_KEY`; not used in the committed outputs | [`s04_firms.py`](pipeline/steps/s04_firms.py) |

The build is split into three parts that teammates work on in parallel ([`WORKSTREAMS.md`](docs/spec/WORKSTREAMS.md)): data and forensics, the web app, and drone footage. This branch carries the data, the forensics, the analyst backend, and the web app's wiring to those outputs.

## How the hard part works

**Arrival time** ([`s06_arrival.py`](pipeline/steps/s06_arrival.py)). Timed NIFC perimeters are cleaned:
- Re-saves are dropped.
- Placeholder triangles from the incident-reporting system are removed.
- Cumulative footprints are clipped to the final perimeter.

Each cell's arrival is then interpolated by distance between consecutive footprints. The first interval is seeded from CAL FIRE's reported start time and location. For Eaton the reported point lies outside the first mapped perimeter, so the seed is that perimeter's nearest cell, 1.7 km away (`arrival_meta.json` records this). For Palisades, whose first map is 26 h in, that seeded interval covers about half the burned area. Times are observed only at the perimeter times, so the layer is labelled MODELED.

**Wind field** ([`s07_weather.py`](pipeline/steps/s07_weather.py)). HRRR is sampled hourly on a grid of points about 3 km apart over each fire area: 4×6 for Eaton, 5×7 for Palisades. Each model is compared with the nearest airport station at the station's own location: HRRR, ERA5 and ECMWF IFS. HRRR tracks hourly wind and humidity better than ERA5 at both stations, which is why it drives the spread model. `wind_field.json` is published for the app.

**Spread model** ([`ember/spread.py`](pipeline/ember/spread.py)):
- **Rate of spread:** elliptical, from a per-fuel base rate (ESA WorldCover classes) times a power-law wind term and a tan²-slope term.
- **Fire shape:** Anderson's length-to-breadth ratio, up to a cap.
- **Arrival:** a time-dependent Dijkstra over a 16-neighbour stencil. Wind is interpolated bilinearly per cell from the HRRR grid, and in time to 15 minutes. The stencil never cuts across non-burnable corners.
- **Speed:** compiled with numba and run in parallel.

**Inversion** ([`s11_ignition.py`](pipeline/steps/s11_ignition.py)). The search runs over (ignition cell, start time, spread-rate scale k):
- **Candidates:**
  - Cells on a lattice inside the first observed footprint.
  - Up to 16 start times, log-spaced from 0.5 h to 90 h before that footprint, and never before the weather record begins.
  - 17 values of k, from 0.25 to 64. Refinement can go 20% past the top, to 76.8; a fit that ends there is reported as at the ceiling.
- **Scoring:** each candidate is simulated forward and scored against every observed footprint with a weighted hinge loss. Cells inside a footprint should have burned by then; a band outside it should not have. Earlier footprints weigh more.
- **Refinement:** a second stage refines the best eight candidates.
- **Fire shape per fit:** the ellipse's length-to-breadth cap is chosen per fit, from 1 to 8, by loss on the real perimeters. With realistic winds, Anderson's curve makes the model fire far narrower than these fires were (spotting and gusts that swing direction widen a real fire), and the cap is how the fit corrects for that. Eaton's fit picks 1, a round fire, so wind no longer sets its shape; Palisades picks 1.5. The hold-out chooses its own cap without the held-out perimeters.

**Calibrated uncertainty and the identifiability rule.** The relative likelihood over the stage-1 grid gives a posterior heatmap, a 90% radius and a 90% start-time interval. That grid is regular (lattice cells × log-spaced lags × log-spaced k), so the implied prior is uniform over the lattice and log-uniform over lag and k; each lattice cell's weight is spread over the cells nearest it. Stage 2 only sharpens the point estimate: counting its dense neighbourhoods would weight cells by how often they were evaluated.
- **Not hand-tuned:** the temperature is calibrated on each fire's own synthetic fires. Half the cases pick it; coverage is reported on the other half. Where no temperature tried reaches 90% on the calibration half, the widest is used, the fit is flagged uncalibrated in the outputs, the app and the analyst, and its start time is withheld.
- **Matched to the fit it serves:** the hold-out and the product fit use different observations, so each gets its own calibration. Both calibrations invert with the product fit's shape cap; the hold-out picks its own cap, which matches for Eaton (1) but not for Palisades (8 vs 1.5).
- **When the start time is withheld:** if the interval is wider than 6 h, k sits at the model's ceiling, or the uncertainty is uncalibrated. The timeline then omits the estimated start and the analyst declines to give one.
- **Inputs to the rule:** it looks only at the fit, never at CAL FIRE's reference. The synthetic benchmark does borrow the real fire's observation delays, measured from CAL FIRE's reported start.

**Synthetic benchmark.** Each synthetic fire runs on the fire's real terrain, fuels and HRRR wind field, and is observed on its real perimeter schedule. The truth runs the same spread equations as the inverting model, but on inputs the model never sees:
- per-fuel rates ±25–30%;
- a smooth, patchy fuel field the model never sees;
- wind speed ±15%, direction ±15° and timing ±1.5 h;
- a perturbed length-to-breadth cap;
- ±1-cell mapping noise.

Synthetic start times are drawn uniformly 2–8 h into the replay window, a range that brackets CAL FIRE's reported start for both fires (2.3 h and 6.5 h in); the inversion itself never uses this prior.

The spread-rate range is centred on the fuel table itself: k log-uniform 0.25–4, i.e. its base rates off by up to 4× either way. It has not always been: commit `0eab9dc` drew k from 4–16 to resemble the real Eaton fit of the time (k ≈ 11), and `66e8516` moved it to 0.25–4 when the HRRR fit brought Eaton's k to 0.42. Other design choices (the shape cap, the start-time lags) were also diagnosed on the real Eaton grid, so the real Eaton hold-out is a sanity check rather than an independent test. The real Palisades fits (k 22.6 in the hold-out, 76.8 at the ceiling in the full fit) lie outside the synthetic range, so Palisades' synthetic coverage describes slower fires than the real one. Each case is inverted twice: on every footprint, as the app does, and with the first two held out, as in the real hold-out. `make eval QUICK=1` recomputes the first cases and checks that they match the committed ones exactly.

**House-level exposure** ([`s09b_exposure.py`](pipeline/steps/s09b_exposure.py)). Each residence within about 100 m of the burn gets three exposure values:
- **Arrival time.** Homes just outside the burned cells take the nearest burned cell's time, and are flagged.
- **HRRR gust** at that place and hour.
- **Distance to wildland:** tree, shrub or grass cover where under 20% of a 500 m window is built up.

The analysis on top:
- **Odds ratios:** each construction feature gets a Mantel–Haenszel odds ratio of destruction, stratified by gust × distance, with a Robins–Breslow–Greenland confidence interval.
- **Regression:** a logistic regression fits all features together.
- **Observability check:** the share of "unknown" answers among destroyed versus surviving homes, because inspectors record a destroyed home's features after the fire.

**Analyst** ([`web/api/_lib/`](web/api/_lib)):
- **Tools:** Muse Spark gets 9 read-only tools over the fire files (place lookup, arrival at a point, street burn times, fire state at a time, weather, structures, events, the ignition back-trace, exposure statistics) plus a `final_answer` call.
- **Checks before a paragraph is returned** ([`verify.ts`](web/api/_lib/verify.ts)):
  - It must cite a tool result from the same conversation.
  - Every number and clock time in it must appear in the cited tool results or in the question. Rounding is allowed; computed numbers are not. Small whole numbers up to 10 are exempt.
  - It must not match the cause, attribution or address patterns.
- **What happens to failures:** dropped paragraphs are counted by reason.
- **Spend limits on the public site** ([`ratelimit.ts`](web/api/_lib/ratelimit.ts)): 10 questions per 30 minutes per visitor (a report counts as 3) and 60 per hour overall, per server instance, with chat history capped at 8,000 characters. A refused request gets HTTP 429 and says when to retry. The counts live in each instance's memory, so they do not bound spend across instances.
- **Eval** ([`scripts/eval-analyst.ts`](web/scripts/eval-analyst.ts)): 15 questions per fire, with ground truth computed from the data files by code independent of the tools. Arrival-time truths come from the interpolated arrival raster, so they are MODELED, not observed. Questions with no truth in the data are skipped and listed, so 14 are scored for Eaton and 13 for Palisades. Where the back-trace withholds a start time, the ignition question becomes a must-decline question.
- **Live run** (2026-10-31, one run per fire; [`eaton`](web/public/data/eaton/eval/analyst.json), [`palisades`](web/public/data/palisades/eval/analyst.json)):
  - 13 of 14 answers right for Eaton and 12 of 13 for Palisades. Numbers 16 of 16, the must-decline start time 2 of 2, times 7 of 9. All 37 cited ids came from a tool result, and the verifier dropped no paragraph.
  - **Both misses were the tool, not the model.** Each was a street's first burn time: Kinneloa Canyon Road (Eaton) and Pacific Coast Highway (Palisades). The model reported exactly what `street_fire_timeline` returned. That tool sampled streets every 40 m over arrival cells of about 16 m, so it read Kinneloa Canyon Road, which clips the burn, as unburned, and put the highway 37 min late.
  - The tool now walks every cell a street crosses. A test checks every eval street against an independent 1 m walk of the raster, and it fails on the old code for exactly these two. The committed scores are from the live run before the fix; a rerun is pending.
  - One question was reworded before the run: Meta's content filter rejected the vents odds-ratio question, so it now asks for the odds ratio `exposure_stats` lists for the vents contrast.

## Evidence

The table is generated by `make report` from the committed eval files. The full tables, with p90s, baselines and every contrast, are in [`docs/RESULTS.md`](docs/RESULTS.md).

<!-- headline:start (generated by make report; do not edit) -->
| | Eaton Fire | Palisades Fire |
|---|---|---|
| Synthetic fires, location error (median): back-trace vs first-footprint centroid | 588 m vs 449 m | 526 m vs 1,624 m |
| Synthetic fires, start-time error (median): back-trace vs √area back-extrapolation | 78 min vs 21.6 h | 4.6 h vs 37.0 h |
| The same with the first two perimeters held out: location; start time | 924 m vs 1,406 m; 3.1 h vs 52.2 h | 786 m vs 1,744 m; 16.4 h vs 109.7 h |
| 90% radius / interval contains the truth, on synthetic cases the calibration never saw | 87% / 93% (radius 1,717 m, interval 10.31 h) | 100% / 100% (radius 1,681 m, interval 43.25 h); the real fit's k (76.8) lies above every synthetic truth (max 3.6) |
| Unseen synthetic cases where the app would show a start time | 0 of 15 | 0 of 15 |
| Real fire: estimated start time | withheld (not identifiable) | withheld (not identifiable) |
| Real hold-out: distance to CAL FIRE's reported point (baseline: first-footprint centroid) | 2,504 m (2,460 m) | 315 m (3,557 m); the hold-out fit predicts neither held-out perimeter, so this is not a result |
| Real hold-out: start-time error vs CAL FIRE (baseline) | 2.3 h (-30.9 h); withheld as not identifiable | 40.0 h (-707.9 h); the estimate is later than the held-out perimeters, so not a credible start, and withheld as not identifiable |
| CAL FIRE's reported point, distance outside the first mapped footprint | 1,772 m | 0 m |
| Real fit with the HRRR wind field vs the old single ERA5 point (footprint IoU, spread-rate scale k) | IoU 0.45, k 0.424 vs IoU 0.30, k 11.314 | IoU 0.38, k 76.8 (ceiling) vs IoU 0.40, k 76.8 (ceiling) |
| Hourly wind vs the nearest airport station: HRRR vs ERA5 | r 0.90 vs 0.71 | r 0.85 vs 0.75 |
| Odds ratio of destruction, fine-mesh vents vs coarse (95% CI) | 0.35 (0.31–0.40) | 0.50 (0.45–0.56) |
| Odds ratio, tile/metal/concrete roof vs asphalt/wood | 0.59 (0.53–0.66) | 0.58 (0.53–0.64) |
| Analyst live on `muse-spark-1.3`: answers matching the data-derived truth; cited ids a tool returned | 13/14; 20/20 | 12/13; 17/17 |
<!-- headline:end -->

How to read it:
- **Synthetic rows** test recovery when the truth is known and the physics deliberately differs from the model.
- **Coverage row:** whether the stated 90% uncertainty holds on cases the calibration never saw.
- **"Would show a start time" row:** how often the identifiability rule lets a start time through, and how good it is when it does.
- **Real-fire rows** compare against CAL FIRE's *reported* start. That is a reported time and incident location, not an investigated origin.
  - For Eaton, the reported point lies outside the first four mapped perimeters (up to 10:37Z): 1,721 m outside the 07:06Z polygon and 1,108 m outside the 10:34Z one (vector distances, computed in `RESULTS.md`; 1,772 m and 1,142 m on the analysis grid, as in the table and `ignition.json`). The search is confined to the first fitted footprint, so it can't reach that point: the early perimeters missed the origin area, or the point is approximate.
- **IoU** (intersection over union) compares the modeled and observed burned areas: 1 means identical, 0 means no overlap.
- **Wind row:** the current fit against the pipeline before HRRR (one ERA5 point, shape cap 8), so it mixes the wind change with the shape-cap change. [`eval/wind_ablation.json`](web/public/data/eaton/eval/wind_ablation.json) separates them, and `RESULTS.md` lists all four variants.
- **Odds ratios** are associations, adjusted only for the recorded exposure.

What it shows:
- **Start time is where the back-trace beats the baseline.** On synthetic fires its start time is closer than √area back-extrapolation in 93% (Eaton) and 83% (Palisades) of cases.
- **Location is mixed.** For Eaton the first footprint's centroid is closer on the median (449 m vs 588 m; the back-trace wins 57% of cases). With the shape cap at 1 the model fire is round, and a round fire's first footprint is centred near its start, so the centroid is a strong guess. The back-trace wins when the early perimeters are held out (924 m vs 1,406 m), and for Palisades, whose first map comes 26 h in.
- **No start time is shown yet.** Under the 6 h rule, no unseen synthetic case (in either scenario) and neither real fit gets one: Eaton's intervals are 10–13 h wide (real fits and synthetic cases). Palisades' synthetic and hold-out intervals are 43–64 h; its full fit's 7.5 h interval is withheld because k sits at the model's ceiling. The Palisades hold-out's temperature (38.4 h) is the top of the grid tried, so its 100% coverage says little. Eaton's real hold-out interval (23:15Z on Jan 7 to 09:52Z on Jan 8, 10.6 h) does hold CAL FIRE's 02:18Z, and its estimate is 2.3 h late. An earlier posterior that also counted the dense second-stage candidates gave Eaton's hold-out a 5.9 h interval that let the time through and missed CAL FIRE's start; that is why the posterior now comes from the regular grid alone.
- **Coverage is close to, not always at, 90%.** On unseen synthetic cases the 90% radius held the true origin in 87% of Eaton's full-fit cases (13 of 15) and 93% of its hold-out cases; the start interval held the true start in 87–100%. Palisades' full fit covered 100% of both, with wide intervals (median 43 h), so it sits above the target rather than at it.
- **HRRR helps Eaton, not Palisades.** For Eaton at the same shape cap, the HRRR field lowers the fit loss (2.16 → 2.02 h) and raises the mean footprint IoU (0.41 → 0.45) over the ERA5 point. Most of the gain over the old pipeline (IoU 0.30) comes from the shape cap, though, and one uniform HRRR wind matches the field (IoU 0.46). For Palisades every wind variant leaves k at the ceiling: the model can't grow that fire fast enough under any of them.

## Post-fire debris flows

Burned, steep slopes can shed debris flows in the first winters' storms. The Risk tab shows USGS's stream segments for each fire (956 for Eaton, 1,864 for Palisades) with the chance of a debris flow under USGS's seven design storms (peak 15-minute rainfall 16–40 mm/h), from three models:
- **USGS M1 (published):** USGS's own hazard assessments for these fires (Staley et al. 2017 coefficients; [doi:10.5066/P14EWYME](https://doi.org/10.5066/P14EWYME), CC0). Our implementation reproduces its likelihoods to within 5×10⁻¹⁶ (largest difference 4.4×10⁻¹⁶), which checks our code, not the model.
- **M1 recalibrated:** the same form refitted on USGS's observed debris-flow inventory ([Graber et al. 2026](https://doi.org/10.5066/P1R9VXC4): 7,639 usable watershed-storm records from 77 fires, 2000–2024, 955 of them debris flows).
- **Random forest:** fitted on that inventory with M1's inputs plus watershed area, days since the fire and antecedent soil moisture (ERA5-Land via Open-Meteo), and constrained never to fall as rainfall rises.

Each trained model is scored on fires it never saw (leave one fire out, [`debris_flow/model_eval.json`](web/public/data/debris_flow/model_eval.json)). The within-storm column covers 99 fire-storm groups for the trained models and the 64 outside M1's training data for M1; `model_eval.json` also scores every model on M1's 64 for a like-for-like comparison:

| Model | ROC AUC, all records | ROC AUC within one fire and storm (median, 95% interval) | Station Fire (2009), held out |
|---|---|---|---|
| USGS M1, published (scored on the 6,319 records it was not fitted on) | 0.881 | 0.809 [0.700, 0.932] (64 storms) | n/a (fitted on it) |
| M1 recalibrated | 0.828 | 0.750 [0.667, 0.800] | 0.825 |
| Random forest, monotone in rainfall | 0.815 | 0.800 [0.688, 0.864] | 0.704 |
| MLP (evaluated, not mapped) | 0.841 | 0.808 [0.700, 0.850] | 0.746 |
| MLP plus neighbouring watersheds (evaluated, not mapped) | 0.848 | 0.750 [0.656, 0.864] | 0.776 |

What it shows:
- **Machine learning did not clearly beat USGS's M1 where it matters.** A design-storm map ranks watersheds within one storm. On the records M1 was not fitted on, with 95% intervals from a bootstrap over fire-storm groups, the extended random forest's within-storm median ROC AUC minus M1's is +0.015 [−0.063, +0.097] and the extended MLP's is +0.004 [−0.104, +0.101]. Every interval includes zero, and those for the models on M1's four inputs alone lean below it. One Thomas Fire storm holds about half of those records, so the record-weighted figures lean on it. The Risk tab shows each model's interval.
- **USGS's published likelihoods run high on newer records.** On the 6,319 records M1 was not fitted on they average 0.363, while 9.8% of those watershed-storm records had a debris flow. M1 recalibrated keeps USGS's ranking of segments (Spearman 0.88 for Eaton, 0.94 for Palisades; the mapped random forest agrees far less, 0.38–0.47 and 0.63–0.82 across the design storms) at a much lower level (at 24 mm/h, mean 0.16 against USGS's 0.71 on Eaton). That level follows how each sub-inventory sampled storms without a debris flow (25% of the Staley et al. 2016 records are flows against 10% of the rest), so read absolute levels with caution.
- **Neighbouring watersheds did not help.** Adding the inputs of the five nearest watersheds raised the MLP's pooled ROC AUC by 0.007 but lowered its within-storm median by 0.058, so no map column uses them.
- **The random forest's level depends on a scenario:** 2025-02-13, 37 days after ignition and the first day after the fire with at least 25.4 mm (1 inch) of rain at the fire in ERA5, with one soil-moisture value per fire. Only 950 inventory records come from storms that soon after a fire, 857 of them from one Thomas Fire storm, so its level is an extrapolation.
- **Nothing here is validated for 2025.** The inventory has no Eaton or Palisades outcomes, so the maps are compared with USGS's assessment. The Station Fire, 13 km from Eaton and held out from fitting, is the nearest past test (M1 was designed on data that include it); Palisades has no such fire, since the inventory's Santa Monica Mountains fires (Topanga 2005, Canyon 2007) recorded no debris flows.

## Limitations

- **Model physics.**
  - No spotting, crown fire or suppression.
  - Wind structure below HRRR's 3 km is missed.
  - The length-to-breadth cap is a stand-in for spotting and gusts that swing direction, fitted per fire, not a mechanism.
- **Weather is a model.** HRRR is a model analysis and short-range forecast, not observations. Its station agreement is in `weather_station.json`.
- **Reference point.** CAL FIRE's start is a reported incident location, not an investigated origin. Distance to it is a sanity check, not ground truth. The project never states or guesses a cause.
- **Palisades is beyond the model.** Under every wind tried, k sits at the ceiling: without spotting, the model can't spread that fire as fast as it burned. That alone withholds its start time. A simple deterministic spotting edge did not fix it either: with embers landing 0.5–2 km downwind whenever HRRR wind reached 15–25 mph, k stayed at the ceiling in all six settings tried and the fit's loss barely moved ([`experiments/spotting.py`](pipeline/experiments/spotting.py), results in `spotting_palisades.json`). So the gap is not just missing ember jumps; we did not ship that term.
- **Calibration scope.** Coverage is measured under the benchmark's perturbations, which are probably smaller than real model errors.
- **What the benchmark does not test.** Synthetic origins lay inside the first footprint the search covers in 100% of Eaton cases and 97–100% of Palisades cases (a fire grown from its origin almost always contains it). For Eaton, CAL FIRE's reported point lies 1.7 km outside the first mapped perimeter, a case the benchmark never exercises.
- **Thin calibration samples.** Calibration rests on 15 unseen cases per scenario.
- **House-level results are associations.** They are not effects of the features.
  - Destroyed homes have far more "unknown" answers, so features that burn away are recorded unevenly.
  - Some contrasts run opposite to building-code expectations, and some don't replicate across the two fires (see `RESULTS.md`). We report them as they are.
- **Burn severity coverage.** AVIRIS-3 dNBR covers about half of Eaton's perimeter and only a sliver of Palisades (`severity_stats.json`).
- **Not yet verified:**
  - The live analyst eval is one run per fire, 27 scored questions in all, and it predates the street-tool fix.
  - The drone footage stream is not in this branch.
  - The web app has been checked in desktop Chromium only; it needs WebGL2.

## Reproduce

Requires Python 3.11+ with [uv](https://docs.astral.sh/uv/), and Node 20.19+ (`web/.nvmrc`; `npm ci` refuses older Node). After a one-time package download (`uv sync`, `npm ci`), everything below runs offline against the committed outputs, except `make debris`: it downloads USGS's inventory and assessments and 256 ERA5-Land soil-moisture series on its first run, and step 15 needs the model file step 14 writes (`pipeline/work/debris_flow/models.joblib`, not committed). With those cached, the two steps take under 2 minutes.

```bash
cd pipeline && uv sync
make test                                        # pipeline tests on the Eaton and Palisades outputs, incl. README headline drift
make eval EVAL_DIR=/tmp/ember-eval               # re-run the real Eaton hold-out; matches eval/ignition_holdout.json (5-15 min)
make eval FIRE=palisades EVAL_DIR=/tmp/ember-eval-pal  # the same for Palisades (about 12 min)
make eval QUICK=1 EVAL_DIR=/tmp/ember-eval-quick # recompute 2 synthetic cases and check them against the committed ones (about 8 min)
make report                                      # regenerate docs/RESULTS.md and the README headline table
make debris                                      # debris-flow models and maps (needs network: ScienceBase, Open-Meteo)

cd ../web && npm ci
npm test                                         # analyst tests (no key needed)
npm run build                                    # typecheck app + API, production build
npm run eval:analyst -- --truth --fire palisades # print an analyst eval's ground truth (no key needed)
npm run dev                                      # the app at http://localhost:5173 (?fire=palisades); no key needed
```

With network access, `make all` rebuilds every output from the public sources (`make FIRE=palisades all` for Palisades). `make eval-full` reruns the whole synthetic benchmark and the wind ablation: about 70 min for Eaton and 100 min for Palisades on a 10-core laptop ([`docs/reproduction/`](docs/reproduction)).

With a Meta key in `.env` (`cp .env.example .env`):
- `npm run ask -- "When did the fire reach Lake Avenue?"` asks the analyst one question.
- `npm run eval:analyst` scores it.
- `npm run dev` also answers in the app's Analyst tab (`POST /api/analyst`).

## Meta models

| Model | Role | Status |
|---|---|---|
| `muse-spark-1.3` (Meta Model API, OpenAI-compatible) | The analyst: a tool-calling loop over the reconstructed fire. Citations and numbers are verified server-side, and an independent per-fire eval includes must-decline questions | Run live on both fires: 25 of 27 eval answers right, all 37 cited ids valid ([`RESULTS.md`](docs/RESULTS.md#analyst-eval)) |
| `sam-3.1` (Meta Model API, Responses API) | Fire and smoke masks in drone video; destroyed-building masks in post-fire imagery | Live smoke test passes ([`tools/smoke_meta.py`](pipeline/tools/smoke_meta.py), [log](pipeline/logs/smoke-meta.log)). The two SAM pipeline steps, drone video ([`s12c_sam_video.py`](pipeline/steps/s12c_sam_video.py)) and destroyed buildings ([`s09c_sam_structures.py`](pipeline/steps/s09c_sam_structures.py)), are stubs in this branch |

## Prior work and credits

- **Sentinel** ([`benjaminxie1/sentinel-app`](https://github.com/benjaminxie1/sentinel-app)) is a team member's earlier open-source fire/smoke detector. Its trained YOLOv8 model is planned as a dependency for the drone part of the build. Everything else is built during the hackathon.
- **Design inspiration:** the layout and interaction model are inspired by Dilum Sanjaya's "FireTrace" wildfire-analysis concept, shared on X. Its name and logo are not used.
- **Data:** every source, with its licence note and status (REAL, MODELED or SIM), is in each fire's `manifest.json` and the app's Evidence tab. Source details are in [`docs/spec/BUILD.md`](docs/spec/BUILD.md) §5.

## Docs

- [`docs/RESULTS.md`](docs/RESULTS.md): every evaluation number, generated from the committed outputs
- [`docs/spec/BUILD.md`](docs/spec/BUILD.md): architecture, data pipeline, models, evaluation plan, schedule
- [`docs/spec/DESIGN.md`](docs/spec/DESIGN.md): UI specification
- [`docs/spec/WORKSTREAMS.md`](docs/spec/WORKSTREAMS.md): the three workstreams and their file and API contracts
- [`docs/judge/RUBRIC.md`](docs/judge/RUBRIC.md) and [`judge-round.js`](docs/judge/judge-round.js): the fixed rubric and the harness this repo is judged with each round; [`rounds/`](docs/judge/rounds) holds each round's raw results
