"""12c: SAM 3.1 fire/smoke masks on the trimmed drone clips, and a frame-level eval beside Sentinel's.

Sentinel runs first (step 12): it picks the ≤ 30 s window of each clip with the most detections, and
that cut is what SAM sees. With --mode sentinel, Sentinel's boxes are also sent as SAM's object
prompts, so SAM refines exactly what Sentinel found; the default text mode prompts the concepts.

  masks   every clip in footage/clips.json → footage/masks/<id>.json, plus Sentinel/SAM agreement
  eval    labelled frames (image mode) → eval/sam_video.json, scored like eval/sentinel.json

Every raw response is cached in footage/sam_cache/, keyed by the media's hash and the prompt, so a
re-run (or the demo) never calls the API again. Billing: $0.20 per 1k video frames (50 minimum per
request) and $2.50 per 1k images, so a 30 s clip at 30 fps is ~$0.18 per prompt.

Run from pipeline/ (needs MODEL_API_KEY, like tools.smoke_meta):
  uv run --extra sam --with opencv-python-headless python -m steps.s12c_sam_video masks
  uv run --extra sam python -m steps.s12c_sam_video eval --dataset flame2 --root ../footage/raw/flame2 --sample 200
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path

from steps.s12_footage import (
    CLASSES,
    FIRE_IDS,
    SAM_CACHE,
    TRIMMED_DIR,
    frame_scores,
    load_labelled,
    stratified_sample,
    sweep,
    today,
    write_all_fires,
)
from ember.config import load_fire

SAM_MODEL = "sam-3.1"


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def _parse(raw: str, video: bool):
    from meta_sam_parser import CompletedOutcome, image_segmentation_format, video_segmentation_format

    parser = (video_segmentation_format() if video else image_segmentation_format()).create_parser()
    parser.push(raw, emit=False)
    return parser.finish(CompletedOutcome()).result


async def _request(key: str, text: str, media_part: dict, video: bool) -> str:
    from meta_sam_parser import image_segmentation_format, parse_responses_stream, video_segmentation_format
    from tools.smoke_meta import sse_events  # same endpoint and SSE reader as the smoke test

    body = {
        "model": SAM_MODEL,
        "input": [{"type": "message", "role": "user",
                   "content": [{"type": "input_text", "text": text}, media_part]}],
        "stream": True,
        "metadata": {"include_confidence": "true"},
    }
    fmt = video_segmentation_format() if video else image_segmentation_format()
    result = await parse_responses_stream(sse_events(key, body), fmt).final_result()
    return result.raw_output


def segment(media: Path, text: str, tag: str, video: bool, key_fn) -> str:
    """Raw SAM output for one media file and prompt, from the cache when present."""
    SAM_CACHE.mkdir(parents=True, exist_ok=True)
    slug = "".join(c if c.isalnum() else "_" for c in tag)[:40]
    cached = SAM_CACHE / f"{slug}_{_hash(media)}_{hashlib.sha1(text.encode()).hexdigest()[:8]}.txt"
    if cached.exists():
        return cached.read_text()
    from tools.smoke_meta import data_url, upload_file

    key = key_fn()
    part = ({"type": "input_video", "file_id": upload_file(key, media)} if video
            else {"type": "input_image", "image_url": data_url(media)})
    raw = asyncio.run(_request(key, text, part, video))
    cached.write_text(raw)
    return raw


def _key_once():
    from tools.smoke_meta import load_key

    key: list[str] = []
    return lambda: key[0] if key else (key.append(load_key()) or key[0])


# ------------------------------------------------------------------ masks


def mask_entries(result, prompt: str, frame_w: int, frame_h: int) -> list[dict]:
    from meta_sam_parser import decode_mask_to_raster, decode_mask_to_svg_path

    out = []
    for r in result.records:
        if r.kind != "mask":
            continue
        raster = decode_mask_to_raster(r.mask)
        b = r.bounds
        filled = sum(raster) / max(len(raster), 1)
        area = filled * (b.right - b.left) * (b.bottom - b.top) / (frame_w * frame_h)
        out.append({
            "frame": r.frame.frame_index if r.frame else 0,
            "object_id": f"{prompt.replace(' ', '_')}-{r.object_id}",
            "prompt": prompt,
            "bounds": [round(b.left, 1), round(b.top, 1), round(b.right, 1), round(b.bottom, 1)],
            "size": [r.mask.width, r.mask.height],
            "path": decode_mask_to_svg_path(r.mask),
            "conf": None if r.confidence is None else round(r.confidence, 3),
            "area_frac": round(area, 5),
        })
    return out


def sentinel_prompt(dets: list[dict], size: tuple[int, int], max_objects: int = 6) -> str:
    """Sentinel's most confident boxes, one per object on distinct frames, as SAM object prompts."""
    from meta_sam_parser import FramePrompt, PromptBox, PromptObject, build_object_prompt

    w, h = size
    picked, frames = [], set()
    for d in sorted(dets, key=lambda d: -d["conf"]):
        if d["frame"] in frames:
            continue
        frames.add(d["frame"])
        x1, y1, x2, y2 = d["box"]
        box = PromptBox()
        box.left, box.top = max(0, int(x1)), max(0, int(y1))
        box.right, box.bottom = min(w, int(x2) + 1), min(h, int(y2) + 1)
        picked.append(PromptObject(id=len(picked), prompts=[FramePrompt(frame=d["frame"], box=box)]))
        if len(picked) == max_objects:
            break
    return build_object_prompt(size=size, objects=picked)


def _iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def agreement(dets: list[dict], masks: list[dict]) -> dict:
    """Share of Sentinel boxes that a SAM mask on the same frame overlaps (box IoU ≥ 0.1)."""
    by_frame: dict[int, list] = {}
    for m in masks:
        by_frame.setdefault(m["frame"], []).append(m["bounds"])
    on_sam_frames = [d for d in dets if d["frame"] in by_frame]
    hit = sum(any(_iou(d["box"], b) >= 0.1 for b in by_frame[d["frame"]]) for d in on_sam_frames)
    return {"sentinel_boxes": len(dets), "on_sam_frames": len(on_sam_frames), "overlapped_by_sam": hit,
            "share": round(hit / len(on_sam_frames), 3) if on_sam_frames else None}


def cmd_masks(args) -> None:
    out_dir = load_fire(FIRE_IDS[0]).out_dir / "footage"
    clips = json.loads((out_dir / "clips.json").read_text())
    key = _key_once()
    per_clip = {}
    for clip in clips:
        cut = TRIMMED_DIR / f"{clip['id']}.mp4"
        dets = json.loads((out_dir / "detections" / f"{clip['id']}.json").read_text())
        size = (clip["width"], clip["height"])
        entries = []
        if args.mode == "sentinel":
            if not dets:
                print(f"[12c] {clip['id']}: no Sentinel boxes to seed SAM; skipped")
                continue
            raw = segment(cut, sentinel_prompt(dets, size), f"{clip['id']}_sentinel", True, key)
            entries += mask_entries(_parse(raw, True), "sentinel box", *size)
        else:
            for prompt in args.prompts:
                raw = segment(cut, prompt, f"{clip['id']}_{prompt}", True, key)
                entries += mask_entries(_parse(raw, True), prompt, *size)
        entries.sort(key=lambda e: (e["frame"], e["object_id"]))
        objects = {e["object_id"] for e in entries}
        print(f"[12c] {clip['id']}: {len(entries)} masks, {len(objects)} objects")
        write_all_fires(f"footage/masks/{clip['id']}.json", entries)
        per_clip[clip["id"]] = {"masks": len(entries), "objects": len(objects), "mode": args.mode,
                                "prompts": args.prompts if args.mode == "text" else ["sentinel box"],
                                **agreement(dets, entries)}
    _merge_eval({"clips": per_clip})


# ------------------------------------------------------------------ eval


def cmd_eval(args) -> None:
    frames = stratified_sample(load_labelled(args.dataset, args.root), args.sample)
    n_pos = sum(f.positive for f in frames)
    print(f"[12c eval] {len(frames)} frames ({n_pos} with fire or smoke); "
          f"{len(frames) * len(args.prompts)} image requests (≈ ${len(frames) * len(args.prompts) * 0.0025:.2f} uncached)")
    key = _key_once()
    scores = []
    for i, f in enumerate(frames):
        best: dict[str, float] = {}
        for prompt in args.prompts:
            cls = prompt if prompt in CLASSES else None
            res = _parse(segment(f.path, prompt, f"img_{prompt}", False, key), False)
            for r in res.records:
                if r.kind == "box" and cls:
                    c = 1.0 if r.confidence is None else r.confidence
                    best[cls] = max(best.get(cls, 0.0), c)
        scores.append(best)
        if (i + 1) % 25 == 0:
            print(f"  {i + 1}/{len(frames)}")
    result = frame_scores(frames, scores, args.threshold)
    a = result["any"]
    print(f"  SAM 3.1: precision {a['precision']}  recall {a['recall']}  f1 {a['f1']}")
    _merge_eval({
        "metric": "frame-level fire-or-smoke detection",
        "precision": a["precision"], "recall": a["recall"], "f1": a["f1"],
        "n": len(frames), "n_positive": n_pos,
        "dataset": {"kind": args.dataset, "name": args.name or args.root.name, "sample": args.sample, "seed": 0},
        "prompts": args.prompts, **result, "sweep": sweep(frames, scores),
        "method": (f"SAM 3.1 (Meta Model API, image mode) prompted with {', '.join(args.prompts)} on the same "
                   f"stratified sample as Sentinel's eval. A frame counts as a detection when any returned box has "
                   f"confidence ≥ {args.threshold} (no confidence returned counts as 1)."),
        "date": today(),
    })


def _merge_eval(patch: dict) -> None:
    path = load_fire(FIRE_IDS[0]).out_dir / "eval" / "sam_video.json"
    current = json.loads(path.read_text()) if path.exists() else {}
    current.update(patch)
    current.setdefault("date", today())
    write_all_fires("eval/sam_video.json", current)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("masks", help="SAM 3.1 masks for every clip in footage/clips.json")
    m.add_argument("--mode", choices=["text", "sentinel"], default="text")
    e = sub.add_parser("eval", help="frame-level precision/recall on labelled frames (image mode)")
    e.add_argument("--dataset", choices=["flame2", "folder", "csv"], required=True)
    e.add_argument("--root", type=Path, required=True)
    e.add_argument("--name")
    e.add_argument("--sample", type=int, default=200)
    e.add_argument("--threshold", type=float, default=0.25)
    for p in (m, e):
        p.add_argument("--prompts", nargs="+", default=list(CLASSES))
    args = ap.parse_args()
    cmd_masks(args) if args.cmd == "masks" else cmd_eval(args)


if __name__ == "__main__":
    main()
