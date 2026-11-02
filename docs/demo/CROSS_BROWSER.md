# Cross-browser check

Checked on 2026-10-31 against `a/data` at `1eadb16`, with `npm run dev`, both fires, at 1600×950.

| Engine | Browser | Result |
|---|---|---|
| Blink | Chromium (Playwright, SwiftShader WebGL) | Works, once the terrain worker can load (see issue 1) |
| WebKit | WebKitGTK 2.52.6 (MiniBrowser under Xvfb, driven over WebDriver) | Works, once the terrain worker can load. WebGL2 available; no page errors |
| Gecko | Firefox | **Not tested.** Firefox could not be downloaded in the sandbox (its download hosts are blocked) |

WebKitGTK shares Safari's engine but not its graphics stack or macOS integration, so this is a strong signal for Safari, not a Safari test. Before recording, open the app once in Safari and once in Firefox on a Mac.

## What was checked in WebKit

- Both fires load from `?fire=` and `?t=` links, and the clock opens at the linked moment (Jan 8, 13:30 PST for `?fire=palisades&t=2025-01-08T21:30:00Z`).
- 3D terrain, burn scar, fire progression, mapped perimeters, ignition posterior, spread spine and place labels render as in Chromium.
- Play advances the clock (Jan 7, 19:00 → Jan 8, 02:54 PST in 4 s at 1×); Pause stops it.
- 2D/3D toggle, the Weather (Wind Vectors) and Structures layers, and the map key update with them.
- Incident → Layers, Analysis, Evidence and Analyst subtabs, and the Risk tab, render without layout breaks.
- No `error` or `unhandledrejection` events during the session.

Not checked: hover readouts, clicking a structure, the analyst with a live key, and touch input.

## Issues

1. **Fixed: the 3D terrain no longer depends on unpkg.com.** `TerrainLayer` (in `web/src/stage/Stage.tsx`) used to let loaders.gl fetch its decoder worker from `https://unpkg.com/@loaders.gl/terrain@4.5.4/dist/terrain-worker.js`, so wherever unpkg was unreachable (an offline demo, a venue or corporate network that blocks it, a strict CSP) the terrain mesh never loaded and the map was empty in every browser. `Stage.tsx` now imports the installed worker (`@loaders.gl/terrain/terrain-worker.js?url`), Vite copies it into the build as `assets/terrain-worker-<hash>.js`, and the `TerrainLayer` gets that URL as `loadOptions: {terrain: {workerUrl}}`, so the worker comes from the app's own origin (in `npm run dev` too). The smoke test (`web/tests-smoke/demo.smoke.mjs`) blocks unpkg.com, and fails if the page requests anything from it, loads the worker from anywhere but the app's origin, or doesn't draw the map.
2. **Google Fonts load from the network.** `index.html` pulls Inter and JetBrains Mono from fonts.googleapis.com. Offline, the app still works and falls back to system fonts, so only the look changes.
3. **README wording.** The Limitations section says the app "has been checked in desktop Chromium only". After this check it can say Chromium and WebKitGTK, with Safari and Firefox still to confirm by hand.
