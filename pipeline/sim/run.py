"""Run swarm rollouts and write them for the web replay.

    uv run --extra sim python -m sim.run --policy greedy --seeds 0 1 2
    uv run --extra sim python -m sim.run --policy muse --seeds 0 --cap-usd 10     # needs MODEL_API_KEY
    uv run --extra sim python -m sim.run --summary                                # eval.json from the rollouts

Outputs (web/public/data/<fire>/swarm/): <policy>_s<seed>.json (tracks, decisions, metrics) and
<policy>_s<seed>_seen.png (when each cell was first seen: R = 1..254 over the episode, 255 = never),
on the analysis grid like arrival.png. Every file is labelled SIM.
--mock runs the Muse Spark swarm against a deterministic stand-in; it may write only outside web/.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

from .env import SimConfig, SwarmSim
from .policies import POLICIES
from .world import DATA_DIR, REPO_DIR, iso

LABEL = "SIM"
DISCLAIMER = ("Simulated drones flown over a replay of the real fire: real terrain, the reconstructed spread "
              "(interpolated between mapped perimeters) and HRRR wind. No drones flew this fire.")


def load_env_file():
    """MODEL_API_KEY from the repo's gitignored .env, if the shell didn't set it."""
    for p in (REPO_DIR / ".env", REPO_DIR / "web" / ".env"):
        if p.exists() and not os.environ.get("MODEL_API_KEY"):
            for line in p.read_text().splitlines():
                if line.startswith("MODEL_API_KEY=") and line.split("=", 1)[1].strip():
                    os.environ["MODEL_API_KEY"] = line.split("=", 1)[1].strip().strip('"')


def make_policy(name: str, mock: bool, cap_usd: float):
    if name in POLICIES:
        return POLICIES[name](), None
    if name == "muse":
        from .muse import MODEL, MockClient, MuseSwarm, make_client

        if mock:
            return MuseSwarm(MockClient(), model="mock", cap_usd=cap_usd), "mock"
        load_env_file()
        return MuseSwarm(make_client(), cap_usd=cap_usd), MODEL
    raise SystemExit(f"unknown policy {name!r}")


def seen_png(sim: SwarmSim, path: Path):
    t = sim.seen_t
    span = max(sim.t_end - sim.t0, 1)
    code = np.full(t.shape, 255, dtype=np.uint8)
    ok = np.isfinite(t)
    code[ok] = (1 + np.clip((t[ok] - sim.t0) / span, 0, 1) * 253).astype(np.uint8)
    rgb = np.zeros((*t.shape, 3), dtype=np.uint8)
    rgb[..., 0] = code
    Image.fromarray(rgb, "RGB").save(path, optimize=True)


def rollout(fire: str, policy_name: str, seed: int, hours: float, out: Path, mock: bool, cap_usd: float, quiet: bool = False) -> dict:
    cfg = SimConfig(fire=fire, seed=seed, duration_s=hours * 3600)
    sim = SwarmSim(cfg)
    policy, model = make_policy(policy_name, mock, cap_usd)
    t = time.time()
    log = None if quiet else (lambda s: print(s, file=sys.stderr, flush=True))
    truncated = None
    try:
        result = sim.run(policy, log=log)
    except Exception as e:  # the budget cap (or an unrecoverable API failure) ends the rollout early
        if type(e).__name__ != "BudgetExceeded":
            raise
        truncated = str(e)
        result = {"decisions": [], "metrics": sim.metrics()}
    spec = cfg.spec
    lon, lat = sim.world.to_lonlat(*sim.base)
    doc = {
        "label": LABEL,
        "disclaimer": DISCLAIMER,
        "fire": fire,
        "policy": policy_name,
        "model": model,
        "seed": seed,
        "t0": iso(sim.t0),
        "t_end": iso(sim.t_end),
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "wall_seconds": round(time.time() - t, 1),
        "base_lonlat": [round(float(lon), 6), round(float(lat), 6)],
        "drone_spec": {k: getattr(spec, k) for k in spec.__dataclass_fields__} | {"drag_area_m2": round(spec.drag_area, 4)},
        "config": {k: v for k, v in cfg.__dict__.items() if k not in ("spec", "base_lonlat")},
        "track_fields": ["t_s", "lon", "lat", "alt_m", "mode", "battery"],
        "modes": ["base", "fly", "rtb", "swap", "lost"],
        "tracks": sim.tracks,
        "decisions": result["decisions"],
        "recalls": sim.recalls,
        "metrics": result["metrics"],
        "truncated": truncated,
    }
    if policy_name == "muse":
        led = policy.ledger
        doc["usage"] = {"calls": led.calls, "input_tokens": led.input_tokens, "output_tokens": led.output_tokens,
                        "spent_usd": round(led.spent_usd, 4), "cap_usd": cap_usd}
    out.mkdir(parents=True, exist_ok=True)
    stem = f"{policy_name}_s{seed}"
    (out / f"{stem}.json").write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    seen_png(sim, out / f"{stem}_seen.png")
    return doc


def summarize(out: Path) -> dict:
    runs = [json.loads(p.read_text()) for p in sorted(out.glob("*_s*.json"))]
    by: dict[str, list] = {}
    for r in runs:
        if r.get("model") == "mock":
            continue
        by.setdefault(r["policy"], []).append(r)
    keys = ["front_seen_within_30min", "front_seen_ever", "mean_map_awareness", "median_latency_min", "flight_hours", "wind_grounded_hours"]
    table = {}
    for pol, rs in by.items():
        row = {"runs": len(rs), "seeds": [r["seed"] for r in rs], "model": rs[0]["model"]}
        for k in keys:
            vals = [r["metrics"][k] for r in rs if r["metrics"].get(k) is not None]
            row[k] = None if not vals else {"mean": round(float(np.mean(vals)), 4), "min": min(vals), "max": max(vals)}
        row["crashes"] = sum(len(r["metrics"]["crashes"]) for r in rs)
        if pol == "muse":
            row["spent_usd"] = round(sum(r.get("usage", {}).get("spent_usd", 0) for r in rs), 2)
            row["model_errors"] = sum(len(d.get("errors", [])) for r in rs for d in r["decisions"])
            row["model_calls"] = sum(r.get("usage", {}).get("calls", 0) for r in rs)
        events = {}
        for r in rs:
            for e in r["metrics"]["events"]:
                events.setdefault(e["id"], {"label": e["label"], "t": e["t"], "first_seen_min": []})["first_seen_min"].append(e["first_seen_min"])
        row["events"] = events
        table[pol] = row
    doc = {"label": LABEL, "disclaimer": DISCLAIMER, "metric_notes": {
        "front_seen_within_30min": "Share of cells the fire reached during the episode that a drone camera saw within 30 min of the interpolated arrival time (arrival times have about half-hour resolution).",
        "front_seen_ever": "Share of those cells seen at any time before the episode ended.",
        "mean_map_awareness": "Hourly mean of the share of the burned area the swarm had seen by then.",
        "median_latency_min": "Median minutes from interpolated arrival to first sighting, over cells that were seen.",
        "events": "Minutes from each mapped event's time to the first sighting of burned ground within 500 m (null = never seen).",
    }, "policies": table}
    (out / "eval.json").write_text(json.dumps(doc, indent=2) + "\n")
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--fire", default=os.environ.get("FIRE", "eaton"))
    ap.add_argument("--policy", choices=[*POLICIES, "muse"], default="greedy")
    ap.add_argument("--seeds", type=int, nargs="+", default=[0])
    ap.add_argument("--hours", type=float, default=12.0)
    ap.add_argument("--cap-usd", type=float, default=10.0, help="hard cap on Muse Spark spend per rollout")
    ap.add_argument("--mock", action="store_true", help="Muse Spark swarm against a deterministic stand-in (never published)")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--summary", action="store_true")
    a = ap.parse_args(argv)
    out = a.out or DATA_DIR / a.fire / "swarm"
    if a.summary:
        print(json.dumps(summarize(out)["policies"], indent=1))
        return
    if a.mock and out.resolve().is_relative_to((REPO_DIR / "web").resolve()):
        raise SystemExit("--mock output can't go under web/: pass --out to a scratch directory.")
    for s in a.seeds:
        doc = rollout(a.fire, a.policy, s, a.hours, out, a.mock, a.cap_usd)
        m = {k: v for k, v in doc["metrics"].items() if k not in ("events", "crashes")}
        print(f"{a.policy} seed {s}: {json.dumps(m)}" + (f" usage {doc['usage']}" if "usage" in doc else ""))


if __name__ == "__main__":
    main()
