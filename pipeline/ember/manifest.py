"""Source manifest: one entry per data layer, rendered by the app's Evidence tab.

Status is one of REAL, MODELED or SIM, matching the Real-vs-Sim table in BUILD.md §6.
"""

from __future__ import annotations

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
    path = fire.out_dir / "manifest.json"
    manifest = fire.read_json("manifest.json") if path.exists() else {"fire": fire.id, "sources": []}
    manifest["sources"] = [s for s in manifest["sources"] if s["layer"] != layer]
    manifest["sources"].append(
        {
            "layer": layer,
            "source": source,
            "url": url,
            "status": status,
            "attribution": attribution,
            "notes": notes,
            "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        }
    )
    manifest["sources"].sort(key=lambda s: s["layer"])
    fire.write_json("manifest.json", manifest)
