"""The fire-spread forecasters (sim/forecast.py): scoring, bounds on Muse Spark output (mocked), no leaks."""

import json
from types import SimpleNamespace as NS

import numpy as np
import pytest

from sim import forecast as F
from sim.muse import MockClient
from sim.world import World, parse_t

T = parse_t("2025-01-08T15:00:00Z")


@pytest.fixture(scope="module")
def world():
    return World("eaton")


@pytest.fixture(scope="module")
def state(world):
    A = world.arrival
    return F.FireState(A <= T, A <= T - 3600, T, 3600, "modeled")


@pytest.fixture(scope="module")
def geo(world, state):
    return F.Geometry(world, state)


def test_score_counts_only_new_growth():
    base = np.zeros((4, 4), bool)
    base[0, 0] = True
    truth = base.copy()
    truth[0, 1] = truth[1, 0] = True
    pred = base.copy()
    pred[0, 1] = pred[3, 3] = True
    r = F.score(pred, base, truth)
    assert (r["tp"], r["fp"], r["fn"]) == (1, 1, 1)
    assert r["recall"] == 0.5 and r["precision"] == 0.5 and r["iou"] == pytest.approx(1 / 3)
    # Persistence: no prediction, recall 0, precision undefined.
    r = F.score(base, base, truth)
    assert r["recall"] == 0 and r["precision"] is None
    p = F.pool([F.score(pred, base, truth), F.score(base, base, truth)])
    assert p["recall"] == pytest.approx(1 / 4) and p["issues"] == 2


def test_official_maps_merge_close_pairs_and_start_at_the_official_start(world):
    maps = F.official_maps(world)
    ts = [t for t, _ in maps]
    assert maps[0][1].sum() == 1  # the official start as one cell
    assert all(b - a >= F.MERGE_S for a, b in zip(ts[1:], ts[2:]))
    assert all(maps[k][1].sum() <= maps[k + 1][1].sum() for k in range(len(maps) - 1))  # cumulative
    assert parse_t("2025-01-08T07:12:13Z") in ts and parse_t("2025-01-08T07:06:14Z") not in ts


def test_baselines_and_physics_are_bounded(world, state, geo):
    assert (F.persistence(world, state, 3600) == state.burned).all()
    for f in (F.uniform, F.physics, F.ellipse):
        pred = f(world, state, 3600, geo)
        assert (pred >= state.burned).all()  # never un-burns
        new = pred & ~state.burned
        assert new.any()
        assert geo.dist[new].max() <= F.MAX_RATE_M_PER_H + 30
    # A longer horizon reaches at least as far (physics need not: the wind window changes with h).
    assert (F.uniform(world, state, 7200, geo) >= F.uniform(world, state, 3600, geo)).all()


def test_validate_clips_and_rejects():
    n, h = 4, 3600
    good = {"sectors": [{"sector": k, "distance_m": 100 * k} for k in range(n)]}
    d, why, clipped = F.validate(good, n, h)
    assert why is None and list(d) == [0, 100, 200, 300] and clipped == 0
    wild = {"sectors": [{"sector": 0, "distance_m": -5}, {"sector": 1, "distance_m": 1e9},
                        {"sector": 2, "distance_m": 1}, {"sector": 3, "distance_m": 2}]}
    d, why, clipped = F.validate(wild, n, h)
    assert why is None and clipped == 2 and d[0] == 0 and d[1] == F.MAX_RATE_M_PER_H
    for bad in (None, {"sectors": "x"}, {"sectors": good["sectors"][:3]},
                {"sectors": good["sectors"] + [{"sector": 0, "distance_m": 1}]},
                {"sectors": [{"sector": k, "distance_m": "far"} for k in range(n)]},
                {"sectors": [{"sector": k, "distance_m": float("nan")} for k in range(n)]},
                {"sectors": [{"sector": k + 7, "distance_m": 1} for k in range(n)]}):
        assert F.validate(bad, n, h)[0] is None


def test_muse_forecaster_on_a_stand_in(world, state, geo):
    client = MockClient()
    m = F.MuseForecaster(client, model="mock", cap_usd=1.0)
    pred = m(world, state, 3600, geo)
    assert m.calls == 1 and m.rejected == 0
    req = client.requests[-1]
    assert req["tools"][0]["function"]["name"] == "forecast_spread"
    body = json.loads(req["messages"][-1]["content"])
    assert len(body["sectors"]) == F.N_SECTORS and "arrival" not in req["messages"][-1]["content"]
    # The mock carries the recent advance forward, so it matches growing by the recent sector advance.
    assert (pred == F.from_sector_distances(state, geo, np.round(geo.recent_advance_m))).all()
    assert m.ledger.spent_usd > 0


class BadClient(MockClient):
    def create(self, **req):
        self.requests.append(req)
        call = NS(id="c", type="function", function=NS(name="forecast_spread", arguments=json.dumps({"sectors": [{"sector": 0}]})))
        return NS(choices=[NS(message=NS(content=None, tool_calls=[call]), finish_reason="tool_calls")],
                  usage=NS(prompt_tokens=10, completion_tokens=10, prompt_tokens_details=None))


def test_malformed_muse_output_is_rejected_and_counted(world, state, geo):
    m = F.MuseForecaster(BadClient(), model="mock")
    pred = m(world, state, 3600, geo)
    assert m.rejected == 1 and (pred == state.burned).all()  # scored as no growth, not filled in
    assert m.log[-1]["rejected"]


def test_swarm_forecast_never_reads_the_arrival_raster(world):
    class NoArrival:
        def __getattr__(self, k):
            if k == "arrival":
                raise AssertionError("the swarm forecast read the arrival raster")
            return getattr(world, k)

    fc = F.SwarmForecast(NoArrival(), "physics")
    f = fc.targets(parse_t("2025-01-09T02:00:00Z"))
    assert f["from_map_utc"] == "2025-01-08T23:10:23Z" and f["status"] == "FORECAST"
    assert f["growth_areas"] and all(a["area_ha"] >= 2 for a in f["growth_areas"])
    assert fc.targets(parse_t("2025-01-08T05:00:00Z")) is None  # only the official start known


def test_export_schema(world, tmp_path):
    ts = [parse_t("2025-01-08T15:00:00Z"), parse_t("2025-01-08T16:00:00Z")]
    F.export(world, "physics", tmp_path, times=ts)
    F.export(world, "muse", tmp_path, forecaster=F.MuseForecaster(MockClient(), model="mock"), times=ts[:1])
    idx = json.loads((tmp_path / "index.json").read_text())
    assert idx == ["2025-01-08T15Z.geojson", "2025-01-08T16Z.geojson"]
    fc = json.loads((tmp_path / idx[0]).read_text())
    assert fc["type"] == "FeatureCollection" and [f["properties"]["method"] for f in fc["features"]] == ["muse", "physics"]
    for f in fc["features"]:
        assert set(f["properties"]) == {"issued_utc", "valid_utc", "method", "status"}
        assert f["properties"]["status"] == "FORECAST" and f["properties"]["issued_utc"] == "2025-01-08T15:00:00Z"
        assert f["properties"]["valid_utc"] == "2025-01-08T16:00:00Z"
        assert f["geometry"]["type"] in ("Polygon", "MultiPolygon")


def test_forecast_swarm_writes_an_agent_event_log(tmp_path):
    pytest.importorskip("mujoco")
    from sim.run import main as run_main

    run_main(["--policy", "muse", "--forecast", "muse", "--mock", "--hours", "0.5", "--out", str(tmp_path)])
    doc = json.loads((tmp_path / "muse-fcst-muse_s0.json").read_text())
    assert doc["policy"] == "muse-fcst-muse" and all("forecast" in d for d in doc["decisions"])
    ev = [json.loads(x) for x in (tmp_path / "muse-fcst-muse_s0_events.jsonl").read_text().splitlines()]
    roles = {e["role"] for e in ev}
    assert roles == {"forecaster", "commander", "squad", "drone"}
    assert [e["seq"] for e in ev] == list(range(1, len(ev) + 1))
    parents = {e["agent"]: e["parent"] for e in ev}
    assert parents["commander"] == "forecaster" and parents["drone-5"] == "squad-2"
    # 2 decisions x (forecaster + commander + 3 squads) model calls
    assert doc["usage"]["calls"] == 10
