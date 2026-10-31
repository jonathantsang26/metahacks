"""Risk model prototype outputs: the map matches its grid, and every score is out-of-fire."""

import numpy as np
from PIL import Image

from steps.s17_risk_model import PRODUCT


def test_map_matches_grid_and_scores_are_out_of_fire(fire):
    doc = fire.read_json("risk/risk_model.json")
    img = np.array(Image.open(fire.out_dir / "risk" / "risk_map.png"))
    assert img.shape[:2] == (doc["grid"]["height"], doc["grid"]["width"])
    ev = doc["evaluation"]
    assert ev["tested_on"] == fire.id and ev["trained_on"] != fire.id
    assert ev["product"] == PRODUCT and PRODUCT in ev["variants"]
    for v in ev["variants"].values():
        for region in ("all", "edge_band"):
            lo, hi = v[region]["auc_ci95"]
            assert 0 <= lo <= hi <= 1
            assert 0 <= v[region]["avg_precision"] <= 1
    assert doc["status"] == "PROTOTYPE"


def test_structure_check_is_coherent(fire):
    st = fire.read_json("risk/risk_model.json")["structures"]
    assert 0 < st["destroyed"] < st["n"]
    for m in st["by_map"].values():
        assert 0 <= m["auc"] <= 1 and len(m["destroyed_rate_by_tercile"]) == 3
