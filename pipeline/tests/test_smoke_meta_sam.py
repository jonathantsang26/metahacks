"""Offline test of the SAM 3.1 request and parse path in tools/smoke_meta.py.

It drives the real `run_sam` and Meta's real `meta_sam_parser` over a fixture event stream, as
web/api/_tests/model.test.ts drives the real Muse Spark client over a recorded transport. No
network, no key.

SYNTHETIC FIXTURE: the `sam-3.1` streams below were written by hand to the documented schema. They
are not recorded live responses, and no model produced any of them. Sources:
  * Meta's SAM 3.1 client-library docs, https://dev.meta.ai/docs/sam/client-libraries: the docs
    page for meta-models/meta-sam, which holds meta-sam-parser and the protocol it implements.
  * The SAM 3 protocol, https://github.com/meta-models/meta-sam/blob/main/protocol/sam3.md. It gives
    the output-text line grammar (`<Nf>id<|box;...|><|mask;...|>`) and the base85 mask payload. It
    also gives the stream rules: one output_text lane named by `item_id`, `output_index` and
    `content_index`, finalized by `response.content_part.done` (an `output_text` part) or
    `response.output_text.done`, then `response.completed`. MASK below is the protocol's own 5x5
    one_bit example.
  * The event envelope (`response.created` through `response.completed`, each with a
    `sequence_number`) is the OpenAI-compatible Responses API streaming schema. meta-sam-parser's
    README says the live SAM API finalizes the lane with `response.content_part.done` only, so the
    fixture never sends `response.output_text.done`.
The fixture claims nothing about the live API beyond those documents. In particular, whether the
live API streams text deltas is not assumed: the main case runs both with and without them.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from meta_sam_parser import (
    ResponsesStreamEventError,
    ResponsesStreamFailedError,
    ResponsesStreamLaneError,
    ResponsesStreamSourceError,
    decode_mask_to_raster,
    image_segmentation_format,
    parse_responses_stream,
    video_segmentation_format,
)

from tools import smoke_meta

RESPONSE_ID = "resp_synthetic_fixture"
ITEM_ID = "msg_synthetic_fixture"
LANE = {"item_id": ITEM_ID, "output_index": 0, "content_index": 0}

MASK = "!!!!!(QO(0lu8?"  # the protocol's 5x5 one_bit example
MASK_ROWS = ["#..#.", "..##.", ".....", "#.###", "#...#"]  # what it decodes to, row-major

# One image frame, two objects (ids need not be dense). Box corners are inclusive on the wire.
IMAGE_TEXT = (
    f"<0f>0<|box;x1=120;y1=40;x2=279;y2=199;w=640;h=480;c=0.91|><|mask;x=0;y=0;c=0.91;data=5,5,{MASK}|>"
    f",3<|box;x1=300;y1=200;x2=304;y2=204;w=640;h=480;c=0.62|><|mask;x=0;y=0;c=0.62;data=5,5,{MASK}|>\n"
)
# One object tracked over two video frames; frames with nothing visible emit no line, so 1-3 are absent.
VIDEO_TEXT = (
    f"<0f>2<|box;x1=10;y1=20;x2=89;y2=69;w=320;h=240;c=0.80|><|mask;x=0;y=0;c=0.80;data=5,5,{MASK}|>\n"
    f"<4f>2<|box;x1=14;y1=18;x2=93;y2=67;w=320;h=240;c=0.77|><|mask;x=0;y=0;c=0.77;data=5,5,{MASK}|>\n"
)
IMAGE_PART = {"type": "input_image", "image_url": "data:image/jpeg;base64,AAAA"}
VIDEO_PART = {"type": "input_video", "file_id": "file_synthetic_fixture"}


def sam_stream(text: str, delta_size: int | None = 7, *, terminal: dict | None = None) -> list[dict]:
    """A synthetic sam-3.1 Responses stream that returns `text` in one output_text lane.

    `delta_size` splits the text into deltas of that many characters, so chunks break inside tokens
    and mask payloads; None sends no deltas, and the finished part carries the whole text.
    `terminal` replaces the closing `response.completed` event.
    """
    response = {"id": RESPONSE_ID, "object": "response", "model": smoke_meta.SAM_MODEL, "status": "in_progress", "output": []}
    item = {"id": ITEM_ID, "type": "message", "role": "assistant", "status": "in_progress", "content": []}
    part = {"type": "output_text", "text": text, "annotations": []}
    done_item = {**item, "status": "completed", "content": [part]}
    deltas = [text[i:i + delta_size] for i in range(0, len(text), delta_size)] if delta_size else []
    events = [
        {"type": "response.created", "response": response},
        {"type": "response.in_progress", "response": response},
        {"type": "response.output_item.added", "output_index": 0, "item": item},
        {"type": "response.content_part.added", **LANE, "part": {**part, "text": ""}},
        *({"type": "response.output_text.delta", **LANE, "delta": d} for d in deltas),
        {"type": "response.content_part.done", **LANE, "part": part},
        {"type": "response.output_item.done", "output_index": 0, "item": done_item},
        terminal or {"type": "response.completed", "response": {**response, "status": "completed", "output": [done_item]}},
    ]
    return [{**e, "sequence_number": n} for n, e in enumerate(events)]


class Source:
    """Stands in for smoke_meta.sse_events: records what run_sam sends and yields fixture events."""

    def __init__(self, events: list[dict]):
        self.events = events
        self.sent: list[tuple[str, dict]] = []

    def __call__(self, key: str, body: dict):
        self.sent.append((key, body))
        return self._stream()

    async def _stream(self):
        for event in self.events:
            yield event


def run_sam(events, *, video: bool = False) -> bool:
    part = VIDEO_PART if video else IMAGE_PART
    return asyncio.run(smoke_meta.run_sam("test-key", part, "smoke", video, "test", events=events))


def parse(events: list[dict], *, video: bool = False):
    async def source():
        for event in events:
            yield event

    fmt = video_segmentation_format() if video else image_segmentation_format()

    async def final():
        return await parse_responses_stream(source(), fmt).final_result()

    return asyncio.run(final())


@pytest.fixture(autouse=True)
def offline(monkeypatch, tmp_path):
    """Raw output goes to tmp_path, and any real HTTP call fails the test."""

    def no_network(*args, **kwargs):
        raise AssertionError("tests must not call the network")

    monkeypatch.setattr(smoke_meta, "OUT_DIR", tmp_path)
    monkeypatch.setattr(smoke_meta, "requests", SimpleNamespace(post=no_network))


# ------------------------------------------------------------------ a successful stream


@pytest.mark.parametrize("delta_size", [7, None], ids=["deltas", "final-part-only"])
def test_parser_turns_the_image_stream_into_boxes_and_masks(delta_size):
    result = parse(sam_stream(IMAGE_TEXT, delta_size))

    assert result.outcome.status == "completed"
    assert result.diagnostics == ()
    assert result.raw_output == IMAGE_TEXT
    boxes = [r for r in result.records if r.kind == "box"]
    masks = [r for r in result.records if r.kind == "mask"]
    # Inclusive wire corners become half-open boxes; ids stay strings and keep their gaps.
    assert [(b.object_id, b.left, b.top, b.right, b.bottom, b.confidence, b.frame) for b in boxes] == [
        ("0", 120, 40, 280, 200, 0.91, None),
        ("3", 300, 200, 305, 205, 0.62, None),
    ]
    assert [m.object_id for m in masks] == ["0", "3"]
    for box, mask in zip(boxes, masks):
        assert (mask.mask.encoding, mask.mask.payload, mask.mask.width, mask.mask.height) == ("one_bit", MASK, 5, 5)
        bounds = mask.bounds
        assert (bounds.left, bounds.top, bounds.right, bounds.bottom) == (box.left, box.top, box.right, box.bottom)
        assert mask.confidence == box.confidence
        raster = decode_mask_to_raster(mask.mask)
        assert ["".join("#" if px else "." for px in raster[r * 5:(r + 1) * 5]) for r in range(5)] == MASK_ROWS


def test_run_sam_sends_the_sam_request_and_finds_smoke(tmp_path, capsys):
    source = Source(sam_stream(IMAGE_TEXT))

    assert run_sam(source) is True

    assert len(source.sent) == 1
    key, body = source.sent[0]
    assert key == "test-key"
    assert body == {
        "model": "sam-3.1",
        "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "smoke"}, IMAGE_PART]}],
        "stream": True,
        "metadata": {"include_confidence": "true"},
    }
    out = capsys.readouterr().out
    assert "2 boxes, 2 masks, 2 objects" in out
    assert "object 0: mask 5×5, 40% filled, c=0.91" in out
    assert "object 3: mask 5×5, 40% filled, c=0.62" in out
    assert "diagnostic" not in out
    assert "PASS  sam-3.1 found 'smoke'" in out
    assert (tmp_path / "sam_test.txt").read_text() == IMAGE_TEXT


def test_run_sam_tracks_one_object_across_video_frames(capsys):
    source = Source(sam_stream(VIDEO_TEXT))

    assert run_sam(source, video=True) is True

    assert source.sent[0][1]["input"][0]["content"][1] == VIDEO_PART
    out = capsys.readouterr().out
    assert "2 boxes, 2 masks, 1 objects, 2 frames" in out
    assert "PASS  sam-3.1 found 'smoke'" in out
    boxes = [r for r in parse(sam_stream(VIDEO_TEXT), video=True).records if r.kind == "box"]
    assert [(b.object_id, b.frame.frame_index) for b in boxes] == [("2", 0), ("2", 4)]


def test_a_completed_response_with_no_records_is_found_nothing(capsys):
    assert run_sam(Source(sam_stream(""))) is False

    out = capsys.readouterr().out
    assert "0 boxes, 0 masks, 0 objects" in out
    assert "CHECK  sam-3.1 found nothing for 'smoke'" in out


# ------------------------------------------------------------------ empty and malformed streams


@pytest.mark.parametrize(
    "events, why",
    [
        ([], "the stream ended with no response.completed event"),
        (sam_stream(IMAGE_TEXT)[:-1], "the stream ended with no response.completed event"),
        (
            sam_stream(IMAGE_TEXT, terminal={
                "type": "response.incomplete",
                "response": {"id": RESPONSE_ID, "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}},
            }),
            "max_output_tokens",
        ),
    ],
    ids=["empty", "truncated", "incomplete"],
)
def test_a_stream_that_does_not_complete_fails(events, why):
    with pytest.raises(RuntimeError, match=f"^sam-3.1 response did not complete: {why}$"):
        run_sam(Source(events))


def _drop_lane(event: dict) -> dict:
    return {k: v for k, v in event.items() if k not in LANE}


@pytest.mark.parametrize(
    "events, error, message",
    [
        (
            [e for e in sam_stream(IMAGE_TEXT)
             if e["type"] not in ("response.output_text.delta", "response.content_part.done")],
            ResponsesStreamLaneError, "The response completed before finalizing one output text lane.",
        ),
        (
            [_drop_lane(e) if e["type"] == "response.output_text.delta" else e for e in sam_stream(IMAGE_TEXT)],
            ResponsesStreamLaneError, "The output text event has an invalid lane identity.",
        ),
        (
            [e for e in sam_stream(IMAGE_TEXT) if e["sequence_number"] != 5],  # one delta lost
            ResponsesStreamLaneError, "The finalized output text conflicts with its accumulated deltas.",
        ),
        (
            [{"type": "response.failed", "response": {
                "id": RESPONSE_ID, "status": "failed", "error": {"code": "server_error", "message": "Segmentation failed."},
            }}],
            ResponsesStreamFailedError, "Segmentation failed.",
        ),
        (
            [{"type": "error", "code": "invalid_request_error", "message": "Unsupported media type."}],
            ResponsesStreamEventError, "Unsupported media type.",
        ),
    ],
    ids=["no-output-text", "no-lane-identity", "lost-delta", "response-failed", "error-event"],
)
def test_a_malformed_or_failed_stream_raises_a_typed_error(events, error, message):
    with pytest.raises(error) as raised:
        run_sam(Source(events))
    assert str(raised.value) == message


def test_malformed_records_are_reported_and_do_not_pass(capsys):
    text = (
        f"<0f>0<|box;x1=1;y1=1;x2=4;y2=4;w=640;h=480|><|mask;x=0;y=0;data=5,5,{MASK[:-1]}|>\n"  # truncated mask
        "<0f>1<|box;x1=8;y1=8;x2=12;y2=12;w=640;h=480|>\n"  # box with no mask
    )

    assert run_sam(Source(sam_stream(text))) is False

    out = capsys.readouterr().out
    assert "1 boxes, 0 masks" in out  # the record with a bad mask keeps its box and loses the mask
    assert "code='invalid_mask_payload'" in out
    assert "code='malformed_record'" in out
    assert "CHECK  sam-3.1 found 'smoke' (2 malformed lines)" in out


# ------------------------------------------------------------------ the HTTP and SSE layer


class FakeResponse:
    def __init__(self, lines: list[str], status_code: int = 200, text: str = ""):
        self.lines, self.status_code, self.text = lines, status_code, text

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def iter_lines(self, decode_unicode: bool = False):
        yield from self.lines


def sse_lines(events: list[dict]) -> list[str]:
    """The fixture events as server-sent-event lines, as requests.iter_lines() would return them."""
    lines = [": synthetic fixture, not a recorded sam-3.1 response", ""]
    for event in events:
        lines += [f"event: {event['type']}", f"data: {json.dumps(event)}", ""]
    return lines + ["data: [DONE]", ""]


def test_sse_events_posts_to_meta_and_reads_the_event_stream(monkeypatch, capsys):
    sent = []

    def post(url, **kwargs):
        sent.append((url, kwargs))
        return FakeResponse(sse_lines(sam_stream(IMAGE_TEXT)))

    monkeypatch.setattr(smoke_meta, "requests", SimpleNamespace(post=post))

    assert run_sam(smoke_meta.sse_events) is True

    assert len(sent) == 1
    url, kwargs = sent[0]
    assert url == "https://api.meta.ai/v1/responses"
    assert kwargs["headers"] == {
        "Authorization": "Bearer test-key",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    assert kwargs["json"]["model"] == "sam-3.1"
    assert kwargs["stream"] is True
    assert "PASS  sam-3.1 found 'smoke'" in capsys.readouterr().out


def test_a_done_marker_before_the_response_completes_fails(monkeypatch):
    lines = sse_lines(sam_stream(IMAGE_TEXT)[:-1])  # every event but response.completed, then [DONE]
    monkeypatch.setattr(smoke_meta, "requests", SimpleNamespace(post=lambda url, **kwargs: FakeResponse(lines)))

    why = "the stream ended with no response.completed event"
    with pytest.raises(RuntimeError, match=f"^sam-3.1 response did not complete: {why}$"):
        run_sam(smoke_meta.sse_events)


@pytest.mark.parametrize(
    "response, cause, message",
    [
        (FakeResponse([], status_code=401, text='{"error": {"message": "invalid api key"}}'),
         RuntimeError, 'HTTP 401: {"error": {"message": "invalid api key"}}'),
        (FakeResponse(["data: {not json"]), json.JSONDecodeError, "Expecting property name"),
    ],
    ids=["http-401", "bad-json"],
)
def test_a_transport_failure_raises_with_its_cause(monkeypatch, response, cause, message):
    monkeypatch.setattr(smoke_meta, "requests", SimpleNamespace(post=lambda url, **kwargs: response))

    with pytest.raises(ResponsesStreamSourceError) as raised:
        run_sam(smoke_meta.sse_events)
    assert isinstance(raised.value.__cause__, cause)
    assert str(raised.value.__cause__).startswith(message)
