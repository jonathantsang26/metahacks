"""Step 09b: house-level exposure and construction-feature associations.

For every inspected residence, joins CAL FIRE's construction attributes with the fire's
exposure at that spot: when the fire arrived (arrival raster), the gust at that hour, the
distance to wildland vegetation, and slope. Then asks, among homes exposed under similar
conditions, which construction features went with survival:

  * strata = gust at arrival (above/below the population median, which is recorded) × distance
    to wildland (< 100 m, 100–500 m, ≥ 500 m)
  * per feature contrast (e.g. ember-resistant vents vs not): Mantel–Haenszel odds ratio of
    destruction pooled across strata, with a Robins–Breslow–Greenland 95% CI
  * a logistic regression (IRLS) with exposure covariates and all contrasts together

These are associations in observational data, not causal effects: homes differ in ways the
inspection does not record (age, maintenance, defensible space, neighbouring structures).

Inputs:  structures.geojson (09), work/<fire>/arrival_hours.npy (06), weather.json (07),
         work/<fire>/landcover.npy (03), work/<fire>/slope_deg.npy (02), aoi.json
Outputs: exposure.json        columnar per-structure exposure (ids match structures.geojson)
         exposure_stats.json  strata, per-feature contrasts and the regression

Run: uv run python -m steps.s09b_exposure
"""

from __future__ import annotations

from datetime import timedelta

import numpy as np
from scipy.ndimage import binary_dilation, distance_transform_edt, uniform_filter

from ember.config import load_fire
from ember.grid import Grid
from ember.manifest import add_source
from steps.s06_arrival import iso, parse_t

RESIDENTIAL = {"Single Residence", "Multiple Residence", "Mixed Commercial/Residential"}
VEGETATION = (10, 20, 30)  # WorldCover tree, shrub, grass
WILDLAND_MAX_BUILT = 0.2   # vegetation counts as wildland only where < 20% of the 500 m around it is built-up
WILDLAND_WINDOW_M = 500.0
DIST_BANDS_M = (100.0, 500.0)

# Feature contrasts: (feature, label, "protective" values, "reference" values). Unknowns excluded.
CONTRASTS = [
    ("vents", "Vents: fine mesh (≤ 1/8\") or none vs coarse/unscreened",
     {'Mesh Screen <= 1/8"', "No Vents"}, {'Mesh Screen > 1/8"', "Unscreened"}),
    ("eaves", "Eaves: enclosed or none vs unenclosed", {"Enclosed", "No Eaves"}, {"Unenclosed", "Combustible"}),
    ("roof", "Roof: tile, metal or concrete vs asphalt or wood", {"Tile", "Metal", "Concrete"}, {"Asphalt", "Wood"}),
    ("window_pane", "Windows: multi-pane vs single-pane", {"Multi Pane"}, {"Single Pane"}),
    ("siding", "Siding: stucco/brick/cement or metal vs wood or vinyl", {"Stucco Brick Cement", "Metal"}, {"Wood", "Vinyl"}),
    ("fence_attached", "Attached fence: non-combustible or none vs combustible", {"Non Combustible", "No Fence"}, {"Combustible"}),
    ("deck_elevated", "Elevated deck: none or masonry vs wood/composite", {"No Deck/Porch", "Masonry/Concrete"}, {"Wood", "Composite"}),
    ("patio_cover", "Patio cover/carport: none or non-combustible vs combustible", {"No Patio Cover/Carport", "Non Combustible"}, {"Combustible"}),
]


def wilson(k: int, n: int, z: float = 1.96) -> list[float]:
    if n == 0:
        return [float("nan"), float("nan")]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 4), round(c + h, 4)]


def mantel_haenszel(tables: list[tuple[int, int, int, int]]) -> dict:
    """Pooled OR of destruction (protective vs reference) with the RBG 95% CI.

    Each table is (a, b, c, d) = (protective destroyed, protective survived,
    reference destroyed, reference survived) within one stratum.
    """
    R = S = PR = PS_QR = QS = 0.0
    for a, b, c, d in tables:
        n = a + b + c + d
        if n == 0:
            continue
        r, s = a * d / n, b * c / n
        p, q = (a + d) / n, (b + c) / n
        R, S = R + r, S + s
        PR, PS_QR, QS = PR + p * r, PS_QR + p * s + q * r, QS + q * s
    if R == 0 or S == 0:
        return {"or": None, "ci95": None}
    or_ = R / S
    se = np.sqrt(PR / (2 * R * R) + PS_QR / (2 * R * S) + QS / (2 * S * S))
    return {"or": round(or_, 3), "ci95": [round(float(np.exp(np.log(or_) - 1.96 * se)), 3),
                                          round(float(np.exp(np.log(or_) + 1.96 * se)), 3)]}


def logistic(X: np.ndarray, y: np.ndarray, names: list[str], iters: int = 50) -> dict:
    """Plain IRLS logistic regression with Wald 95% CIs on the odds ratios.

    Constant columns (no variation in this population) are dropped and listed.
    """
    keep = [j for j in range(X.shape[1]) if np.ptp(X[:, j]) > 0]
    dropped = [names[j] for j in range(X.shape[1]) if j not in keep]
    X, names = X[:, keep], [names[j] for j in keep]
    X = np.column_stack([np.ones(len(X)), X])
    beta = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ beta))
        w = np.clip(p * (1 - p), 1e-9, None)
        H = X.T @ (X * w[:, None]) + 1e-8 * np.eye(X.shape[1])
        step = np.linalg.solve(H, X.T @ (y - p))
        beta += step
        if np.abs(step).max() < 1e-8:
            break
    cov = np.linalg.inv(X.T @ (X * w[:, None]))
    se = np.sqrt(np.diag(cov))
    out = []
    for name, b, s in zip(["intercept"] + names, beta, se):
        out.append({"term": name, "coef": round(float(b), 4), "or": round(float(np.exp(b)), 3),
                    "ci95": [round(float(np.exp(b - 1.96 * s)), 3), round(float(np.exp(b + 1.96 * s)), 3)]})
    return {"n": int(len(y)), "terms": out, "dropped_constant": dropped}


def main() -> None:
    fire = load_fire()
    grid = Grid.for_fire(fire)
    aoi = fire.read_json("aoi.json")
    w0 = parse_t(aoi["window_utc"][0])
    arrival = np.load(fire.work_dir / "arrival_hours.npy")
    landcover = np.load(fire.work_dir / "landcover.npy")
    slope = np.load(fire.work_dir / "slope_deg.npy")
    hourly = fire.read_json("weather.json")["hourly"]
    w_t = np.array([(parse_t(h["t"]) - w0).total_seconds() / 3600 for h in hourly])
    w_gust = np.array([h.get("gust_mph") or h["wind_mph"] for h in hourly], float)

    px, py = grid.pixel_m
    # Street trees are 'tree cover' in WorldCover, so wildland = vegetation away from the urban fabric.
    built_frac = uniform_filter((landcover == 50).astype(float), size=max(3, int(round(WILDLAND_WINDOW_M / px))))
    wild = np.isin(landcover, VEGETATION) & (built_frac < WILDLAND_MAX_BUILT)
    dist_wild = distance_transform_edt(~wild, sampling=(py, px))
    burned = ~np.isnan(arrival)
    near_burn = binary_dilation(burned, iterations=max(1, int(round(100 / px))))  # within ~100 m

    feats = fire.read_json("structures.geojson")["features"]
    cols = {k: [] for k in ("id", "arrival_t", "gust_mph", "dist_wildland_m", "slope_deg", "exposed")}
    rows = []
    for f in feats:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"][:2]
        c, r = (int(round(v)) for v in grid.to_px(lon, lat))
        if not (0 <= r < grid.height and 0 <= c < grid.width):
            continue
        a = arrival[r, c]
        gust = float(np.interp(a, w_t, w_gust)) if np.isfinite(a) else None
        exposed = bool(near_burn[r, c])
        cols["id"].append(p["id"])
        cols["arrival_t"].append(iso(w0 + timedelta(hours=float(a))) if np.isfinite(a) else None)
        cols["gust_mph"].append(round(gust, 1) if gust is not None else None)
        cols["dist_wildland_m"].append(round(float(dist_wild[r, c]), 1))
        cols["slope_deg"].append(round(float(slope[r, c]), 1))
        cols["exposed"].append(exposed)
        if exposed and p.get("structure_category") in RESIDENTIAL and p.get("damage") not in (None, "Inaccessible"):
            # Gust at arrival; for cells just outside the burned area use the nearest burned cell's time.
            if gust is None:
                r0, r1, c0, c1 = max(r - 8, 0), r + 9, max(c - 8, 0), c + 9
                local = arrival[r0:r1, c0:c1]
                gust = float(np.interp(np.nanmin(local), w_t, w_gust)) if np.isfinite(local).any() else 0.0
            rows.append({**p, "gust": gust, "dist": float(dist_wild[r, c]), "slope": float(slope[r, c]),
                         "destroyed": p["damage"] == "Destroyed"})
    fire.write_json("exposure.json", {"fields": list(cols), **cols})

    gust_split = float(np.median([r["gust"] for r in rows])) if rows else 0.0

    def stratum(row) -> str:
        g = f"gust>{gust_split:.0f}" if row["gust"] > gust_split else f"gust≤{gust_split:.0f}"
        d = row["dist"]
        band = "<100m" if d < DIST_BANDS_M[0] else ("100-500m" if d < DIST_BANDS_M[1] else "≥500m")
        return f"{g}|{band}"

    strata_names = sorted({stratum(r) for r in rows})
    strata = []
    for s in strata_names:
        sel = [r for r in rows if stratum(r) == s]
        k = sum(r["destroyed"] for r in sel)
        strata.append({"stratum": s, "n": len(sel), "destroyed": k, "rate": round(k / len(sel), 4),
                       "ci95": wilson(k, len(sel))})

    contrasts = []
    for feature, label, good, bad in CONTRASTS:
        tables, by = [], []
        for s in strata_names:
            sel = [r for r in rows if stratum(r) == s]
            a = sum(1 for r in sel if r.get(feature) in good and r["destroyed"])
            b = sum(1 for r in sel if r.get(feature) in good and not r["destroyed"])
            c = sum(1 for r in sel if r.get(feature) in bad and r["destroyed"])
            d = sum(1 for r in sel if r.get(feature) in bad and not r["destroyed"])
            tables.append((a, b, c, d))
            by.append({"stratum": s, "protective": {"n": a + b, "destroyed_rate": round(a / (a + b), 4) if a + b else None},
                       "reference": {"n": c + d, "destroyed_rate": round(c / (c + d), 4) if c + d else None}})
        n = sum(sum(t) for t in tables)
        # Observability check: features that burn away are harder to record on destroyed homes.
        unk = lambda grp: round(sum(1 for r in grp if r.get(feature) in (None, "Unknown", "N/A", "NA")) / max(len(grp), 1), 4)
        unknown = {"destroyed": unk([r for r in rows if r["destroyed"]]), "surviving": unk([r for r in rows if not r["destroyed"]])}
        contrasts.append({"feature": feature, "label": label, "n": n, **mantel_haenszel(tables),
                          "unknown_rate": unknown, "by_stratum": by})

    # Regression: complete cases on the contrasts' known values.
    names = [c[0] for c in CONTRASTS]
    complete = [r for r in rows if all(r.get(f) in (g | b) for f, _, g, b in CONTRASTS)]
    X = np.array([[r["gust"], np.log1p(r["dist"]), r["slope"]]
                  + [float(r.get(f) in g) for f, _, g, _ in CONTRASTS] for r in complete])
    y = np.array([float(r["destroyed"]) for r in complete])
    regression = logistic(X, y, ["gust_at_arrival_mph", "log1p_dist_wildland_m", "slope_deg"] + [f"{n}_protective" for n in names]) if len(y) > 50 else None

    fire.write_json("exposure_stats.json", {
        "population": "Inspected residences within ~100 m of the burned area (arrival raster), excluding inaccessible",
        "n": len(rows), "destroyed": int(sum(r["destroyed"] for r in rows)),
        "gust_split_mph": round(gust_split, 1),
        "strata": strata, "contrasts": contrasts, "regression": regression,
        "caveat": "Associations in observational inspection data, adjusted only for the recorded exposure variables; not causal effects. "
                  "Attributes of destroyed homes are recorded after the fire, so features that burn away (decks, fences, siding) can be "
                  "misrecorded; compare unknown_rate between destroyed and surviving homes per feature.",
        "wildland_definition": f"WorldCover tree/shrub/grass where < {WILDLAND_MAX_BUILT:.0%} of the surrounding {WILDLAND_WINDOW_M:.0f} m is built-up",
    })
    add_source(fire, layer="House-level exposure", source="CAL FIRE DINS joined with arrival, weather and land cover",
               url="", status="MODELED",
               notes=f"{len(rows)} exposed residences; Mantel–Haenszel ORs across {len(strata_names)} exposure strata; "
                     f"logistic regression on {len(complete)} complete cases.")
    print(f"{len(rows)} exposed residences, {sum(r['destroyed'] for r in rows)} destroyed")
    for c in contrasts:
        print(f"  {c['feature']:<15} n={c['n']:>5}  OR={c['or']}  CI={c['ci95']}")


if __name__ == "__main__":
    main()
