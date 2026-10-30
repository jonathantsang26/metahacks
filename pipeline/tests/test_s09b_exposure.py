"""House-level exposure outputs: aligned columns, no private fields, coherent statistics."""

import numpy as np

PRIVATE = ("address", "street", "apn", "parcel", "owner", "year")


def test_exposure_columns_align_with_structures(fire):
    ex = fire.read_json("exposure.json")
    n = len(ex["id"])
    assert all(len(ex[k]) == n for k in ex["fields"])
    assert not any(p in k.lower() for k in ex["fields"] for p in PRIVATE)
    ids = {f["properties"]["id"] for f in fire.read_json("structures.geojson")["features"]}
    assert set(ex["id"]) <= ids


def test_contrast_intervals_bracket_their_estimates(fire):
    st = fire.read_json("exposure_stats.json")
    assert st["n"] > 100 and 0 < st["destroyed"] < st["n"]
    for c in st["contrasts"]:
        if c["or"] is not None:
            lo, hi = c["ci95"]
            assert lo <= c["or"] <= hi
    terms = st["regression"]["terms"]
    assert terms[0]["term"] == "intercept"
    assert len(terms) + len(st["regression"]["dropped_constant"]) == 1 + 3 + len(st["contrasts"])
    assert all(np.isfinite(t["coef"]) for t in terms)


def test_imputed_arrivals_are_flagged_and_counted(fire):
    ex = fire.read_json("exposure.json")
    st = fire.read_json("exposure_stats.json")
    assert "arrival_imputed" in ex["fields"]
    imputed = [i for i, flag in enumerate(ex["arrival_imputed"]) if flag]
    assert all(ex["arrival_t"][i] is not None for i in imputed)
    assert 0 <= st["arrival_imputed"]["n"] <= sum(ex["arrival_imputed"])
    # Every exposed home has an arrival time and a gust (no 0 mph fallbacks).
    exposed = [i for i, e in enumerate(ex["exposed"]) if e]
    assert all(ex["arrival_t"][i] is not None and ex["gust_mph"][i] is not None for i in exposed)
    assert "HRRR" in st["gust_source"]
