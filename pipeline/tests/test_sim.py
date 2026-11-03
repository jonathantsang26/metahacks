"""The drone-swarm simulation (sim/): physics, sensing honesty, the Muse Spark swarm on a stand-in client."""

import json

import numpy as np
import pytest

pytest.importorskip("mujoco")

from sim.env import SimConfig, SwarmEnv, SwarmSim  # noqa: E402
from sim.muse import BudgetExceeded, MockClient, MuseSwarm, scrub  # noqa: E402
from sim.policies import Greedy, Lawnmower  # noqa: E402
from sim.run import main as run_main  # noqa: E402
from sim.world import DATA_DIR, World, parse_t  # noqa: E402

# A calm, post-wind hour on Eaton so a short test flight is not recalled for wind.
CALM = "2025-01-08T15:30:00Z"


@pytest.fixture(scope="module")
def world():
    return World("eaton")


def test_frame_and_layers(world):
    x, y = world.to_local(*world.aoi["center"])
    lon, lat = world.to_lonlat(x, y)
    assert abs(lon - world.aoi["center"][0]) < 1e-9 and abs(lat - world.aoi["center"][1]) < 1e-9
    z = world.elevation
    assert z.shape == world.grid_shape and 100 < z.min() < z.max() < 2000
    burned = np.isfinite(world.arrival)
    # arrival_meta.json reports the burned area; the decoded raster must match it.
    acres = burned.sum() * world.cell_m[0] * world.cell_m[1] / 4046.86
    assert abs(acres - world._json("arrival_meta.json")["burned_acres"]) / acres < 0.02
    u10, v10 = world.wind(parse_t("2025-01-08T06:00:00Z"), 8000.0, 6000.0, agl=10)
    u150, v150 = world.wind(parse_t("2025-01-08T06:00:00Z"), 8000.0, 6000.0, agl=150)
    assert np.hypot(u150, v150) > np.hypot(u10, v10) > 5
    bx, by = world.safe_base()
    r, c = world.cell_of(bx, by)
    assert not np.isfinite(world.arrival[r, c])


def test_drone_flies_to_a_waypoint(world):
    sim = SwarmSim(SimConfig(t_start=CALM, duration_s=600, n_drones=1), world)
    goal = sim.base + np.array([0.0, 2000.0])
    sim.set_plan({0: [goal, goal + np.array([500.0, 0])]})
    sim.advance(sim.t + 150)
    p = sim.pos(0)
    assert sim.mode[0] == "fly"
    assert np.hypot(*(p[:2] - goal)) < 600  # reached the first waypoint (about 22 m/s), now on the second leg
    agl = p[2] - world.ground(p[0], p[1])
    assert 60 < agl < 260


def test_sensing_sees_only_the_replayed_fire(world):
    sim = SwarmSim(SimConfig(t_start=CALM, duration_s=1200, n_drones=2), world)
    out = sim.run(Greedy())
    seen = np.isfinite(sim.seen_t)
    assert seen.any(), "a drone sent toward the reported start should see burned ground"
    # Nothing is recorded as seen before the fire got there, or outside the burned area.
    assert np.all(world.arrival[seen] <= sim.seen_t[seen])
    assert out["metrics"]["flight_hours"] > 0


def test_policies_never_get_the_arrival_raster(world):
    sim = SwarmSim(SimConfig(t_start=CALM, duration_s=60, n_drones=2), world)
    obs = sim.observe()
    text = json.dumps(obs)
    assert "arrival" not in text
    assert set(obs) >= {"drones", "fire_clusters", "coverage", "wind_grid", "reported_start_km"}
    assert Lawnmower().decide(obs)["waypoints_km"]


def test_muse_swarm_commander_and_squads_on_a_stand_in(world):
    sim = SwarmSim(SimConfig(t_start=CALM, duration_s=60), world)
    client = MockClient()
    swarm = MuseSwarm(client, model="mock", cap_usd=1.0)
    out = swarm.decide(sim.observe())
    tools = [r["tools"][0]["function"]["name"] for r in client.requests]
    assert tools.count("task_squads") == 1 and tools.count("set_waypoints") == 3
    assert sorted(out["waypoints_km"]) == list(range(6))
    assert not out["errors"] and out["calls"] == 4
    # The squad prompts carry their own drones only.
    for r in client.requests[1:]:
        body = json.loads(r["messages"][-1]["content"])
        assert len(body["your_drones"]) == 2


def test_muse_swarm_respects_the_spend_cap(world):
    sim = SwarmSim(SimConfig(t_start=CALM, duration_s=60), world)
    swarm = MuseSwarm(MockClient(), model="mock", cap_usd=0.001)
    with pytest.raises(BudgetExceeded):
        swarm.decide(sim.observe())


def test_bad_model_output_keeps_the_previous_plan(world):
    class Broken(MockClient):
        def create(self, **req):
            r = super().create(**req)
            if req["tools"][0]["function"]["name"] == "set_waypoints":
                r.choices[0].message.tool_calls[0].function.arguments = "{not json"
            return r

    sim = SwarmSim(SimConfig(t_start=CALM, duration_s=60), world)
    out = MuseSwarm(Broken(), model="mock").decide(sim.observe())
    assert out["waypoints_km"] == {} and len(out["errors"]) == 3


def test_scrub_drops_talk_about_how_the_fire_started():
    assert scrub("Head is moving SW. Power lines likely caused it.") == "Head is moving SW."
    assert scrub("Send squad 1 north of the ridge.") == "Send squad 1 north of the ridge."


def test_mock_rollouts_cannot_be_published(tmp_path):
    with pytest.raises(SystemExit):
        run_main(["--policy", "muse", "--mock", "--hours", "0.1", "--out", str(DATA_DIR / "eaton" / "swarm")])
    run_main(["--policy", "muse", "--mock", "--hours", "0.25", "--out", str(tmp_path)])
    doc = json.loads((tmp_path / "muse_s0.json").read_text())
    assert doc["label"] == "SIM" and doc["model"] == "mock" and len(doc["tracks"]) == 6
    assert (tmp_path / "muse_s0_seen.png").exists()


def test_gym_env(world):
    env = SwarmEnv(SimConfig(t_start=CALM, duration_s=1800, decision_s=900, n_drones=2), world)
    obs, _ = env.reset(seed=1)
    assert obs["maps"].shape == (3, 32, 44) and obs["drones"].shape == (2, 5)
    obs, reward, done, trunc, info = env.step(env.action_space.sample())
    assert np.isfinite(reward) and not done
    obs, reward, done, trunc, info = env.step(np.zeros((2, 2)))
    assert done and info["metrics"]["front_cells"] >= 0


def test_degenerate_commander_output_is_bounded(world):
    class Looping(MockClient):
        def create(self, **req):
            r = super().create(**req)
            if req["tools"][0]["function"]["name"] == "task_squads":
                r.choices[0].message.tool_calls[0].function.arguments = json.dumps({"tasks": [{"objective": "search"}] * 796})
            return r

    sim = SwarmSim(SimConfig(t_start=CALM, duration_s=60), world)
    swarm = MuseSwarm(Looping(), model="mock")
    swarm.last_tasks = [{"squad": 0, "center_km": [5.0, 5.0], "radius_km": 1.0, "objective": "search", "why": ""}]
    out = swarm.decide(sim.observe())
    assert len(out["errors"]) == 2 and "796 tasks" in out["errors"][0]
    assert out["tasks"][0]["reused"] and sorted(out["waypoints_km"]) == [0, 1]


def test_runaway_squad_output_is_one_error_per_squad(world):
    class Runaway(MockClient):
        def create(self, **req):
            r = super().create(**req)
            if req["tools"][0]["function"]["name"] == "set_waypoints":
                args = json.loads(r.choices[0].message.tool_calls[0].function.arguments)
                args["plans"] += [{"drone": "x"}] * 500
                r.choices[0].message.tool_calls[0].function.arguments = json.dumps(args)
            return r

    sim = SwarmSim(SimConfig(t_start=CALM, duration_s=60), world)
    out = MuseSwarm(Runaway(), model="mock").decide(sim.observe())
    assert sorted(out["waypoints_km"]) == list(range(6))
    assert len(out["errors"]) == 3 and all("502 plans returned" in e for e in out["errors"])


def test_muse_commander_with_greedy_squads_makes_one_call(world):
    from sim.muse import MuseCommanderGreedy

    sim = SwarmSim(SimConfig(t_start=CALM, duration_s=60), world)
    client = MockClient()
    out = MuseCommanderGreedy(client, model="mock").decide(sim.observe())
    assert len(client.requests) == 1 and out["calls"] == 1
    assert sorted(out["waypoints_km"]) == list(range(6)) and not out["errors"]
