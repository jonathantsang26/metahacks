# Submission write-up

Draft text for the hackathon submission form, in the usual Devpost sections. Check the official form's fields and character limits, and trim to fit. Every number here comes from the README (its Evidence table and its Analyst and Post-fire debris flows sections) or `docs/RESULTS.md`; if those change, update this file to match.

The one item left in [brackets] is the video URL. Fill it in before submitting.

---

## Project name

Sentinel Ember

## Tagline

A forensic reconstruction of a real wildfire from public records: when the fire reached each street, where it started, and which homes survived.

## Inspiration

In January 2025 the Eaton and Palisades fires burned more than 37,000 acres of Los Angeles County. After a fire like that, someone has to explain what happened: after-action review teams, recovery and rebuild planners, insurance and legal investigators, journalists. Today they rebuild the timeline by hand from a dozen agency services that don't line up. Perimeters are snapshots hours apart (Eaton's first map came 4.8 hours after the reported start; Palisades' came 26 hours after), wind comes from a few airport stations, and the damage inspections are a separate table of about 30,000 structures.

For these two fires, every one of those inputs is now public and machine-readable. We wanted to see how much of the story could be rebuilt from them, honestly labelled as observed or modeled.

## What it does

Sentinel Ember replays each fire on 3D terrain, with one clock that drives the map, the charts, the weather and the key events. It runs live at https://sentinel-ember.vercel.app.

- **When the fire reached each street.** An arrival time for every burned place, interpolated between NIFC's timed perimeters and seeded from CAL FIRE's reported start. Fire area, rate of spread and the elevation profile along the spread path all follow from it.
- **Where and when it started.** A back-trace inverts a fire-spread model through every observed perimeter and gives a location with a calibrated 90% radius. A start time is shown only when the data pin it to within 6 hours. For both real fires they don't, so the app withholds it instead of guessing.
- **Which homes survived.** Every inspected home within about 100 m of the burn gets its exposure (when the fire arrived, the gust at that hour, its distance to wildland), and construction features are compared at matched exposure.
- **Where debris flows could follow.** The Risk tab scores each of USGS's stream segments in the burn scars (956 for Eaton, 1,864 for Palisades) under USGS's seven design storms, and compares USGS's published model with two of our own fitted on USGS's observed debris-flow inventory: the same model recalibrated, and a random forest. There are no 2025 outcomes to score against yet, so the maps are compared with USGS's assessment, not validated.
- **An analyst you can question.** Meta's Muse Spark answers questions about the fire through nine read-only tools, and every paragraph it returns is checked: it must cite a tool result, and every number in it must appear in what the tools returned. Citation chips move the map and the clock to the place and time they cite. It runs live on the public site, behind a hard spend cap and per-visitor rate limits.

Every layer is tagged REAL or MODELED, and every source with its licence is listed in the app's Evidence tab.

## How we built it

- **Pipeline (Python, 12 steps, plus two for debris flows).** Pulls NIFC's 2025 perimeter archive, CAL FIRE's damage inspections (DINS), NASA JPL's AVIRIS-3 burn severity, NOAA HRRR 3 km wind through Open-Meteo, ESA WorldCover fuels and USGS terrain, and writes one set of files per fire. The debris-flow steps add USGS's observed debris-flow inventory, its hazard assessments for both fires, and ERA5-Land soil moisture through Open-Meteo.
- **Spread model.** Elliptical rate of spread from per-fuel base rates, a wind term and a slope term, solved as a time-dependent Dijkstra over a 16-neighbour stencil with hourly HRRR wind interpolated per cell. Compiled with numba.
- **Inversion.** Searches over ignition cell, start time and a spread-rate scale; scores each candidate against every observed perimeter; refines the best eight. The posterior's temperature is calibrated on each fire's own synthetic fires, and coverage is reported on held-out synthetic cases.
- **Synthetic benchmark.** 30 synthetic fires per real fire, run on its real terrain, fuels and wind and observed on its real perimeter schedule. The synthetic fires use the same spread equations as the model, on inputs the model never sees (perturbed fuel rates, a hidden patchy fuel field, wind and mapping noise), so they test parameter misspecification only, not missing physics such as spotting.
- **House-level exposure.** Mantel–Haenszel odds ratios stratified by gust and distance to wildland, a logistic regression, and a check of how often features are recorded as "unknown" on destroyed versus surviving homes.
- **Debris-flow models.** USGS's M1 model reimplemented (it reproduces USGS's published likelihoods to within 5×10⁻¹⁶), then refitted on 7,639 usable watershed-storm records from 77 fires in USGS's inventory, beside a random forest that adds watershed area, days since the fire and antecedent soil moisture and is constrained never to fall as rainfall rises. Every fitted model is scored leaving one fire out; an MLP is evaluated but not mapped.
- **Analyst.** A tool-calling loop on `muse-spark-1.3` over the Meta Model API's OpenAI-compatible endpoint, with server-side citation, number and guardrail checks, and a 15-question eval per fire whose ground truth is computed by code independent of the tools. On the public site, every model call first reserves its worst-case cost against a hard dollar cap in one shared counter, and each visitor gets 10 questions per 30 minutes.
- **Web app.** React, deck.gl and a custom terrain shader that colours the fire from the arrival raster in real time. Built as a static site plus one serverless function for the analyst, deployed on Vercel at https://sentinel-ember.vercel.app.

## Results

| | Eaton | Palisades |
|---|---|---|
| Start-time error on synthetic fires (median): back-trace vs √area back-extrapolation | 78 min vs 21.6 h | 4.6 h vs 37.0 h |
| Location error on synthetic fires (median): back-trace vs first-footprint centroid | 588 m vs 449 m | 526 m vs 1,624 m |
| 90% radius / interval held the truth, on synthetic cases the calibration never saw | 87% / 93% | 100% / 100% |
| HRRR vs ERA5, hourly wind against the nearest airport station (r) | 0.90 vs 0.71 | 0.85 vs 0.75 |
| Odds of destruction, fine-mesh vs coarse vents, at matched exposure (95% CI) | 0.35 (0.31–0.40) | 0.50 (0.45–0.56) |
| Odds of destruction, tile/metal/concrete vs asphalt/wood roof | 0.59 (0.53–0.66) | 0.58 (0.53–0.64) |
| Analyst live on `muse-spark-1.3`: answers matching the data-derived truth; cited ids a tool returned | 17/17; 23/23 | 16/16; 20/20 |

The back-trace beats the usual baseline on start time for both fires. On location it is mixed: for Eaton the first perimeter's centroid is closer on the median, and the back-trace wins once the early perimeters are held out. The house-level results are associations adjusted for recorded exposure, not effects. On debris flows, machine learning did not clearly beat USGS's model: on records that model was not fitted on, the random forest's median within-storm ROC AUC is +0.015 above it, with a 95% interval (−0.063 to +0.097) that includes zero.

## Use of Meta models

- **Muse Spark (`muse-spark-1.3`)** is the analyst: a tool-calling loop whose answers are verified on the server before the user sees them. Its first live eval run got 13 of 14 Eaton and 12 of 13 Palisades questions right; both misses were our street tool's 40 m sampling, not the model. After fixing the tool, the live rerun (2026-11-03) got 17 of 17 and 16 of 16, with the must-decline start-time questions declined and all 43 cited ids taken from a tool result. Muse Spark also made the Eaton +1 h spread forecasts and flew the simulated drone swarm as commander and squad agents; those runs were live and their outputs are cached and replayed in the app. It also runs live on the public site, behind a hard spend cap and per-visitor rate limits.
- **SAM 3.1 (`sam-3.1`)** outlines fire in the Drones tab. In Live mode, frames from a camera, screen or video stream go to SAM 3.1 through the app's `/api/sam` route while Sentinel has a box. On the bundled clips the masks were computed once through the API and are cached. On the DeepQuest test split it detects fire or smoke frames at precision 1.00 and recall 0.945.

## Challenges

- **Sparse, late perimeters.** Palisades' first map is 26 hours in. That first interval covers about half its burned area, so the arrival layer is labelled MODELED throughout.
- **Honest uncertainty.** An early version of the posterior counted the refinement stage's dense candidates, which narrowed Eaton's hold-out start-time interval to 5.9 hours, just inside the 6-hour rule, so a start time was shown, and it missed CAL FIRE's start. We rebuilt the posterior from the regular grid alone and calibrated it on held-out synthetic fires; under the same 6-hour rule, both real start times are now withheld.
- **A fire the model can't reproduce.** No wind field we tried could grow Palisades as fast as it burned, and neither could a simple spotting term we tested; the spread-rate scale sits at its ceiling. We report that rather than tune around it.
- **Recording bias in the inspections.** Destroyed homes have far more "unknown" construction fields, because the features burned away. We measure that and show it beside every contrast.

## Accomplishments we're proud of

- A start-time estimator that is far closer than the baseline on synthetic fires, and that knows when not to answer.
- An analyst that cannot show a number it didn't read from the data.
- Every headline number generated from committed files, with a test that fails if the README drifts from them.

## What we learned

The hard part of forensic reconstruction isn't the model, it's saying how sure you are. Most of our time went into calibration, hold-outs and the rules for when to withhold an answer.

## What's next

- A fuller spotting model and gust variability in the spread model, so it can grow fires like Palisades.
- Turning the Risk tab's per-storm likelihood into a yearly chance with NOAA Atlas 14 return periods.
- Running the live drone detection on a real drone feed with flight telemetry, and scoring it on FLAME 2.
- More fires: the pipeline takes each fire from one entry in `pipeline/fire.yaml`.

## Built with

Python, numba, scikit-learn, uv, TypeScript, React, Vite, deck.gl, loaders.gl, Tailwind, Vercel, Upstash Redis, Meta Model API (Muse Spark, SAM 3.1), onnxruntime-web, MuJoCo, NOAA HRRR, Open-Meteo, ERA5-Land, NIFC, CAL FIRE DINS, NASA JPL AVIRIS-3, ESA WorldCover, USGS post-fire debris-flow inventory and hazard assessments.

## Prior work and credits

- **Sentinel** ([`benjaminxie1/sentinel-app`](https://github.com/benjaminxie1/sentinel-app)) is a team member's earlier open-source fire and smoke detector. Its shipped model file, `fire_yolov8n.pt`, turned out to be the stock COCO YOLOv8n with no fire class, so for the drone stream we fine-tuned it on FireNET during the hackathon ([PR #5](https://github.com/jonathantsang26/metahacks/pull/5)) and exported it to ONNX to run in the browser. Sentinel itself is prior work; everything else, including that fine-tuning, was built during the hackathon.
- The layout and interaction model are inspired by Dilum Sanjaya's "FireTrace" wildfire-analysis concept, shared on X. Its name and logo are not used.
- Data sources and licences are listed in each fire's `manifest.json` and in the app's Evidence tab.

## Links

- Code: https://github.com/jonathantsang26/metahacks
- Live app: https://sentinel-ember.vercel.app
- Video: [video URL]
