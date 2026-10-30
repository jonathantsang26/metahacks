"""Source manifest: one entry per data layer, rendered by the app's Evidence tab.

Status is one of REAL, MODELED or SIM, matching the Real-vs-Sim table in BUILD.md §6.
Steps may run concurrently, so the read-modify-write holds an exclusive file lock.
"""

from __future__ import annotations

import fcntl
import json
from datetime import datetime, timezone

from .config import Fire

STATUSES = {"REAL", "MODELED", "SIM"}


def add_source(
    fire: Fire,
    *,
    layer: str,
    source: str,
    url: str,
    status: str,
    attribution: str = "",
    notes: str = "",
) -> None:
    if status not in STATUSES:
        raise ValueError(f"status must be one of {STATUSES}")
    entry = {
        "layer": layer,
        "source": source,
        "url": url,
        "status": status,
        "attribution": attribution,
        "notes": notes,
        "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    }
    path = fire.out_dir / "manifest.json"
    with open(fire.out_dir / ".manifest.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        manifest = json.loads(path.read_text()) if path.exists() else {"fire": fire.id, "sources": []}
        manifest["sources"] = [s for s in manifest["sources"] if s["layer"] != layer] + [entry]
        manifest["sources"].sort(key=lambda s: s["layer"])
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(manifest, indent=2) + "\n")
        tmp.replace(path)
