---
name: drone-planning
description: >-
  How the agent plans the next hour of planned drone coverage on a replayed
  fire and writes the cited crew briefing. Use for "plan the drones", "auto-plan",
  "cover the front", "write the briefing", "approve", or any question about the
  drone plan, its score, grounded drones or hindsight.
---

# Drone planning

## The job

Plan **one hour** of coverage for six drones (D1 to D6, a plan; none fly) on the fire
the person is looking at. Then write a short crew briefing in which every
number comes from an action result. The person edits the same plan through the
same actions (dragging a watch point calls `update-drone-assignment`), so
read before you write and never overwrite their choices.

Be honest in plain words, without jargon tags: this is a replay of a past
fire, the drones are a plan, and the forecast was made earlier. Never say or
suggest that a drone flew, saw something or will fly.

Times: always speak local Pacific time the way people say it ("9 AM", "the
10 AM hour", "Jan 8, 9 AM"), in replies and suggested next steps. Never write
UTC or Z times ("17:00Z", "18Z hour"); those are only for action arguments.

## Steps

1. **Read the screen.** Call `view-screen` for fire, `t`, the selected drone,
   whether a forecast exists for this hour and any existing plan. If the
   person has a plan open, work on that plan.
2. **Read the front and the wind.** Call `get-forecast-front {fire, t}`. Note
   `method` (`muse` = Muse Spark, `physics` = fallback when Muse's reply was
   rejected) and say which one in the briefing. `frontPieces` with
   `maxAdvanceM >= 200` are the fast-moving head of the fire. Then call
   `flyable-cells {fire, t}`. A drone whose watch point sits in a cell with
   `flyable: false` (gust over 12 m/s at 120 m, the DJI Matrice 4TD rating) is
   grounded and counts for nothing.
3. **Place drones** with one `create-drone-plan` call (atomic; at most 6):
   - Put watch points only in flyable cells. A drone just inside a flyable
     cell can still watch front that lies in a grounded cell next to it, up to
     its radius (400 m by default) away. Keep the radius at 400 m unless the person asks; the cap is 600 m, and a bigger circle is a vaguer view, not a better plan.
   - Spread drones along the fast-moving front first, then along stretches
     near homes. Do not stack circles. Two watch points closer than about
     800 m overlap.
   - Locked drones are the person's (or an approved plan's). Leave them
     where they are: `create-drone-plan` keeps them and skips any drone you
     send with a locked id. `update-drone-assignment` refuses to change them.
   - Give every drone a short `reason` (for example "fast front by homes,
     flyable 11.4 m/s").
4. **Score and iterate, up to 3 times.** Every mutating call returns the new
   `score`. Look at `frontCoveragePct`, `fastCoveragePct`, `homesWatched`,
   `groundedCount` and `gaps`. `gaps` list uncovered front stretches, flyable
   ones first, with a `mid` you can use as a watch point. Move grounded or
   overlapping drones into the best flyable gaps. Stop after 3 rounds or when
   no flyable gap is left.
5. **Write the briefing** with `save-briefing`: 2 to 4 short paragraphs.
   - Paragraph 1 gives the hour (local time), the forecast method, front km
     in view and %, the fast-front %, and homes watched of homes near the
     front. Cite `{action: "score-plan", args: {planId}}`.
   - Paragraph 2 covers the wind and why some ground cannot be watched. Cite
     `weather-at` and/or `flyable-cells` with the exact args you used.
   - Copy numbers exactly as the actions returned them (rounding is fine) and
     compute nothing new. The server re-runs each cite and drops any
     paragraph with a number no cite contains. It also drops paragraphs with
     an address or with talk of what started the fire.
   - Read `dropped` in the result. Fix those paragraphs and save again.
6. **Report** concrete proof: plan id, drones placed, coverage, grounded
   count, paragraphs kept and dropped. Ask the person to review, then approve
   (`approve-plan` locks the drones and moves the map to t + 1 h). Approve
   only when the person asks.
7. **After approval**, `hindsight-check {planId}` shows the share of ground
   that actually burned in that hour (estimated arrival raster) inside the
   flying drones' circles, next to an even-spacing baseline. It is hindsight
   on estimated data. Do not present it as a prediction.

## When the wind grounds everything

Some hours have no flyable cell. At **10 AM PST on Jan 8, 2025** (t = 2025-01-08T18:00Z) on
Eaton, all 24 wind cells gust over 12 m/s at 120 m, so all six drones are
grounded and coverage is 0 whatever the plan. Say so plainly ("the wind grounds
all six drones this hour") and cite `flyable-cells`. Do not place drones to
make the number look better. That night and morning, drones of this class
could not have flown at all, the same headline as the Meta build's swarm
study.

## Reference

- Score: geometry on the forecast front from `get-forecast-front`. It is not
  the MuJoCo sim. Watch circle: 400 m default. At 120 m, a 45° tilted thermal
  camera sees about 70 to 200 m ahead, the gimbal sweeps about 150 m, and a
  slow orbit of about 250 m around the point adds the rest.
- Homes are inspected structures (CAL FIRE DINS) not yet burned at t, within
  500 m of the front. Use counts only, never addresses.
- Gust: HRRR hourly gust (max of the preceding hour) on a 4 x 6 grid, scaled
  from 10 m to 120 m by the 1/7 power law. The planned hour uses every HRRR
  hour that overlaps it.
