"""Rainfall frequency: the Atlas 14 inversion is monotone and matches the table at its own points."""

import json
import math

import pytest

from ember.config import PIPELINE_DIR
from steps.s16_rain_frequency import DESIGN_I15_MM_H, MM_PER_IN, ari_for, chance, parse_pfds


def _table(fire):
    return json.loads((PIPELINE_DIR / "fixtures" / fire.id / "atlas14_intensity.json").read_text())


def test_ari_reproduces_table_points_and_is_monotone(fire):
    t = _table(fire)
    for ari, inch in zip(t["ari_years"], t["intensity_in_h"]["15-min"]):
        got, extrap = ari_for(t, "15-min", inch * MM_PER_IN)
        assert got == pytest.approx(ari, rel=1e-6) and not extrap
    aris = [ari_for(t, "15-min", mm)[0] for mm in range(5, 400, 5)]
    assert all(a <= b for a, b in zip(aris, aris[1:]))


def test_chance_is_poisson():
    assert chance(1.0) == pytest.approx(1 - math.exp(-1))
    assert chance(10.0, 5) == pytest.approx(1 - math.exp(-0.5))


def test_output_lists_every_design_storm(fire):
    out = fire.read_json("rain_frequency.json")
    storms = out["design_storms"]
    assert [s["i15_mm_h"] for s in storms] == list(DESIGN_I15_MM_H)
    assert all(0 < s["annual_chance"] <= 1 for s in storms)
    assert all(a["annual_chance"] >= b["annual_chance"] for a, b in zip(storms, storms[1:]))
    one_year = _table(fire)["intensity_in_h"]["15-min"][0] * MM_PER_IN
    assert all(s["extrapolated"] == (s["i15_mm_h"] < one_year) for s in storms)


def test_parse_pfds_reads_the_server_format():
    text = "\n".join([
        "Point precipitation frequency estimates (inches/hour)",
        "PRECIPITATION FREQUENCY ESTIMATES by duration for ARI (years):, 1,2,5",
        "5-min:, 2.0,3.0,4.0",
        "15-min:, 1.0,1.5,2.0",
        "60-min:, 0.5,0.7,0.9",
        "Date/time (GMT): Sat Oct 31 02:36:40 2026",
    ])
    t = parse_pfds(text)
    assert t["ari_years"] == [1, 2, 5]
    assert t["intensity_in_h"]["15-min"] == [1.0, 1.5, 2.0]
    assert "Date/time (GMT)" not in t["intensity_in_h"]
