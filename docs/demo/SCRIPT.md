# Demo video script

About 3 minutes. Check the official length limit before recording, and cut beat 3 first if you're over.

Every link below opens the replay at an exact moment: `?fire=` picks the fire and `?t=` sets the clock (UTC, clamped to the replay window). The app shows the same moment in Pacific time, so the PST time to expect on screen is listed next to each link. Replace `http://localhost:5173` with the deployed URL if there is one.

## Before recording

- `cd web && npm ci && npm run dev`, in desktop Chrome or Safari at 1600×950 or larger. The app needs WebGL2.
- Stay online: the 3D terrain mesh is decoded by a loaders.gl worker that is fetched from unpkg.com at run time (see [`CROSS_BROWSER.md`](CROSS_BROWSER.md)).
- Open each link once before recording, so the textures are cached and the first frame isn't blank.
- Beat 6 (Risk) is written against the Risk tab that is still being built. Fill in its numbers from the app once that lands; the bracketed values are placeholders.
- Beat 5 (Analyst) needs `MODEL_API_KEY` in `web/.env`. Without a live run, use the fallback line in that beat. Never show an answer the app didn't produce.

## Beats

### 1. Open (0:00–0:15)

**Screen:** Eaton at the reported start, 3D.
[`?fire=eaton&t=2025-01-08T02:18:00Z`](http://localhost:5173/?fire=eaton&t=2025-01-08T02:18:00Z) → Jan 7, 18:18 PST

**Voice:**
> "January 7th, 2025. Two fires start in Los Angeles County, Palisades in the morning and Eaton that evening. Together they burn more than 37,000 acres. Afterwards, someone has to explain what happened: when the fire reached each street, where it started, and why some homes survived."

### 2. The problem (0:15–0:30)

**Screen:** stay on the same view. Hover the Map Key's REAL and MODELED tags.

**Voice:**
> "The public record is scattered. Perimeters are snapshots hours apart. Eaton's first map is almost five hours after the reported start; Palisades' is 26 hours. Wind comes from a few airports. Damage inspections are a separate table of about 30,000 structures. Sentinel Ember joins them into one timeline, and labels every layer as real or modeled."

### 3. Eaton replay (0:30–1:05)

**Screen:** press play at 2× from the peak gust; let it run through the first mapped perimeter and the ridge crossing.
[`?fire=eaton&t=2025-01-08T06:00:00Z`](http://localhost:5173/?fire=eaton&t=2025-01-08T06:00:00Z) → Jan 7, 22:00 PST

Then jump to the run into Altadena, and turn on the Weather (Wind Vectors) layer.
[`?fire=eaton&t=2025-01-08T23:10:00Z`](http://localhost:5173/?fire=eaton&t=2025-01-08T23:10:00Z) → Jan 8, 15:10 PST (mapped perimeter 8,761 acres)

**Voice:**
> "This is Eaton on real terrain. The peak HRRR gust over the fire area is 73 miles an hour at 10 p.m. The first mapped perimeter comes at 11:06. Between perimeters, every place gets an arrival time, interpolated from public perimeters and seeded from CAL FIRE's reported start. The charts below, fire area, rate of spread and the elevation profile along the spread spine, all follow the same clock. The arrows are the HRRR 3-kilometre wind field, which tracks the airport stations better than ERA5 does: a correlation of 0.90 against 0.71."

### 4. Palisades replay (1:05–1:25)

**Screen:** Palisades at the first mapped perimeter, then scrub back to the reported start to show how much of the fire had no map.
[`?fire=palisades&t=2025-01-08T20:34:00Z`](http://localhost:5173/?fire=palisades&t=2025-01-08T20:34:00Z) → Jan 8, 12:34 PST (11,543 acres at the first map)
[`?fire=palisades&t=2025-01-07T18:30:00Z`](http://localhost:5173/?fire=palisades&t=2025-01-07T18:30:00Z) → Jan 7, 10:30 PST

**Voice:**
> "Palisades is harder. Its first map comes 26 hours in, already at 11,500 acres. Everything before that is interpolated, and the app says so: the spread layer is labelled MODELED."

### 5. Ask the analyst (1:25–1:55)

**Screen:** Eaton, Incident → Analyst. Type the question, then click a citation chip so the map flies there and the clock jumps.
[`?fire=eaton&t=2025-01-08T12:00:00Z`](http://localhost:5173/?fire=eaton&t=2025-01-08T12:00:00Z) → Jan 8, 04:00 PST

Suggested question: *"When did the fire reach Lake Avenue, and what was the wind then?"*

**Voice (live run):**
> "The analyst is Meta's Muse Spark, calling nine read-only tools over the fire data. Every paragraph has to cite a tool result, and every number in it is checked against what those tools returned before it's shown. Click a citation, and the map and the clock go to it. Ask it what caused the fire, and it declines: that's not in the data."

**Voice (no live run yet):**
> "The analyst is built on Meta's Muse Spark with nine read-only tools over this data. The server checks that every paragraph cites a tool result and that every number matches it. It's tested offline against a 15-question eval per fire, and it's waiting on a live key."

### 6. Risk: after the fire (1:55–2:20)

**Screen:** switch to the Risk tab. The Debris-Flow Likelihood layer turns on. Step the design storm from 16 to 40 mm/h, then switch models.

**Voice:**
> "A burn scar is a hazard of its own. When winter rain hits it, slopes fail as debris flows. The Risk tab scores every stream segment in both burn areas with USGS's debris-flow model, under its design storms from 16 to 40 millimetres an hour of peak 15-minute rain. At [24] mm/h, [N] segments above Altadena are over [50]% likely. We compare it with our own [random forest and MLP], trained on [source]; they [agree/disagree] where [...]."

Fill in the bracketed values from the Risk tab before recording. If the rainfall-frequency step lands, add: "A [24] mm/h storm here has about a [X]% chance in any given year (NOAA Atlas 14)."

### 7. Analysis: where it started, and which homes survived (2:20–2:50)

**Screen:** Eaton, Incident → Analysis. Show the Ignition back-trace card and the posterior on the map, then press "Fly to estimate".
[`?fire=eaton&t=2025-01-08T07:06:00Z`](http://localhost:5173/?fire=eaton&t=2025-01-08T07:06:00Z) → Jan 7, 23:06 PST

**Voice:**
> "Where and when did it start? We back-trace a fire-spread model through every observed perimeter. On 30 synthetic Eaton fires with deliberately different physics, the start time lands within a median of 78 minutes, against 21.6 hours for the usual area back-extrapolation. On cases its calibration never saw, the 90% interval held the true start 93% of the time. For the real fires the interval is wider than six hours, so the app withholds a start time rather than guess."

**Screen:** turn on Structures, jump to the morning of Jan 8, and click two neighbouring houses 35 m apart: one destroyed with coarse vents, one undamaged with fine-mesh vents and a tile roof. Both had the fire arrive within 11 minutes of each other, under gusts of about 61–63 mph.
[`?fire=eaton&t=2025-01-08T13:30:00Z`](http://localhost:5173/?fire=eaton&t=2025-01-08T13:30:00Z) → Jan 8, 05:30 PST
The pair is near 34.2048, -118.1333 (structure ids 276924 and 277894 in `structures.geojson`).

**Voice:**
> "Then the homes. Each inspected house gets its exposure: when the fire arrived, the gust then, and its distance to wildland. At the same exposure, homes with fine-mesh vents had about a third the odds of destruction in Eaton, and half in Palisades. These are associations, not causes, and the app shows where the two fires disagree."

### 8. Close (2:50–3:05)

**Screen:** Incident → Evidence (the source manifest with REAL / MODELED tags), then the README's Evidence table.

**Voice:**
> "Every number here traces to a public source or a committed evaluation file, and the README's table is generated from them. Sentinel Ember: a forensic reconstruction of a real wildfire from public records."

## Lines to avoid

- Don't state or suggest a cause for either fire.
- Don't call CAL FIRE's reported point the origin. It is a reported incident location.
- Don't say the back-trace "found" the start time: for both real fires it is withheld.
- Don't claim the analyst ran live unless it did on camera.
- The Drones tab is disabled in this build; don't show it unless stream C has landed.
