# Drone swarm (SIM)

**Could a drone swarm have kept eyes on the Eaton Fire's front?** This is a MuJoCo simulation flown over the real fire. Six simulated thermal survey drones fly over the real terrain. Underneath them, the reconstructed spread and the real HRRR wind and gusts are replayed. Muse Spark plans their flights in two ways: as a commander with three squad agents, and as a commander only, with a fixed rule flying the drones. Two rule-based policies fly the same episode for comparison.

Everything in this section is **SIM**. No drones flew this fire. The drone is modelled on a published spec sheet, but it is not a claim about any product's performance on that day.

Code: [`pipeline/sim/`](../pipeline/sim) · tests: [`pipeline/tests/test_sim.py`](../pipeline/tests/test_sim.py) · app: Incident rail → **Swarm** ([`rail/swarm.tsx`](../web/src/rail/swarm.tsx), [`stage/swarm-layer.ts`](../web/src/stage/swarm-layer.ts)) · rationale and sources for every number: [Swarm numbers rethink](https://claude.ai/artifact/F1d6GLZkT5bNizpF9WKiV6).

## Headline: on the first night, no drone could have flown

The rule is a real drone's wind rating, checked against the HRRR hourly gust at flight height. Under it, the whole Eaton area was unflyable from 02:00 to 14:00 UTC on Jan 8 (6 PM Jan 7 to 6 AM Jan 8 PST), with a median gust aloft of 33 to 44 m/s. During that day, 20 to 33% of the area was flyable. About 35% of the final burned area burned in hours when none of it was flyable, and about 65% burned in hours when less than half of it was ([`flyable.json`](../web/public/data/eaton/swarm/flyable.json)). A greedy swarm launched at 6:30 PM Jan 7 never leaves the ground (`greedy_night_s0.json`: 0 flight hours, 12 h grounded).

That is consistent with the record. Los Angeles County Fire's helicopters aborted a water drop at 6:45 PM on Jan 7 because of updrafts. So the policy comparison starts at **4 PM PST Jan 8 (2025-01-09T00:00Z)**, the first 12 h in which most of the area is flyable most of the time.

## What is real and what is simulated

| Part | Source | Status |
| --- | --- | --- |
| Terrain | `dem.png` on the 16 m analysis grid, as a MuJoCo heightfield | REAL |
| Where and when the fire burned | `arrival.png`: arrival times interpolated between mapped perimeters (about 28 min steps) | MODELED |
| Wind and gusts | HRRR 3 km hourly 10 m wind and gust (`wind_field.json`, 4 x 6 partition), scaled to flight height by a 1/7 power law | REAL input, scaled |
| Drones, sensors, batteries, every flight | `sim/env.py` | SIM |

## The drone (DroneSpec)

| Parameter | Value | Basis |
| --- | --- | --- |
| Wind limit | 12 m/s, checked against the gust at 120 m | DJI Matrice 4TD wind rating 12 m/s. The 1/7 law is the low end of measured shear exponents (0.19 to 0.62), so this is the generous case |
| Height | 120 m above the ground below, drones stacked 120, 110 … 70 m | FAA Part 107 ceiling (400 ft) |
| Speed | 15 m/s cruise, 21 m/s top | M4TD Normal and Sport modes |
| Drag | sized so 21 m/s needs a 35° tilt | typical multirotor top-speed tilt |
| Battery | 40 min usable per pack (M4TD: 54 min max, 47 min hover), 25% reserve plus the trip home against the wind | margin for cold air, wind and climbs |
| Packs | 3 per drone, 5 min swap, 60 min recharge | field kit assumption |
| Camera | 150 m sweep radius, line of sight against terrain | M4TD thermal 640 x 512, 45° diagonal FOV. Tilted 45° at 120 m it sees a wedge about 70 to 200 m ahead, and the panning gimbal is modelled as a 150 m circle. arXiv 2407.05473 reports a 94 x 70 m nadir footprint at 150 m |

Thermal cameras see through smoke far better than visible ones, so smoke is not modelled as a blinder. Dense plumes do degrade them, which is listed as a limit below.

## How it works

1. **Physics (MuJoCo).** Each drone is a free rigid body. It feels gravity, a thrust force capped at 2.5 times its weight, quadratic drag against the local wind, and turbulence scaled by the hour's gust excess. A velocity-capped position controller follows the terrain: it holds 120 m over the ground below, climbs early to clear the ground 400 m ahead by 40 m, and slows down where the ground rises or falls faster than it can climb or descend. A terrain contact ends the flight. This is a point-mass model with no attitude dynamics.
2. **Safety layer (all policies).** A drone may not launch, and is recalled, when the gust at flight height exceeds 12 m/s. It returns home on its own when its battery reaches the trip home against the wind plus the 25% reserve.
3. **Sensing.** Every 10 s each airborne drone checks line of sight to the ground cells within 150 m. A visible cell inside the replayed fire is recorded as seen.
4. **What policies know.** Policies get only the swarm's own observations: clusters of ground seen burning in the last 30 min, and the minutes since each 2 km block was last viewed. They also get the current-hour wind and gust per block (with a flyable flag), each drone's battery and spare packs, and the publicly reported start. They never see the arrival raster. The forecast-edge policies (below) also read the official NIFC perimeters published up to that time, which is public information, and the cells the swarm itself has seen burned.
5. **Policies**, deciding every 15 min:
   - **Lawnmower:** one strip per drone, swept back and forth.
   - **Greedy:** each free drone orbits the downwind edge of the nearest observed cluster, or searches around the reported start.
   - **Muse Spark swarm** (`muse`, `sim/muse.py`): first a commander call (`task_squads`) gives each squad an area and an objective. Then three squad calls run in parallel (`set_waypoints`), and each plans its own two drones. Each one is a real `muse-spark-1.3` tool call.
   - **Muse Spark commander + rule** (`muse-hybrid`): the same commander call assigns the areas, and the greedy rule flies the drones inside them. That is one call per decision. It follows the split that SMART-LLM (arXiv 2309.10062) and similar work find works best, where the LLM decomposes and allocates the task and fixed controllers execute.

   - **Forecast edge + rule** (`forecast-physics`, `sim/forecast.py` and `policies.ForecastEdge`): before each decision, the physics forecaster ([FORECAST.md](FORECAST.md)) forecasts from the latest official map where the fire will spread in the next hour. The forecast footprints for t and t + 1 h are both made from that map, minus what the swarm has seen burned. The rule sends each free drone to orbit one of the up to 6 largest areas of that band, and falls back to greedy when the band is empty.
   - **Ablation: latest-map edge + rule** (`forecast-map-edge`): the same rule with no forecast. It watches a 300 m ring outside the latest official map.
   - **Muse Spark forecaster + swarm** (`muse --forecast muse`, `muse-fcst-muse`): the Muse Spark forecaster makes the forecast. Its forecast areas go into the commander's situation as `forecast_next_hour`, and the commander and three squads then plan as in `muse`. The forecaster, commander and squads share one spend cap. `muse-hybrid --forecast physics|muse` gives the same input to the commander + rule variant.

   For all Muse variants, waypoints are only clipped to the area. Output is bounded: at most 4 tasks per squad and 4 plans per drone, and a cut-off reply counts as an error. When a call fails, those drones keep their previous plan and the error is logged. Free text that talks about how the fire started is removed, the same rule the analyst follows. Spend is capped per rollout at the analyst's prices.
6. **RL view.** `SwarmEnv` is a Gymnasium environment on the same simulation, where one step is one decision interval. The action is a target point per drone. The observation is three coarse maps (seen burning, seen ever, coverage age) plus the drone states. The reward is newly seen burned cells, tripled for cells seen within 30 min of arrival, after Julian & Kochenderfer (arXiv 1810.04244). It is there for training. No trained policy is part of the results.

## Metrics

- **Front seen within 60 min:** the share of cells the fire reached during the episode that a camera saw within 60 min of their interpolated arrival. Arrival times move in about 28 min steps, so the 30 min version (also in `eval.json`) is coarse.
- **Area mapped:** the hourly mean of the share of the burned area the swarm had seen by then.
- **Median minutes to first sighting**, over cells that were seen.

## Results

Eaton, 2025-01-09 00:00 to 12:00 UTC (4 PM Jan 8 to 4 AM Jan 9 PST), 6 drones, 3 seeds per policy. The table is generated from `web/public/data/eaton/swarm/eval.json` (`uv run --extra sim python -m sim.run --summary`).

| Policy | Front seen within 60 min | Front seen by the end | Area mapped | Median minutes to first sighting | Flight hours | Model calls · cost |
| --- | --- | --- | --- | --- | --- | --- |
| Muse Spark swarm (`muse-spark-1.3`) | 13.6% (9.1–17.0) | 23.1% (15.7–28.4) | 19.4% (15.3–22.4) | 31 (18–44) | 53 (52–54) | 573 · $7.15 |
| Muse Spark commander + rule | 12.5% (9.1–15.8) | 22.8% (14.1–28.5) | 20.0% (18.0–22.3) | 46 (26–65) | 44 (43–45) | 144 · $1.85 |
| Greedy | 14.0% (13.7–14.7) | 21.6% (19.7–25.3) | 17.0% (16.3–18.2) | 33 (28–42) | 43 (43–43) | – |
| Lawnmower | 15.2% (15.2–15.2) | 28.5% (28.5–28.5) | 19.6% (19.6–19.6) | 46 (45–46) | 47 (47–47) | – |
| Forecast edge + rule (physics) | 18.0% (18.0–18.0) | 42.7% (42.6–42.7) | 27.9% (27.9–27.9) | 72 (72–72) | 43 (43–43) | – |
| Latest-map edge + rule (ablation, no forecast) | 21.1% (21.1–21.2) | 43.9% (43.9–43.9) | 33.7% (33.7–33.8) | 61 (61–61) | 46 (46–46) | – |
| Muse Spark forecaster + swarm | pending the Mac run | | | | | |

The two forecast-edge rows were added in v2.3 from the same code and window. The greedy and lawnmower reruns on that code reproduced the rows above exactly.

**The forecast edge, honestly.** Targeting the physics forecast edge sees more of the front within an hour than any earlier policy. The ablation shows where that gain comes from: watching the latest official map's edge with no forecast does better still. In this window, the gain comes from knowing the official map, not from the forecast. The forecast band from a map 1 to 6 h old overshoots the front ([FORECAST.md](FORECAST.md): the forecasts catch most new ground but draw far too much), so drones are spread over ground that has not burned yet. Both rows also use information the other policies lack (published perimeters, assumed available at their timestamps).

The table shows the mean over the 3 seeds, with the range in brackets. No drone was lost in any run, and none was grounded at base by wind. Drones still came back early: gusts over the flight area recalled them, and so did battery reserves.

**What it shows.**
- **Physics first.** Six drones with realistic cameras see only about 13 to 15% of the front within an hour, whichever policy flies them. The four policies overlap within their seed ranges. In this window the plain lawnmower is best on front coverage, and the hybrid has the best mean on area mapped.
- **The Muse Spark swarm is now competitive.** In v1 it lost clearly to greedy (14.6% against 25.7% on the old metric). Now it matches the rules on average. It flies the most hours (53, against 43 to 47), because it routes squads around gusty blocks, and it sees burned ground soonest (31 min median). It varies most from seed to seed (9 to 17%), and that is the honest caveat.
- **The commander alone does almost as well for a quarter of the cost:** 144 calls and $1.85, against 573 calls and $7.15.
- **Robustness:** 10 of 288 Muse decisions had an error (v1: 26 of 144). Nine of them were the commander returning no usable tasks, and those squads kept their previous tasks. The runaway squad output from v1 is gone.
- **The commander's own words** (seed 0, 08:00Z): "Confirmed active front at 12.5,3.0 spreading west, main head near 10.5,6.6 unseen for 34 min likely drifting WSW/S. South winds push west and north winds push south, NW corner unflyable."

The bigger result is the headline above. When the fire grew fastest, the wind ruled out drones of this class entirely.

## Limits

- Point-mass drones with no attitude, motor or sensor-noise models. Battery drain scales with thrust to the 1.5 power.
- Wind is HRRR at 3 km, partitioned 4 x 6 over the area and power-law scaled. Real flow over the San Gabriel ridges is far more complex, and the gust is the hour's maximum, so flyability is a coarse hourly estimate.
- The fire is the interpolated arrival raster, not a live fire. Dense smoke, heat plumes and firefighting airspace restrictions (TFRs) are not modelled.
- Three seeds per policy. The rule-based policies are nearly deterministic, while the Muse Spark runs vary from call to call.
- The base is a simulation setting, picked as the nearest point at least 1.5 km from the final burned area. It is not a claim about real staging.

## Reproduce

```
cd pipeline
uv sync --extra sim
uv run --extra sim pytest -q tests/test_sim.py
uv run --extra sim python -m sim.run --policy greedy --seeds 0 1 2
uv run --extra sim python -m sim.run --policy lawnmower --seeds 0 1 2
uv run --extra sim python -m sim.run --policy greedy --seeds 0 --t-start 2025-01-08T02:30:00Z --tag night
uv run --extra sim python -m sim.run --policy muse --seeds 0 1 2 --cap-usd 5          # MODEL_API_KEY in ../.env
uv run --extra sim python -m sim.run --policy muse-hybrid --seeds 0 1 2 --cap-usd 2
uv run --extra sim python -m sim.run --policy forecast --seeds 0 1 2                    # physics forecast edge
uv run --extra sim python -m sim.run --policy forecast --forecast map-edge --seeds 0 1 2 # ablation
uv run --extra sim python -m sim.run --policy muse --forecast muse --seeds 0 --cap-usd 3.5
uv run --extra sim python -m sim.run --events                                           # agent event logs for the app
uv run --extra sim python -m sim.run --summary
```

Each rollout also writes `<run>_s<seed>_events.jsonl`, which the Swarm tab's agent graph replays. It has one line per agent per decision: `{seq, t_utc, agent, parent, role: forecaster | commander | squad | drone, model, task, status: spawned | done | failed, output}`. A failed line means that agent's output was rejected or its call failed.
