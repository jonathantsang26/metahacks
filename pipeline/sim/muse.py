"""The Muse Spark swarm: a commander agent and squad agents, each a real muse-spark-1.3 tool call.

Every decision interval:
1. The commander sees the whole picture (drones, the swarm's own fire observations, coverage age,
   wind on a 3 x 3 grid, the public reported start) and calls `task_squads`, giving each squad an
   area and an objective.
2. The squad agents run in parallel. Each sees its tasking, its own drones and the observations
   near its area, and calls `set_waypoints` for its drones.

Model output is used as returned: waypoints are only clipped to the AOI, and a malformed or failed
call leaves that squad's drones on their previous plan, recorded as an error. Free-text rationales
are kept for the replay log, minus any sentence that talks about how the fire started.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

MODEL = "muse-spark-1.3"
BASE_URL = "https://api.meta.ai/v1"
#: muse-spark-1.3, Standard mode, USD per 1M tokens (dev.meta.ai/docs/pricing-rate-limits, 2026-10-31),
#: the same figures as web/api/_lib/budget.ts.
PRICE = {"input": 1.25, "cached_input": 0.15, "output": 4.25}
MAX_COMPLETION_TOKENS = 6000

# The analyst's rule: no statement about what started the fire (web/api/_lib/verify.ts, a subset).
_CAUSE = re.compile(
    r"\bcaus(?:e|es|ed|ing)\b|\b(?:ignited|sparked|lit)\s+by\b|\bignition\s+source\b|\barson|\bpower\s*-?lines?\b|"
    r"\butility\b|\belectrical\b|\bEdison\b|\bSCE\b|\bstarted\s+by\b|\battribut\w*\s+to\b|\bblam\w*\b|\bresponsible\s+for\b",
    re.I,
)


def scrub(text: str) -> str:
    """Drops sentences that speculate about how the fire started; the swarm's job is where it is now."""
    parts = re.split(r"(?<=[.!?])\s+", (text or "").strip())
    return " ".join(p for p in parts if p and not _CAUSE.search(p))[:600]


RULES = """You coordinate a simulated survey-drone swarm (SIM) flying over a replay of a real wildfire's spread on real terrain.
Goal: keep the active fire front observed. Score: the share of newly burning ground a camera sees within 30 minutes of the fire reaching it, then the share of the burned area the swarm has mapped.
You know only what the swarm has observed (fire_clusters: ground seen actively burning in the last 30 min), the coverage age of each 2 km block, the current-hour wind and the publicly reported start point. You cannot see where the fire is unless a drone has looked.
Coordinates are km east (x) and north (y) of the area's south-west corner. Wind "toward_deg" is the compass direction the air moves toward; fires usually run downwind. A drone's camera sees about 0.6 km around it. Drones fly about 22 m/s; above the wind ceiling they are recalled automatically, and they return to base on their own for battery swaps.
Never discuss what started the fire or who is responsible. Talk only about where to fly and why."""

COMMANDER_TOOL = {
    "type": "function",
    "function": {
        "name": "task_squads",
        "description": "Give every squad an area to work and an objective for the next 15 minutes.",
        "parameters": {
            "type": "object",
            "properties": {
                "assessment": {"type": "string", "description": "Two sentences at most: where the front likely is and where it is heading."},
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "squad": {"type": "integer"},
                            "center_km": {"type": "array", "items": {"type": "number"}, "description": "[x, y]"},
                            "radius_km": {"type": "number"},
                            "objective": {"type": "string", "enum": ["track_head", "track_flank", "search", "map_burned", "hold"]},
                            "why": {"type": "string"},
                        },
                        "required": ["squad", "center_km", "radius_km", "objective"],
                    },
                },
            },
            "required": ["tasks"],
        },
    },
}

SQUAD_TOOL = {
    "type": "function",
    "function": {
        "name": "set_waypoints",
        "description": "Waypoints for each of your drones for the next 15 minutes, flown in order.",
        "parameters": {
            "type": "object",
            "properties": {
                "plans": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "drone": {"type": "integer"},
                            "waypoints_km": {"type": "array", "items": {"type": "array", "items": {"type": "number"}}, "description": "Up to 6 [x, y] points."},
                        },
                        "required": ["drone", "waypoints_km"],
                    },
                },
                "note": {"type": "string", "description": "One sentence on the plan."},
            },
            "required": ["plans"],
        },
    },
}


class BudgetExceeded(RuntimeError):
    pass


@dataclass
class Ledger:
    cap_usd: float
    spent_usd: float = 0.0
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def reserve(self, worst: float):
        with self.lock:
            if self.spent_usd + worst > self.cap_usd:
                raise BudgetExceeded(f"the next call could pass the ${self.cap_usd:.2f} cap (spent ${self.spent_usd:.2f})")
            self.spent_usd += worst

    def settle(self, worst: float, usage):
        with self.lock:
            self.spent_usd -= worst
            self.calls += 1
            if usage is None:
                self.spent_usd += worst
                return
            cached = getattr(getattr(usage, "prompt_tokens_details", None), "cached_tokens", 0) or 0
            pin, out = usage.prompt_tokens, usage.completion_tokens
            self.input_tokens += pin
            self.output_tokens += out
            self.spent_usd += ((pin - cached) * PRICE["input"] + cached * PRICE["cached_input"] + out * PRICE["output"]) / 1e6


def make_client(api_key: str | None = None):
    from openai import OpenAI

    key = api_key or os.environ.get("MODEL_API_KEY", "").strip()
    if not key:
        raise SystemExit("MODEL_API_KEY is not set: the Muse Spark swarm only runs against the real model.")
    return OpenAI(api_key=key, base_url=BASE_URL, timeout=60, max_retries=2)


class MuseSwarm:
    name = "muse-spark"

    def __init__(self, client, model: str = MODEL, squads: int = 3, cap_usd: float = 5.0, workers: int = 4):
        self.client, self.model, self.n_squads = client, model, squads
        self.ledger = Ledger(cap_usd)
        self.pool = ThreadPoolExecutor(max_workers=workers)
        self.last_tasks: list[dict] = []
        self.transcript: list[dict] = []

    # ----------------------------------------------------------------- model calls
    def _call(self, role: str, messages: list[dict], tool: dict) -> tuple[dict | None, str | None]:
        size = sum(len(m["content"]) for m in messages)
        worst = (size / 3 * PRICE["input"] + MAX_COMPLETION_TOKENS * PRICE["output"]) / 1e6
        self.ledger.reserve(worst)
        usage = None
        t0 = time.time()
        try:
            name = tool["function"]["name"]
            try:
                r = self.client.chat.completions.create(model=self.model, messages=messages, tools=[tool],
                                                        tool_choice={"type": "function", "function": {"name": name}},
                                                        max_completion_tokens=MAX_COMPLETION_TOKENS)
            except Exception as e:  # named tool_choice rejected: fall back to auto, as the web analyst does
                status = getattr(e, "status_code", None)
                if status is None or not (400 <= status < 500) or status in (401, 403):
                    raise
                r = self.client.chat.completions.create(model=self.model, messages=messages, tools=[tool], tool_choice="auto",
                                                        max_completion_tokens=MAX_COMPLETION_TOKENS)
            usage = getattr(r, "usage", None)
            msg = r.choices[0].message
            calls = [c for c in (msg.tool_calls or []) if c.function.name == name]
            finish = r.choices[0].finish_reason
            if not calls:
                return None, f"{role}: no {name} call (finish_reason {finish})"
            if finish == "length":
                return None, f"{role}: reply cut off at the {MAX_COMPLETION_TOKENS}-token output cap"
            try:
                return json.loads(calls[0].function.arguments or "{}"), None
            except json.JSONDecodeError as e:
                return None, f"{role}: {name} arguments are not JSON ({e})"
        except BudgetExceeded:
            raise
        except Exception as e:
            return None, f"{role}: API error {getattr(e, 'status_code', '')} {str(e)[:200]}"
        finally:
            self.ledger.settle(worst, usage)
            self.transcript.append({"role": role, "seconds": round(time.time() - t0, 1)})

    # ----------------------------------------------------------------- one decision
    def squad_of(self, drone_id: int, n_drones: int) -> int:
        per = max(1, -(-n_drones // self.n_squads))
        return min(drone_id // per, self.n_squads - 1)

    def decide(self, obs: dict) -> dict:
        n = len(obs["drones"])
        squads = {s: [d for d in obs["drones"] if self.squad_of(d["id"], n) == s] for s in range(self.n_squads)}
        view = _compact(obs)
        cmd_user = json.dumps({
            "situation": view,
            "squads": {str(s): [d["id"] for d in ds] for s, ds in squads.items()},
            "your_previous_tasks": self.last_tasks,
        }, separators=(",", ":"))
        args, err = self._call("commander", [{"role": "system", "content": RULES + "\nYou are the commander. Task every squad."},
                                             {"role": "user", "content": cmd_user}], COMMANDER_TOOL)
        errors = [err] if err else []
        tasks = {}
        raw = (args or {}).get("tasks", []) or []
        if not isinstance(raw, list):
            raw = []
        bad = 0
        for t in raw[: 4 * self.n_squads]:
            try:
                s = int(t["squad"])
                c = [float(t["center_km"][0]), float(t["center_km"][1])]
            except (KeyError, TypeError, ValueError, IndexError):
                bad += 1
                continue
            if 0 <= s < self.n_squads and s not in tasks:
                tasks[s] = {"squad": s, "center_km": c, "radius_km": float(t.get("radius_km") or 1.5),
                            "objective": t.get("objective", "search"), "why": scrub(t.get("why", ""))}
        if bad or len(raw) > 4 * self.n_squads:
            errors.append(f"commander: {len(raw)} tasks returned, {bad + max(len(raw) - 4 * self.n_squads, 0)} malformed or extra, ignored")
        if tasks:
            self.last_tasks = list(tasks.values())
        elif self.last_tasks:
            # The commander's call failed: squads keep working their previous tasks, marked as such.
            tasks = {t["squad"]: {**t, "reused": True} for t in self.last_tasks}
            errors.append("commander: no usable tasks; squads kept their previous tasks")
        assessment = scrub((args or {}).get("assessment", ""))

        def run_squad(s):
            ds = squads[s]
            if not ds or s not in tasks:
                return s, None, None
            task = tasks[s]
            local = _near(view, task["center_km"], task["radius_km"] + 2.0)
            user = json.dumps({"task": task, "your_drones": ds, "nearby": local, "wind_grid": view["wind_grid"],
                               "area_km": view["area_km"], "base_km": view["base_km"], "t": view["t"]}, separators=(",", ":"))
            return (s, *self._call(f"squad {s}", [{"role": "system", "content": RULES + f"\nYou lead squad {s}. Plan only your drones."},
                                                  {"role": "user", "content": user}], SQUAD_TOOL))

        waypoints, notes = {}, {}
        for s, a, e in self.pool.map(run_squad, range(self.n_squads)):
            if e:
                errors.append(e)
            if not a:
                continue
            notes[s] = scrub(a.get("note", ""))
            mine = {d["id"] for d in squads[s]}
            for p in a.get("plans", []) or []:
                try:
                    i = int(p["drone"])
                    wps = [[float(w[0]), float(w[1])] for w in p["waypoints_km"]][:6]
                except (KeyError, TypeError, ValueError, IndexError):
                    errors.append(f"squad {s}: a malformed plan")
                    continue
                if i in mine:
                    waypoints[i] = wps
                else:
                    errors.append(f"squad {s}: planned drone {i}, which is not in the squad")
        return {"waypoints_km": waypoints, "assessment": assessment, "tasks": list(tasks.values()),
                "squad_notes": {str(k): v for k, v in notes.items()}, "errors": errors,
                "spent_usd": round(self.ledger.spent_usd, 4), "calls": self.ledger.calls}


def _compact(obs: dict) -> dict:
    """The observation without blocks that are uninformative (seen in the last 10 minutes)."""
    v = dict(obs)
    v["coverage"] = [c for c in obs["coverage"] if c["minutes_since_seen"] is None or c["minutes_since_seen"] > 10]
    return v


def _near(view: dict, center, radius) -> dict:
    cx, cy = center

    def close(p):
        return (p[0] - cx) ** 2 + (p[1] - cy) ** 2 <= radius**2

    return {
        "fire_clusters": [view["fire_clusters"][0]] + [c for c in view["fire_clusters"][1:] if close(c["center_km"])],
        "coverage": [c for c in view["coverage"] if close([c["block_km"][0] + 1, c["block_km"][1] + 1])],
        "reported_start_km": view["reported_start_km"],
    }


# --------------------------------------------------------------------- offline stand-in (tests only)
class MockClient:
    """A deterministic stand-in that answers like the tools expect. For tests and dry runs only:
    the runner refuses to publish a rollout made with it."""

    def __init__(self):
        self.chat = self
        self.completions = self
        self.requests: list[dict] = []

    def create(self, **req):
        from types import SimpleNamespace as NS

        self.requests.append(req)
        name = req["tools"][0]["function"]["name"]
        body = json.loads(req["messages"][-1]["content"])
        if name == "task_squads":
            sit = body["situation"]
            target = (sit["fire_clusters"][1]["center_km"] if len(sit["fire_clusters"]) > 1
                      else sit["reported_start_km"] or [sit["area_km"][0] / 2, sit["area_km"][1] / 2])
            args = {"assessment": "Mock assessment.", "tasks": [{"squad": int(s), "center_km": target, "radius_km": 1.0 + int(s),
                                                                  "objective": "track_head", "why": "mock"} for s in body["squads"]]}
        else:
            c = body["task"]["center_km"]
            r = body["task"]["radius_km"]
            args = {"plans": [{"drone": d["id"], "waypoints_km": [[c[0] + r, c[1]], [c[0], c[1] + r], [c[0] - r, c[1]], [c[0], c[1] - r]]}
                              for d in body["your_drones"]], "note": "Mock orbit."}
        call = NS(id="call_1", type="function", function=NS(name=name, arguments=json.dumps(args)))
        usage = NS(prompt_tokens=len(req["messages"][-1]["content"]) // 4, completion_tokens=200, prompt_tokens_details=None)
        return NS(choices=[NS(message=NS(content=None, tool_calls=[call]), finish_reason="tool_calls")], usage=usage)
