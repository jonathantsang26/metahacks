"""Step 16: how often each debris-flow design storm happens at the fire (NOAA Atlas 14).

USGS's post-fire debris-flow assessments (steps 14–15) give a likelihood *if* a storm of a given
peak 15-minute intensity (I15 = 16 … 40 mm/h) hits the burn area. This step supplies the other half:
how often such a storm comes. NOAA Atlas 14 (Volume 6, partial-duration series) gives rainfall
intensity for each duration at average recurrence intervals (ARI) of 1–1000 years at a point; this
step reads the table at the area of interest's center and inverts it for each design storm.

  * ARI between table points: ln(ARI) interpolated linearly in ln(intensity).
  * Below the 1-year value (Atlas 14 stops there): a Gumbel-type line through the 1- and 2-year
    values, I = I1 + b·ln(ARI), extended down to ARI = 0.1 years. Flagged as extrapolated.
  * Partial-duration ARI → chance per year: storms are a Poisson process with rate 1/ARI, so
    P(at least one in a year) = 1 − exp(−1/ARI), and in n years 1 − exp(−n/ARI).

`annual_chance(table, "15-min", mm_h)` is importable, so the Risk build can turn any threshold
(e.g. USGS's I15 at 50% likelihood per segment) into a chance per year.

Inputs:  aoi.json; the PFDS table (fetched, else fixtures/<fire>/atlas14_intensity.json)
Outputs: rain_frequency.json

Run: uv run python -m steps.s16_rain_frequency
"""

from __future__ import annotations

import json
import math

import numpy as np
import requests

from ember.config import PIPELINE_DIR, load_fire

PFDS = ("https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv"
        "?data=intensity&lat={lat}&lon={lon}&series=pds&units=english")
DESIGN_I15_MM_H = (16, 20, 24, 28, 32, 36, 40)   # USGS design storms (WORKSTREAMS.md, Risk contract)
MIN_ARI_Y = 0.1
YEARS = (1, 3, 5)  # windows for "chance in n years"; burn-related hazard fades over ~1–3 winters
MM_PER_IN = 25.4


def parse_pfds(text: str) -> dict:
    """PFDS CSV → {ari_years, durations, intensity_in_h: {duration: [..]}}."""
    ari, rows = None, {}
    for line in text.splitlines():
        cells = [c.strip() for c in line.split(",")]
        if line.startswith("PRECIPITATION FREQUENCY ESTIMATES") or cells[0] == "Duration":
            ari = [int(float(c)) for c in cells[1:] if c]
        elif ari and cells[0].rstrip(":").split("-")[0].isdigit() and len(cells) > len(ari):
            rows[cells[0].rstrip(":")] = [float(c) for c in cells[1:len(ari) + 1]]
    if not ari or "15-min" not in rows:
        raise ValueError("not a PFDS intensity table")
    return {"ari_years": ari, "durations": list(rows), "intensity_in_h": rows}


def load_table(fire, lon: float, lat: float) -> dict:
    url = PFDS.format(lat=round(lat, 4), lon=round(lon, 4))
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        table = parse_pfds(r.text)
        table |= {"url": url, "fetched": True}
        return table
    except (requests.RequestException, ValueError):
        fixture = json.loads((PIPELINE_DIR / "fixtures" / fire.id / "atlas14_intensity.json").read_text())
        return fixture | {"fetched": False}


def ari_for(table: dict, duration: str, mm_h: float) -> tuple[float, bool]:
    """Average recurrence interval (years) of a storm with this intensity; flag if extrapolated."""
    ari = np.array(table["ari_years"], float)
    inten = np.array(table["intensity_in_h"][duration], float) * MM_PER_IN
    if mm_h >= inten[0]:
        if mm_h > inten[-1]:
            return float(ari[-1]), True  # rarer than the table's longest ARI; reported as at least that
        return float(np.exp(np.interp(np.log(mm_h), np.log(inten), np.log(ari)))), False
    b = (inten[1] - inten[0]) / math.log(ari[1] / ari[0])
    return max(MIN_ARI_Y, float(math.exp((mm_h - inten[0]) / b))), True


def chance(ari_y: float, years: float = 1.0) -> float:
    return 1.0 - math.exp(-years / ari_y)


def annual_chance(table: dict, duration: str, mm_h: float) -> float:
    return chance(ari_for(table, duration, mm_h)[0])


def main() -> None:
    fire = load_fire()
    lon, lat = fire.read_json("aoi.json")["center"]
    table = load_table(fire, lon, lat)
    storms = []
    for i15 in DESIGN_I15_MM_H:
        ari, extrap = ari_for(table, "15-min", i15)
        storms.append({
            "i15_mm_h": i15, "ari_years": round(ari, 2), "extrapolated": extrap,
            "annual_chance": round(chance(ari), 3),
            **{f"chance_{n}y": round(chance(ari, n), 3) for n in YEARS if n > 1},
        })
    mm = {d: [round(v * MM_PER_IN, 1) for v in vals] for d, vals in table["intensity_in_h"].items()}
    fire.write_json("rain_frequency.json", {
        "source": "NOAA Atlas 14 Volume 6 Version 2 (PFDS), partial-duration series, point estimates",
        "url": table.get("url"), "point": [lon, lat], "fetched_live": table["fetched"],
        "ari_years": table["ari_years"], "intensity_mm_h": mm,
        "design_storms": storms,
        "method": {
            "interpolation": "ln(ARI) linear in ln(intensity) between table points",
            "below_1yr": "Gumbel-type line through the 1- and 2-year values, floored at ARI 0.1 y; flagged extrapolated",
            "chance": "Poisson arrivals: P(≥1 in n years) = 1 − exp(−n / ARI)",
        },
        "caveats": [
            "Point values at the area's center; Atlas 14 varies with terrain across a burn area.",
            "Atlas 14 (published 2011 from historical records) assumes a stationary climate; recent trends are not in it.",
            "Burn-related debris-flow susceptibility fades as vegetation recovers (typically 1–3 winters), so "
            "multi-year chances are an upper bound on post-fire storms.",
        ],
    })
    print(json.dumps(storms))


if __name__ == "__main__":
    main()
