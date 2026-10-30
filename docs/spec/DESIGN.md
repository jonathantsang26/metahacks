# DESIGN.md: the reference UI, transcribed

Source: Dilum Sanjaya's X post, "Played around with an idea for a wildfire analysis tool" (built with Claude), 115 s screen recording, no audio, captured at 3456×1990 (a 1728×995 CSS-px window at 2×). The app in the video is called **FireTrace**. We copy the layout and interaction model, but **we do not ship the FireTrace name or its mountain logo**. Our working name is **Sentinel Ember**, and the repo README credits the post as design inspiration.

The frames referenced below (`ref/…`) are stills from that video. They are **kept locally in `docs/spec/ref/` and are not committed**, because they are someone else's work. Ask a teammate for the folder, or watch the original post. This file is the checklist; the frames are the target.

All the data in the video is fictional (the "Ridgeview Incident", Aug 14–18 2024, San Gabriel Mountains). The drone fleet, aircraft and crews are a scripted scenario. Our version replaces that data with a real fire wherever possible. See BUILD.md §6.

---

## 1. Layout (CSS px at a 1728×995 viewport)

```
┌──────────────────────────────── Header 40px ─────────────────────────────────┐
├─────────────────────────────────────────────────────────────┬────────────────┤
│                                                             │                │
│                    Map stage (3D / 2D)                      │  Right rail    │
│                    flex 1 × ~729px                          │  308px wide    │
│                                                             │  full height   │
├──────────────────────────── Dock 226px ─────────┬───────────┤  below header  │
│ Timeline row ~100px (transport + scrubber)      │ Side list │                │
├─────────────────────────────────────────────────┤ 221px     │                │
│ Charts row ~126px: 3 equal charts               │           │                │
└─────────────────────────────────────────────────┴───────────┴────────────────┘
```

- Measured from frames: header bottom edge y=80 device px, so 40 CSS px. The rail's left edge is at x≈2837 device px, which makes it ≈309 CSS px wide. The dock's top edge is at y≈1539 device px, so the dock is ≈225 CSS px tall. The side list (Key Events / Detections / Air Ops Log) is ≈221 CSS px wide.
- The right rail runs from the header to the bottom of the window. The dock sits only under the map, not under the rail.
- Panels have no drop shadows. Separation comes from 1px hairlines and slightly different cream tones. Corner radius is ~6px on cards and buttons and ~4px on chips.
- Density is high: 11–13px UI text, with 6–8px of padding in list rows.

## 2. Design tokens (sampled from frames, rounded)

| Token | Value | Where |
|---|---|---|
| `--bg-chrome` | `#DEDBCC` | header, dock, chart backgrounds |
| `--bg-card` | `#DEDACE` | rail cards, key-events list |
| `--bg-rail` | `#D1C8B9` | rail background below the cards |
| `--bg-section-head` | `#D3CCBC` | card title rows ("Incident Overview") |
| `--bg-tabgroup` | `#D1CEBF` | segmented control track (header tabs) |
| `--bg-tab-active` | `#F2EFE6` | active header tab pill |
| `--bg-row-selected` | `#DCCABC` | selected list row (terracotta tint) |
| `--text` | `#29251A` | primary text |
| `--text-muted` | ≈`#857E6E` | labels, secondary lines, disabled layers |
| `--accent` | `#D1654B` | primary buttons ("Full camera view", "Chase"), active 3D toggle, selected-row icon tile |
| `--live` | `#B53536` | LIVE dot, "On final" status, retardant bars |
| `--badge` | ≈`#D2492F` bg, white text | count badges on tabs and lists |
| `--ok` | `#678352` | battery bars, "Mapping" chip text |
| `--chip-ok-bg` | ≈`#DCE3CF` | mission chips |
| `--btn-dark` | `#2E2A22` | "Thermal" button, pause (active transport) |
| `--hud-bg` | `#27231A` at ~92% | chase HUD card, PiP chrome bar |
| Chart: area | fill `#D3A488` @ 60%, stroke `#C0563A` | Fire Area |
| Chart: rate | stroke `#B8322E` | Rate of Spread |
| Chart: elevation | fill `#B3B7A0`, stroke `#4E5A44` | Elevation Profile, Personnel |
| Chart: retardant | fill/stroke `#9D2E35` | Retardant Dropped |
| Fire glow | `#FF7A1A` → `#FFD27A` (additive) | active front in 3D |
| Char | ≈`#3A332C` with red-orange ember speckle | burned area in 3D |
| Perimeter | white, 2px, dashed 6/4 | final perimeter (3D and 2D) |
| Spread spine | `#F2B233`, dashed | ignition-to-head path with time waypoints |

Fonts: the UI sans looks like Inter or SF Pro. Use `Inter, system-ui`, weight 400/500/600. All HUD text is monospaced and uppercase (`JetBrains Mono` or `SF Mono`), 11–12px, with letter-spacing 0.04em.

## 3. Header (40px)

Left to right:
1. Logo mark (a small terracotta mountain or flame; **draw our own**) followed by the product name, 18px semibold
2. A thin vertical divider, then the subtitle "Wildfire Forensic Analysis", 14px, muted
3. A dotted vertical divider, then the incident switcher "Ridgeview Incident ⌄" in 14px semibold
4. The location, "San Gabriel Mountains, CA", muted
5. A calendar icon and the date range "Aug 14, 2024 – Aug 18, 2024"
6. A segmented tab group: **Incident** (map icon) | **Drones** (quad icon, red badge `6`) | **Resources** (truck icon, red badge `6`). The active tab is a lighter pill.
7. Dropdowns, each with an icon and a ⌄: **View**, **Analysis**, **Share**
8. A divider, then a gear icon
9. A divider, then a minimize "—" that collapses the rail

## 4. Map stage

### 4.1 Persistent chrome
- **Compass**: top-left, a 36px circle containing an arrow with "N" above it. It rotates with the camera bearing. Clicking it resets north-up.
- **Bottom-right cluster**: a scale bar (`0 · 0.5 · 1 km`) to the left of a segmented **2D | 3D** toggle (active segment filled `--accent`), then a zoom-multiplier dropdown ("2.5× ⌄", "1.4× ⌄", up to "82.8×" in chase cam), then a fullscreen button.
- **Hover inspector**: a dark tooltip (`--hud-bg`) that follows the cursor over terrain. Example contents:
  - Line 1: `1,169 m · 37° slope · SSW-facing`
  - Line 2: `● Outside the final perimeter`, or `● Burned Aug 15 00:01 · 42 h 29 min ago`
  - Line 3 (muted): fuel class, e.g. `Mixed conifer, heavy` or `Annual grass, light`
  - Line 4 (mono, muted): `34°17.44'N 117°55.91'W`
- In **2D only**: graticule labels along the top (`118°03'W … 117°53'W`) and right edge (`34°21'N … 34°17'N`) in small boxed chips.

### 4.2 3D scene (Incident tab), see `ref/01`, `ref/02`, `ref/12`
- Terrain: a stylized painted relief, not a photo. Grassland is warm beige, chaparral is olive, conifer stands are dark green. It is lit by a low sun, and the far terrain fades into light haze with a pale sky.
- **Instanced low-poly trees** (cones and rounded blobs) cover vegetated cells. Trees inside burned cells turn dark brown or black.
- Places: water bodies are flat blue-grey ("Silverwood Reservoir"). Roads are pale grey ribbons. Labels are white with a soft shadow: peaks get a ▲ and their elevation ("Pine Ridge 2,430 m", "Mesa Peak 1,892 m", "Oak Flats 1,120 m"), and creeks are named ("Canyon Creek").
- **Fire rendering at time t**:
  - Burned area: charred dark texture with scattered glowing ember speckle.
  - Active front: a bright orange-yellow glowing band with bloom. Close up (`ref/02`) it shows flicker and point lights.
  - Not yet burned: normal terrain.
  - Final perimeter: a white dashed line, always visible.
  - Burn-scar dNBR layer: a red-orange wash over high-severity patches on the flanks.
- **Spread spine**: a yellow dashed path from the ignition point to the head of the fire, with timestamp waypoints (orange ring markers labelled `Aug 14, 18:00`, `Aug 15, 00:00`, `Aug 15, 06:00`, `Aug 15, 12:00` in dark label chips).
- **Spread arrows**: thick orange arrows with arrowheads along the major runs.
- **Ignition marker**: a red dot with expanding concentric rings, a starburst glow, and the label `Ignition` / `Aug 14, 14:26`.
- **Suppression layer**: red retardant stripes on the terrain that fade over the following days, and hand lines drawn as orange hatched lines along ridges (`ref/11`).
- **Wind vectors layer** (off by default, toggled on in the last 10 s, `ref/12`): animated white streamlines flowing across the terrain.

### 4.3 2D mode, see `ref/07`, `ref/08`
- A light topographic basemap: white and pale green with contour texture.
- The fire is a red-orange fill: the core is darker red, the outer rings are lighter, there is a hatch pattern inside the final perimeter, and the final perimeter is drawn as a grey dashed line.
- The same spine and waypoint chips as 3D, plus red retardant drop bars.
- The Resources tab adds unit chips on the map: a colored square, the ID, and a status (`C-14 17 · Holding & mop-up`, `E-45 Patrol`, `WT-12 To E-31`), and a staging marker `Ⓢ Staging · Canyon Creek Rd`.

## 5. Right rail by tab

### 5.1 Incident tab (`ref/crop-rail-incident.jpg`)
**Sub-tabs**: `Layers` (active, underlined) · `Analysis` · `Evidence` · `Notes`

**Layers list** (checkbox, 36px square thumbnail, name, opacity slider, %). Unchecked rows are muted.

| # | Layer | Default | Opacity |
|---|---|---|---|
| 1 | Terrain (3D) | on | 100% |
| 2 | Aerial Imagery | on | 100% |
| 3 | Burn Scar (dNBR) | on | 90% |
| 4 | Fire Spread (Modeled) | on | 100% |
| 5 | Ignition Probability | on | 80% |
| 6 | Weather (Wind Vectors) | off | 70% |
| 7 | Suppression (Drops & Line) | on | (no slider) |
| 8 | Structures | off | — |
| 9 | Roads & Trails | off | — |
| 10 | Administrative Boundaries | off | — |

**Incident Overview** card (title row with an `Edit` link). The rows are key/value pairs:
`Incident Name` Ridgeview Incident · `Incident ID` CA-LAC-2024-0176 · `Location` San Gabriel Mountains, CA · `Start (Est.)` Aug 14, 2024 14:26 · `End` Aug 18, 2024 11:20 · `Total Acres` 12,480 acres · `Cause (Prelim.)` **Under Investigation** · `Analysis Status` ◉ In Progress (grey dot chip)

**Weather & Fire Behavior** `(at cursor)` with a ⋮ menu. A 3×2 grid with an icon, label and value in each cell:
- Wind `16 mph` / `W (273°)` · Temp `35 °C` · RH `11%`
- Fuel Moisture `3%` · ERC `84` · Flame Length `12–19 ft`

These values **change with the timeline and the cursor**. At a later time the same card read Wind 13 mph SW (235°), Temp 21 °C, RH 54%, Fuel Moisture 10%, ERC 60, Flame Length 4–5 ft. Out-of-normal values are tinted `--live` red (seen on RH 54%, Fuel Moisture 10%, Flame Length). At the very end it read "Flame Length: Burned out".

### 5.2 Drones tab (`ref/crop-rail-drone.jpg`, `ref/03`–`06`)
**Drone Fleet** header: `· 6 of 6 airborne` with a `● LIVE` indicator on the right.

Each fleet row has: a 40px icon tile (fixed-wing or quad glyph; the selected row's tile is filled `--accent`), the ID in bold and callsign, the mission on a second line, a status chip at top right, altitude below the chip, and a battery bar with its %.

| ID | Callsign | Mission line | Chip | Alt | Batt |
|---|---|---|---|---|---|
| FT-01 | Kestrel | Perimeter mapping | Mapping | 1,980 ft | 77% |
| FT-02 | Harrier | Head fire watch | Orbit · active fire | 580 ft | 73% |
| FT-03 | Swift | Flank & spot watch | Orbit · spot fire | 600 ft | 77% |
| FT-04 | Osprey | Structure protection | Patrol | 760 ft | 84% |
| FT-05 | Condor | Hotspot survey | Survey | 1,560 ft | 69% |
| FT-06 | Wren | Comms relay | Relay | 910 ft | 78% |

**With nothing selected**, a **Fleet Overview** card shows the hint "Select an aircraft on the map or in the list to ride along and open its camera feed." and four stats: Airborne `6 of 6`, Avg battery `77`, Detections `1 this session`, Weakest link `-77 dBm`.

**With a drone selected**, a detail card appears: title `FT-01 Kestrel` with a `Mapping` chip, then a 3×2 stat grid:
Altitude `1,980` ft AGL · Ground speed `55` kn · Heading `162°` SSE · Battery `77%` ~68 min left · Link `-73` dBm · Flight time `0:50:06`.
Below that come key/value rows: Aircraft `Fixed-wing VTOL` · Mission `Perimeter mapping` · Task `Flying the current fire edge, mapping it every lap` · Sensor `EO/IR · 30× zoom` · Position `34°20.73'N 117°55.28'W` · Gimbal `219° · -70° · 1.0×`.
Buttons: `⤢ Full camera view` (accent) and `Thermal` (dark).
Other drones' Task strings include "Circling the most active part of the fire", "Circling the next most active part of the fire (spot fire once it starts)", "Patrolling Oak Flats and East Fork", "Survey lines over the burned area", and "Relay for crews in Canyon Creek".

### 5.3 Resources tab (`ref/08`, `ref/09`)
Header: **Resources** `· 13 units · 13 active` with `● LIVE`.
A stat strip of four cells: `6/6` aircraft up · `312k` gal retardant · `1,111` chains line · `67` personnel.

Grouped list (row: icon, **ID** + type, status line with a colored dot, right-aligned quantity):
- **AIRCRAFT**: T-910 DC-10 VLAT · Inbound · 9,400 gal / T-131 C-130Q Air Tanker · On final · 4,000 gal / T-162 RJ85 Air Tanker · Return to reload · 0 gal / H-743 S-64 Air-Crane · To drop · 2,650 gal / H-531 Bell 205 · bucket · To drop · 324 gal / AA-52 King Air 200 · Air Attack · Air Attack · supervising · 2 pers.
- **ENGINES & TENDERS**: E-31 Type 3 Engine · Structure protection · 4 pers. / E-32 Type 3 Engine · Structure protection · 5 pers. / E-45 Type 1 Engine · Patrol · 4 pers. / WT-12 Water Tender · To E-31 · 2,500 gal
- **CREWS & DOZERS**: C-7 Crew 7 · Hotshots · 20 · Holding & mop-up · 352 ch / C-14 Crew 14 · Hand crew · 17 · Holding & mop-up · 321 ch / DZ-4 D6 Dozer · Holding & mop-up · 438 ch

**Operations** card (`● Air ops active`) containing the hint: "Click an aircraft to ride along with it. Click an engine, crew or dozer to follow it. Drops leave retardant lines that fade over the following days."

**Aircraft detail** (replaces the Operations card): `T-910 DC-10 VLAT` `● On final`. Airspeed `300` kt · Altitude `1,440` ft AGL · Heading `155°` SSE. Then `Load · retardant 9,400 / 9,400 gal` with a red bar. Agency `CAL FIRE (exclusive use)` · Assignment `On final · lead plane` · Drops `0 this session` · Position. Buttons: `Chase` (accent) · `Cockpit` · `Overview`.

**Ground-unit detail**: Speed `0` mph · Personnel `4` on unit · Division `Z` ICS. Agency, Assignment (`Structure protection · Oak Flats`, `Patrol · Canyon Creek Rd`), Position. Buttons: `Ride along` · `Overview`. Crews also show a `352 / 352 ch` line-built bar.

## 6. Dock

### 6.1 Timeline row (all tabs)
- `Timeline` label at top-left. Transport controls: ▶ play, ❚❚ pause (dark when playing), ▶❙ step, and a speed dropdown `1× ⌄`.
- The scrubber is a full-width track. A red gradient band marks fire activity intensity over time. Event glyphs sit on the track: a red dot for ignition, a 🔥 for rapid growth, ▲ triangles for spot fire, ridge crossing and containment. A round handle carries a dark tooltip with the current time (`Aug 15, 16:00`).
- Two-level tick labels: the day (`Aug 14`) above hours (`06:00 12:00 18:00 …`). The right side shows the range `Aug 14, 14:00 – Aug 18, 12:00`.

### 6.2 Charts row: three charts per tab, each with a ⋮ menu
Each chart draws a vertical cursor line at the current time with hollow circle handles. The past is solid and the future is drawn faded or dashed.

| Tab | Chart 1 | Chart 2 | Chart 3 |
|---|---|---|---|
| Incident | Fire Area (acres), 0–15,000 | Rate of Spread (chains/hr), 0–40, red line, future dashed | Elevation Profile (selected path), 900–2,100 m over 0–15 km, red dot at the front |
| Drones | Altitude (ft AGL), trailing −60 s → now | Max Temperature in View (°C) | Battery (%) |
| Resources | Retardant Dropped (gal), 0–500,000 | Fire Line Built (chains), 0–2,000 | Personnel Assigned, 0–100 |

The Drones charts are live telemetry with an x-axis of `−60 s … now` and the selected drone's ID and current value in the top-right corner (`FT-05 · 1,860 ft`, `48 °C`, `FT-05 · 69%`). The **selected drone** is drawn as a bold red-orange line with a light area fill, and the **other five drones** as thin grey lines behind it. Max Temperature in View drops to ambient the moment the hot spot leaves the camera frustum. That makes a good live tell that the panel is computed from the view.

### 6.3 Side list (right of the dock)
- **Incident: Key Events** with a `+ Add` button. Each row has an icon, label and time: ● Ignition (est.) Aug 14, 14:26 · 🔥 Rapid Growth Aug 14, 16:50 · ▲ Spot Fire (prob.) Aug 15, 03:12 · ⧗ Ridge Crossing Aug 15, 17:48 · ■ Containment (est.) Aug 18, 11:20. The current or most recent event row is highlighted with `--bg-row-selected` and a left accent bar. Future events are muted.
- **Drones: Detections** with a red count badge (`3`). Each row has an orange dot, `Hot spot · 980 °C` on the first line, `FT-01 · 34°19.8'N 117°55.6'W` muted and truncated on the second, and the time `04:00` on the right. In our build, each row is a Sentinel detection, labelled with its class and confidence (`Flame · 0.91`), and the temperature is shown only when it comes from the IR heat field.
- **Resources: Air Ops Log** with a red count badge (`99`). Each row has a colored square (red = retardant, blue = water), `T-162 · 3,000 gal retardant`, then `Div. C · 34°29.5'N 117°51.1'W` muted, and the time on the right.

## 7. Overlays

### 7.1 Drone camera PiP, see `ref/crop-pip-hud.jpg`
A floating 16:10 panel over the top-right of the map (≈ 700×450 CSS px). It is a rendered view from the drone's camera.

HUD elements, all mono, white on video:
- Corner brackets in all four corners, and a center crosshair
- Top-left: `● REC 0:00:03` / `FT-01 KESTREL` / `IR · IRONBOW` (or `EO`)
- Top-center: a heading tape (`210 … 240`) with a ▲ caret and the value `219°`
- Top-right: `AUG 15, 04:00 PDT` / mission `MAPPING`. The zone label must be computed: a January fire shows `PST` (BUILD §8).
- Right edge: a vertical gimbal scale labelled `GMB` with the caret at `-70°`
- Bottom-left: `ALT 1,970 FT AGL` / `GS 55 KT` / `HDG 169°`
- Bottom-center: `SPI 34°20.54'N 117°55.46'W` / `RNG 700 M · ELEV 1,661 M · 27 °C` (muted)
- Bottom-right: `BAT 77%` / `LNK -73 DBM` / `ZOOM 1.0× · 42° FOV`
- Target box: cyan corner-bracket box around a hot spot, labelled `HOT 963°C`

Chrome bar along the bottom: `FT-01 Kestrel` | `EO` `IR` segmented (the IR state is violet) | palette dropdown `Ironbow` (also `White hot`) | `− 1.0× +` zoom | a recenter icon | ⤢ expand | ✕ close.

Thermal palettes: **Ironbow** (black → violet → magenta → orange → yellow-white) and **White hot** (greyscale). Fire and recent burn are hot, and terrain is cool violet.

`Full camera view` expands the PiP to fill the whole map stage (`ref/05`, `ref/06`) while keeping the HUD.

On the map, the selected drone shows a callsign chip (`FT-01 1,980 ft`) and its flight pattern: an orbit ellipse drawn on the terrain, or the perimeter track.

### 7.2 Chase HUD (Resources), see `ref/09`
A dark card bottom-center over the map (≈ 640×110 CSS px):
- Line 1: `T-910 DC-10 VLAT  ● On final · lead plane`
- Stats: `IAS 300 kt` · `ALT 1,410 ft AGL` · `HDG 154° SSE`, then a `Retardant` red bar reading `9,400 gal`
- Buttons: `Chase` (accent) · `Cockpit`, and ✕ close
- Hint (muted): `Drag to look around · scroll to move the camera · C to switch view`

The camera follows a low-poly aircraft model with nav lights. Drops paint red stripes on the terrain. Ground units have a `Ride along` mode where the camera follows the vehicle along the road (`ref/10`).

## 8. Interaction walkthrough (what the video shows, in order)

| t (s) | What happens |
|---|---|
| 0–4 | Incident tab, 3D, timeline playing. The camera slowly orbits the burn scar, and the hover tooltip appears over terrain. |
| 4–10 | Fly-in to the ignition close-up (glow and rings), then follow the front up-slope. The current event row highlights as the playhead passes it (Spot Fire). |
| 10–16 | Pull back, scrub forward, and the spread arrows and waypoints build up. |
| 16–20 | Click **Drones**. Fleet chips appear over the scene and the rail switches to Drone Fleet. |
| 20–26 | Select FT-01. The PiP opens (EO) and the camera moves to follow the drone, with its orbit drawn on the terrain. |
| 26–30 | Toggle **IR**: the Ironbow palette appears, with the `HOT 963°C` target box. |
| 30–46 | Click through FT-02 … FT-06. Each one re-targets the follow camera, the PiP and the detail card, and a tooltip with burned time appears over the scar. |
| 46–52 | **Full camera view** on FT-06. Switch the palette Ironbow → White hot → Ironbow. |
| 52–56 | Back to **Incident**, then switch **3D → 2D**: topo basemap, perimeter fill, graticule. |
| 56–68 | Scrub in 2D. The perimeter grows, then zoom in and out. |
| 68–74 | Click **Resources** in 2D. Unit chips appear on the map. Toggle 2D → 3D. |
| 74–90 | Select T-910, T-131 and T-162 in turn. The chase camera rides behind each aircraft with the HUD, and drops paint red stripes. |
| 90–102 | Select E-31, E-45 (ride along on the road) and C-7 (hand line hatched along the ridge). |
| 102–115 | Back to **Incident**, 3D, with **Weather (Wind Vectors)** on. Animated streamlines, timeline at the end (`Aug 18, 11:20`), Flame Length "Burned out". |

## 9. Additions not in the reference (Meta models, house-level analysis)

Style these in the same visual language: cream cards, hairlines, `--accent` for primary actions, and mono only inside HUDs.

- **Notes sub-tab → Analyst** (Muse Spark):
  - A chat column: a question input at the bottom, and answers as cards.
  - Each factual clause ends in a **citation chip**: a small rounded chip in `--bg-row-selected` with an icon for the layer type and a mono label such as `ARRIVAL · Jan 8 02:14` or `WIND · 52 mph`. Hovering a chip highlights the cited place on the map. Clicking it eases the camera there and sets `t`.
  - A `Report` button produces a multi-paragraph incident report in the same chip style, with a `Copy` action.
  - The footer, muted, reads `Muse Spark · answers cite their sources · no cause is inferred`.
- **SAM 3.1 mask overlay in the PiP**:
  - EO mode: a 1.5 px cyan outline with a 15% cyan fill.
  - IR mode: a white outline.
  - Each mask carries a small mono label `SAM 3.1 · FIRE 0.88` at its top-left, matching the reference's `HOT 963°C` target box.
  - Sentinel's YOLO box stays as the corner-bracket target box, and the mask sits inside it.
  - A legend chip in the PiP chrome bar reads `Boxes: Sentinel · Masks: SAM 3.1`.
- **Analysis sub-tab → Ignition**: a heatmap legend, then the estimate (time ± and position ± as a credible region), then the **hold-out score** as a stat block like the drone detail grid.
- **Analysis sub-tab → Homes**:
  - Selecting a structure on the map shows its exposure timeline: a mini chart with the front-distance line and wind, marking the arrival time.
  - Beside it: construction features (roof, eaves, vents) and the outcome chip (`Destroyed`, `Major`, `No damage`).
  - Below: the exposure-matched table with counts and confidence-interval bars.
  - No addresses are shown anywhere.
- **Evidence sub-tab**: the source manifest as a list (layer, source, retrieval date, link), with `REAL` / `MODELED` / `SIM` chips.

## 10. Fidelity notes for the build agent

- Match the **structure, density and palette** first. A warm cream UI around a cinematic 3D map is what makes the reference look expensive.
- Camera moves are always eased (≈ 1.2–2 s, ease-in-out). There are no hard cuts except tab switches.
- Every number in the rail, charts and HUD is driven by the single global time `t`. Scrubbing must update all of them in the same frame (BUILD.md §3).
- Use `ref/01` as an overlay at 30% opacity during the first layout pass to match the proportions, then remove it.
