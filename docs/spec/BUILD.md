# BUILD.md: Sentinel Ember build spec

**Target**: **Meta Global AI Developer Hackathon** (Meta × Cerebral Valley, virtual). Projects must be built on Meta's models.

**Goal**: rebuild the reference UI (DESIGN.md) on a **real fire** with **real public data**. **Meta's SAM 3.1 and Muse Spark have to do real work in the product.** Ben's Sentinel detector is a disclosed open-source dependency.

**Deadline**:
- The third-party listing says **Nov 5, 6:30 AM IST, which is Wed Nov 4, 5:00 PM PST**. Confirm it in your participant email.
- Our target is **Tue Nov 3, 6 pm**. Tue evening and Wed morning are buffer.

The data sources in §5 were checked live on Oct 29, 2026, by querying the endpoints. Rows marked *unverified* could not be confirmed.

---

## 0. One-paragraph summary for a fresh Claude Code session

We are building a web app for the Meta Global AI Developer Hackathon. It replays a real wildfire as a 3D/2D forensic analysis, and the layout copies DESIGN.md.
- **Time**: everything on screen is driven by one global time `t`.
- **Spread**: the fire's spread is encoded as an **arrival-time raster**, built offline from time-stamped satellite detections and perimeters, so scrubbing time is a cheap lookup.
- **Ignition**: a forensic module estimates where and when the fire started by back-tracing the spread, and is scored on held-out evidence.
- **Meta models in the product**:
  - **SAM 3.1** (hosted on the Meta Model API) segments fire and smoke in real drone footage, alongside Ben's Sentinel YOLOv8 boxes, and segments destroyed buildings in post-fire imagery. The building masks are scored against CAL FIRE inspections.
  - **Muse Spark** is an analyst agent. It answers questions and writes the incident report by calling tools over our data, and it cites a source for every claim.
- **Labeling**: anything that isn't real data is labelled `SIM`.

## 1. Stack (decided)

| Concern | Choice | Why |
|---|---|---|
| App | Vite + React 18 + TypeScript + Tailwind | Same React/Tailwind as Sentinel's UI, and fast to scaffold |
| Map + 3D | **deck.gl 9** with `react-map-gl` / **MapLibre GL** | One geo-native stack covering terrain mesh, draped layers, first-person camera, multiple views and instancing |
| State | Zustand (`useTime`, `useSelection`, `useLayers`) | One store for `t` that every panel subscribes to |
| Charts | visx (or Recharts if faster for the dev) | Needs a custom time-cursor overlay and past/future styling |
| Pipeline | Python 3.11 + uv: rasterio, numpy, scikit-image, geopandas, shapely, pystac-client, requests | Runs offline once and writes static assets |
| Hosting | Vercel: static data under `public/data/` plus **one serverless function `api/analyst`** | Judges get a link. The Meta API key stays server-side. |
| **Segmentation** | **SAM 3.1 via the Meta Model API** (model `sam-3.1`, text/image/video in → boxes + masks out), called from the pipeline | Hosted, so no GPU of our own. Fallback: run `facebookresearch/sam3` locally on a CUDA GPU (gated Hugging Face weights, SAM License, 848M params, CUDA 12.6+). Request HF access tonight anyway. |
| **Reasoning** | **Muse Spark via the Meta Model API**: OpenAI-compatible at `https://api.meta.ai/v1`, model `muse-spark-1.3`, bearer `MODEL_API_KEY` | Reuse the `openai` SDK with `baseURL` swapped. Meta's docs describe parallel tool calls. Confirm tool calling on Chat Completions in the Thursday smoke test. |
| Sentinel | Imported as a library by the pipeline (git submodule `vendor/sentinel-app`) and **disclosed as prior work** | Runs `fire_yolov8n.pt` on drone video. Its boxes seed SAM's prompts and appear in the Detections panel. |
| Muse Code / Muse Image | Muse Code only if the team actually codes with it (disclose it); no Muse Image | Don't invent a runtime role for a tool just to tick a box. |

Use a **web app, not Tauri**, for the hackathon: a judge can open a URL but won't install a desktop app. Folding this into Sentinel's Tauri shell as a new "Incident" view is a post-hackathon step.

deck.gl pieces to use (current release is 9.4.1):
- `TerrainLayer`: DEM image → mesh with a texture on it
- `SimpleMeshLayer` / `ScenegraphLayer`: instanced trees, aircraft and engines
- `PathLayer` / `TripsLayer`: spine, tracks, wind streamlines
- `TextLayer` / `IconLayer`: labels, waypoints
- `FirstPersonView` as a second view, for the drone PiP and the cockpit camera. The deck.gl Views guide documents multiple views and shows a FirstPersonView picture-in-picture example.

**`TerrainExtension` is marked Experimental in the docs, so don't put the fire on it.** The fire goes into the terrain mesh's own shader (§3). Vector overlays (perimeter, spine, labels, tracks) get their heights from DEM samples on the CPU and are drawn in 3D with a small z-offset. TerrainExtension is optional polish only.

Don't use Google Photorealistic 3D Tiles. Its terms forbid caching and image analysis and limit videos to 30 s promotional clips, and its imagery may predate the fire.

## 2. Pick the fire (decide Thursday night)

The pipeline is parameterized by `fire.yaml` (name, bbox, time window, official origin and acreage for validation).

- **Default suggestion: Eaton Fire, Jan 2025** (Altadena, San Gabriel foothills). It matches the reference's San Gabriel setting, and the data is unusually rich: structure damage points, many timed perimeters, and dense satellite detections. The **Palisades Fire, Jan 2025** is the alternative.
- Use the fire your team actually evacuated from if the data supports it. That is the story.
- **Do not state a cause** for any fire in the UI or pitch. The Overview field stays `Cause (Prelim.): Under Investigation` or quotes the official status verbatim with a source link.

## 3. The core mechanism: one arrival-time raster drives everything

`arrival.png`: a grid aligned to the DEM bounds (row 0 = north). The **red channel** holds when the fire reached each cell, as an 8-bit code relative to `aoi.window_utc`:
- codes **1–254** → arrival = `(code − 1) / 253` of the way through the window
- **255** → never burned

For a 5-day window that is ~28 min per code. Unlike a 16-bit R/G split, it survives deck's default linear filtering. If step 06 changes the window, it must rewrite `aoi.json` and `arrival.png` together.

With linear and mipmap sampling, the 255 boundary blends into its neighbours, which gives the perimeter edge a thin "burns last" halo. To remove it, use nearest filtering on the arrival image.

At render time, for a cell with arrival time `a` at scrub time `t`:
- `t < a` → **unburned**: base terrain
- `0 ≤ t − a ≤ 2 h` → **active front**: emissive orange-yellow, flicker noise, additive bloom
- `t − a > 2 h` → **burned**: char color, ember speckle that fades over ~12 h, darkness scaled by dNBR

The same raster also produces:
- the **perimeter at t**: a marching-squares contour at level `t` (d3-contour on the CPU, throttled to 10 Hz; or precompute every 15 min)
- **Fire Area(t)**: the count of cells with `a ≤ t`, times the cell area, converted to acres
- **Rate of Spread(t)**: the head advance along the spine per hour, in chains/hr (1 chain = 20.1168 m)
- **spread arrows**: the direction of steepest descent of `a`, sampled at major runs
- the **hover inspector's "Burned Aug 15 00:01 · 42 h ago"** line
- the **thermal heat field** for the IR camera: `heat = 1` on the front, decaying with `t − a`
- **tree charring**: a per-instance arrival time, recolored when `t > a`

**How to build it** (pipeline step 6): start from the time-stamped perimeters. For Eaton and Palisades, the NIFC 2025 operational archive has dozens of perimeter versions per fire (§5).
1. Each perimeter at time `T_k` sets `a ≤ T_k` for the cells inside it.
2. Between two successive perimeters, interpolate by normalized distance from the inner to the outer polygon.
3. Refine with FIRMS detections: a cell detected at time `T` gets `a = min(a, T)`. Then re-smooth.

The **first night is the weak spot**. Eaton's archived perimeters jump 400 → 2,227 → 9,507 acres between 06Z and 23Z on Jan 8, so FIRMS detections carry the first hours. If perimeters are sparse for the chosen fire, fall back to FIRMS alone, interpolating detection times inside the final perimeter (nearest-neighbour, then Gaussian smoothing).

**Render path A (preferred)**: put the fire in the terrain's own shader. Write a small deck.gl `LayerExtension` that injects into `fs:DECKGL_FILTER_COLOR` and samples the `arrival` and `severity` textures by mesh UV, with a `uTime` uniform. Pass it in the `TerrainLayer`'s `extensions` prop. With a single DEM image (not tiles), there is one mesh and one UV space aligned to the bbox. **Test on day 1** that the extension reaches the TerrainLayer's mesh sublayer.

**Render path B (fallback if path A fights you for more than half a day)**: pre-render the composited terrain texture (base + fire state) as JPEG frames every 30 min in Python (≈ 200 frames), then swap the `TerrainLayer` `texture` prop and crossfade. It is uglier when scrubbing, but it cannot break, and it uses no experimental APIs.

## 4. Forensic module: "where and when did it start?" (the real-model hook)

This produces the **Ignition Probability** layer, the `Ignition (est.)` event, and the **Analysis** sub-tab.

1. Use a spread-time model on the grid. Local rate of spread `R(x, dir)` = base ROS by fuel model × wind factor (hourly wind) × slope factor, computed with simplified Rothermel factors. Compute travel time from a candidate ignition with a **fast-marching / Dijkstra** solver on an 8- or 16-neighbour grid (scikit-fmm, or Dijkstra on the grid graph).
2. Candidates: a coarse grid of ignition points (≈ 200 m spacing) within ~3 km of the earliest detections, × start times from −6 h to the first detection in 15-min steps.
3. Score each candidate by how well its predicted arrival field matches the observed one: a Gaussian log-likelihood on the cells where arrival is observed (the earliest perimeters and FIRMS hits), weighted toward early observations.
4. Posterior over (point, time). The **heatmap** is the marginal over time, rendered as a red glow. Report the **MAP estimate** with a credible region (the ellipse that holds 90% of the mass).
5. **Validate with a temporal hold-out, which needs no official origin.** Fit the back-trace only on observations after hour N (e.g. N = 6). Then score how well it predicts the held-out early evidence: the earliest FIRMS cluster (distance in meters, time error in minutes) and the first archived perimeter (IoU). This number always exists. It goes in the Analysis tab and the README.
   - *Only if* an official origin area is published in citable form, also report the distance to it, quoting the source. Don't infer or state a cause. For Eaton the investigation was still open at the time of writing.
6. Running the same model forward from the MAP ignition gives the **Fire Spread (Modeled)** layer. The UI can show modeled vs observed side by side, which also makes a good demo beat.

**As built** (`pipeline/steps/s11_ignition.py`; results in `docs/RESULTS.md`). The plan above is what we started from. What changed:
- **Candidates:** a lattice inside the first fitted footprint, not a 200 m grid around detections.
- **Start times:** log-spaced 0.5–90 h before that footprint, not −6 h in 15-minute steps. Palisades was first mapped 26 h after ignition.
- **Score:** a weighted hinge loss on the observed footprints, not a Gaussian likelihood. Inside a footprint should have burned by then; a band outside it should not have. FIRMS is not used without a key.
- **Uncertainty:** a 90% radius and a 90% start-time interval. Their temperature is calibrated on the fire's own synthetic cases.
- **Evaluation:** a synthetic recovery benchmark alongside the hold-out.
- **Withheld start time:** when the start time is not identifiable, it is left off the timeline and out of the analyst's answers.
- **Wind:** the spread model's wind is the HRRR 3 km field, interpolated per cell, instead of one ERA5 point. HRRR tracks the airport stations better (`weather_station.json`). Eaton's real fit improves; Palisades' does not, since k stays at its ceiling under every wind tried (`eval/wind_ablation.json`).
- **Fire shape:** the ellipse's length-to-breadth cap is chosen per fit by loss on the real perimeters. With realistic winds, Anderson's curve makes the model fire far narrower than these fires were.

### 4b. Meta models

Facts from Meta's developer docs (`dev.meta.ai/docs`, read Oct 29):
- The **Meta Model API** is OpenAI-compatible at `https://api.meta.ai/v1` with a bearer `MODEL_API_KEY`.
- Hosted models include `muse-spark-1.3` / `1.2` / `1.1`, `muse-image-1.0` and **`sam-3.1`**. `sam-3.1` takes text, image or video in and returns boxes and masks.
- Pricing and rate limits weren't on the page. Check your hackathon credits on Thursday.

**SAM 3.1 on drone video** (pipeline step 12c):
- Prompt with the text concepts `fire`, `smoke` and `burned vegetation`, and get tracked masks per frame.
- Run Sentinel first. Its YOLO boxes tell us *which frames and where* to look, and SAM supplies the precise mask. That makes a two-stage detector: fast edge detection, then accurate segmentation.
- In the PiP's Recorded mode, draw the mask outlines (DESIGN §10). The Detections panel lists one row per tracked object.
- Measure it on FLAME 2's labelled frames (frame-level fire/smoke precision and recall, step 12b), next to Sentinel's own numbers.
- Pre-trim clips to ≤ 30 s and cache the results, so the live demo never calls the API for video.

**SAM 3.1 on post-fire aerial imagery** (step 9c):
- Prompt `destroyed building` and `building` on sub-meter post-fire imagery of the burned area. Sentinel-2 at 10 m is too coarse.
- Source: *unverified* candidates are Maxar Open Data (LA wildfires), NOAA emergency-response imagery, or county post-fire orthophotos. **Find one on Friday.** If none exists in time, drop this item. Nothing else depends on it.
- Score the result against CAL FIRE DINS `DAMAGE` labels (precision and recall on Destroyed).

**Muse Spark analyst agent** (the `Notes` sub-tab, `api/analyst`):
- It has tools that run in the serverless function over the precomputed data:
  - `arrival_at(lat, lon)`
  - `fire_state_at(t)` (area, rate of spread, front position)
  - `weather_at(t)`
  - `events()`
  - `structures_near(lat, lon, r)`, which returns damage category and construction only
  - `ignition_summary()`
  - `exposure_stats(feature)`
- It answers questions such as *"When did the fire reach Eaton Canyon Rd, and what were the wind and humidity then?"*
- **Report** button: it drafts the incident report. Every sentence must carry a citation `{layer, t, lat, lon}`, rendered as a chip that flies the camera there and sets `t`. Sentences without a citation are dropped before display.
- Hard rules in the system prompt: never state or speculate about a cause; never output addresses; say "the data doesn't show" when a tool returns nothing.
- Measure it with a small set of 15 questions whose answers we computed in the pipeline. Report exact-match accuracy on times and numbers in the README.

**Muse Code**: if the team actually codes with it, say so in the submission. **Muse Image**: not used; don't invent a role for it.

### 4c. House-level outcomes

`09b_exposure.py` takes each DINS structure (keeping damage category and construction fields, and dropping address, APN and owner) and joins it with:
- the arrival time at its cell
- the wind speed and direction at that time
- the distance to the nearest earlier-burned cell
- the local slope
- the fuel class

Its outputs:
- **Exposure-matched comparison.** Bin homes by exposure (arrival during peak wind vs. not, distance band). Within each bin, report destruction rates by vent screen, eave type, roof material and the defensible-space fields. Add a plain logistic regression with exposure covariates. Show the counts and confidence intervals, and title it as **association**.
- **In the UI**: the `Analysis` sub-tab gets a "Homes" panel. Clicking a structure on the map shows its exposure timeline (front arrival and wind at that moment) next to its construction features and outcome. Show no addresses.

Keep it to this. Don't also train a neural spread model unless a teammate finishes everything else early. If they do, WildfireSpreadTS / Next Day Wildfire Spread are the datasets (§5).

## 5. Data sources

Fetch everything for the fire's bbox and time window, and cache raw downloads under `pipeline/raw/` (gitignored).

URL shorthands: `NIFC` = `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services`, `CF` = `https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services`.

| Layer / panel | Source | Access | Notes |
|---|---|---|---|
| **Fire progression** | **NIFC Operational Data Archive 2025**: `NIFC/Operational_Data_Archive_2025/FeatureServer/6` | open, no key | **Dozens of perimeter versions per fire, Jan 8 06:14Z → Jan 21.** Query `where=UPPER(IncidentName) IN ('EATON','PALISADES')`, `orderByFields=DateCurrent`, `outSR=4326`, `f=geojson`. Key the series on **`DateCurrent`**, because `PolygonDateTime` is null or stuck. Eaton has two IRWINIDs, so filter by name. Remove duplicates and allow for null acres. *(Not usable: WFIGS and the CAL FIRE 2025 view have final perimeters only; the FIRIS public view is rolling and starts in 2026; NASA FEDS has a gap over Jan 2025.)* |
| Final perimeter / official acres | `CF/2025_California_Fire_Perimeters_View` | open | Eaton 14,056 ac, Palisades 23,449 ac. Use these to validate Fire Area(t). |
| Hot spots | NASA FIRMS: area API `…/api/area/csv/{MAP_KEY}/VIIRS_SNPP_SP/{bbox}/{days≤5}/{date}`, plus NOAA-20 and NOAA-21 sources | free key by email | `acq_date` + `acq_time` (UTC) and FRP. 1–5 days per call, so ~5 calls cover Jan 7–31. **Request the key Thursday night.** Fills the first-night gap in the perimeters and drives the spot-fire event. |
| Terrain | **AWS Terrain Tiles** `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (CORS open) for the mesh; **USGS 3DEP** via `tnmaccess.nationalmap.gov/api/v1/products` for analysis | open | Stitch terrarium tiles into one heightmap for `TerrainLayer`. 3DEP has **1 m lidar from both before (`CA_LosAngeles_B23`) and after the fire (`CA_2025LosAngelesPostWildfire_C25`)**, 40–380 MB per tile. Use 10 m for slope and aspect. Before/after lidar differencing is a stretch beat. |
| Burn severity | **JPL AVIRIS-3 dNBR** `popo.jpl.nasa.gov/pub/LA_Fires/dist/dnbr/` (COGs, Eaton 19 MB); else **Sentinel-2 L2A via Planetary Computer STAC** (pre 2025-01-02, post 01-12 / 01-17, <1% cloud, tiles 11SLT/SLU/SMT/SMU) | open (PC needs anonymous signing) | MTBS has **no 2025 fires yet**. AVIRIS covers Palisades only partially, so use Sentinel-2 dNBR (B8A, B12) for Palisades. |
| Weather (wind, temp, RH) | **Open-Meteo archive** `archive-api.open-meteo.com/v1/archive` with `models=era5_seamless` (its default for 2025 is IFS 9 km, not ERA5) | open, no key | Reanalysis grid, not station data. Eaton's ERA5 peak gust is 46 mph against 83 mph at the Burbank ASOS station (hourly wind correlation 0.67; `weather_station.json`). Station data comes from **Iowa Environmental Mesonet ASOS** (no key). Synoptic RAWS is out: its free tier only goes back 1 year. |
| ERC / burning index / fm100 | **gridMET** THREDDS `http://thredds.northwestknowledge.net:8080/thredds/dodsC/MET/{erc,bi,fm100,fm1000}/{var}_2025.nc` | open | Daily at 4 km. Eaton ERC was 86–96 over Jan 6–13, excluding a QC-flagged Jan 7. 1-hr fuel moisture is not modelled yet. |
| Flame length | Byram, from modeled fireline intensity | derived | Shown as a range, "est." |
| Fuels / vegetation | **ESA WorldCover 2021 v200** (10 m, CC BY 4.0, read as a window from the AWS COG); LANDFIRE FBFM40 is the upgrade path | open, no key | **Used now.** LANDFIRE needs an emailed job, so WorldCover classes map to per-fuel spread rates in `pipeline/ember/spread.py`. They also drive the stylized texture and the hover "fuel class" line. |
| Stylized base texture | Built from LANDFIRE EVT + hillshade | derived | Palette (grass beige, shrub olive, conifer dark green, urban grey, water blue-grey) × hillshade gives the painted look. |
| Aerial imagery layer | Sentinel-2 true color (same STAC pull) | open | The optional "Aerial Imagery" layer. |
| Structures | **CAL FIRE DINS** `CF/POSTFIRE_MASTER_DATA_SHARE/FeatureServer/0` | open | **Eaton 18,428 and Palisades 12,137 inspected structures**, 45 fields: `DAMAGE` (No/Affected/Minor/Major/Destroyed/Inaccessible), structure type, roof, eaves, vents, siding, year built, address and lat/lon. Query `where=INCIDENTNAME IN ('Eaton','Palisades')`, `outSR=4326`, paged with `resultOffset` in steps of 2000 (~16 requests). The per-fire public views have only 4 fields, so skip them. **Privacy: render only the damage category and structure type. Never display or ship the address, APN, year built or owner fields.** Drop those columns in the pipeline before anything reaches `public/`, because these are your neighbors' homes. |
| Roads, peaks, places | OpenStreetMap (Overpass) | open | Roads & Trails, peak labels, place names. |
| Personnel / containment | CAL FIRE incident page daily updates | open, hand-transcribed | "Personnel Assigned" and containment points. Cite the URL. |
| Drone footage, RGB + **thermal** | **FLAME 2** (IEEE DataPort): 7 paired side-by-side RGB/thermal drone videos of prescribed burns, 13.6 GB zip; plus the team's own drone footage | free IEEE account; **license not stated, so cite it and check before redistributing** | Real thermal for the PiP "Recorded" IR mode, and the RGB half for Sentinel. It is not footage of this fire, and the UI says so. |
| Aircraft tracks (Could tier) | **adsb.lol** `github.com/adsblol/globe_history_2025/releases` (Jan 7, 8, 9 present) | open, ODbL | ~2.1 GB/day, global, split tar in readsb format. Filter by the tankers' hex codes. Real tanker tracks would make the Resources tab real for the first three days. ADS-B Exchange (1st of each month only) and OpenSky (application review) are out. |

**Fastest real-data path**: every core layer except FIRMS comes from plain no-key HTTP requests and can be pulled in a few hours: NIFC archive perimeters, CAL FIRE DINS, Open-Meteo, gridMET, AWS terrain tiles + 3DEP, and AVIRIS / Sentinel-2 dNBR. Two things are asynchronous and should be started **tonight**: the FIRMS MAP_KEY (sent by email) and the LANDFIRE LFPS job.

**Optional model upgrade (only if everything in "Should" is done)**: Google's **Next Day Wildfire Spread** dataset (Kaggle, CC BY 4.0, 3.96 GB, 18,445 samples of 64×64 km at 1 km, 2012–2020) can train a small U-Net in under an hour on a Colab T4 *(estimate)*. Run it on the chosen fire's day-by-day inputs and show it next to the physics back-trace. WildfireSpreadTS is 48 GB, too big for this week.

## 6. Real vs simulated

This table goes **verbatim into the repo README**. The `Evidence` sub-tab in the app renders the same list, with a source link per row. Any panel whose data is simulated shows a small `SIM` chip in its header.

| Element | Status | Source |
|---|---|---|
| Terrain, land cover, fuels, roads, peaks | **Real** | USGS 3DEP / AWS Terrain Tiles, LANDFIRE, OSM |
| Fire progression (char, front, perimeter at t) | **Real**, interpolated between observations | NIFC 2025 archive perimeters + FIRMS |
| Fire Area / Rate of Spread charts | **Real-derived** | Arrival raster, checked against the official final acres |
| Burn severity | **Real** | JPL AVIRIS-3 dNBR / Sentinel-2 dNBR |
| Weather card, wind vectors | **Real** reanalysis; streamlines are interpolated | Open-Meteo (ERA5), gridMET, IEM ASOS |
| Fuel moisture, flame length | **Modeled** from real inputs | Fosberg, Byram |
| Ignition probability, Fire Spread (Modeled) | **Our model** (§4), with a validation number | Our code |
| Structures | **Real** | CAL FIRE DINS |
| Key Events | **Derived** by the pipeline (§7 step 10) | Our code |
| Detections panel | **Real model output** (Sentinel YOLOv8 + SAM 3.1 masks) on real footage | Sentinel, Meta Model API `sam-3.1`, FLAME 2 / own footage |
| Destroyed-building masks | **Real model output** on real post-fire imagery, scored against DINS | `sam-3.1` |
| Analyst answers / incident report | **Model-generated**, with a source cited for every sentence | Meta Model API `muse-spark-1.3` + our tools |
| Drone fleet paths, telemetry | **SIM**: generated from the real fire front | Scenario generator |
| Drone camera, rendered view | **SIM**: synthetic view of the real terrain and fire | deck.gl FirstPersonView |
| Thermal, rendered view | **SIM**: the rendered heat field through an Ironbow LUT | Our shader |
| Thermal, Recorded mode | **Real** thermal footage, **not of this fire** | FLAME 2 |
| Aircraft tracks | **Real** for Jan 7–9 if adsb.lol is wired in, otherwise **SIM** | adsb.lol / scenario |
| Engines, crews, drops | **SIM** | Scenario generator |
| Personnel, containment | **Real** | CAL FIRE updates |

## 7. Pipeline (`pipeline/`, run with `uv run make all`)

Each step reads `fire.yaml` and writes to `web/public/data/<fire_id>/`. Step files are `pipeline/steps/sNN_name.py`, run as `uv run python -m steps.sNN_name` or through the Makefile. Steps 01–02 are implemented; the rest are documented stubs.

1. `01_aoi.py`: bbox, CRS (UTM zone), grid definition (30 m), time window, `t0`.
2. `02_dem.py` → `dem.png` (terrarium-encoded), `slope.npy`, `aspect.npy`, `hillshade.png`.
3. `03_landcover.py` → `base_stylized.jpg` (the painted texture), `fuel.png` (class indices), `trees.json` (instance positions sampled from vegetated cells, ≤ 40k).
4. `04_firms.py` → `hotspots.geojson` (time, FRP, confidence).
5. `05_perimeters.py` → `perimeters.geojson` (one feature per `DateCurrent`, de-duplicated, from the NIFC 2025 archive) and `final_perimeter.geojson` (from the CAL FIRE 2025 view).
6. `06_arrival.py` → `arrival.png` (16-bit), `isochrones.geojson` (every 15 min, for 2D and the fallback path).
7. `07_weather.py` → `weather.json` (hourly wind speed, direction, gusts, temp, RH; daily ERC).
8. `08_severity.py` → `severity.png`.
9. `09_vectors.py` → `structures.geojson`, `roads.geojson`, `labels.json`.
10. `10_events.py` → `events.json`: Ignition (est.) from §4; Rapid Growth = the peak-ROS window; Spot Fire (prob.) = the first FIRMS hit more than 500 m outside the perimeter at that time; Ridge Crossing = the spine crossing a local ridge line (DEM); Containment = the official date.
11. `11_ignition.py` → `ignition_posterior.png`, `ignition.json` (MAP, credible region, validation errors), `modeled_arrival.png`.
12. `12_sentinel.py` → for each video in `footage/`, run Sentinel's detector at 5 fps and write `detections.json` (video time, bbox, class, confidence) plus a hot-spot event per sustained detection.
    - **Friday checkpoint `12b_sentinel_eval.py`**: Sentinel was trained on fixed security-camera views, and drone footage is top-down, so it may underperform. Run it over a sample of FLAME 2's 53,541 fire/smoke-labelled frames and report frame-level precision and recall.
    - **Good result** → a real metric for the README.
    - **Weak result** → you learn it on Friday, not Monday. Pick Recorded-mode clips where it does fire, say so honestly, and optionally fine-tune on FLAME 2 frames, since Sentinel already ships `model_trainer.py`.
12c. `12c_sam_video.py` → for each trimmed clip, call `sam-3.1` with the text prompts, seeded by Sentinel's frames. Write `masks/<clip>.json` (RLE or polygon per frame and object) and add frame-level scores to the 12b report.
9c. `09c_sam_structures.py` (only if post-fire imagery is found) → tile the imagery, call `sam-3.1` with `destroyed building`, and write `sam_structures.geojson` plus a precision/recall report against DINS.
15. `15_analyst_eval.py` → 15 questions with answers computed from our data, run through `api/analyst`, scored, and written to `eval/analyst.json`.
13. `13_scenario.py` → `scenario.json`: 6 drones (perimeter-following from the isochrones, orbits around the most active cells, a relay at a fixed point), telemetry series, and optionally aircraft and ground units. Every object carries `simulated: true`.
14. `manifest.json`: lists every asset with its source URL, retrieval date and license. This file drives the Evidence tab.

## 8. Web app structure (`web/src/`)

```
app/AppShell.tsx           CSS grid: header 40 / [stage | rail 308] / dock 226 (DESIGN §1)
app/tokens.css             DESIGN §2 tokens as CSS vars + Tailwind theme
state/time.ts              t, playing, speed, range; rAF loop
state/selection.ts         tab, selectedDrone/unit, cameraMode, hover
state/layers.ts            10 layers: visible + opacity
data/load.ts               manifest → typed assets; arrival decode
header/Header.tsx          DESIGN §3
stage/Stage.tsx            DeckGL + MapLibre; views: main (Map/Orbit) + pip (FirstPerson)
stage/layers/*.ts          terrain, fireShader, perimeter, spine, arrows, ignition, trees,
                           severity, wind, structures, roads, labels, drones, units, drops
stage/camera.ts            eased fly-to, follow, chase, orbit-on-idle
stage/overlays/            Compass, MapControls(2D/3D, zoom×, fullscreen), ScaleBar,
                           HoverInspector, DronePip(+Hud), ChaseHud
rail/incident/             Layers, AnalysisTab(forensic + Homes), EvidenceTab(manifest),
                           NotesTab(Muse Spark analyst chat + Report, citation chips),
                           IncidentOverview, WeatherBehavior
api/analyst.ts             Vercel function: OpenAI SDK → api.meta.ai/v1, muse-spark-1.3,
                           tool loop over public/data (key in env, never in the client)
rail/drones/               FleetList, FleetOverview, DroneDetail
rail/resources/            StatStrip, UnitList, Operations, UnitDetail
dock/Timeline.tsx          transport, scrubber, event glyphs, activity band
dock/charts/*.tsx          TimeChart base (cursor, past solid/future faded) + 9 configs
dock/side/                 KeyEvents, Detections, AirOpsLog
```

**Time zones**: store every timestamp as UTC; perimeters, FIRMS and Open-Meteo all arrive in UTC or GMT. Render in `America/Los_Angeles` and **compute the zone label** with `Intl.DateTimeFormat`. A January fire is **PST**. The reference's `PDT` is right only for its fictional August fire, so don't copy it literally.

**Thermal mode**: the PiP view renders the same layers with a `thermal` prop. The fire layer outputs `heat` instead of color, terrain outputs a low ambient heat from sun-facing aspect, and a final full-screen pass maps heat through a 256-px Ironbow or White-hot LUT texture.

**PiP "Recorded" mode**: plays real footage in the PiP instead of the render. FLAME 2's videos are side-by-side RGB|thermal, so split them, and show the RGB half in EO and the thermal half in IR. Sentinel's boxes from the RGB half are overlaid in sync on both, and the HUD stays the same. A `RECORDED · NOT THIS FIRE` tag sits under the REC line. This is the demo moment where Sentinel visibly does real work.

## 9. Scope tiers and day plan

**Must** (the submission works with only this):
1. **The Incident tab end to end**: 3D terrain with the stylized texture and trees; fire scrub from the arrival raster; perimeter, spine, waypoints and ignition marker; timeline with events; the three charts; Layers panel with opacity; Overview; Weather (at cursor); hover inspector.
2. **Muse Spark analyst** in the Notes tab, with citation chips that fly the camera to the cited place and time (§4b).
3. **SAM 3.1 + Sentinel on recorded drone footage**: PiP with HUD, masks and boxes, Detections list, and the FLAME 2 eval numbers (§4b, step 12b/12c).
4. **Forensic back-trace** with its hold-out score (§4).

**Should**: house-level outcomes (§4c); Evidence tab; 2D mode; the analyst eval set (step 15); SAM destroyed-building masks scored against DINS (step 9c, only if post-fire imagery turns up on Friday).

**Could**: the simulated drone fleet with follow camera and rendered PiP/IR; the Resources tab (aircraft chase, cockpit, drops, ground ride-along, air-ops log); wind streamlines; ADS-B tracks; tree charring.

**Drop in this order if behind**: Resources tab → wind streamlines → simulated fleet + rendered IR → tree charring → SAM on aerial imagery (9c) → 2D mode → house-level outcomes. **Never drop** the arrival-raster scrub, the analyst with citations, SAM on footage, or the Real-vs-Sim labeling.

| Day | Deliverable by end of day | Checkpoint |
|---|---|---|
| **Thu Oct 29 (night)** | Fire chosen. **Keys and slow requests**: Meta Model API key, with credits and rate limits checked; FIRMS MAP_KEY; LANDFIRE LFPS job; SAM 3 Hugging Face access (fallback only). Start the FLAME 2 download (13.6 GB) overnight. **Smoke-test both Meta models**: `muse-spark-1.3` makes one tool call, and `sam-3.1` returns masks for `fire`/`smoke` on a 10 s clip. Repo scaffolded; tokens + AppShell matching the reference layout; steps 1–2 run; path A extension smoke-tested. | Both Meta models answered a real request; layout overlay matches |
| **Fri Oct 30** | Steps 3–9 produce assets. Terrain, stylized texture, trees and labels render in deck.gl. **Vision eval on FLAME 2**: Sentinel (12b) and SAM 3.1 (12c) precision/recall. Go/no-go on post-fire aerial imagery for 9c. | A pretty static 3D scene, plus two vision numbers |
| **Sat Oct 31** | Arrival raster (step 6), fire layer (path A, or B by 6 pm), timeline, Incident charts and Key Events. The analyst's tool functions are written in TS over `public/data` and checked against pipeline numbers. | **Scrubbing time burns the terrain.** If this isn't true by Sat night, switch to path B. |
| **Sun Nov 1** | Forensic back-trace (step 11) with its hold-out score, and the Analysis tab. **Analyst end to end**: `api/analyst` + Notes tab + citation chips + Report. House-level join (§4c). Hover inspector, Weather card, Layers. | Ask the analyst a question in the app, click a citation, and the camera flies to it |
| **Mon Nov 2** | **Drones tab as a footage player**: PiP + HUD, Sentinel boxes + SAM masks, and Detections. Homes panel. 9c if it was a go. Analyst eval (step 15). Evidence tab. 2D mode if time allows. **Feature freeze at 11 pm.** | A 3-minute run-through works end to end |
| **Tue Nov 3** | Polish only. Record the demo video; write the README (Real vs Sim, every eval number, which Meta models do what, prior-work disclosure) and the submission form. **Submit by 6 pm.** | Submitted. The official close is Wed Nov 4, 5 pm PST, which leaves buffer. |

**Team split**: three parallel streams, sized to the Claude plans. They are defined in [WORKSTREAMS.md](WORKSTREAMS.md), together with the file and API contracts between them and a day-by-day table per stream.
- **A: Data & forensics** (20x)
- **B: Web app** (20x)
- **C: Vision & story** (5x)

## 10. Demo video beats (about 2.5–3 min)

1. **Personal open (15 s)**: "We're from SoCal. We evacuated, and homes in our neighborhood burned." Our own drone b-roll.
2. **The problem (15 s)**: after a fire, investigators and residents reconstruct what happened from scattered satellite passes, perimeters and reports.
3. **Incident replay (45 s)**: scrub the real fire across the real terrain while the charts and weather move with it. Hover a cell to see something like "burned at [time], 37° slope, chaparral".
4. **Ask the analyst (30 s)**: "When did the fire reach [street], and what was the wind?" Muse Spark answers with citation chips. Click one, and the camera flies there and time jumps to that moment.
5. **Forensics (30 s)**:
   - The ignition back-trace heatmap, with its hold-out score in meters and minutes.
   - Click a home to see its exposure, construction and outcome.
   - The exposure-matched table.
6. **Drone footage (30 s)**: real footage plays in the PiP. Sentinel's boxes find the fire, and SAM 3.1 outlines it frame by frame. Detections land in the list, and the precision/recall numbers are on screen. Say it straight: "detection from Ben's open-source Sentinel model, segmentation by SAM 3.1."
7. **Honesty slide (10 s)**: the Real vs SIM table and the eval numbers. Close.

Check the official video-length limit and trim the replay beat first.

## 11. Constraints and risks

- **Rules and prior work**: Sentinel (`benjaminxie1/sentinel-app`) is a team member's earlier open-source project. It's used here as a dependency and disclosed in the submission; everything else is built during the event. Confirm in the official rules that this is allowed, and check the video length and submission fields.
- **Meta Model API limits**: pricing, rate limits and video-input limits weren't published on the docs page. So pre-trim clips to ≤ 30 s, cache every `sam-3.1` result, and never call video segmentation live during the demo. The analyst calls `muse-spark-1.3` live, with cached answers for the scripted demo questions as a fallback.
- **SAM on fire and smoke**: they are amorphous, so masks may be noisy. Thursday's smoke test decides. If they're poor, keep Sentinel for fire and point SAM at `burned vegetation` and `destroyed building`, where its masks are crisp.
- **Drone flying**: recreational TRUST certificate or Part 107; check B4UFLY for airspace and TFRs; never over people or near active incidents. The footage is b-roll and EO-feed material, not fire data.
- **Credit**: the README credits Dilum Sanjaya's post as design inspiration. Don't use the FireTrace name or logo.
- **Sparse perimeters**: if there are fewer than ~4 timed perimeters in the first 24 h, the arrival raster leans on FIRMS. Say so in the Evidence tab.
- **Shader risk**: covered by fallback path B (§3).
- **Performance**: cap trees at 40k instances, the arrival texture at 2048², and contour updates at 10 Hz. Test on the demo laptop on Sunday.
