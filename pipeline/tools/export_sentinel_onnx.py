"""Export the fine-tuned Sentinel detector (pipeline/models/sentinel_fire.pt) to ONNX for the browser,
and check the export against PyTorch.

  web/public/models/sentinel_fire.onnx       static [1,3,416,416] float32 in, raw [1,6,3549] out (no NMS)
  web/public/models/sentinel_fire.onnx.json  I/O spec, preprocessing, thresholds, hashes, parity numbers

Parity runs on frames from the published clips at the frame numbers in footage/detections/*.json:
  1. tensor parity: the same 416x416 letterboxed tensor through PyTorch and onnxruntime (raw outputs)
  2. end-to-end: ultralytics `predict` on the .pt (exactly as step 12 ran it) versus onnxruntime with the
     NumPy letterbox + decode + NMS below, which is the algorithm the browser implements.
  3. onnxruntime CPU timing, single-threaded and default threads.

Run from pipeline/ (ultralytics is not a pipeline dependency):
  uv run --with ultralytics --with onnx --with onnxruntime --with onnxslim python -m tools.export_sentinel_onnx
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import statistics
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

PIPELINE_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = PIPELINE_DIR.parent
WEIGHTS = PIPELINE_DIR / "models" / "sentinel_fire.pt"
OUT_DIR = REPO_DIR / "web" / "public" / "models"
ONNX_PATH = OUT_DIR / "sentinel_fire.onnx"
SPEC_PATH = OUT_DIR / "sentinel_fire.onnx.json"
LOG_PATH = PIPELINE_DIR / "logs" / "sentinel-onnx.log"
FOOTAGE = REPO_DIR / "web" / "public" / "data" / "eaton" / "footage"
CLIPS = ("blm-north-bank", "blm-north-umpqua-ir")

IMGSZ = 416
OPSET = 12
CONF = 0.25
#: ultralytics `predict` default (the value step 12 used, since it never passed iou=).
IOU = 0.7
PAD = 114
MAX_DET = 300
MAX_WH = 7680  # ultralytics' per-class offset for batched NMS


class Tee:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = path.open("w")

    def __call__(self, *a) -> None:
        s = " ".join(str(x) for x in a)
        print(s, flush=True)
        self.fh.write(s + "\n")
        self.fh.flush()


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------ the browser algorithm, in NumPy


def letterbox(bgr: np.ndarray, size: int = IMGSZ) -> tuple[np.ndarray, float, tuple[int, int]]:
    """Square letterbox exactly as ultralytics LetterBox(auto=False): scale to fit, centre, pad 114.
    Returns the [1,3,size,size] float32 RGB/255 tensor, the gain, and (left, top) padding."""
    import cv2

    h, w = bgr.shape[:2]
    r = min(size / h, size / w)
    nw, nh = int(round(w * r)), int(round(h * r))
    dw, dh = (size - nw) / 2, (size - nh) / 2
    img = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR) if (nw, nh) != (w, h) else bgr
    top, bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
    left, right = int(round(dw - 0.1)), int(round(dw + 0.1))
    img = cv2.copyMakeBorder(img, top, bottom, left, right, cv2.BORDER_CONSTANT, value=(PAD, PAD, PAD))
    x = img[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    return np.ascontiguousarray(x), r, (left, top)


def iou_one(box: np.ndarray, boxes: np.ndarray) -> np.ndarray:
    x1 = np.maximum(box[0], boxes[:, 0]); y1 = np.maximum(box[1], boxes[:, 1])
    x2 = np.minimum(box[2], boxes[:, 2]); y2 = np.minimum(box[3], boxes[:, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    a = (box[2] - box[0]) * (box[3] - box[1])
    b = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    return inter / (a + b - inter + 1e-9)


def decode(out: np.ndarray, gain: float, pad: tuple[int, int], w: int, h: int,
           conf: float = CONF, iou: float = IOU) -> list[dict]:
    """Raw [1, 4+nc, N] → boxes in source pixels. Per anchor: best class score; keep ≥ conf; greedy
    per-class NMS (sorted by score, at most MAX_DET); undo the letterbox; clip to the frame."""
    p = out[0].T  # [N, 4+nc]
    scores = p[:, 4:]
    cls = scores.argmax(1)
    sc = scores[np.arange(len(p)), cls]
    keep = sc >= conf
    p, cls, sc = p[keep], cls[keep], sc[keep]
    xyxy = np.stack([p[:, 0] - p[:, 2] / 2, p[:, 1] - p[:, 3] / 2, p[:, 0] + p[:, 2] / 2, p[:, 1] + p[:, 3] / 2], 1)
    order = np.argsort(-sc, kind="stable")
    picked: list[int] = []
    suppressed = np.zeros(len(order), bool)
    for i_, i in enumerate(order):
        if suppressed[i_]:
            continue
        picked.append(i)
        if len(picked) >= MAX_DET:
            break
        rest = order[i_ + 1:]
        same = cls[rest] == cls[i]
        ov = iou_one(xyxy[i], xyxy[rest])
        suppressed[i_ + 1:] |= same & (ov > iou)
    dets = []
    for i in picked:
        b = xyxy[i].copy()
        b[[0, 2]] = np.clip((b[[0, 2]] - pad[0]) / gain, 0, w)
        b[[1, 3]] = np.clip((b[[1, 3]] - pad[1]) / gain, 0, h)
        dets.append({"box": b.tolist(), "cls": int(cls[i]), "conf": float(sc[i])})
    return dets


# ------------------------------------------------------------------ helpers


def box_iou(a, b) -> float:
    return float(iou_one(np.asarray(a, float), np.asarray([b], float))[0])


def match(pt: list[dict], ox: list[dict], thr: float = 0.5):
    """Greedy same-class matching by IoU (highest first). Returns pairs, unmatched pt, unmatched onnx."""
    cands = sorted(((box_iou(a["box"], b["box"]), i, j) for i, a in enumerate(pt) for j, b in enumerate(ox)
                    if a["cls"] == b["cls"]), reverse=True)
    ui, uj, pairs = set(range(len(pt))), set(range(len(ox))), []
    for v, i, j in cands:
        if v < thr:
            break
        if i in ui and j in uj:
            pairs.append((pt[i], ox[j], v)); ui.discard(i); uj.discard(j)
    return pairs, [pt[i] for i in sorted(ui)], [ox[j] for j in sorted(uj)]


def sample_frames(n_per_clip: int) -> dict[str, list[int]]:
    """Evenly spaced frame numbers from the set step 12 ran on (every 6th frame of each published clip)."""
    import cv2

    out = {}
    for cid in CLIPS:
        cap = cv2.VideoCapture(str(FOOTAGE / "clips" / f"{cid}.mp4"))
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)); cap.release()
        step = 6  # round(29.97 / 5): step 12's stride, so these are frames it ran on
        grid = list(range(0, n, step))
        idx = np.linspace(0, len(grid) - 1, n_per_clip).round().astype(int)
        out[cid] = sorted({grid[i] for i in idx})
    return out


def read_frames(cid: str, wanted: list[int]) -> dict[int, np.ndarray]:
    import cv2

    cap = cv2.VideoCapture(str(FOOTAGE / "clips" / f"{cid}.mp4"))
    want, got, i = set(wanted), {}, 0
    while want - got.keys():
        ok, frame = cap.read()
        if not ok:
            break
        if i in want:
            got[i] = frame
        i += 1
    cap.release()
    return got


def stats(xs: list[float]) -> dict:
    if not xs:
        return {"n": 0}
    a = np.asarray(xs, float)
    return {"n": len(xs), "max": round(float(a.max()), 6), "median": round(float(np.median(a)), 6),
            "mean": round(float(a.mean()), 6), "min": round(float(a.min()), 6)}


def compare(pt_by_frame: dict, ox_by_frame: dict) -> dict:
    dconf, ious, only_pt, only_ox, n_pt, n_ox = [], [], [], [], 0, 0
    for k in pt_by_frame:
        pt, ox = pt_by_frame[k], ox_by_frame[k]
        n_pt += len(pt); n_ox += len(ox)
        pairs, up, uo = match(pt, ox)
        for a, b, v in pairs:
            dconf.append(abs(a["conf"] - b["conf"])); ious.append(v)
        only_pt += [{"frame": k, **d} for d in up]
        only_ox += [{"frame": k, **d} for d in uo]
    r = lambda ds: [{"clip": d["frame"][0], "frame": d["frame"][1], "cls": d["cls"], "conf": round(d["conf"], 4),
                     "box": [round(v, 1) for v in d["box"]]} for d in ds]
    return {"detections_pt": n_pt, "detections_onnx": n_ox, "matched": len(ious),
            "abs_conf_diff": stats(dconf), "matched_box_iou": stats(ious),
            "only_pt": len(only_pt), "only_onnx": len(only_ox),
            "only_pt_list": r(only_pt), "only_onnx_list": r(only_ox)}


# ------------------------------------------------------------------ main


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--frames-per-clip", type=int, default=30)
    ap.add_argument("--timing-runs", type=int, default=100)
    args = ap.parse_args()

    import cv2
    import onnx
    import onnxruntime as ort
    import torch
    import ultralytics
    from ultralytics import YOLO

    log = Tee(LOG_PATH)
    log(f"# Sentinel ONNX export + parity · {datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    log(f"python {sys.version.split()[0]} · torch {torch.__version__} · ultralytics {ultralytics.__version__} · "
        f"onnx {onnx.__version__} · onnxruntime {ort.__version__} · opencv {cv2.__version__}")
    log(f"machine: {platform.platform()} · {platform.processor() or platform.machine()} · "
        f"{__import__('os').cpu_count()} logical CPUs")

    # ---- export
    pt_sha = sha256(WEIGHTS)
    log(f"\n## export\nweights {WEIGHTS.relative_to(REPO_DIR)} sha256 {pt_sha}")
    model = YOLO(str(WEIGHTS))
    names = {int(k): v for k, v in model.names.items()}
    log(f"classes {names}")
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "sentinel_fire.pt"
        shutil.copyfile(WEIGHTS, tmp)
        exported = YOLO(str(tmp)).export(format="onnx", imgsz=IMGSZ, opset=OPSET, dynamic=False, simplify=True,
                                         half=False, nms=False, batch=1, device="cpu")
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(exported, ONNX_PATH)
    m = onnx.load(str(ONNX_PATH))
    onnx.checker.check_model(m)
    ops = sorted({n.op_type for n in m.graph.node})
    onnx_sha = sha256(ONNX_PATH)
    dims = lambda v: [d.dim_value if d.HasField("dim_value") else d.dim_param for d in v.type.tensor_type.shape.dim]
    dt = lambda v: {"float": "float32"}.get(n := onnx.TensorProto.DataType.Name(v.type.tensor_type.elem_type).lower(), n)
    inp, out = m.graph.input[0], m.graph.output[0]
    log(f"onnx {ONNX_PATH.relative_to(REPO_DIR)} {ONNX_PATH.stat().st_size} bytes sha256 {onnx_sha}")
    log(f"opset {m.opset_import[0].version} · ir {m.ir_version} · {len(m.graph.node)} nodes · ops {ops}")
    log(f"input  {inp.name} {dims(inp)} {dt(inp)}")
    log(f"output {out.name} {dims(out)} {dt(out)}")
    n_anchors = dims(out)[2]
    meta = {p.key: p.value for p in m.metadata_props}

    sess = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
    torch_model = model.model.float().eval()
    torch.set_grad_enabled(False)

    # ---- which imgsz did step 12 use? compare .pt predictions at 416 and 640 to the published detections
    frames_by_clip = sample_frames(args.frames_per_clip)
    frames = {cid: read_frames(cid, fr) for cid, fr in frames_by_clip.items()}
    n_frames = sum(len(v) for v in frames.values())
    log(f"\n## frames\n{n_frames} frames: " + "; ".join(f"{c} {len(v)} ({min(v)}..{max(v)}, every 6th-frame grid)"
                                                         for c, v in frames.items()))
    published = {}
    for cid in CLIPS:
        for d in json.loads((FOOTAGE / "detections" / f"{cid}.json").read_text()):
            published.setdefault((cid, d["frame"]), []).append(
                {"box": d["box"], "cls": 0 if d["cls"] == "fire" else 1, "conf": d["conf"]})

    def pt_predict(imgsz: int, rect: bool = True) -> dict:
        res = {}
        for cid, fr in frames.items():
            for k, img in fr.items():
                r = model.predict(img, conf=CONF, imgsz=imgsz, rect=rect, verbose=False)[0]
                res[(cid, k)] = [{"box": b, "cls": int(c), "conf": float(p)} for b, c, p in
                                 zip(r.boxes.xyxy.tolist(), r.boxes.cls.tolist(), r.boxes.conf.tolist())]
        return res

    log("\n## which imgsz reproduces footage/detections/*.json (step 12 default --imgsz is 640)")
    pt_runs, repro = {}, {}
    for s in (416, 640):
        pt_runs[s] = pt_predict(s)
        c = compare({k: published.get(k, []) for k in pt_runs[s]}, pt_runs[s])
        repro[s] = {k: c[k] for k in ("detections_pt", "detections_onnx", "matched", "only_pt", "only_onnx")}
        repro[s]["abs_conf_diff_max"] = c["abs_conf_diff"].get("max")
        log(f"imgsz {s}: published {c['detections_pt']} vs re-run {c['detections_onnx']}, matched {c['matched']}, "
            f"only-published {c['only_pt']}, only-re-run {c['only_onnx']}, max |Δconf| {c['abs_conf_diff'].get('max')}")
    step12_imgsz = max((416, 640), key=lambda s: (repro[s]["matched"] - repro[s]["only_pt"] - repro[s]["only_onnx"]))
    log(f"→ published detections are best reproduced by imgsz {step12_imgsz}")

    # ---- run ONNX with the NumPy pipeline; tensor parity on the same input
    log("\n## tensor parity: identical 416x416 letterboxed tensor → PyTorch vs onnxruntime raw output")
    from ultralytics.utils.nms import non_max_suppression
    from ultralytics.utils.ops import scale_boxes

    ox_run, ref_run, raw_box, raw_cls = {}, {}, [], []
    for cid, fr in frames.items():
        for k, img in fr.items():
            x, gain, pad = letterbox(img)
            o = sess.run(None, {inp.name: x})[0]
            t = torch_model(torch.from_numpy(x))
            t = (t[0] if isinstance(t, (list, tuple)) else t).numpy()
            raw_box.append(float(np.abs(o[0, :4] - t[0, :4]).max()))
            raw_cls.append(float(np.abs(o[0, 4:] - t[0, 4:]).max()))
            ox_run[(cid, k)] = decode(o, gain, pad, img.shape[1], img.shape[0])
            # reference post-processing: ultralytics' own NMS + scale_boxes on the PyTorch output
            d = non_max_suppression(torch.from_numpy(t), CONF, IOU, max_det=MAX_DET)[0]
            d[:, :4] = scale_boxes((IMGSZ, IMGSZ), d[:, :4], img.shape[:2])
            ref_run[(cid, k)] = [{"box": b[:4], "cls": int(b[5]), "conf": float(b[4])} for b in d.tolist()]
    log(f"max |Δ| per frame, box rows (px in 416 space): {stats(raw_box)}")
    log(f"max |Δ| per frame, class-score rows:           {stats(raw_cls)}")

    log("\n## end-to-end parity: PyTorch side vs onnxruntime + NumPy letterbox/decode/NMS (the browser algorithm)")
    log(f"(conf {CONF}, NMS IoU {IOU} per class, matching = same class and box IoU ≥ 0.5, boxes in source pixels)")
    pt_runs["416sq"] = pt_predict(IMGSZ, rect=False)
    published_s = {k: published.get(k, []) for k in ox_run}
    sides = {
        "pt_square416": (pt_runs["416sq"], "ultralytics .pt predict, imgsz 416, rect=False (square 416x416 letterbox, same input geometry as the ONNX)"),
        "pt_raw_ultralytics_nms": (ref_run, "PyTorch raw output on the identical NumPy tensor + ultralytics non_max_suppression/scale_boxes (checks decode/NMS only)"),
        "pt_rect416": (pt_runs[416], "ultralytics .pt predict, imgsz 416, default rect letterbox (416x256 for 1280x720)"),
        "pt_rect640": (pt_runs[640], "ultralytics .pt predict, imgsz 640, default rect letterbox (640x384): how step 12 ran"),
        "published_detections": (published_s, "the committed footage/detections/*.json at these frames (conf rounded to 3 dp, box to 0.1 px)"),
    }
    parity = {}
    for key, (ref, desc) in sides.items():
        c = compare(ref, ox_run)
        c["reference"] = desc
        parity[key] = c
        log(f"\n### vs {key}: {desc}")
        log(f"detections: ref {c['detections_pt']}, onnx {c['detections_onnx']}, matched {c['matched']}, "
            f"only ref {c['only_pt']}, only onnx {c['only_onnx']}")
        log(f"|Δconf| matched: {c['abs_conf_diff']}")
        log(f"box IoU matched: {c['matched_box_iou']}")
        for d in c["only_pt_list"][:15]:
            log(f"  only ref  {d}")
        for d in c["only_onnx_list"][:15]:
            log(f"  only onnx {d}")
        if len(c["only_pt_list"]) > 15 or len(c["only_onnx_list"]) > 15:
            log("  (lists truncated to 15 each)")

    # ---- timing
    log("\n## onnxruntime CPU timing (session.run only, one 1x3x416x416 tensor, after 10 warm-up runs)")
    x, _, _ = letterbox(next(iter(frames[CLIPS[0]].values())))
    timing = {}
    for label, threads in (("single_thread", 1), ("default", 0)):
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        if threads == 1:
            so.inter_op_num_threads = 1
        s = ort.InferenceSession(str(ONNX_PATH), so, providers=["CPUExecutionProvider"])
        for _ in range(10):
            s.run(None, {inp.name: x})
        ts = []
        for _ in range(args.timing_runs):
            t0 = time.perf_counter(); s.run(None, {inp.name: x}); ts.append((time.perf_counter() - t0) * 1000)
        timing[label] = {"intra_op_threads": threads or "default", "runs": len(ts),
                         "median_ms": round(statistics.median(ts), 2), "mean_ms": round(statistics.mean(ts), 2),
                         "p90_ms": round(float(np.percentile(ts, 90)), 2), "min_ms": round(min(ts), 2)}
        log(f"{label}: {timing[label]}")
    t0 = time.perf_counter()
    for cid, fr in frames.items():
        for k, img in fr.items():
            xx, g, p = letterbox(img)
            decode(sess.run(None, {inp.name: xx})[0], g, p, img.shape[1], img.shape[0])
    e2e = round((time.perf_counter() - t0) * 1000 / n_frames, 2)
    log(f"end-to-end per frame (letterbox + run + decode/NMS, default threads, 1280x720 BGR in): {e2e} ms")

    # ---- spec
    strip = lambda c: {k: v for k, v in c.items() if not k.endswith("_list")}
    spec = {
        "model": "Sentinel YOLOv8n fine-tuned on FireNET (fire, smoke)",
        "file": ONNX_PATH.name,
        "bytes": ONNX_PATH.stat().st_size,
        "sha256": onnx_sha,
        "source_weights": {"file": f"pipeline/models/{WEIGHTS.name}", "sha256": pt_sha,
                           "training": json.loads(WEIGHTS.with_suffix(".json").read_text())},
        "export": {"tool": f"ultralytics {ultralytics.__version__}", "torch": torch.__version__,
                   "onnx": onnx.__version__, "opset": m.opset_import[0].version, "ir_version": m.ir_version,
                   "dynamic": False, "simplify": True, "half": False, "nms": False, "ops": ops,
                   "script": "pipeline/tools/export_sentinel_onnx.py", "date": datetime.now(timezone.utc).date().isoformat()},
        "classes": [names[i] for i in sorted(names)],
        "imgsz": IMGSZ,
        "input": {"name": inp.name, "shape": dims(inp), "dtype": dt(inp), "layout": "NCHW",
                  "colour": "RGB", "range": "0..1 (uint8 / 255)"},
        "output": {"name": out.name, "shape": dims(out), "dtype": dt(out),
                   "layout": f"[batch, 4 + nc, anchors]: row 0..3 = cx, cy, w, h in input pixels (0..{IMGSZ}); "
                             f"row 4 = fire score, row 5 = smoke score (already sigmoid, 0..1; no objectness); "
                             f"{n_anchors} anchors = 52² + 26² + 13² (strides 8, 16, 32)",
                   "nms_included": False},
        "preprocessing": {
            "letterbox": f"r = min({IMGSZ}/h, {IMGSZ}/w); resize to (round(w*r), round(h*r)) bilinear; "
                         f"pad left = round(({IMGSZ}-nw)/2 - 0.1), top = round(({IMGSZ}-nh)/2 - 0.1) to {IMGSZ}x{IMGSZ}",
            "pad_value": PAD, "pad_colour_rgb": [PAD, PAD, PAD], "colour": "RGB", "scale": "1/255",
            "layout": "CHW, batch 1", "resize_interpolation": "bilinear (cv2.INTER_LINEAR)",
        },
        "postprocessing": {
            "score": "per anchor, max over class rows; class = argmax",
            "conf": CONF, "nms_iou": IOU, "nms": "greedy, per class (class-aware), sorted by score",
            "max_det": MAX_DET,
            "unletterbox": "x = (x - padLeft) / r, y = (y - padTop) / r, then clip to the frame",
            "note": (f"conf {CONF} is what step 12 used for footage/detections. NMS IoU {IOU} is ultralytics' "
                     "predict default, which step 12 used (it never passed iou=); 0.45 is ultralytics' older/val "
                     "value and suppresses a little more."),
        },
        "parity": {
            "frames": n_frames,
            "frame_sample": {c: v for c, v in frames_by_clip.items()},
            "clips": [f"web/public/data/eaton/footage/clips/{c}.mp4" for c in CLIPS],
            "published_detections_reproduced_by_imgsz": step12_imgsz,
            "published_vs_rerun": repro,
            "tensor": {"max_abs_diff_box_rows_px": stats(raw_box), "max_abs_diff_score_rows": stats(raw_cls)},
            "end_to_end": {k: strip(v) for k, v in parity.items()},
            "method": ("ONNX side: onnxruntime CPU on this script's NumPy square letterbox + decode + per-class NMS "
                       "(the browser algorithm). Each end_to_end entry compares one reference against it; 'pt' "
                       "fields mean the reference. Matching: same class, IoU >= 0.5, greedy by IoU."),
        },
        "timing_onnxruntime_cpu": {"machine": f"{platform.machine()}, {__import__('os').cpu_count()} logical CPUs",
                                   "onnxruntime": ort.__version__, **timing, "end_to_end_ms_per_frame": e2e},
        "metadata_props": meta,
    }
    SPEC_PATH.write_text(json.dumps(spec, indent=2) + "\n")
    log(f"\nwrote {SPEC_PATH.relative_to(REPO_DIR)}")


if __name__ == "__main__":
    main()
