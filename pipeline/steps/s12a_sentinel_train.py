"""12a: fine-tune Sentinel's YOLOv8n into a fire/smoke detector.

Sentinel's shipped `fire_yolov8n.pt` is the stock COCO YOLOv8n: it has no fire or smoke class, and
`fire_detector.py` only simulates the fire training. This step does the training WORKSTREAMS.md §4
names as the fallback, starting from those same weights.

Inputs:  one or more box-labelled datasets, each either
           - Pascal VOC: <root>/{train,validation}/{images,annotations}/ (e.g. FireNET), or
           - YOLO: <root>/data.yaml with names that include fire and/or smoke
Outputs: footage/models/sentinel_fire.pt plus sentinel_fire.json (base weights, data, epochs, val mAP)

Run from pipeline/ (CPU works; ~1 min per epoch per 500 images at --imgsz 416):
  uv run --with ultralytics python -m steps.s12a_sentinel_train --voc ../footage/train/firenet --epochs 30
"""

from __future__ import annotations

import argparse
import json
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

from steps.s12_footage import CLASSES, FOOTAGE_DIR, MODELS_DIR, sha256, shipped_weights, today

BUILD_DIR = FOOTAGE_DIR / "train" / "_yolo"


def voc_to_yolo(root: Path, split_in: str, split_out: str) -> int:
    """Pascal VOC boxes → YOLO txt labels under BUILD_DIR/<split>; returns the image count."""
    img_dir = root / split_in / "images"
    ann_dir = root / split_in / "annotations"
    (BUILD_DIR / split_out / "images").mkdir(parents=True, exist_ok=True)
    (BUILD_DIR / split_out / "labels").mkdir(parents=True, exist_ok=True)
    n = 0
    for ann in sorted(ann_dir.glob("*.xml")):
        tree = ET.parse(ann).getroot()
        size = tree.find("size")
        w, h = float(size.findtext("width")), float(size.findtext("height"))
        lines = []
        for obj in tree.iter("object"):
            name = obj.findtext("name", "").strip().lower()
            if name not in CLASSES or not w or not h:
                continue
            bb = obj.find("bndbox")
            x1, y1, x2, y2 = (float(bb.findtext(k)) for k in ("xmin", "ymin", "xmax", "ymax"))
            lines.append(f"{CLASSES.index(name)} {(x1 + x2) / 2 / w:.6f} {(y1 + y2) / 2 / h:.6f} "
                         f"{(x2 - x1) / w:.6f} {(y2 - y1) / h:.6f}")
        img = next((p for p in img_dir.glob(ann.stem + ".*")), None)
        if img is None:
            continue
        stem = f"{root.name}_{img.stem}"
        shutil.copyfile(img, BUILD_DIR / split_out / "images" / f"{stem}{img.suffix.lower()}")
        (BUILD_DIR / split_out / "labels" / f"{stem}.txt").write_text("\n".join(lines))
        n += 1
    return n


def build_dataset(voc_roots: list[Path]) -> Path:
    shutil.rmtree(BUILD_DIR, ignore_errors=True)
    counts = {}
    for root in voc_roots:
        val_split = "validation" if (root / "validation").exists() else "val"
        counts[root.name] = {"train": voc_to_yolo(root, "train", "train"), "val": voc_to_yolo(root, val_split, "val")}
    data = {"path": str(BUILD_DIR), "train": "train/images", "val": "val/images", "names": dict(enumerate(CLASSES))}
    (BUILD_DIR / "data.yaml").write_text(yaml.safe_dump(data))
    (BUILD_DIR / "counts.json").write_text(json.dumps(counts))
    print(f"[12a] dataset {counts}")
    return BUILD_DIR / "data.yaml"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--voc", type=Path, nargs="*", default=[], help="Pascal VOC dataset roots")
    ap.add_argument("--yolo", type=Path, help="an existing YOLO data.yaml instead of --voc")
    ap.add_argument("--base", type=Path, help="starting weights (default: Sentinel's shipped fire_yolov8n.pt)")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--imgsz", type=int, default=416)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args()
    if not args.voc and not args.yolo:
        raise SystemExit("pass --voc <root> ... or --yolo <data.yaml>")

    from ultralytics import YOLO

    data = args.yolo or build_dataset(args.voc)
    base = args.base or shipped_weights()
    model = YOLO(str(base))
    run_dir = FOOTAGE_DIR / "train" / "runs"
    model.train(data=str(data), epochs=args.epochs, imgsz=args.imgsz, batch=args.batch, device=args.device,
                project=str(run_dir), name="sentinel_fire", exist_ok=True, seed=0, deterministic=True,
                plots=False, verbose=False)
    best = run_dir / "sentinel_fire" / "weights" / "best.pt"
    metrics = YOLO(str(best)).val(data=str(data), imgsz=args.imgsz, device=args.device, plots=False, verbose=False)

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    out = MODELS_DIR / "sentinel_fire.pt"
    shutil.copyfile(best, out)
    counts_path = BUILD_DIR / "counts.json"
    meta = {
        "base": {"file": base.name, "sha256": sha256(base), "note": "Sentinel's shipped weights (stock COCO YOLOv8n)"},
        "data": json.loads(counts_path.read_text()) if not args.yolo and counts_path.exists() else str(args.yolo),
        "classes": list(CLASSES),
        "epochs": args.epochs,
        "imgsz": args.imgsz,
        "val": {"map50": round(float(metrics.box.map50), 3), "map50_95": round(float(metrics.box.map), 3),
                "precision": round(float(metrics.box.mp), 3), "recall": round(float(metrics.box.mr), 3)},
        "date": today(),
    }
    out.with_suffix(".json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"[12a] {out}  val mAP50 {meta['val']['map50']}")


if __name__ == "__main__":
    main()
