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


def make_policy(name: str, mock: bool, cap_usd: float, forecast: str | None = None, fire: str = "eaton"):
    """The policy and the model it calls (None for rules, "mock" for the stand-in)."""
    if name == "forecast" and not forecast:
        forecast = "physics"
    client, model = None, None
    if name.startswith("muse") or forecast == "muse":
        from .muse import MODEL, MockClient, make_client

        if mock:
            client, model = MockClient(), "mock"
        else:
            load_env_file()
            client, model = make_client(), MODEL
    fc = None
    if forecast:
        from .forecast import MuseForecaster, SwarmForecast
        from .world import World

        fc = SwarmForecast(World(fire), forecast)  # a muse forecaster is attached below
    if name in POLICIES:
        return POLICIES[name](), None
    if name == "forecast":
        from .policies import ForecastEdge

        if forecast == "muse":
            fc.muse = MuseForecaster(client, model=model, cap_usd=cap_usd)
        p = ForecastEdge(fc)
        p.ledger = fc.muse.ledger if fc.muse else None
        return p, model
    if name in ("muse", "muse-hybrid"):
        from .muse import MuseCommanderGreedy, MuseSwarm
        from .policies import with_forecast

        cls = MuseSwarm if name == "muse" else MuseCommanderGreedy
        kw = {"model": model, "cap_usd": cap_usd}
        if not fc:
            return cls(client, **kw), model
        p = with_forecast(cls)(client, forecast=fc, **kw)
        if forecast == "muse":  # the forecaster's calls count against the same cap
            fc.muse = MuseForecaster(client, model=model, ledger=p.ledger)
        return p, model
    raise SystemExit(f"unknown policy {name!r}")


def run_name(policy: str, forecast: str | None) -> str:
    if policy == "forecast":
        return f"forecast-{forecast or 'physics'}"
    return f"{policy}-fcst-{forecast}" if forecast else policy


def agent_events(doc: dict) -> list[dict]:
    """The rollout's decisions as an agent event log for the app's agent graph: one line per agent
    per decision, {seq, t_utc, agent, parent, role, model, task, status, output}. Roles: forecaster,
    commander, squad, drone. status is spawned (first line), done, or failed (the agent's output was
    rejected or its call failed). Outputs are short and already scrubbed of talk about fire causes."""
    from .muse import scrub
    from .world import parse_t

    pol, model = doc["policy"], doc.get("model")
    muse_cmd = pol.startswith("muse")
    muse_squads = pol.startswith("muse") and not pol.startswith("muse-hybrid")
    n = len(doc["tracks"])
    n_sq = 3
    per = max(1, -(-n // n_sq))
    has_fc = any(d.get("forecast") is not None or "forecast" in d for d in doc["decisions"]) or "fcst" in pol or pol.startswith("forecast")
    fc_method = pol.split("-")[-1] if has_fc else None
    agents = []
    if has_fc:
        agents.append(("forecaster", None, "forecaster", model if fc_method == "muse" else "physics rule",
                       "Forecast where the fire edge will be in 1 h"))
    agents.append(("commander", "forecaster" if has_fc else None, "commander", model if muse_cmd else "rule",
                   "Task 3 squads to keep the front watched"))
    for q in range(n_sq):
        agents.append((f"squad-{q}", "commander", "squad", model if muse_squads else "rule", f"Plan drones {q * per}-{min((q + 1) * per, n) - 1}"))
    for i in range(n):
        agents.append((f"drone-{i}", f"squad-{min(i // per, n_sq - 1)}", "drone", "MuJoCo", f"Fly the squad's waypoints, camera on"))
    out, seq = [], 0

    def emit(t, a, status, output):
        nonlocal seq
        seq += 1
        aid, parent, role, mdl, task = a
        out.append({"seq": seq, "t_utc": t, "agent": aid, "parent": parent, "role": role, "model": mdl, "task": task,
                    "status": status, "output": output[:300]})

    for a in agents:
        emit(doc["t0"], a, "spawned", "")
    by = {a[0]: a for a in agents}
    t0 = parse_t(doc["t0"])
    for d in doc["decisions"]:
        t = d["t"]
        errs = d.get("errors") or []
        if has_fc:
            f = d.get("forecast")
            if not f:
                emit(t, by["forecaster"], "failed", "No forecast: fewer than two official maps before this time.")
            elif f.get("rejected"):
                emit(t, by["forecaster"], "failed", "Forecast call failed or its reply was rejected by the validator; no growth assumed.")
            else:
                ga = f.get("growth_areas") or []
                top = ", ".join(f"{g['area_ha']} ha at {g['bearing_deg']}°" for g in ga[:3])
                emit(t, by["forecaster"], "done", f"From the {f['from_map_utc'][11:16]}Z map: {len(ga)} growth areas by {f['valid_utc'][11:16]}Z" + (f" ({top})" if top else ""))
        # A commander error other than a partly usable reply means the call failed or gave no usable
        # tasks; the squads then kept their previous tasks, so `tasks` is not this call's output.
        cmd_failed = any(e.startswith("commander") and "tasks returned" not in e for e in errs)
        if muse_cmd:
            tasks = d.get("tasks") or []
            if cmd_failed:
                emit(t, by["commander"], "failed", "Call failed or gave no usable tasks; squads kept their previous tasks.")
            else:
                txt = scrub(d.get("assessment") or "") or "; ".join(f"squad {x['squad']}: {x['objective']} at {x['center_km']}" for x in tasks)
                emit(t, by["commander"], "done", txt or "No usable tasks.")
        else:
            wp = d.get("waypoints_km") or {}
            emit(t, by["commander"], "done", f"Rule: {len(wp)} drones re-planned" + (" toward the forecast edge" if has_fc else ""))
        notes = d.get("squad_notes") or {}
        tasks = {x["squad"]: x for x in (d.get("tasks") or [])}
        for q in range(n_sq):
            bad = any(e.startswith(f"squad {q}") for e in errs)
            if muse_squads:
                emit(t, by[f"squad-{q}"], "failed" if bad else "done", scrub(notes.get(str(q), "")) or ("Call failed; drones kept their plan." if bad else "Plan set."))
            else:
                tk = tasks.get(q)
                emit(t, by[f"squad-{q}"], "done", f"Rule: {tk['objective']} around {tk['center_km']}" if tk else "Rule: orbit targets")
        wps = d.get("waypoints_km") or {}
        dt = parse_t(t) - t0
        for i in range(n):
            tr = doc["tracks"][i]
            row = min(tr, key=lambda r: abs(r[0] - dt)) if tr else None
            mode = doc.get("modes", ["base", "fly", "rtb", "swap", "lost"])[row[4]] if row else "base"
            w = wps.get(str(i))
            txt = f"{mode}, battery {round(100 * row[5]) if row else 100}%" + (f", {len(w)} new waypoints" if w else "")
            emit(t, by[f"drone-{i}"], "failed" if mode == "lost" else "done", txt)
    return out


def write_events(doc: dict, path: Path):
    path.write_text("".join(json.dumps(e, separators=(",", ":")) + "\n" for e in agent_events(doc)))


def seen_png(sim: SwarmSim, path: Path):
    t = sim.seen_t
    span = max(sim.t_end - sim.t0, 1)
    code = np.full(t.shape, 255, dtype=np.uint8)
    ok = np.isfinite(t)
    code[ok] = (1 + np.clip((t[ok] - sim.t0) / span, 0, 1) * 253).astype(np.uint8)
    rgb = np.zeros((*t.shape, 3), dtype=np.uint8)
    rgb[..., 0] = code
    Image.fromarray(rgb, "RGB").save(path, optimize=True)


def rollout(fire: str, policy_name: str, seed: int, hours: float, out: Path, mock: bool, cap_usd: float, quiet: bool = False,
            t_start: str | None = None, tag: str = "", forecast: str | None = None) -> dict:
    cfg = SimConfig(fire=fire, seed=seed, duration_s=hours * 3600, **({"t_start": t_start} if t_start else {}))
    sim = SwarmSim(cfg)
    policy, model = make_policy(policy_name, mock, cap_usd, forecast, fire)
    policy_name = run_name(policy_name, forecast)
    t = time.time()
    log = None if quiet else (lambda s: print(s, file=sys.stderr, flush=True))
    truncated = None
    try:
        result = sim.run(policy, log=log)
    except Exception as e:  # the budget cap (or an unrecoverable API failure) ends the rollout early
        if type(e).__name__ != "BudgetExceeded":
            raise
        truncated = str(e)
        result = {"decisions": getattr(sim, "decisions", []), "metrics": sim.metrics()}
    spec = cfg.spec
    lon, lat = sim.world.to_lonlat(*sim.base)
    doc = {
        "label": LABEL,
        "disclaimer": DISCLAIMER,
        "fire": fire,
        "policy": policy_name,
        "model": model,
        "seed": seed,
        "tag": tag or None,
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
    led = getattr(policy, "ledger", None)
    if led is not None:
        doc["usage"] = {"calls": led.calls, "input_tokens": led.input_tokens, "output_tokens": led.output_tokens,
                        "spent_usd": round(led.spent_usd, 4), "cap_usd": cap_usd}
    out.mkdir(parents=True, exist_ok=True)
    stem = f"{policy_name}{'_' + tag if tag else ''}_s{seed}"
    (out / f"{stem}.json").write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    seen_png(sim, out / f"{stem}_seen.png")
    write_events(doc, out / f"{stem}_events.jsonl")
    return doc


def flyable(fire: str, out: Path, hours: int = 72) -> dict:
    """Hourly share of the area where the gust at flight height is within the drone's rating: when a swarm could fly at all."""
    from .env import DroneSpec
    from .world import World, parse_t

    w, spec = World(fire), DroneSpec()
    sx, sy = w.size_m
    X, Y = np.meshgrid((np.arange(24) + 0.5) / 24 * sx, (np.arange(16) + 0.5) / 16 * sy)
    t0 = parse_t(w.aoi["official"]["incident"]["start_utc"])
    t0 -= t0 % 3600
    rows = []
    for h in range(hours):
        t = t0 + h * 3600
        g = w.gust(t, X.ravel(), Y.ravel()) * (spec.agl_m / 10) ** w.wind_shear_exp
        burned = np.isfinite(w.arrival) & (w.arrival > t) & (w.arrival <= t + 3600)
        rows.append({"t": iso(t), "flyable_share": round(float(np.mean(g <= spec.wind_ceiling)), 3),
                     "median_gust_ms": round(float(np.median(g)), 1), "cells_burning_next_hour": int(burned.sum())})
    doc = {"label": LABEL, "gust_limit_ms": spec.wind_ceiling, "agl_m": spec.agl_m,
           "note": "HRRR hourly gust (10 m, max of the preceding hour) scaled to flight height by the 1/7 power law, on a 24 x 16 sample of the area.",
           "hours": rows}
    out.mkdir(parents=True, exist_ok=True)
    (out / "flyable.json").write_text(json.dumps(doc, indent=1) + "\n")
    return doc


def summarize(out: Path) -> dict:
    runs = [json.loads(p.read_text()) for p in sorted(out.glob("*_s*.json"))]
    by: dict[str, list] = {}
    extra: dict[str, list] = {}
    for r in runs:
        if r.get("model") == "mock":
            continue
        # Tagged runs (e.g. the night window) are reported apart from the main comparison.
        (extra.setdefault(f"{r['policy']}_{r['tag']}", []) if r.get("tag") else by.setdefault(r["policy"], [])).append(r)
    by.update(extra)
    keys = ["front_seen_within_60min", "front_seen_within_30min", "front_seen_ever", "mean_map_awareness", "median_latency_min", "flight_hours", "wind_grounded_hours"]
    table = {}
    for pol, rs in by.items():
        row = {"runs": len(rs), "seeds": [r["seed"] for r in rs], "model": rs[0]["model"]}
        for k in keys:
            vals = [r["metrics"][k] for r in rs if r["metrics"].get(k) is not None]
            row[k] = None if not vals else {"mean": round(float(np.mean(vals)), 4), "min": min(vals), "max": max(vals)}
        row["crashes"] = sum(len(r["metrics"]["crashes"]) for r in rs)
        row["t0"], row["t_end"] = rs[0]["t0"], rs[0]["t_end"]
        if any("usage" in r for r in rs):
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
        "front_seen_within_60min": "Share of cells the fire reached during the episode that a drone camera saw within 60 min of the interpolated arrival time.",
        "front_seen_within_30min": "The same within 30 min; arrival times move in about 28 min steps, so this one is coarse.",
        "front_seen_ever": "Share of those cells seen at any time before the episode ended.",
        "mean_map_awareness": "Hourly mean of the share of the burned area the swarm had seen by then.",
        "median_latency_min": "Median minutes from interpolated arrival to first sighting, over cells that were seen.",
        "events": "Minutes from each mapped event's time to the first sighting of burned ground within 500 m (negative = seen before the mapped time; null = never seen).",
    }, "policies": table}
    (out / "eval.json").write_text(json.dumps(doc, indent=2) + "\n")
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--fire", default=os.environ.get("FIRE", "eaton"))
    ap.add_argument("--policy", choices=[*POLICIES, "forecast", "muse", "muse-hybrid"], default="greedy")
    ap.add_argument("--forecast", choices=["physics", "muse", "map-edge"], default=None,
                    help="the commander targets the forecast edge (sim/forecast.py); the 'forecast' policy defaults to physics")
    ap.add_argument("--t-start", default=None, help="episode start (UTC ISO); default SimConfig.t_start")
    ap.add_argument("--tag", default="", help="suffix for a run outside the main comparison, e.g. night")
    ap.add_argument("--seeds", type=int, nargs="+", default=[0])
    ap.add_argument("--hours", type=float, default=12.0)
    ap.add_argument("--cap-usd", type=float, default=10.0, help="hard cap on Muse Spark spend per rollout")
    ap.add_argument("--mock", action="store_true", help="Muse Spark swarm against a deterministic stand-in (never published)")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--events", action="store_true", help="(re)write <run>_events.jsonl for every rollout in --out")
    a = ap.parse_args(argv)
    out = a.out or DATA_DIR / a.fire / "swarm"
    if a.events:
        for p in sorted(out.glob("*_s[0-9].json")):
            write_events(json.loads(p.read_text()), p.with_name(p.stem + "_events.jsonl"))
            print(p.with_name(p.stem + "_events.jsonl").name)
        return
    if a.summary:
        flyable(a.fire, out)
        print(json.dumps(summarize(out)["policies"], indent=1))
        return
    if a.mock and out.resolve().is_relative_to((REPO_DIR / "web").resolve()):
        raise SystemExit("--mock output can't go under web/: pass --out to a scratch directory.")
    for s in a.seeds:
        doc = rollout(a.fire, a.policy, s, a.hours, out, a.mock, a.cap_usd, t_start=a.t_start, tag=a.tag, forecast=a.forecast)
        m = {k: v for k, v in doc["metrics"].items() if k not in ("events", "crashes")}
        print(f"{doc['policy']} seed {s}: {json.dumps(m)}" + (f" usage {doc['usage']}" if "usage" in doc else ""))


if __name__ == "__main__":
    main()
