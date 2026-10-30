"""Thursday checkpoint: prove both Meta models answer a real request.

  1. muse-spark-1.3 calls a tool and uses its result (Chat Completions via the OpenAI SDK).
  2. sam-3.1 returns boxes and masks for a text prompt on an image and/or a video
     (Responses API, streamed, parsed with Meta's meta-sam-parser).

Needs MODEL_API_KEY in the environment or in the repo-root .env (see .env.example).
Costs: one short chat exchange; SAM is $2.50/1k images and $0.20/1k frames (50-frame minimum).

Run from pipeline/:
  make smoke-meta                                       # tool-calling test only
  make smoke-meta ARGS="--image fire.jpg"               # + SAM on an image
  make smoke-meta ARGS="--video clip.mp4 --prompt smoke"  # + SAM on a video (MP4/MOV, H.264/H.265)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import mimetypes
import os
import sys
from pathlib import Path

import requests
from openai import OpenAI

from ember.config import REPO_DIR, WORK_DIR

BASE_URL = "https://api.meta.ai/v1"
CHAT_MODEL = "muse-spark-1.3"
SAM_MODEL = "sam-3.1"
OUT_DIR = WORK_DIR / "smoke"


def load_key() -> str:
    key = os.environ.get("MODEL_API_KEY", "").strip()
    env = REPO_DIR / ".env"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("MODEL_API_KEY="):
                key = line.split("=", 1)[1].strip().strip("'\"")
    if not key:
        raise SystemExit("MODEL_API_KEY is not set (environment or repo-root .env). See .env.example.")
    return key


# ------------------------------------------------------------------ 1. tool calling

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "arrival_at",
            "description": "Hours after the replay start when the fire reached a point. Returns burned=false if it never did.",
            "parameters": {
                "type": "object",
                "properties": {"lat": {"type": "number"}, "lon": {"type": "number"}},
                "required": ["lat", "lon"],
            },
        },
    }
]
CANNED = {"burned": True, "hours_after_start": 7.5, "note": "smoke-test value, not real data"}


def test_tool_calling(key: str) -> bool:
    client = OpenAI(api_key=key, base_url=BASE_URL)
    messages: list[dict] = [
        {"role": "system", "content": "Answer questions about a wildfire only by calling tools. Never guess."},
        {"role": "user", "content": "How many hours after the start did the fire reach 34.19, -118.13? One sentence."},
    ]
    first = client.chat.completions.create(model=CHAT_MODEL, messages=messages, tools=TOOLS)
    msg = first.choices[0].message
    if not msg.tool_calls:
        print(f"  FAIL  {CHAT_MODEL} answered without calling the tool: {msg.content!r}")
        return False
    call = msg.tool_calls[0]
    print(f"  tool call: {call.function.name}({call.function.arguments})")
    messages.append(msg.model_dump(exclude_none=True))
    messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(CANNED)})
    second = client.chat.completions.create(model=CHAT_MODEL, messages=messages, tools=TOOLS)
    answer = second.choices[0].message.content or ""
    ok = "7.5" in answer or "7½" in answer
    print(f"  answer: {answer.strip()}")
    print(f"  {'PASS' if ok else 'CHECK'}  {CHAT_MODEL} {'used' if ok else 'may not have used'} the tool result")
    return ok


# ------------------------------------------------------------------ 2. SAM 3.1


def data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def upload_file(key: str, path: Path) -> str:
    with path.open("rb") as fh:
        r = requests.post(
            f"{BASE_URL}/files",
            headers={"Authorization": f"Bearer {key}"},
            files={"file": (path.name, fh)},
            data={"purpose": "user_data"},
            timeout=300,
        )
    r.raise_for_status()
    return r.json()["id"]


async def sse_events(key: str, body: dict):
    """Yield Responses API events (dicts) from a streamed request."""
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    with requests.post(f"{BASE_URL}/responses", headers=headers, json=body, stream=True, timeout=900) as r:
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:500]}")
        for line in r.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            yield json.loads(payload)


async def run_sam(key: str, media_part: dict, prompt: str, video: bool, tag: str) -> bool:
    from meta_sam_parser import (
        decode_mask_to_raster,
        image_segmentation_format,
        parse_responses_stream,
        video_segmentation_format,
    )

    body = {
        "model": SAM_MODEL,
        "input": [{"type": "message", "role": "user",
                   "content": [{"type": "input_text", "text": prompt}, media_part]}],
        "stream": True,
        "metadata": {"include_confidence": "true"},
    }
    fmt = video_segmentation_format() if video else image_segmentation_format()
    result = await parse_responses_stream(sse_events(key, body), fmt).final_result()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"sam_{tag}.txt").write_text(result.raw_output)
    boxes = [r for r in result.records if r.kind == "box"]
    masks = [r for r in result.records if r.kind == "mask"]
    objects = {r.object_id for r in boxes}
    frames = {r.frame.frame_index for r in boxes if r.frame is not None}
    print(f"  {len(boxes)} boxes, {len(masks)} masks, {len(objects)} objects"
          + (f", {len(frames)} frames" if video else ""))
    for m in masks[:3]:
        raster = decode_mask_to_raster(m.mask)
        filled = sum(raster) / max(len(raster), 1)
        conf = f", c={m.confidence:.2f}" if m.confidence is not None else ""
        print(f"    object {m.object_id}: mask {m.mask.width}×{m.mask.height}, {filled:.0%} filled{conf}")
    for d in result.diagnostics[:5]:
        print(f"    diagnostic: {d}")
    print(f"  raw output → {OUT_DIR / f'sam_{tag}.txt'}")
    ok = bool(boxes)
    print(f"  {'PASS' if ok else 'CHECK'}  {SAM_MODEL} {'found' if ok else 'found nothing for'} '{prompt}'")
    return ok


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", type=Path, help="local image to segment (sent as a data URL)")
    ap.add_argument("--video", type=Path, help="local MP4/MOV clip to segment (uploaded via the Files API)")
    ap.add_argument("--prompt", default="fire", help="short noun phrase for SAM (default: fire)")
    ap.add_argument("--skip-chat", action="store_true", help="skip the tool-calling test")
    args = ap.parse_args()

    key = load_key()
    results: dict[str, bool] = {}
    if not args.skip_chat:
        print(f"[1] {CHAT_MODEL} tool calling")
        results["tool_calling"] = test_tool_calling(key)
    if args.image:
        print(f"[2a] {SAM_MODEL} on image {args.image.name}")
        part = {"type": "input_image", "image_url": data_url(args.image)}
        results["sam_image"] = asyncio.run(run_sam(key, part, args.prompt, False, "image"))
    if args.video:
        print(f"[2b] {SAM_MODEL} on video {args.video.name}")
        part = {"type": "input_video", "file_id": upload_file(key, args.video)}
        results["sam_video"] = asyncio.run(run_sam(key, part, args.prompt, True, "video"))
    if not (args.image or args.video):
        print("[2] SAM skipped: pass --image and/or --video")

    print("\nsummary:", ", ".join(f"{k}={'ok' if v else 'check'}" for k, v in results.items()) or "nothing run")
    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    main()
