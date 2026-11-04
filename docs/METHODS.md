# How the hard part works

How [Sentinel Ember](../README.md) builds each part. The numbers these parts produce are in the README's Evidence table and in [`RESULTS.md`](RESULTS.md).

- [Arrival time](#arrival-time)
- [Wind field](#wind-field)
- [Spread model](#spread-model)
- [Inversion](#inversion)
- [Calibrated uncertainty and the identifiability rule](#calibrated-uncertainty-and-the-identifiability-rule)
- [Synthetic benchmark](#synthetic-benchmark)
- [House-level exposure](#house-level-exposure)
- [Analyst](#analyst)
- [Web app](#web-app)

## Arrival time

Code: [`s06_arrival.py`](../pipeline/steps/s06_arrival.py), with the area and spread-rate series and key events in [`s10_events.py`](../pipeline/steps/s10_events.py).

Timed NIFC perimeters are cleaned:
- Re-saves are dropped.
- Placeholder triangles from the incident-reporting system are removed.
- Cumulative footprints are clipped to the final perimeter.

Each cell's arrival is then interpolated by distance between consecutive footprints. The first interval is seeded from CAL FIRE's reported start time and location. For Eaton the reported point lies outside the first mapped perimeter, so the seed is that perimeter's nearest cell, 1.7 km away (`arrival_meta.json` records this). For Palisades, whose first map is 26 h in, that seeded interval covers about half the burned area. Times are observed only at the perimeter times, so the layer is labelled MODELED.

## Wind field

Code: [`s07_weather.py`](../pipeline/steps/s07_weather.py).

HRRR is sampled hourly on a grid of points about 3 km apart over each fire area: 4×6 for Eaton, 5×7 for Palisades. Each model is compared with the nearest airport station at the station's own location: HRRR, ERA5 and ECMWF IFS. HRRR tracks hourly wind and humidity better than ERA5 at both stations, which is why it drives the spread model. `wind_field.json` is published for the app.

## Spread model

Code: [`ember/spread.py`](../pipeline/ember/spread.py).

- **Rate of spread:** elliptical, from a per-fuel base rate (ESA WorldCover classes) times a power-law wind term and a tan²-slope term.
- **Fire shape:** Anderson's length-to-breadth ratio, up to a cap.
- **Arrival:** a time-dependent Dijkstra over a 16-neighbour stencil. Wind is interpolated bilinearly per cell from the HRRR grid, and in time to 15 minutes. The stencil never cuts across non-burnable corners.
- **Speed:** compiled with numba and run in parallel.

## Inversion

Code: [`s11_ignition.py`](../pipeline/steps/s11_ignition.py).

The search runs over (ignition cell, start time, spread-rate scale k):
- **Candidates:**
  - Cells on a lattice inside the first observed footprint.
  - Up to 16 start times, log-spaced from 0.5 h to 90 h before that footprint, and never before the weather record begins.
  - 17 values of k, from 0.25 to 64. Refinement can go 20% past the top, to 76.8; a fit that ends there is reported as at the ceiling.
- **Scoring:** each candidate is simulated forward and scored against every observed footprint with a weighted hinge loss. Cells inside a footprint should have burned by then; a band outside it should not have. Earlier footprints weigh more.
- **Refinement:** a second stage refines the best eight candidates.
- **Fire shape per fit:** the ellipse's length-to-breadth cap is chosen per fit, from 1 to 8, by loss on the real perimeters. With realistic winds, Anderson's curve makes the model fire far narrower than these fires were (spotting and gusts that swing direction widen a real fire), and the cap is how the fit corrects for that. Eaton's fit picks 1, a round fire, so wind no longer sets its shape; Palisades picks 1.5. The hold-out chooses its own cap without the held-out perimeters.

## Calibrated uncertainty and the identifiability rule

The relative likelihood over the stage-1 grid gives a posterior heatmap, a 90% radius and a 90% start-time interval. That grid is regular (lattice cells × log-spaced lags × log-spaced k), so the implied prior is uniform over the lattice and log-uniform over lag and k; each lattice cell's weight is spread over the cells nearest it. Stage 2 only sharpens the point estimate: counting its dense neighbourhoods would weight cells by how often they were evaluated.
- **Not hand-tuned:** the temperature is calibrated on each fire's own synthetic fires. Half the cases pick it; coverage is reported on the other half. Where no temperature tried reaches 90% on the calibration half, the widest is used, the fit is flagged uncalibrated in the outputs, the app and the analyst, and its start time is withheld.
- **Matched to the fit it serves:** the hold-out and the product fit use different observations, so each gets its own calibration. Both calibrations invert with the product fit's shape cap; the hold-out picks its own cap, which matches for Eaton (1) but not for Palisades (8 vs 1.5).
- **When the start time is withheld:** if the interval is wider than 6 h, k sits at the model's ceiling, or the uncertainty is uncalibrated. The timeline then omits the estimated start and the analyst declines to give one.
- **Inputs to the rule:** it looks only at the fit, never at CAL FIRE's reference. The synthetic benchmark does borrow the real fire's observation delays, measured from CAL FIRE's reported start.

## Synthetic benchmark

Each synthetic fire runs on the fire's real terrain, fuels and HRRR wind field, and is observed on its real perimeter schedule. The truth runs the same spread equations as the inverting model, but on inputs the model never sees:
- per-fuel rates ±25–30%;
- a smooth, patchy fuel field the model never sees;
- wind speed ±15%, direction ±15° and timing ±1.5 h;
- a perturbed length-to-breadth cap;
- ±1-cell mapping noise.

Synthetic start times are drawn uniformly 2–8 h into the replay window, a range that brackets CAL FIRE's reported start for both fires (2.3 h and 6.5 h in); the inversion itself never uses this prior.

The spread-rate range is centred on the fuel table itself: k log-uniform 0.25–4, i.e. its base rates off by up to 4× either way. It has not always been: commit `0eab9dc` drew k from 4–16 to resemble the real Eaton fit of the time (k ≈ 11), and `66e8516` moved it to 0.25–4 when the HRRR fit brought Eaton's k to 0.42. Other design choices (the shape cap, the start-time lags) were also diagnosed on the real Eaton grid, so the real Eaton hold-out is a sanity check rather than an independent test. The real Palisades fits (k 22.6 in the hold-out, 76.8 at the ceiling in the full fit) lie outside the synthetic range, so Palisades' synthetic coverage describes slower fires than the real one. Each case is inverted twice: on every footprint, as the app does, and with the first two held out, as in the real hold-out. `make eval QUICK=1` recomputes the first cases and checks that they match the committed ones exactly.

## House-level exposure

Code: [`s09b_exposure.py`](../pipeline/steps/s09b_exposure.py).

Each residence within about 100 m of the burn gets three exposure values:
- **Arrival time.** Homes just outside the burned cells take the nearest burned cell's time, and are flagged.
- **HRRR gust** at that place and hour.
- **Distance to wildland:** tree, shrub or grass cover where under 20% of a 500 m window is built up.

The analysis on top:
- **Odds ratios:** each construction feature gets a Mantel–Haenszel odds ratio of destruction, stratified by gust × distance, with a Robins–Breslow–Greenland confidence interval.
- **Regression:** a logistic regression fits all features together.
- **Observability check:** the share of "unknown" answers among destroyed versus surviving homes, because inspectors record a destroyed home's features after the fire.

## Analyst

Code: [`web/api/_lib/`](../web/api/_lib), and the chat in [`rail/analyst.tsx`](../web/src/rail/analyst.tsx).

- **Tools:** Muse Spark gets 9 read-only tools over the fire files (place lookup, arrival at a point, street burn times, fire state at a time, weather, structures, events, the ignition back-trace, exposure statistics) plus a `final_answer` call.
- **Checks before a paragraph is returned** ([`verify.ts`](../web/api/_lib/verify.ts)):
  - It must cite a tool result from the same conversation.
  - Every number and clock time in it must appear in the cited tool results or in the question. Rounding is allowed; computed numbers are not. Small whole numbers up to 10 are exempt.
  - It must not match the cause, attribution or address patterns.
- **What happens to failures:** dropped paragraphs are counted by reason.
- **In the app:** the chat's citation chips move the map and the clock. Without `MODEL_API_KEY` the chat shows the server's message, never an answer.
- **Spend limits on the public site:**
  - **Hard dollar cap** ([`budget.ts`](../web/api/_lib/budget.ts)): Meta bills pay-as-you-go, and its console spend limit only sends an alert. So every model call first reserves its worst-case cost in one shared Upstash Redis counter, in a single atomic step, and refuses if that would pass the cap. The worst case is the request's bytes plus a 16,384-token output cap, at Meta's published `muse-spark-1.3` prices. The counter then settles to the cost the reply reports.
  - **The cap itself:** `ANALYST_BUDGET_USD` sets it, $100 by default and never more than $150. Without the shared counter the analyst refuses rather than spend untracked; local runs can opt into an in-process count with `ANALYST_BUDGET_LOCAL=1`.
  - **Rate limits** ([`ratelimit.ts`](../web/api/_lib/ratelimit.ts)): 10 questions per 30 minutes per visitor (a report counts as 3) and 60 per hour per server instance, so no single visitor can exhaust the budget. A refused request gets HTTP 429 and says when to retry. Chat history is capped at 8,000 characters.
- **Eval** ([`scripts/eval-analyst.ts`](../web/scripts/eval-analyst.ts)): 18 questions per fire, with ground truth computed from the data files by code independent of the tools. Arrival-time truths come from the interpolated arrival raster, so they are MODELED, not observed. Questions with no truth in the data are skipped and listed, so 17 are scored for Eaton and 16 for Palisades. Where the back-trace withholds a start time, the ignition question becomes a must-decline question.
- **Live rerun** (2026-11-03, one run per fire, after the street-tool fix below; [`eaton`](../web/public/data/eaton/eval/analyst.json), [`palisades`](../web/public/data/palisades/eval/analyst.json)): 17 of 17 answers right for Eaton and 16 of 16 for Palisades, including new street questions. All 43 cited ids came from a tool result, and the verifier dropped no paragraph.
- **First live run** (2026-10-31, 15 questions per fire):
  - 13 of 14 answers right for Eaton and 12 of 13 for Palisades. Numbers 16 of 16, the must-decline start time 2 of 2, times 7 of 9. All 37 cited ids came from a tool result, and the verifier dropped no paragraph.
  - **Both misses were the tool, not the model.** Each was a street's first burn time: Kinneloa Canyon Road (Eaton) and Pacific Coast Highway (Palisades). The model reported exactly what `street_fire_timeline` returned. That tool sampled streets every 40 m over arrival cells of about 16 m, so it read Kinneloa Canyon Road, which clips the burn, as unburned, and put the highway 37 min late.
  - The tool now walks every cell a street crosses. A test checks every eval street against an independent 1 m walk of the raster, and it fails on the old code for exactly these two. The committed scores are from the rerun after the fix.
  - One question was reworded before the run: Meta's content filter rejected the vents odds-ratio question, so it now asks for the odds ratio `exposure_stats` lists for the vents contrast.

## Web app

Code: [`web/src/`](../web/src).

The app replays each fire on 3D terrain from the pipeline's files, on Eaton and Palisades (switch fires from the header).
- **The map:** the interpolated progression from `arrival.png`, the burn scar (AVIRIS-3 dNBR, the differenced Normalized Burn Ratio, a standard burn-severity index), the mapped perimeter at the current time, the ignition estimate and its 90% region beside CAL FIRE's reported point, structures, roads and HRRR wind arrows (a layer toggle, off by default).
- **One timeline:** charts, key events, weather at the current time, the back-trace and house-level analysis, and the source manifest all follow it.
- **Tabs:** the Risk tab takes the place of the Resources tab in the original design. The Drones tab plays the bundled BLM clips with cached Sentinel boxes and SAM 3.1 masks, and its Live mode runs Sentinel in the browser (onnxruntime-web) on a camera, screen or video stream, with SAM 3.1 outlines through `POST /api/sam` when the server has a key. The Incident rail's Swarm tab replays the simulated drone swarm ([SWARM.md](SWARM.md)), and the Spread Forecast layer shows the committed +1 h forecasts ([FORECAST.md](FORECAST.md)).
