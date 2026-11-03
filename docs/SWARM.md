# Drone swarm (SIM)

**Would a drone swarm have kept eyes on the Eaton Fire's front?** This is a MuJoCo simulation flown over the real fire.
Six simulated survey drones fly over the real terrain, while the reconstructed spread and real HRRR wind are replayed underneath them. Muse Spark plans their flights as a commander agent plus three squad agents. Two rule-based policies fly the same episode for comparison.

Everything in this section is **SIM**. No drones flew this fire, and the drone class is a set of round, documented assumptions, not a product.

Code: [`pipeline/sim/`](../pipeline/sim) · tests: [`pipeline/tests/test_sim.py`](../pipeline/tests/test_sim.py) · app: Incident rail → **Swarm** ([`rail/swarm.tsx`](../web/src/rail/swarm.tsx), [`stage/swarm-layer.ts`](../web/src/stage/swarm-layer.ts)).

## What is real and what is simulated

| Part | Source | Status |
| --- | --- | --- |
| Terrain | `dem.png` on the 16 m analysis grid, as a MuJoCo heightfield | REAL |
| Where and when the fire burned | `arrival.png`: arrival times interpolated between mapped perimeters (about 28 min steps) | MODELED |
| Wind | HRRR 3 km hourly 10 m wind (`wind_field.json`, 4 x 6 partition), scaled to flight height by a 1/7 power law | REAL input, scaled |
| Drones, sensors, batteries, every flight | `sim/env.py` | SIM |

## How it works

1. **Physics (MuJoCo).** Each drone is a free rigid body. It feels gravity, a thrust force capped at 2.5 times its weight, and quadratic drag against the local wind, plus turbulence scaled by the hour's gust excess. A velocity-capped position controller flies it to waypoints at 150 m above ground, and it follows the terrain by clearing the highest ground 400 m ahead. A terrain contact ends the flight. This is a point-mass model with no attitude dynamics.
2. **Safety layer (all policies).** A drone may not launch, and is recalled, when the wind at flight height exceeds 26 m/s. It returns home on its own when its battery reaches what the trip home against the wind needs, plus a 15% reserve, and it swaps batteries at base in 5 min.
3. **Sensing.** Every 10 s each airborne drone checks line of sight to the ground cells within 600 m against the terrain. A visible cell inside the replayed fire is recorded as seen.
4. **What policies know.** Policies get only the swarm's own observations: clusters of ground seen burning in the last 30 min, and the minutes since each 2 km block was last viewed. They also get the current-hour wind and the publicly reported start. They never see the arrival raster.
5. **Policies**, deciding every 15 min:
   - **Lawnmower:** one strip per drone, swept back and forth.
   - **Greedy:** each free drone orbits the downwind edge of the nearest observed cluster, or searches around the reported start.
   - **Muse Spark swarm** (`sim/muse.py`): a commander call (`task_squads`) gives each squad an area and an objective. Then three squad calls run in parallel (`set_waypoints`), and each plans its own two drones. Each one is a real `muse-spark-1.3` tool call. Waypoints are only clipped to the area. When a call fails or returns something malformed, those drones keep their previous plan and the error is logged. Free text that talks about how the fire started is removed, the same rule the analyst follows. Spend is capped per rollout with the analyst's prices.
6. **RL view.** `SwarmEnv` is a Gymnasium environment on the same simulation, where one step is one decision interval. The action is a target point per drone. The observation is three coarse maps (seen burning, seen ever, coverage age) plus the drone states. The reward is newly seen burned cells, tripled for cells seen within 30 min of arrival. It is there for training. No trained policy is part of the results.

## Metrics

- **Front seen within 30 min:** the share of cells the fire reached during the episode that a camera saw within 30 min of their interpolated arrival. The arrival times have about half-hour resolution, so this is coarse.
- **Area mapped:** the hourly mean of the share of the burned area the swarm had seen by then.
- **Event sightings:** the minutes from a mapped event (ridge crossing, fastest growth) to the first sighting of burned ground within 500 m.

## Results

Eaton, 2025-01-08 02:30 to 14:30 UTC (6:30 PM to 6:30 AM PST), 6 drones, 3 seeds per policy. The table is generated from `web/public/data/eaton/swarm/eval.json` (`uv run --extra sim python -m sim.run --summary`).

| Policy | Front seen within 30 min | Front seen by the end | Area mapped | Median minutes to first sighting | Flight hours | Model calls · cost |
| --- | --- | --- | --- | --- | --- | --- |
| Muse Spark swarm (`muse-spark-1.3`) | 14.6% (12.0–17.5) | 41.6% (38.1–46.9) | 40.0% (38.3–41.6) | 63 (40–92) | 40 (37–41) | 573 · $7.98 |
| Greedy | 25.7% (25.6–25.9) | 73.2% (73.1–73.3) | 58.2% (58.2–58.2) | 108 (108–108) | 35 (35–35) | – |
| Lawnmower | 20.7% (20.6–20.8) | 82.7% (82.4–83.0) | 38.3% (38.1–38.5) | 133 (124–138) | 23 (23–23) | – |

Mean over the 3 seeds, with the range in brackets. No drone was lost in any run. The wind kept the whole swarm on the ground for 1.3 h of the 12 h, at the Santa Ana peak.

**What it shows.** The Muse Spark swarm does not beat the greedy rule here. It flew the most hours, and the burned ground it did reach it saw sooner (a 63 min median against 108 min). But it concentrated on a few clusters, so it saw the least of the front overall. Its orders are coherent and wind-aware. For example, at 07:15Z it wrote: "Central ground north of ~5.5 km is above the 26 m/s ceiling and unflyable."

These runs also show a failure mode. In 26 of 144 decisions, a squad agent returned a runaway list of malformed plans, or the commander returned no usable tasks. Those drones kept their previous plan. The published rollouts were made before squad output was bounded the way commander output is. That fix is in `sim/muse.py`, and rerunning them is the obvious next step.

## Limits

- Point-mass drones with no attitude, motor or sensor-noise models, and a battery model that only scales with thrust.
- Wind is HRRR at 3 km, partitioned 4 x 6 over the area and power-law scaled. Real flow over the San Gabriel ridges is far more complex.
- The fire is the interpolated arrival raster, not a live fire. Smoke, which would blind a real camera, is not modeled.
- Three seeds per policy. Muse Spark runs also vary from call to call.
- The base is a simulation setting, picked as the nearest point at least 1.5 km from the final burned area. It is not a claim about real staging.

## Reproduce

```
cd pipeline
uv sync --extra sim
uv run --extra sim pytest -q tests/test_sim.py
uv run --extra sim python -m sim.run --policy greedy --seeds 0 1 2
uv run --extra sim python -m sim.run --policy lawnmower --seeds 0 1 2
uv run --extra sim python -m sim.run --policy muse --seeds 0 1 2 --cap-usd 5   # MODEL_API_KEY in ../.env
uv run --extra sim python -m sim.run --summary
```
