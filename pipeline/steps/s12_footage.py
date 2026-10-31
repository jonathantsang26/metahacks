"""Shared paths, clip config, labelled-frame loaders and metrics for the vision steps (12, 12a, 12c).

Footage lives in the repo-root `footage/` folder, which is gitignored (FLAME 2 has no stated
license, BUILD.md §5):

  footage/clips.yaml            which clips to publish (see CLIPS_EXAMPLE)
  footage/models/               fine-tuned Sentinel weights (step 12a; the committed copy is pipeline/models/)
  footage/sam_cache/            raw SAM 3.1 responses, so no clip is ever billed twice
  footage/trimmed/              ≤ 30 s H.264 cuts sent to SAM and copied to the web app

Outputs go to web/public/data/<fire>/footage/ and web/public/data/<fire>/eval/ (WORKSTREAMS.md §1, C → B).
The footage is not of either fire, so every fire gets the same files.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import random
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import yaml

from ember.config import PIPELINE_DIR, REPO_DIR, load_fire

FOOTAGE_DIR = REPO_DIR / "footage"
MODELS_DIR = FOOTAGE_DIR / "models"
#: The committed fine-tune (FireNET is MIT-licensed), so a fresh clone can run step 12 without retraining.
COMMITTED_MODELS = PIPELINE_DIR / "models"
SAM_CACHE = FOOTAGE_DIR / "sam_cache"
TRIMMED_DIR = FOOTAGE_DIR / "trimmed"
CLIPS_YAML = FOOTAGE_DIR / "clips.yaml"
FIRE_IDS = ("eaton", "palisades")

#: The two classes Sentinel is meant to detect, in training-label order.
CLASSES = ("fire", "smoke")

CLIPS_EXAMPLE = """\
# footage/clips.yaml: one entry per clip the Drones tab shows.
clips:
  - id: flame2-01
    title: FLAME 2 · video 1 (RGB)
    file: raw/flame2/video1_rgb.mp4      # relative to footage/
    source: FLAME 2 (IEEE DataPort), Northern Arizona University
    note: FLAME 2 · prescribed burn · not this fire
    crop: left                           # optional: left/right half of a side-by-side RGB|IR video
    publish: false                       # true only for footage we may redistribute (our own)
"""


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------ Sentinel weights


def shipped_weights() -> Path:
    """Sentinel's own `fire_yolov8n.pt`, from the submodule or a sibling checkout ($SENTINEL_DIR wins)."""
    candidates = [
        Path(os.environ["SENTINEL_DIR"]) / "models" / "fire_yolov8n.pt" if os.environ.get("SENTINEL_DIR") else None,
        REPO_DIR / "vendor" / "sentinel-app" / "models" / "fire_yolov8n.pt",
        REPO_DIR.parent / "sentinel-app" / "models" / "fire_yolov8n.pt",
    ]
    for c in candidates:
        if c and c.exists():
            return c
    raise SystemExit("Sentinel weights not found: set SENTINEL_DIR to a sentinel-app checkout "
                     "(github.com/benjaminxie1/sentinel-app) or add it as vendor/sentinel-app.")


def default_weights() -> Path:
    """A local step-12a fine-tune, else the committed one, else Sentinel's shipped weights."""
    for d in (MODELS_DIR, COMMITTED_MODELS):
        if (d / "sentinel_fire.pt").exists():
            return d / "sentinel_fire.pt"
    return shipped_weights()


def fire_class_ids(names: dict[int, str]) -> dict[int, str]:
    """Model class ids that mean fire or smoke. A stock COCO model has none ("fire hydrant" is not fire)."""
    out = {}
    for i, n in names.items():
        n = n.lower().strip()
        if n in ("fire", "flame", "flames"):
            out[i] = "fire"
        elif n == "smoke":
            out[i] = "smoke"
    return out


def describe_weights(path: Path, names: dict[int, str]) -> dict:
    meta_path = path.with_suffix(".json")
    return {
        "file": path.name,
        "sha256": sha256(path),
        "classes": len(names),
        "fire_classes": sorted(set(fire_class_ids(names).values())),
        "training": json.loads(meta_path.read_text()) if meta_path.exists() else None,
    }


# ------------------------------------------------------------------ clips


@dataclass(frozen=True)
class Clip:
    id: str
    title: str
    file: Path
    source: str
    note: str
    crop: str | None = None
    publish: bool = False


def load_clips() -> list[Clip]:
    if not CLIPS_YAML.exists():
        raise SystemExit(f"{CLIPS_YAML} not found. Create it like this:\n\n{CLIPS_EXAMPLE}")
    cfg = yaml.safe_load(CLIPS_YAML.read_text()) or {}
    clips = []
    for c in cfg.get("clips", []):
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", c["id"]):
            raise SystemExit(f"clip id {c['id']!r}: use lowercase letters, digits, - and _")
        f = FOOTAGE_DIR / c["file"]
        if not f.exists():
            raise SystemExit(f"clip {c['id']}: {f} not found")
        clips.append(Clip(c["id"], c["title"], f, c["source"], c["note"], c.get("crop"), bool(c.get("publish", False))))
    return clips


def footage_out(fire_id: str) -> Path:
    d = load_fire(fire_id).out_dir / "footage"
    d.mkdir(parents=True, exist_ok=True)
    return d


def eval_out(fire_id: str) -> Path:
    d = load_fire(fire_id).out_dir / "eval"
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_all_fires(rel: str, data) -> None:
    """Writes the same JSON under every fire's data folder (the footage is not of either fire)."""
    for fid in FIRE_IDS:
        path = load_fire(fid).out_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=1 if isinstance(data, list) else 2) + "\n")
    print(f"  wrote {rel} for {', '.join(FIRE_IDS)}")


def crop_frame(frame, crop: str | None):
    """Left or right half of a side-by-side RGB|IR frame (FLAME 2 videos are paired)."""
    if crop is None:
        return frame
    w = frame.shape[1] // 2
    return frame[:, :w] if crop == "left" else frame[:, w:]


# ------------------------------------------------------------------ labelled frames


@dataclass(frozen=True)
class LabelledFrame:
    path: Path
    fire: bool
    smoke: bool

    @property
    def positive(self) -> bool:
        return self.fire or self.smoke


IMAGE_EXT = {".jpg", ".jpeg", ".png", ".bmp"}


def _images(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.suffix.lower() in IMAGE_EXT)


def _natural(p: Path):
    return [int(s) if s.isdigit() else s for s in re.split(r"(\d+)", p.stem)]


def load_folder(root: Path) -> list[LabelledFrame]:
    """Class-per-folder sets (e.g. DeepQuest's Fire / Smoke / Neutral): the folder name is the label."""
    out = []
    for p in _images(root):
        name = p.parent.name.lower()
        fire = "fire" in name and "no" not in name
        smoke = "smoke" in name and "no" not in name
        if fire or smoke or any(k in name for k in ("neutral", "nofire", "no_fire", "none", "normal")):
            out.append(LabelledFrame(p, fire, smoke))
    return out


def load_csv(path: Path) -> list[LabelledFrame]:
    """`path,fire,smoke` with 0/1 (or Y/N) flags; paths relative to the CSV."""
    def flag(v: str) -> bool:
        return v.strip().upper() in ("1", "Y", "YES", "TRUE")

    with path.open() as fh:
        return [LabelledFrame(path.parent / r["path"], flag(r["fire"]), flag(r["smoke"])) for r in csv.DictReader(fh)]


def load_flame2(root: Path) -> list[LabelledFrame]:
    """FLAME 2's frame pairs plus its label file.

    The label file has one two-letter code per frame pair, in frame order: fire then smoke, Y or N
    (NN, YY, YN). Images are matched to codes by their natural sort order. Check the first and last
    few pairs by eye before trusting a run: if the counts differ, this raises instead of guessing.
    """
    label_files = [p for p in root.rglob("*.txt") if "label" in p.name.lower()] + \
                  [p for p in root.rglob("*.csv") if "label" in p.name.lower()]
    if not label_files:
        raise SystemExit(f"no label file (*label*.txt|csv) under {root}")
    codes = re.findall(r"\b([YN]{2})\b", label_files[0].read_text().upper())
    rgb = [p for p in _images(root) if "ir" not in p.parent.name.lower() and "thermal" not in p.parent.name.lower()]
    rgb.sort(key=_natural)
    if len(rgb) != len(codes):
        raise SystemExit(f"FLAME 2: {len(rgb)} RGB frames but {len(codes)} labels in {label_files[0].name}; "
                         "point --root at the folder holding one set of frames and the label file")
    return [LabelledFrame(p, c[0] == "Y", c[1] == "Y") for p, c in zip(rgb, codes)]


def load_labelled(kind: str, root: Path) -> list[LabelledFrame]:
    if kind == "folder":
        return load_folder(root)
    if kind == "csv":
        return load_csv(root)
    if kind == "flame2":
        return load_flame2(root)
    raise SystemExit(f"unknown dataset kind {kind!r}")


def stratified_sample(frames: list[LabelledFrame], n: int | None, seed: int = 0) -> list[LabelledFrame]:
    """Up to n frames with the positive/negative mix of the full set; fixed seed so runs repeat."""
    if not n or n >= len(frames):
        return frames
    rng = random.Random(seed)
    pos = [f for f in frames if f.positive]
    neg = [f for f in frames if not f.positive]
    k = round(n * len(pos) / len(frames))
    return sorted(rng.sample(pos, k) + rng.sample(neg, n - k), key=lambda f: str(f.path))


# ------------------------------------------------------------------ metrics


def prf(pred: list[bool], truth: list[bool]) -> dict:
    tp = sum(p and t for p, t in zip(pred, truth))
    fp = sum(p and not t for p, t in zip(pred, truth))
    fn = sum(t and not p for p, t in zip(pred, truth))
    tn = len(truth) - tp - fp - fn
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = 2 * precision * recall / (precision + recall) if precision and recall else 0.0
    r3 = lambda v: None if v is None else round(v, 3)  # noqa: E731
    return {"precision": r3(precision), "recall": r3(recall), "f1": r3(f1),
            "tp": tp, "fp": fp, "fn": fn, "tn": tn}


def frame_scores(frames: list[LabelledFrame], scores: list[dict[str, float]], threshold: float) -> dict:
    """Frame-level metrics from per-frame max confidence per class: any of fire/smoke, then each class."""
    def hit(s: dict[str, float], cls: str | None) -> bool:
        vals = [v for k, v in s.items() if cls is None or k == cls]
        return bool(vals) and max(vals) >= threshold

    out = {"threshold": threshold, "any": prf([hit(s, None) for s in scores], [f.positive for f in frames])}
    for cls in CLASSES:
        out[cls] = prf([hit(s, cls) for s in scores], [getattr(f, cls) for f in frames])
    return out


def sweep(frames: list[LabelledFrame], scores: list[dict[str, float]]) -> list[dict]:
    """Precision/recall of fire-or-smoke at thresholds 0.05–0.95, for the curve in the README."""
    rows = []
    for thr in [round(0.05 * i, 2) for i in range(1, 20)]:
        m = frame_scores(frames, scores, thr)["any"]
        rows.append({"threshold": thr, "precision": m["precision"], "recall": m["recall"]})
    return rows
