"""Contract tests for step 08 (burn severity): offline, against the committed outputs."""

import numpy as np
import pytest
from PIL import Image

from ember.grid import Grid
from steps.s08_severity import CLASS_EDGES, CLASS_LABELS, classify, edge_alignment, encode_png


def decode_red(red: np.ndarray) -> np.ndarray:
    return -0.1 + (red.astype(np.float64) - 1) / 254 * 1.1


@pytest.fixture
def severity(fire):
    path = fire.out_dir / "severity.png"
    if not path.exists():
        pytest.skip(f"{path} not built yet")
    img = Image.open(path)
    assert img.mode == "RGB"
    return np.asarray(img)


@pytest.fixture
def stats(fire):
    if not (fire.out_dir / "severity_stats.json").exists():
        pytest.skip(f"{fire.out_dir / 'severity_stats.json'} not built yet")
    return fire.read_json("severity_stats.json")


@pytest.fixture
def inside(fire):
    perim = fire.read_json("final_perimeter.geojson")
    return Grid.for_fire(fire).rasterize([f["geometry"] for f in perim["features"]]).astype(bool)


# ------------------------------------------------------------------ encoding (synthetic)


def test_encoding_endpoints_and_nodata():
    d = np.array([[np.nan, -0.5, -0.1, 1.0, 1.7]], np.float32)
    rgb = encode_png(d)
    assert rgb[0, :, 0].tolist() == [0, 1, 1, 255, 255]
    assert rgb[0, :, 1].tolist() == [0, 1, 1, 5, 5]
    assert not rgb[..., 2].any()


def test_class_breaks():
    d = np.array([0.0999, 0.1, 0.2699, 0.27, 0.4399, 0.44, 0.6599, 0.66, np.nan], np.float32)
    assert classify(d).tolist() == [1, 2, 2, 3, 3, 4, 4, 5, 0]


def test_edge_alignment_recovers_a_known_shift():
    inside = np.zeros((60, 60), bool)
    inside[15:45, 15:45] = True
    valid = np.roll(inside, (3, -2), axis=(0, 1))  # data shifted 3 cells south, 2 cells west
    a = edge_alignment(valid, inside, radius=6)
    assert a["best_offset_px"] == [2, -3] and a["best_mean_dist"] == 0.0
    assert a["mean_dist_at_zero"] > 1.0


# ------------------------------------------------------------------ committed outputs


def test_png_on_analysis_grid(fire, severity):
    assert severity.shape == Grid.for_fire(fire).shape + (3,)


def test_red_green_consistent(severity):
    red, green, blue = severity[..., 0], severity[..., 1], severity[..., 2]
    assert ((red == 0) == (green == 0)).all()
    assert green.max() <= 5 and not blue.any()
    valid = red > 0
    assert valid.any()
    # Re-derive the class from the quantized red value; only cells within one quantization
    # step (1.1/254) of a class break, or clipped at the ends, may legitimately disagree.
    rederived = np.digitize(decode_red(red[valid]), CLASS_EDGES) + 1
    assert (rederived != green[valid]).mean() < 0.01


def test_stats_keys_and_ranges(stats):
    for key in ("source", "grid", "encoding", "perimeter", "mean_dnbr", "valid_inside_fraction", "georef_check"):
        assert key in stats
    p = stats["perimeter"]
    assert 0 < p["coverage"] <= 1
    assert set(p["class_fraction_of_valid"]) == set(CLASS_LABELS)
    assert abs(sum(p["class_fraction_of_valid"].values()) - 1) < 1e-3
    assert stats["source"]["provisional"] is True
    assert stats["source"]["units"] == "unitless dNBR"


def test_coverage_matches_png(severity, stats, inside):
    valid = severity[..., 0] > 0
    assert abs(valid[inside].mean() - stats["perimeter"]["coverage"]) < 1e-3
    assert abs(inside[valid].mean() - stats["valid_inside_fraction"]) < 1e-3


def test_georeferencing_sanity(severity, stats, inside):
    valid = severity[..., 0] > 0
    # JPL clipped the product to a burn perimeter: nearly every valid cell sits inside ours.
    assert inside[valid].mean() > 0.9
    m = stats["mean_dnbr"]
    assert m["inside"] > m["outside"]
    assert 0.2 < m["inside"] < 0.8  # burned chaparral and suburbs, not a scaled or empty product
    # The data outline traces the perimeter outline best with no shift, and clearly better than
    # at a typical shift within ±12 cells.
    a = stats["georef_check"]
    assert a["best_offset_px"] == [0, 0]
    assert a["mean_dist_at_zero"] < 0.6 * a["background_median"]
    assert a["within_1_cell_at_zero"] > 0.5


def test_manifest_entry(fire, stats):
    entries = [s for s in fire.read_json("manifest.json")["sources"] if s["layer"] == "Burn severity (dNBR)"]
    assert len(entries) == 1
    e = entries[0]
    assert e["status"] == "REAL"
    assert e["url"] == "https://popo.jpl.nasa.gov/pub/LA_Fires/dist/dnbr/"
    assert "provisional" in e["notes"].lower()
    assert f"{stats['perimeter']['coverage']:.1%}" in e["notes"]
    if stats["perimeter"]["coverage"] < 0.9:
        assert "GAP" in e["notes"]


def test_dnbr_work_array_if_present(fire, severity):
    path = fire.work_dir / "dnbr.npy"
    if not path.exists():
        pytest.skip("work/<fire>/dnbr.npy is gitignored and not built here")
    d = np.load(path)
    assert d.dtype == np.float32 and d.shape == severity.shape[:2]
    assert (np.isfinite(d) == (severity[..., 0] > 0)).all()
    assert np.nanmin(d) >= -2 and np.nanmax(d) <= 2
