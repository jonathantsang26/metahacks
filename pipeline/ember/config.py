"""Fire selection and output paths.

Every step reads the same fire config and writes into web/public/data/<fire_id>/,
which the web app serves as static files.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

import yaml

PIPELINE_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = PIPELINE_DIR.parent
RAW_DIR = PIPELINE_DIR / "raw"      # cached downloads (gitignored)
WORK_DIR = PIPELINE_DIR / "work"    # intermediate arrays (gitignored)


@dataclass(frozen=True)
class Fire:
    id: str
    name: str
    calfire_name: str
    nifc_name: str
    year: int
    location: str
    timezone: str
    window_utc: tuple[str, str]
    buffer_km: float
    dem_zoom: int

    @property
    def out_dir(self) -> Path:
        d = REPO_DIR / "web" / "public" / "data" / self.id
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def raw_dir(self) -> Path:
        d = RAW_DIR / self.id
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def work_dir(self) -> Path:
        d = WORK_DIR / self.id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def read_json(self, name: str) -> dict:
        return json.loads((self.out_dir / name).read_text())

    def write_json(self, name: str, data: dict) -> Path:
        path = self.out_dir / name
        path.write_text(json.dumps(data, indent=2) + "\n")
        return path


def load_fire(fire_id: str | None = None) -> Fire:
    cfg = yaml.safe_load((PIPELINE_DIR / "fire.yaml").read_text())
    fire_id = fire_id or os.environ.get("FIRE") or cfg["default"]
    f = cfg["fires"][fire_id]
    return Fire(
        id=fire_id,
        name=f["name"],
        calfire_name=f["calfire_name"],
        nifc_name=f["nifc_name"],
        year=int(f["year"]),
        location=f["location"],
        timezone=f["timezone"],
        window_utc=tuple(f["window_utc"]),
        buffer_km=float(f["buffer_km"]),
        dem_zoom=int(f["dem_zoom"]),
    )
