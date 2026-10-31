"""12 + 12b: Sentinel YOLOv8 fire/smoke detection on drone footage, and its frame-level eval.

Sentinel is Ben's detector (github.com/benjaminxie1/sentinel-app), disclosed as prior work.
Its shipped `fire_yolov8n.pt` is the stock COCO YOLOv8n (byte-identical to `yolov8n_base.pt`,
no fire or smoke class), so the default weights are the fine-tune from step 12a when present.

  detect   every clip in footage/clips.yaml at --fps → footage/detections/<id>.json + clips.json
  eval     (12b) labelled frames → eval/sentinel.json: frame-level precision/recall of fire-or-smoke,
           per class, and a threshold sweep. --baseline adds the shipped weights' numbers.

Run from pipeline/ (ultralytics is not a pipeline dependency, so pull it in for this step only):
  uv run --with ultralytics python -m steps.s12_sentinel eval --dataset flame2 --root ../footage/raw/flame2 --sample 1000 --baseline
  uv run --with ultralytics python -m steps.s12_sentinel detect
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

from steps.s12_footage import (
    FIRE_IDS,
    TRIMMED_DIR,
    Clip,
    crop_frame,
    default_weights,
    describe_weights,
    fire_class_ids,
    footage_out,
    frame_scores,
    load_clips,
    load_labelled,
    shipped_weights,
    stratified_sample,
    sweep,
    today,
    write_all_fires,
)

MAX_CLIP_S = 30.0


def load_model(weights: Path):
    from ultralytics import YOLO

    model = YOLO(str(weights))
    names = {int(k): v for k, v in model.names.items()}
    return model, names


def frame_max_scores(model, names: dict[int, str], images, conf: float, imgsz: int) -> list[dict[str, float]]:
    """Per image: the highest confidence for each of fire/smoke (empty if none)."""
    ids = fire_class_ids(names)
    out = []
    for i in range(0, len(images), 16):
        for r in model.predict(images[i:i + 16], conf=conf, imgsz=imgsz, verbose=False):
            best: dict[str, float] = {}
            for c, p in zip(r.boxes.cls.tolist(), r.boxes.conf.tolist()):
                cls = ids.get(int(c))
                if cls:
                    best[cls] = max(best.get(cls, 0.0), round(float(p), 4))
            out.append(best)
    return out


def evaluate(weights: Path, frames, threshold: float, imgsz: int) -> dict:
    model, names = load_model(weights)
    scores = frame_max_scores(model, names, [str(f.path) for f in frames], conf=0.05, imgsz=imgsz)
    result = frame_scores(frames, scores, threshold)
    return {"weights": describe_weights(weights, names), **result, "sweep": sweep(frames, scores)}


def cmd_eval(args) -> None:
    frames = stratified_sample(load_labelled(args.dataset, args.root), args.sample)
    if not frames:
        raise SystemExit(f"no labelled frames under {args.root}")
    n_pos = sum(f.positive for f in frames)
    print(f"[12b] {len(frames)} frames ({n_pos} with fire or smoke) from {args.root}")
    weights = args.weights or default_weights()
    main = evaluate(weights, frames, args.threshold, args.imgsz)
    a = main["any"]
    print(f"  {weights.name}: precision {a['precision']}  recall {a['recall']}  f1 {a['f1']}")
    out = {
        "metric": "frame-level fire-or-smoke detection",
        "precision": a["precision"],
        "recall": a["recall"],
        "f1": a["f1"],
        "n": len(frames),
        "n_positive": n_pos,
        "dataset": {"kind": args.dataset, "name": args.name or args.root.name, "sample": args.sample, "seed": 0},
        **main,
        "method": (f"Sentinel YOLOv8 ({weights.name}) on {len(frames)} labelled frames. A frame counts as "
                   f"a detection when any fire or smoke box has confidence ≥ {args.threshold}; scored against "
                   "the frame's fire/smoke label. Frame-level, not box-level: the labels have no boxes."),
        "date": today(),
    }
    if args.baseline and shipped_weights().resolve() != weights.resolve():
        base = evaluate(shipped_weights(), frames, args.threshold, args.imgsz)
        b = base["any"]
        print(f"  shipped {shipped_weights().name}: precision {b['precision']}  recall {b['recall']}")
        out["baseline"] = base
    write_all_fires("eval/sentinel.json", out)


# ------------------------------------------------------------------ detect


def probe(path: Path) -> tuple[float, int, int, int]:
    import cv2

    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    return fps, w, h, n


def busiest_window(dets: list[dict], fps: float, n_frames: int) -> tuple[float, float]:
    """Start and length (s) of the ≤ 30 s window with the most detections: Sentinel picks what SAM sees."""
    dur = n_frames / fps
    if dur <= MAX_CLIP_S:
        return 0.0, dur
    times = sorted(d["frame"] / fps for d in dets)
    best, start = -1, 0.0
    for t0 in [i * 1.0 for i in range(int(dur - MAX_CLIP_S) + 1)]:
        k = sum(t0 <= t < t0 + MAX_CLIP_S for t in times)
        if k > best:
            best, start = k, t0
    return start, MAX_CLIP_S


def trim(clip: Clip, start: float, length: float) -> Path:
    """H.264 cut (and half-frame crop for side-by-side RGB|IR) that SAM and the browser both read."""
    TRIMMED_DIR.mkdir(parents=True, exist_ok=True)
    out = TRIMMED_DIR / f"{clip.id}.mp4"
    vf = {"left": "crop=iw/2:ih:0:0", "right": "crop=iw/2:ih:iw/2:0"}.get(clip.crop or "", "null")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start:.2f}", "-i", str(clip.file), "-t", f"{length:.2f}",
         "-vf", f"{vf},scale=trunc(iw/2)*2:trunc(ih/2)*2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
         "-crf", "23", "-movflags", "+faststart", str(out)],
        check=True,
    )
    return out


def detect_video(model, names, path: Path, every: int, conf: float, imgsz: int, crop: str | None) -> list[dict]:
    import cv2

    ids = fire_class_ids(names)
    cap = cv2.VideoCapture(str(path))
    dets, i = [], 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % every == 0:
            r = model.predict(crop_frame(frame, crop), conf=conf, imgsz=imgsz, verbose=False)[0]
            for box, c, p in zip(r.boxes.xyxy.tolist(), r.boxes.cls.tolist(), r.boxes.conf.tolist()):
                if int(c) in ids:
                    dets.append({"frame": i, "box": [round(v, 1) for v in box], "cls": ids[int(c)],
                                 "conf": round(float(p), 3)})
        i += 1
    cap.release()
    return dets


def cmd_detect(args) -> None:
    weights = args.weights or default_weights()
    model, names = load_model(weights)
    if not fire_class_ids(names):
        raise SystemExit(f"{weights.name} has no fire or smoke class (it is a stock COCO model). "
                         "Fine-tune it first: python -m steps.s12a_sentinel_train")
    clips_json = []
    for clip in load_clips():
        fps, *_ , n = probe(clip.file)
        every = max(1, round(fps / args.fps))
        print(f"[12] {clip.id}: {n} frames at {fps:.1f} fps, every {every}th")
        full = detect_video(model, names, clip.file, every, args.conf, args.imgsz, clip.crop)
        start, length = busiest_window(full, fps, n)
        cut = trim(clip, start, length)
        # Detections are re-run on the cut so frame numbers match the published video exactly.
        tfps, w, h, _ = probe(cut)
        dets = detect_video(model, names, cut, max(1, round(tfps / args.fps)), args.conf, args.imgsz, None)
        print(f"  window {start:.0f}–{start + length:.0f} s: {len(dets)} boxes")
        write_all_fires(f"footage/detections/{clip.id}.json", dets)
        for fid in FIRE_IDS:
            dst = footage_out(fid) / "clips" / f"{clip.id}.mp4"
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(cut, dst)
        clips_json.append({
            "id": clip.id, "title": clip.title, "src": f"clips/{clip.id}.mp4", "fps": round(tfps, 3),
            "width": w, "height": h, "source": clip.source, "note": clip.note,
            "publish": clip.publish, "window_s": [round(start, 2), round(start + length, 2)],
            "sentinel": {"weights": weights.name, "fps": args.fps, "conf": args.conf},
        })
    write_all_fires("footage/clips.json", clips_json)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("eval", help="12b: frame-level precision/recall on labelled frames")
    e.add_argument("--dataset", choices=["flame2", "folder", "csv"], required=True)
    e.add_argument("--root", type=Path, required=True, help="dataset folder (or the CSV for --dataset csv)")
    e.add_argument("--name", help="dataset name for the report")
    e.add_argument("--sample", type=int, default=1000, help="stratified sample size (0 = all)")
    e.add_argument("--threshold", type=float, default=0.25)
    e.add_argument("--baseline", action="store_true", help="also score Sentinel's shipped weights")
    d = sub.add_parser("detect", help="12: boxes for every clip in footage/clips.yaml")
    d.add_argument("--fps", type=float, default=5.0)
    d.add_argument("--conf", type=float, default=0.25)
    for p in (e, d):
        p.add_argument("--weights", type=Path)
        p.add_argument("--imgsz", type=int, default=640)
    args = ap.parse_args()
    cmd_eval(args) if args.cmd == "eval" else cmd_detect(args)


if __name__ == "__main__":
    main()
