"""Step 17 (prototype): per-area fire risk under the fire's own weather, scored on the other fire.

Question: given the terrain, fuels and the January 2025 Santa Ana winds, which ~95 m cells were
most likely to burn, and which homes sat in them? The step builds one risk map per fire and is
honest about how it is tested: every number it reports for a fire comes from a model that never
saw that fire's burn. Both fires are built in one run, because each is the other's training set.

Features per cell (model grid of step 11, 6 analysis cells ≈ 95 m):
  * fuel class (WorldCover, one-hot), slope, topographic position (cell minus its ~1 km mean)
  * how upslope points along the event's downwind direction, mean wind speed and peak gust over
    the 24 h after the reported start (HRRR wind field, step 07)
  * vegetation and built-up fractions within ~500 m, distance to wildland
  * variant "hybrid" only: the cell's Monte Carlo burn probability (below)

Monte Carlo burn probability (the simulated fires): N_SIMS ignitions, uniform over burnable
cells, each burning MC_HORIZON_H hours in the real HRRR wind with the step 11 spread model. Start
time uniform over the 12 h after the reported start, spread-rate scale k log-uniform 0.25–4 (the
synthetic benchmark's range), length-to-breadth cap from step 11's choices. Burn probability =
share of runs that reach the cell. It never looks at the real burn.

Variants (each trained on the other fire, then predicted on this one):
  baseline_veg   vegetation fraction within ~500 m (no training)
  physics_mc     Monte Carlo burn probability on this fire's own terrain and wind (no training)
  rf_real        random forest on local + neighbour-mean features, real burn labels
  mlp_real       one-hidden-layer MLP on local features, real burn labels
  attn_real      the MLP plus attention over 24 neighbours (ember/risk_nn.py), real burn labels
  attn_sim       the same attention model trained only on simulated burn probability (soft labels)
  attn_hybrid    attention model with burn probability as a feature, real burn labels  ← the map

The map was meant to be attn_hybrid, fixed before scoring. It scored worst on Eaton: trained on
Palisades, where burn probability ran against the real burn, it learned to use burn probability
backwards. The map now carries physics_mc (R) and attn_sim (G), the two variants that use no real
burn labels; that switch was made after seeing the scores, and risk_model.json says so. Metrics: ROC AUC and average precision over burnable cells, and for
inspected residences near the fire, AUC of the cell risk for "destroyed".

Not modelled: fuel moisture and soil moisture vary by day but hardly across one fire's area
(gridMET is 4 km, ERA5-Land 9 km), so with two fires they cannot be learned; the scenario block
records gridMET's ERC and 100-h fuel moisture as context instead. No ignition likelihood (people,
power lines): every burnable cell is equally likely to ignite.

Inputs:  fixtures/<fire>/model_inputs.npz (via step 11), wind_field.json, arrival.png, aoi.json,
         weather.json, structures.geojson, exposure.json
Outputs: risk/risk_map.png (R = physics_mc burn probability, G = attn_sim risk, both 0–255, on the
         model grid; bounds in risk_model.json), risk/risk_model.json

Run: uv run python -m steps.s17_risk_model [--sims 1000]
"""

from __future__ import annotations

import argparse
import json
from datetime import timedelta

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, uniform_filter
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import average_precision_score, roc_auc_score

from ember import spread as sp
from ember.config import load_fire
from ember.risk_nn import AttentionMLP
from steps.s06_arrival import iso, parse_t
from steps.s09b_exposure import RESIDENTIAL, VEGETATION, WILDLAND_MAX_BUILT
from steps.s11_ignition import FACTOR, LB_CHOICES, K_TRUE_RANGE, build_model

FIRES = ("eaton", "palisades")
N_SIMS = 1000
MC_HORIZON_H = 12.0       # each simulated fire burns for its first 12 h
EVENT_H = 24.0            # wind features: the 24 h after the reported start
NEIGHBOUR_RADII = (1, 2, 4)  # model cells (~95, 190, 380 m), 8 directions each → K = 24
WINDOW_CELLS = 5          # ~475 m neighbourhood for vegetation / built-up fractions
TPI_CELLS = 11            # ~1 km window for topographic position
FUELS = ((10,), (20,), (30,), (50,), (40,), (90, 95, 100))  # tree, shrub, grass, built, crop, other burnable
FUEL_NAMES = ("tree", "shrub", "grass", "built", "crop", "other_burnable")
LOCAL_FEATURES = [f"fuel_{n}" for n in FUEL_NAMES] + [
    "tan_slope", "tpi_100m", "upslope_downwind_cos", "wind_mean_mph", "gust_peak_mph",
    "veg_frac_500m", "built_frac_500m", "log1p_dist_wildland_m"]
EDGE_FEATURES = ["distance_cells", "upwind_cos", "downslope_cos"]
PRODUCT = "physics_mc"     # the map's R channel; see the module docstring for why it changed
PLANNED_PRODUCT = "attn_hybrid"
LEARNED_MAP = "attn_sim"   # the map's G channel, and the model whose attention is summarised
EDGE_BAND_M = 1000.0      # second evaluation region: cells within 1 km of the real burn's edge
BLOCK_CELLS = 10          # bootstrap blocks of 10 × 10 model cells (~1 km)
BOOTSTRAP = 200
SEED = 7
EPOCHS = 60


def offsets() -> np.ndarray:
    dirs = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]
    return np.array([(dr * r, dc * r) for r in NEIGHBOUR_RADII for dr, dc in dirs], np.int64)


# ----------------------------------------------------------------------------- inputs


class Scene:
    """One fire's model grid, features, Monte Carlo burn probability and real burn label."""

    def __init__(self, fire_id: str, n_sims: int):
        self.fire = fire = load_fire(fire_id)
        self.model = m = build_model(fire)
        self.grid = m.grid
        H, W = self.shape = m.grid.shape
        aoi = fire.read_json("aoi.json")
        self.start = parse_t(aoi["official"]["incident"]["start_utc"])
        self.start_h = (self.start - m.w0).total_seconds() / 3600
        self.burnable = m.terrain.r0 > 0
        self.landcover = np.load(_fixture(fire))["landcover"]
        self.elev = np.load(_fixture(fire))["elev"].astype(float)
        self.wind_to, self.wind_speed, self.gust = self._wind()
        self.local = self._local_features()
        self.burn_prob = self._monte_carlo(n_sims)
        self.burned = self._real_burn()

    def _wind(self):
        """Per-cell event-mean downwind unit vector (e, n), mean speed and peak gust (mph)."""
        m, (H, W) = self.model, self.shape
        idx, wts = m.wind.stencil(H, W)
        t = m.wind.t0_h + m.wind.dt_h * np.arange(len(m.wind.u_mph))
        sel = (t >= self.start_h) & (t <= self.start_h + EVENT_H)
        at_cells = lambda a: (a[:, idx] * wts).sum(-1)  # (T, H*W)
        u, v = at_cells(m.wind.u_mph[sel]), at_cells(m.wind.v_mph[sel])
        speed = np.hypot(u, v).mean(0)
        mu, mv = u.mean(0), v.mean(0)
        norm = np.maximum(np.hypot(mu, mv), 1e-9)
        f = self.fire.read_json("wind_field.json")
        th = np.array([(parse_t(s) - m.w0).total_seconds() / 3600 for s in f["t"]])
        gsel = (th >= self.start_h) & (th <= self.start_h + EVENT_H)
        gust = at_cells(np.array(f["gust_mph"], float).T[gsel]).max(0)
        to = np.stack([mu / norm, mv / norm], -1).reshape(H, W, 2)
        return to, speed.reshape(H, W), gust.reshape(H, W)

    def _local_features(self) -> np.ndarray:
        tr, lc = self.model.terrain, self.landcover
        px, py = self.grid.pixel_m
        onehot = [np.isin(lc, codes).astype(float) for codes in FUELS]
        veg = np.isin(lc, VEGETATION)
        built = (lc == 50).astype(float)
        built_frac = uniform_filter(built, WINDOW_CELLS, mode="nearest")
        wild = veg & (built_frac < WILDLAND_MAX_BUILT)
        dist_wild = distance_transform_edt(~wild, sampling=(py, px)) if wild.any() else np.full(lc.shape, 5000.0)
        tpi = self.elev - uniform_filter(self.elev, TPI_CELLS, mode="nearest")
        align = tr.up_e * self.wind_to[..., 0] + tr.up_n * self.wind_to[..., 1]
        cols = onehot + [tr.tan_slope, tpi / 100.0, align, self.wind_speed, self.gust,
                         uniform_filter(veg.astype(float), WINDOW_CELLS, mode="nearest"), built_frac,
                         np.log1p(dist_wild)]
        return np.stack(cols, -1)

    def _monte_carlo(self, n: int) -> np.ndarray:
        rng = np.random.default_rng(SEED)
        H, W = self.shape
        cells = np.flatnonzero(self.burnable.ravel())
        hits = np.zeros((H, W))
        lo, hi = np.log(K_TRUE_RANGE[0]), np.log(K_TRUE_RANGE[1])
        for _ in range(n):
            rc = divmod(int(rng.choice(cells)), W)
            t0 = self.start_h + rng.uniform(0, 12)
            arr = sp.arrival(self.model.terrain, self.model.wind, rc, t0, k=float(np.exp(rng.uniform(lo, hi))),
                             t_stop_h=t0 + MC_HORIZON_H, lb_max=float(rng.choice(LB_CHOICES)))
            hits += np.isfinite(arr)
        return hits / n

    def _real_burn(self) -> np.ndarray:
        """Cells (model grid) more than half burned in arrival.png (step 06)."""
        code = np.array(Image.open(self.fire.out_dir / "arrival.png"))[..., 0]
        fine = (code < 255).astype(float)
        H, W = self.shape
        return fine[:H * FACTOR, :W * FACTOR].reshape(H, FACTOR, W, FACTOR).mean(axis=(1, 3)) > 0.5

    def eval_regions(self, rc):
        """Bootstrap block id (~1 km squares) and the edge band (within EDGE_BAND_M of the burn's edge)."""
        rr, cc = rc
        block = (rr // BLOCK_CELLS) * 10_000 + cc // BLOCK_CELLS
        px, py = self.grid.pixel_m
        d_in = distance_transform_edt(self.burned, sampling=(py, px))
        d_out = distance_transform_edt(~self.burned, sampling=(py, px))
        edge = np.maximum(d_in, d_out)[rr, cc] <= EDGE_BAND_M
        return block, edge

    # ------------------------------------------------------------------ model tensors

    def tensors(self, with_bp: bool):
        """Flat (burnable cells) local features, neighbour inputs, valid mask, real and sim labels."""
        H, W = self.shape
        feats = self.local
        if with_bp:
            feats = np.concatenate([feats, self.burn_prob[..., None]], -1)
        rr, cc = np.nonzero(self.burnable)
        offs = offsets()
        nr, nc = rr[:, None] + offs[:, 0], cc[:, None] + offs[:, 1]
        valid = (nr >= 0) & (nr < H) & (nc >= 0) & (nc < W)
        nr, nc = np.clip(nr, 0, H - 1), np.clip(nc, 0, W - 1)
        # Edge geometry: unit vector from neighbour j to cell i, against i's downwind and upslope.
        dist = np.hypot(offs[:, 0], offs[:, 1]).astype(float)
        e_ji, n_ji = -offs[:, 1] / dist, offs[:, 0] / dist  # j→i: east = −dcol, north = +drow
        to = self.wind_to[rr, cc]
        tr = self.model.terrain
        upwind = e_ji * to[:, :1] + n_ji * to[:, 1:]
        downslope = e_ji * tr.up_e[rr, cc][:, None] + n_ji * tr.up_n[rr, cc][:, None]
        geo = np.stack([np.broadcast_to(dist / max(NEIGHBOUR_RADII), upwind.shape), upwind, downslope], -1)
        return {"x": feats[rr, cc], "zj": feats[nr, nc], "geo": geo, "valid": valid,
                "y": self.burned[rr, cc].astype(float), "bp": self.burn_prob[rr, cc], "rc": (rr, cc)}


def _fixture(fire):
    from steps.s11_ignition import fixture_path
    return fixture_path(fire)


# ----------------------------------------------------------------------------- variants


class Standardizer:
    def __init__(self, x):
        flat = x.reshape(-1, x.shape[-1])
        self.mu, self.sd = flat.mean(0), flat.std(0) + 1e-6

    def __call__(self, x):
        return (x - self.mu) / self.sd


def balanced_weights(y: np.ndarray) -> np.ndarray:
    p = np.clip(y.mean(), 1e-3, 1 - 1e-3)
    return np.where(y > 0.5, 0.5 / p, 0.5 / (1 - p))


def neighbour_inputs(t, std):
    zn = np.concatenate([std(t["zj"]), t["geo"]], -1)
    return zn


def train_attention(src, attention: bool, soft: bool):
    std = Standardizer(src["x"])
    y = src["bp"] if soft else src["y"]
    w = np.ones(len(y)) if soft else balanced_weights(y)
    model = AttentionMLP(d=src["x"].shape[1], g=len(EDGE_FEATURES), attention=attention, seed=SEED)
    zn = neighbour_inputs(src, std) if attention else None
    hist = model.fit(std(src["x"]), y, w, zn, src["valid"] if attention else None, epochs=EPOCHS, lr=0.005,
                     batch=2048)
    return model, std, hist


def predict_attention(model, std, t):
    if model.attention:
        return model.predict(std(t["x"]), neighbour_inputs(t, std), t["valid"])
    return model.predict(std(t["x"]))


def rf_features(t):
    zj = np.where(t["valid"][..., None], t["zj"], np.nan)
    return np.hstack([t["x"], np.nanmean(zj, axis=1)])


def block_ci(y, s, block, n_boot: int = BOOTSTRAP, seed: int = SEED) -> list[float]:
    """95% interval of the AUC by resampling ~1 km blocks of cells (neighbouring cells are not independent)."""
    rng = np.random.default_rng(seed)
    ids, inv = np.unique(block, return_inverse=True)
    members = [np.flatnonzero(inv == i) for i in range(len(ids))]
    out = []
    for _ in range(n_boot):
        idx = np.concatenate([members[i] for i in rng.integers(0, len(ids), len(ids))])
        if 0 < y[idx].sum() < len(idx):
            out.append(roc_auc_score(y[idx], s[idx]))
    return [round(float(v), 3) for v in np.quantile(out, [0.025, 0.975])]


def scores(y, s, block, sel) -> dict:
    """AUC (with a block-bootstrap 95% interval) and average precision, over all cells and near the edge."""
    out = {}
    for name, m in (("all", np.ones(len(y), bool)), ("edge_band", sel)):
        out[name] = {"auc": round(float(roc_auc_score(y[m], s[m])), 3), "auc_ci95": block_ci(y[m], s[m], block[m]),
                     "avg_precision": round(float(average_precision_score(y[m], s[m])), 3)}
    return out


def run_pair(src: Scene, tgt: Scene) -> dict:
    """Train every variant on src, predict tgt. Returns per-variant scores and the product map."""
    s0, t0 = src.tensors(False), tgt.tensors(False)
    s1, t1 = src.tensors(True), tgt.tensors(True)
    veg_i = LOCAL_FEATURES.index("veg_frac_500m")
    preds = {"baseline_veg": t0["x"][:, veg_i], "physics_mc": t0["bp"]}
    rf = RandomForestClassifier(n_estimators=200, min_samples_leaf=20, class_weight="balanced", n_jobs=-1,
                                random_state=SEED).fit(rf_features(s0), s0["y"])
    preds["rf_real"] = rf.predict_proba(rf_features(t0))[:, 1]
    models = {}
    for name, (s, t, att, soft) in {"mlp_real": (s0, t0, False, False), "attn_real": (s0, t0, True, False),
                                    "attn_sim": (s0, t0, True, True), "attn_hybrid": (s1, t1, True, False)}.items():
        models[name] = train_attention(s, att, soft)
        preds[name] = predict_attention(models[name][0], models[name][1], t)
    block, edge = tgt.eval_regions(t0["rc"])
    out = {"variants": {k: scores(t0["y"], v, block, edge) for k, v in preds.items()}, "preds": preds,
           "edge_cells": int(edge.sum())}
    model, std, hist = models[LEARNED_MAP]
    out["train_loss"] = [round(hist[0], 4), round(hist[-1], 4)]
    a = model.attention_weights(std(t0["x"]), neighbour_inputs(t0, std), t0["valid"])
    up = t0["geo"][..., 1]
    k = len(offsets())
    out["attention"] = {
        "uniform_weight": round(1 / k, 4),
        "model": LEARNED_MAP,
        "mean_weight_upwind": round(float(a[(up > 0.5) & t0["valid"]].mean()), 4),
        "mean_weight_downwind": round(float(a[(up < -0.5) & t0["valid"]].mean()), 4),
        "by_radius_cells": {str(r): round(float(a[:, i * 8:(i + 1) * 8].sum(1).mean()), 4)
                            for i, r in enumerate(NEIGHBOUR_RADII)},
    }
    return out


# ----------------------------------------------------------------------------- homes


def structure_check(scene: Scene, maps: dict[str, np.ndarray]) -> dict:
    """AUC of cell risk for 'destroyed' among inspected residences exposed to the fire (step 09b)."""
    ex = scene.fire.read_json("exposure.json")
    exposed = {i for i, e in zip(ex["id"], ex["exposed"]) if e}
    dist = dict(zip(ex["id"], ex["dist_wildland_m"]))
    y, rc, d = [], [], []
    H, W = scene.shape
    for f in scene.fire.read_json("structures.geojson")["features"]:
        p = f["properties"]
        if p["id"] not in exposed or p.get("structure_category") not in RESIDENTIAL or p.get("damage") in (None, "Inaccessible"):
            continue
        col, row = scene.grid.to_px(*f["geometry"]["coordinates"])
        row, col = int(round(float(row))), int(round(float(col)))
        if not (0 <= row < H and 0 <= col < W):
            continue
        y.append(p["damage"] == "Destroyed")
        rc.append((row, col))
        d.append(-dist[p["id"]])
    y, (rows, cols) = np.array(y), np.array(rc).T
    out = {"population": "Inspected residences exposed to the fire (exposure.json), excluding inaccessible",
           "n": int(len(y)), "destroyed": int(y.sum()),
           "auc_closer_to_wildland": round(float(roc_auc_score(y, d)), 3), "by_map": {}}
    for name, grid_map in maps.items():
        r = grid_map[rows, cols]
        band = np.empty(len(r), int)
        band[np.argsort(r, kind="stable")] = np.arange(len(r)) * 3 // len(r)  # rank terciles (risk has ties)
        out["by_map"][name] = {"auc": round(float(roc_auc_score(y, r)), 3),
                               "destroyed_rate_by_tercile": [round(float(y[band == b].mean()), 3) for b in range(3)]}
    return out


# ----------------------------------------------------------------------------- outputs


def to_grid(scene: Scene, flat: np.ndarray) -> np.ndarray:
    out = np.zeros(scene.shape)
    out[scene.tensors(False)["rc"]] = flat
    return out


def scenario(scene: Scene) -> dict:
    daily = {d["date"]: d for d in scene.fire.read_json("weather.json")["daily"]}
    day = daily.get(scene.start.strftime("%Y-%m-%d"), {})
    return {
        "reported_start": iso(scene.start),
        "wind_window": [iso(scene.start), iso(scene.start + timedelta(hours=EVENT_H))],
        "wind_source": "HRRR 3 km wind field (wind_field.json, step 07)",
        "fuel_dryness_context": {"date": day.get("date"), "erc": day.get("erc"), "fm100_pct": day.get("fm100"),
                                 "fm1000_pct": day.get("fm1000"), "source": "gridMET (weather.json); not a model input"},
        "monte_carlo": {"runs": None, "horizon_h": MC_HORIZON_H, "start_window_h": [0, 12],
                        "k_range": list(K_TRUE_RANGE), "lb_choices": list(LB_CHOICES), "ignitions": "uniform over burnable cells"},
    }


def write(scene: Scene, pair: dict, other: str, n_sims: int) -> None:
    maps = {k: to_grid(scene, pair["preds"][k]) for k in (PRODUCT, LEARNED_MAP)}
    rgb = np.dstack([np.round(255 * maps[PRODUCT]), np.round(255 * maps[LEARNED_MAP]),
                     np.zeros(scene.shape)]).astype(np.uint8)
    d = scene.fire.out_dir / "risk"
    d.mkdir(exist_ok=True)
    Image.fromarray(rgb).save(d / "risk_map.png")
    g = scene.grid
    sc = scenario(scene)
    sc["monte_carlo"]["runs"] = n_sims
    doc = {
        "status": "PROTOTYPE",
        "question": "Under this fire's own winds, which ~95 m cells were most likely to burn, scored with models that never saw this fire's burn",
        "grid": {"bounds": [g.west, g.south, g.east, g.north], "width": g.width, "height": g.height,
                 "cell_m": [round(v, 1) for v in g.pixel_m]},
        "png": {"file": "risk/risk_map.png", "R": f"{PRODUCT} × 255 (Monte Carlo burn probability)", "G": f"{LEARNED_MAP} risk × 255",
                "non_burnable": "0"},
        "scenario": sc,
        "features": {"local": LOCAL_FEATURES, "edge": EDGE_FEATURES, "neighbours": len(offsets()),
                     "neighbour_radii_m": [round(r * g.pixel_m[0]) for r in NEIGHBOUR_RADII]},
        "evaluation": {
            "trained_on": other, "tested_on": scene.fire.id, "cells": int(scene.burnable.sum()),
            "burned_share": round(float(scene.burned[scene.burnable].mean()), 3),
            "labels": "arrival.png (step 06), model cell > 50% burned; burnable cells only",
            "regions": {"all": "every burnable cell in the area of interest",
                        "edge_band": f"burnable cells within {EDGE_BAND_M:.0f} m of the real burn's edge, either side "
                                     "(which side of the line, given the fire got close)",
                        "edge_cells": pair["edge_cells"]},
            "ci": f"95% block bootstrap, {BLOCK_CELLS}×{BLOCK_CELLS}-cell (~1 km) blocks, {BOOTSTRAP} resamples",
            "variants": pair["variants"], "product": PRODUCT,
            "product_note": f"Planned map was {PLANNED_PRODUCT}, fixed before scoring. It scored worst on Eaton, so the "
                            f"map shows {PRODUCT} and {LEARNED_MAP} instead; that choice was made after seeing scores.",
        },
        "attention": pair["attention"],
        "train_loss_first_last": pair["train_loss"],
        "structures": structure_check(scene, maps),
        "caveats": [
            "Two fires: each fire is the other's only training set, so these scores carry large uncertainty.",
            "The area of interest is the final perimeter plus 2 km, so unburned cells are only those near the fire.",
            "Risk here is conditional on the January 2025 wind event, not an annual probability.",
            "Fuel and soil moisture are near-constant across one fire's area at available resolution and are not inputs.",
            "Ignition likelihood (people, power lines) is not modelled: every burnable cell is equally likely to ignite.",
        ],
    }
    (d / "risk_model.json").write_text(json.dumps(doc, indent=2) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sims", type=int, default=N_SIMS)
    args = ap.parse_args()
    scenes = {f: Scene(f, args.sims) for f in FIRES}
    for tgt, src in ((FIRES[0], FIRES[1]), (FIRES[1], FIRES[0])):
        pair = run_pair(scenes[src], scenes[tgt])
        write(scenes[tgt], pair, src, args.sims)
        print(tgt, json.dumps(pair["variants"]), json.dumps(pair["attention"]))


if __name__ == "__main__":
    main()
