"""Step 03 outputs against the contract: fuel.png, fuel_classes.json, base_stylized.jpg, trees.json.

Offline: reads only committed files in web/public/data/<fire>/ (work/ is gitignored).
"""

import json

import numpy as np
import pytest
from PIL import Image
from scipy.ndimage import binary_erosion

from ember.geo import terrarium_decode
from ember.grid import Grid

WORLDCOVER_CODES = {10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100}


@pytest.fixture
def classes(fire):
    return {int(k): v for k, v in fire.read_json("fuel_classes.json").items()}


@pytest.fixture
def fuel(fire):
    return np.asarray(Image.open(fire.out_dir / "fuel.png"))


def index_of(classes, code):
    return next(i for i, c in classes.items() if code in c["worldcover"])


def test_fuel_classes_contract(fire):
    raw = fire.read_json("fuel_classes.json")
    seen = []
    for key, c in raw.items():
        assert key.isdigit() and 0 <= int(key) <= 255
        assert set(c) == {"label", "worldcover", "burnable"}
        assert isinstance(c["label"], str) and c["label"]
        assert isinstance(c["burnable"], bool)
        assert all(isinstance(code, int) for code in c["worldcover"])
        seen += c["worldcover"]
    assert len(seen) == len(set(seen)), "a WorldCover code maps to two classes"
    assert WORLDCOVER_CODES <= set(seen)


def test_burnable_flags(classes):
    assert classes[index_of(classes, 50)]["burnable"], "built-up must burn (Altadena)"
    for code in (10, 20, 30):
        assert classes[index_of(classes, code)]["burnable"]
    for code in (60, 80):
        assert not classes[index_of(classes, code)]["burnable"]


def test_fuel_png_on_grid(fire, fuel, classes):
    g = Grid.for_fire(fire)
    assert fuel.shape == (g.height, g.width, 3) and fuel.dtype == np.uint8
    red = fuel[..., 0]
    assert set(np.unique(red)) <= set(classes)
    assert (red == index_of(classes, 0)).mean() < 0.01, "too much no-data"


def test_georeferencing(fire, fuel, classes):
    """Coarse geography that a flipped or shifted raster would fail."""
    red = fuel[..., 0]
    h = red.shape[0]
    built, tree, shrub, water = (index_of(classes, c) for c in (50, 10, 20, 80))
    north, south = red[: h // 3], red[2 * h // 3:]
    if fire.id == "eaton":
        assert (south == built).mean() > 0.35, "Altadena/Pasadena should fill the south"
        assert np.isin(north, [tree, shrub]).mean() > 0.85, "San Gabriels should be vegetated"
    if fire.id == "palisades":
        assert red[-1, 0] == water, "southwest corner is Santa Monica Bay"
        # Independent check against the terrain: step 02 clamps the sea to exactly 0 m.
        dem = terrarium_decode(np.asarray(Image.open(fire.out_dir / "dem.png").convert("RGB")))
        rows = np.rint(np.linspace(0, dem.shape[0] - 1, red.shape[0])).astype(int)
        cols = np.rint(np.linspace(0, dem.shape[1] - 1, red.shape[1])).astype(int)
        sea = dem[np.ix_(rows, cols)] <= 0.5
        assert sea.mean() > 0.03 and (red[sea] == water).mean() > 0.95


def test_burnable_inside_perimeter(fire, fuel, classes):
    g = Grid.for_fire(fire)
    perim = fire.read_json("final_perimeter.geojson")
    inside = g.rasterize([f["geometry"] for f in perim["features"]]).astype(bool)
    burnable = np.array([classes.get(i, {"burnable": False})["burnable"] for i in range(256)])
    assert inside.mean() > 0.05
    assert burnable[fuel[..., 0][inside]].mean() > 0.95


def test_base_texture_follows_land_cover(fire, fuel, classes):
    g = Grid.for_fire(fire)
    img = np.asarray(Image.open(fire.out_dir / "base_stylized.jpg").convert("RGB")).astype(np.float32)
    assert img.shape == (g.height, g.width, 3)
    red = fuel[..., 0]
    lum = img.mean(axis=-1)
    tree, grass, built = (index_of(classes, c) for c in (10, 30, 50))
    assert lum[red == tree].mean() < lum[red == grass].mean() - 20, "forest should be darker than grass"
    built_px = img[red == built]
    assert np.abs(built_px[:, 0] - built_px[:, 1]).mean() < 15, "built-up should be a warm grey"
    water = binary_erosion(red == index_of(classes, 80), iterations=3)
    if water.sum() > 100:
        assert np.allclose(np.median(img[water], axis=0), [0x9E, 0xAC, 0xB0], atol=8)


def test_trees(fire, fuel, classes):
    g = Grid.for_fire(fire)
    raw = (fire.out_dir / "trees.json").read_text()
    trees = np.array(json.loads(raw), dtype=np.float64)
    assert 0 < len(trees) <= 40_000 and trees.shape[1] == 3
    lon, lat, h = trees.T
    assert g.contains(lon.min(), lat.min()) and g.contains(lon.max(), lat.max())
    assert np.allclose(np.round(lon, 6), lon) and np.allclose(np.round(lat, 6), lat)

    col, row = g.to_px(lon, lat)
    cls = fuel[..., 0][np.rint(row).astype(int), np.rint(col).astype(int)]
    tree, shrub = index_of(classes, 10), index_of(classes, 20)
    on_tree, on_shrub = cls == tree, cls == shrub
    assert (on_tree | on_shrub).mean() > 0.99
    assert ((h[on_tree] >= 8) & (h[on_tree] <= 18)).all()
    assert ((h[on_shrub] >= 1.5) & (h[on_shrub] <= 3)).all()
    # Denser on forest cells than on shrub cells.
    red = fuel[..., 0]
    assert on_tree.sum() / (red == tree).sum() > 2 * on_shrub.sum() / max((red == shrub).sum(), 1)


def test_manifest(fire):
    sources = {s["layer"]: s for s in fire.read_json("manifest.json")["sources"]}
    lc = sources["Land cover / fuels"]
    assert lc["status"] == "REAL" and "WorldCover" in lc["source"] and "ESA WorldCover" in lc["attribution"]
    assert "LANDFIRE" in lc["notes"]
    base = sources["Base texture"]
    assert base["status"] == "MODELED" and "WorldCover" in base["source"]


def test_landcover_npy_matches_fuel_png(fire, fuel, classes):
    path = fire.work_dir / "landcover.npy"
    if not path.exists():
        pytest.skip("work/ is not committed; run step 03 locally")
    lc = np.load(path)
    assert lc.dtype == np.uint8 and lc.shape == fuel.shape[:2]
    assert set(np.unique(lc)) <= WORLDCOVER_CODES | {0}
    lut = np.zeros(256, np.uint8)
    for i, c in classes.items():
        lut[c["worldcover"]] = i
    assert (lut[lc] == fuel[..., 0]).all()
