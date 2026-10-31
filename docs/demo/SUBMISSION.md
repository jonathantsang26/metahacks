# Submission write-up

Draft text for the hackathon submission form, in the usual Devpost sections. Check the official form's fields and character limits, and trim to fit. Every number here comes from the README's Evidence table or `docs/RESULTS.md`; if those change, update this file to match.

Items in [brackets] depend on work still landing (the Risk tab, a live analyst run, the drone stream). Delete or fill them before submitting.

---

## Project name

Sentinel Ember

## Tagline

A forensic reconstruction of a real wildfire from public records: when the fire reached each street, where it started, and which homes survived.

## Inspiration

In January 2025 the Eaton and Palisades fires burned more than 37,000 acres of Los Angeles County. After a fire like that, someone has to explain what happened: after-action review teams, recovery and rebuild planners, insurance and legal investigators, journalists. Today they rebuild the timeline by hand from a dozen agency services that don't line up. Perimeters are snapshots hours apart (Eaton's first map came 4.8 hours after the reported start; Palisades' came 26 hours after), wind comes from a few airport stations, and the damage inspections are a separate table of about 30,000 structures.

For these two fires, every one of those inputs is now public and machine-readable. We wanted to see how much of the story could be rebuilt from them, honestly labelled as observed or modeled.

## What it does

Sentinel Ember replays each fire on 3D terrain, with one clock that drives the map, the charts, the weather and the key events.

- **When the fire reached each street.** An arrival time for every burned place, interpolated between NIFC's timed perimeters and seeded from CAL FIRE's reported start. Fire area, rate of spread and the elevation profile along the spread path all follow from it.
- **Where and when it started.** A back-trace inverts a fire-spread model through every observed perimeter and gives a location with a calibrated 90% radius. A start time is shown only when the data pin it to within 6 hours. For both real fires they don't, so the app withholds it instead of guessing.
- **Which homes survived.** Every inspected home gets its exposure (when the fire arrived, the gust at that hour, its distance to wildland), and construction features are compared at matched exposure.
- **[Post-fire debris-flow risk.** The Risk tab scores each stream segment in the burn scars under USGS's design storms, and compares USGS's model with our own [models].]
- **An analyst you can question.** Meta's Muse Spark answers questions about the fire through nine read-only tools, and every paragraph it returns is checked: it must cite a tool result, and every number in it must appear in what the tools returned. Citation chips move the map and the clock to the place and time they cite.

Every layer is tagged REAL or MODELED, and every source with its licence is listed in the app's Evidence tab.

## How we built it

- **Pipeline (Python, 12 steps).** Pulls NIFC's 2025 perimeter archive, CAL FIRE's damage inspections (DINS), NASA JPL's AVIRIS-3 burn severity, NOAA HRRR 3 km wind through Open-Meteo, ESA WorldCover fuels and USGS terrain, and writes one set of files per fire.
- **Spread model.** Elliptical rate of spread from per-fuel base rates, a wind term and a slope term, solved as a time-dependent Dijkstra over a 16-neighbour stencil with hourly HRRR wind interpolated per cell. Compiled with numba.
- **Inversion.** Searches over ignition cell, start time and a spread-rate scale; scores each candidate against every observed perimeter; refines the best eight. The posterior's temperature is calibrated on each fire's own synthetic fires, and coverage is reported on held-out synthetic cases.
- **Synthetic benchmark.** 30 synthetic fires per real fire, run on its real terrain, fuels and wind and observed on its real perimeter schedule, with truth physics that differs from the model (perturbed fuel rates, a hidden patchy fuel field, wind noise, mapping noise).
- **House-level exposure.** Mantel–Haenszel odds ratios stratified by gust and distance to wildland, a logistic regression, and a check of how often features are recorded as "unknown" on destroyed versus surviving homes.
- **Analyst.** A tool-calling loop on `muse-spark-1.3` over the Meta Model API's OpenAI-compatible endpoint, with server-side citation, number and guardrail checks, and a 15-question eval per fire whose ground truth is computed by code independent of the tools.
- **Web app.** React, deck.gl and a custom terrain shader that colours the fire from the arrival raster in real time. Built as a static site plus one serverless function for the analyst (configured for Vercel).

## Results

| | Eaton | Palisades |
|---|---|---|
| Start-time error on synthetic fires (median): back-trace vs √area back-extrapolation | 78 min vs 21.6 h | 4.6 h vs 37.0 h |
| Location error on synthetic fires (median): back-trace vs first-footprint centroid | 588 m vs 449 m | 526 m vs 1,624 m |
| 90% radius / interval held the truth, on synthetic cases the calibration never saw | 87% / 93% | 100% / 100% |
| HRRR vs ERA5, hourly wind against the nearest airport station (r) | 0.90 vs 0.71 | 0.85 vs 0.75 |
| Odds of destruction, fine-mesh vs coarse vents, at matched exposure (95% CI) | 0.35 (0.31–0.40) | 0.50 (0.45–0.56) |
| Odds of destruction, tile/metal/concrete vs asphalt/wood roof | 0.59 (0.53–0.66) | 0.58 (0.53–0.64) |

The back-trace beats the usual baseline on start time for both fires. On location it is mixed: for Eaton the first perimeter's centroid is closer on the median, and the back-trace wins once the early perimeters are held out. The house-level results are associations adjusted for recorded exposure, not effects.

## Use of Meta models

- **Muse Spark (`muse-spark-1.3`)** is the analyst: a tool-calling loop whose answers are verified on the server before the user sees them. [It was run live against the eval: N of 14 Eaton and N of 13 Palisades questions correct, with the must-decline questions declined.] / [It is built and tested offline; the live run waits on a key.]
- **SAM 3.1 (`sam-3.1`)** [segments fire and smoke in drone footage, seeded by Sentinel's YOLOv8 detections, with frame-level precision and recall on FLAME 2.] / [has a smoke test against the Meta Model API; the drone stream did not land in time.]

## Challenges

- **Sparse, late perimeters.** Palisades' first map is 26 hours in. That first interval covers about half its burned area, so the arrival layer is labelled MODELED throughout.
- **Honest uncertainty.** An early version of the posterior counted the refinement stage's dense candidates, which made Eaton's start-time interval look tight enough to show, and it missed CAL FIRE's start. We rebuilt the posterior from the regular grid alone, calibrated it on held-out synthetic fires, and added the 6-hour rule that now withholds both real start times.
- **A fire the model can't reproduce.** Without spotting, no wind field we tried could grow Palisades as fast as it burned; the spread-rate scale sits at its ceiling. We report that rather than tune around it.
- **Recording bias in the inspections.** Destroyed homes have far more "unknown" construction fields, because the features burned away. We measure that and show it beside every contrast.

## Accomplishments we're proud of

- A start-time estimator that is far closer than the baseline on synthetic fires, and that knows when not to answer.
- An analyst that cannot show a number it didn't read from the data.
- Every headline number generated from committed files, with a test that fails if the README drifts from them.

## What we learned

The hard part of forensic reconstruction isn't the model, it's saying how sure you are. Most of our time went into calibration, hold-outs and the rules for when to withhold an answer.

## What's next

- Spotting and gust variability in the spread model, so it can grow fires like Palisades.
- [Turning the Risk tab's per-storm likelihood into a yearly chance with NOAA Atlas 14 return periods.]
- The drone stream: Sentinel detection and SAM 3.1 segmentation on real footage.
- More fires: the pipeline is parameterized by one config file per fire.

## Built with

Python, numba, uv, TypeScript, React, Vite, deck.gl, loaders.gl, Tailwind, Vercel, Meta Model API (Muse Spark [, SAM 3.1]), NOAA HRRR, Open-Meteo, NIFC, CAL FIRE DINS, NASA JPL AVIRIS-3, ESA WorldCover.

## Prior work and credits

- **Sentinel** ([`benjaminxie1/sentinel-app`](https://github.com/benjaminxie1/sentinel-app)) is a team member's earlier open-source fire and smoke detector. [Its trained YOLOv8 model is used as a dependency for the drone stream.] Everything else was built during the hackathon.
- The layout and interaction model are inspired by Dilum Sanjaya's "FireTrace" wildfire-analysis concept, shared on X. Its name and logo are not used.
- Data sources and licences are listed in each fire's `manifest.json` and in the app's Evidence tab.

## Links

- Code: https://github.com/jonathantsang26/metahacks
- Live app: [deployed URL]
- Demo video: [video URL]
