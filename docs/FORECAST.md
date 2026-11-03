# One-hour spread forecast (FORECAST)

**Where will the fire's edge be in an hour?** A forecaster reads the fire's mapped edge, the recent spread, the HRRR wind and the terrain slope, and draws the burned footprint it expects one hour (or any horizon) later. The swarm commander can then target that forecast edge ([SWARM.md](SWARM.md)).

Every output here is a **FORECAST** made in hindsight for the Eaton Fire. It is not an operational product and was not available during the fire. The drone part is a MuJoCo simulation: no drones flew this fire.

Code: [`pipeline/sim/forecast.py`](../pipeline/sim/forecast.py) · tests: [`pipeline/tests/test_forecast.py`](../pipeline/tests/test_forecast.py) · scores: [`forecast/eval.json`](../web/public/data/eaton/forecast/eval.json) · app polygons: [`forecast/index.json`](../web/public/data/eaton/forecast/index.json).

## Forecasters

The edge is split into 16 sectors by compass bearing from the fire's centroid. A sector's **recent advance** is the 90th-percentile distance of its newly burned cells (burned now, not at the previous observation) from the previous footprint. A cell outside the fire belongs to the sector of its nearest burned cell, and is forecast to burn when its distance to the edge is within that sector's reach.

| Method | What it does |
| --- | --- |
| `persistence` | No growth. |
| `uniform` | Every edge advances at the recent mean rate (mean over the 16 sectors), times the horizon. |
| `sector-rate` | Each sector keeps its own recent rate (per-sector persistence). No wind, no slope. |
| `physics` | Each sector's recent rate, adjusted cell by cell for the wind and slope ahead compared with what that sector saw over the last interval: `rate × h × clip(ell_f · slope_f / (ell_p · slope_p), ½, 2)`. `ell` is Anderson's (1983) wind ellipse (length-to-breadth from the HRRR 10 m wind, midflame = 0.4 × 10 m, capped at 8 as in FARSITE). The slope factor doubles the rate per 10° upslope and halves it per 10° downslope (McArthur's rule), clipped to [¼, 4]. |
| `ellipse` | v1 of the physics baseline, kept for the record: the pure ellipse × slope shape with one head rate fitted to the recent sector advance. It scored far worse, so `physics` replaced it. Nothing else was tuned. |
| `muse` | Muse Spark reads a compact summary: per sector, the bearing, edge length, recent advance, the HRRR wind over the horizon (speed, direction and its outward component) and the slope just outside the edge. It returns a spread distance per sector as a `forecast_spread` tool call. The code bounds the reply: distances are clipped to [0, 8 km/h × h] and counted when clipped. A reply with missing, duplicate, out-of-range or non-numeric sectors is **rejected and scored as no growth**, never filled in by another forecaster. Rejections are counted. |

Wind: the HRRR hourly analysis over the forecast window stands in for an HRRR forecast, which is a generous assumption. No parameter is fitted across issue times. The only per-issue fit is the recent rate, from data before the issue time.

## How it is scored

Each forecast's **new growth** (forecast footprint minus the issue-time footprint) is compared with the true new growth:

- **Caught (recall):** the share of the newly burned ground that the forecast covered.
- **Precision:** the share of the forecast's new growth that really burned.
- **IoU** of the new growth. The table pools cells over all issue times, and also shows the mean of per-issue IoU.

Official Eaton perimeters are hours apart (3.4 to 21.6 h, about 5.3 h on the night of Jan 8 to 9), so no official map exists exactly an hour after an issue time. Two truth sets are reported, and every eligible issue time is used. No issue time is picked.

- **(a) +1 h vs our modeled arrival map.** Issued every hour from 05:00Z Jan 8 to 18:00Z Jan 10 (62 issue times, all of them). Edge = cells with modeled arrival ≤ t, recent rate from t − 1 h, truth = arrival ≤ t + 1 h. **The arrival map is our own interpolation between official perimeters** (`steps/s06_arrival.py`: a cell's arrival is set by its distance ratio between consecutive maps). It is not an observation, and it favours forecasters that carry the recent per-sector advance forward, because the interpolation itself advances each part of the edge at a steady rate.
- **(b) Official map to official map (real truth).** Issued at each official NIFC map, with the recent rate from the previous map, and scored at the next official map: 5 issue times (07:12Z, 10:37Z and 23:10Z Jan 8; 04:30Z and 22:10Z Jan 9). The official start (02:18Z Jan 8, one cell) counts as the map before the first. Maps less than 1 h apart (07:06/07:12 and 10:34/10:37, two mapping methods) are merged, keeping the later one. Horizons are 3.4 to 21.6 h, not 1 h.

A third set, issued hourly from the modeled map and scored at the next official map, is in `eval.json` (`c_hourly_to_next_official`). It is not reported here because it leaks: the modeled edge at t was interpolated toward that same next map.

## Results (Eaton)

Generated by `uv run --extra sim python -m sim.forecast` (`forecast/eval.json`).

**(a) +1 h, vs our modeled arrival map** (62 hourly issue times)

| Forecaster | Caught (recall) | Precision | IoU (pooled) | Mean IoU |
| --- | --- | --- | --- | --- |
| persistence | 0.0% | – | 0.0% | 0.0% |
| uniform | 51.5% | 25.2% | 20.4% | 15.3% |
| sector-rate | **81.9%** | **30.6%** | **28.6%** | **33.1%** |
| ellipse (v1) | 13.8% | 9.9% | 6.1% | 4.9% |
| physics | 70.9% | 22.4% | 20.5% | 24.4% |
| muse | pending the Mac run | | | |

**(b) Issued at an official map, scored at the next official map** (5 issue times, real perimeters)

| Forecaster | Caught (recall) | Precision | IoU (pooled) | Mean IoU |
| --- | --- | --- | --- | --- |
| persistence | 0.0% | – | 0.0% | 0.0% |
| uniform | 56.1% | **14.0%** | **12.6%** | **15.6%** |
| sector-rate | **59.7%** | 11.3% | 10.5% | 12.2% |
| ellipse (v1) | 14.8% | 5.5% | 4.2% | 3.0% |
| physics | 59.1% | 9.3% | 8.7% | 9.2% |
| muse | pending the Mac run | | | |

Per issue time for physics on (b): caught 81%, 54%, 73%, 48% and 100% of the new growth, with precision of 3 to 20%.

**What it shows.**
- **Against real maps, the forecasts catch most new ground but draw far too much.** Physics caught 59% of the ground that burned between official maps, and the uniform buffer caught 56%. Both forecasts were mostly area that did not burn, because a rate held for 3 to 22 h overshoots once the fire slows.
- **The wind and slope adjustment does not beat carrying the recent rate forward.** Per-sector persistence (`sector-rate`) is at least as good as `physics` on every metric, and the pure wind ellipse (`ellipse`) is far worse. In the hours we inspected, much of the growth ran across or against the hourly 3 km HRRR wind. At 15:00Z Jan 8, for example, the wind blew toward the west-northwest, yet about half of the next hour's new ground in the modeled map burned on the upwind east side. A 3 km hourly wind does not capture that.
- **The +1 h numbers (a) are against our own interpolation.** They are much higher than (b), partly because the interpolation advances the edge steadily. Read them as a consistency check, not as accuracy against the fire.

## Forecasts in the app

`web/public/data/eaton/forecast/index.json` is a JSON array of file names. Each file is a GeoJSON FeatureCollection for one hourly issue time (`2025-01-08T05Z.geojson` to `2025-01-10T18Z.geojson`). It holds one feature per method, a Polygon or MultiPolygon of the forecast footprint at +1 h, with properties `{issued_utc, valid_utc, method: "physics" | "muse", status: "FORECAST"}`. These are issued from the modeled edge (truth set a). Physics is exported now. The Mac run adds `muse` features to the same files. They are static files, so the app makes no model calls at view time.

## Run it

Cloud (no model):

```
cd pipeline
uv run --extra sim pytest -q tests/test_forecast.py tests/test_sim.py
uv run --extra sim python -m sim.forecast                                    # scores the five non-model forecasters
uv run --extra sim python -m sim.forecast --methods physics --export --no-score
```

**Live Muse Spark (Ben's Mac, `~/Developer/metahacks-swarm`, MODEL_API_KEY in `../.env`). Total spend cap: $4.90.**

```
cd ~/Developer/metahacks-swarm
git fetch origin sim/forecast && git checkout sim/forecast
cd pipeline && uv sync --extra sim
# 1. Score the Muse Spark forecaster on every issue time of (a) and (b), then add its polygons for the app (cap $1.40).
uv run --extra sim python -m sim.forecast --methods persistence uniform sector-rate ellipse physics muse --export --cap-usd 1.4
# 2. The preloaded video run: Muse Spark forecaster, commander and three squad agents, seed 0 (cap $3.50).
uv run --extra sim python -m sim.run --policy muse --forecast muse --seeds 0 --cap-usd 3.5
uv run --extra sim python -m sim.run --summary
git add ../web/public/data/eaton/forecast ../web/public/data/eaton/swarm
git commit -m "Live Muse Spark forecasts and forecast-edge swarm run (FORECAST, simulated drones)"
git push
```

Step 1 makes 67 forecaster calls: 62 for (a) and 5 for (b). The export reuses the 62 (a) forecasts, so it makes no new calls. It writes `forecast/eval.json` (every method, including muse, with call, rejection and clipping counts), `forecast/muse_eval_log.json` (each Muse forecast, its distances and its one-line note) and the muse features. Step 2 writes `swarm/muse-fcst-muse_s0.json` and its `_events.jsonl`, and the app's Swarm tab then opens on it. If a cap is reached, the run stops and says so (`truncated`) and keeps the decisions made so far.

## Caveats

- Hindsight: the HRRR analysis stands in for a forecast, and official maps are assumed to be available at their timestamps. Real perimeters are published later.
- Eaton only, and 5 real issue times for (b). The intervals are long and uneven, so these are not one-hour scores.
- Fuel, spotting, suppression and structures are not modelled. Precision is low partly because the fire stopped in places for reasons none of these forecasters can see.
- The truth rasters (perimeters on a 16 m grid) have mapping error of their own. NIFC maps come from mixed methods.
