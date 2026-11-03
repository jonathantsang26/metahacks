from pathlib import Path

from steps.s12_footage import LabelledFrame, fire_class_ids, frame_scores, load_csv, load_folder, prf, stratified_sample
from steps.s12_sentinel import busiest_window
from steps.s12c_sam_video import agreement


def test_prf_counts():
    m = prf([True, True, False, False], [True, False, True, False])
    assert (m["tp"], m["fp"], m["fn"], m["tn"]) == (1, 1, 1, 1)
    assert m["precision"] == 0.5 and m["recall"] == 0.5 and m["f1"] == 0.5


def test_prf_no_predictions_has_no_precision():
    m = prf([False, False], [True, False])
    assert m["precision"] is None and m["recall"] == 0.0 and m["f1"] == 0.0


def test_coco_model_has_no_fire_class():
    coco = {0: "person", 10: "fire hydrant", 79: "toothbrush"}
    assert fire_class_ids(coco) == {}
    assert fire_class_ids({0: "fire", 1: "smoke"}) == {0: "fire", 1: "smoke"}


def test_frame_scores_per_class():
    frames = [LabelledFrame(Path("a"), True, False), LabelledFrame(Path("b"), False, True), LabelledFrame(Path("c"), False, False)]
    scores = [{"fire": 0.9}, {"fire": 0.3}, {}]
    out = frame_scores(frames, scores, 0.25)
    assert out["any"]["recall"] == 1.0 and out["any"]["precision"] == 1.0
    # The smoke frame was found, but as fire: right for "any", wrong for each class.
    assert out["fire"]["fp"] == 1 and out["smoke"]["fn"] == 1


def test_load_folder_and_csv(tmp_path):
    for cls in ("Fire", "Smoke", "Neutral"):
        (tmp_path / "Test" / cls).mkdir(parents=True)
        (tmp_path / "Test" / cls / "1.jpg").write_bytes(b"")
    frames = {f.path.parent.name: f for f in load_folder(tmp_path)}
    assert frames["Fire"].fire and not frames["Fire"].smoke
    assert frames["Smoke"].smoke and not frames["Smoke"].fire
    assert not frames["Neutral"].positive

    (tmp_path / "labels.csv").write_text("path,fire,smoke\nx.jpg,Y,N\ny.jpg,0,1\n")
    rows = load_csv(tmp_path / "labels.csv")
    assert [(r.fire, r.smoke) for r in rows] == [(True, False), (False, True)]


def test_stratified_sample_keeps_mix_and_repeats():
    frames = [LabelledFrame(Path(f"{i}"), i < 30, False) for i in range(100)]
    a = stratified_sample(frames, 10)
    assert len(a) == 10 and sum(f.positive for f in a) == 3
    assert a == stratified_sample(frames, 10)


def test_busiest_window_picks_most_detections():
    fps = 10.0
    dets = [{"frame": int(t * fps)} for t in range(70, 90)]
    start, length = busiest_window(dets, fps, n_frames=int(120 * fps))
    assert length == 30.0 and start <= 70 and start + length >= 89
    assert busiest_window(dets, fps, n_frames=200) == (0.0, 20.0)


def test_agreement_counts_overlaps_on_sam_frames():
    dets = [{"frame": 0, "box": [0, 0, 10, 10]}, {"frame": 0, "box": [50, 50, 60, 60]}, {"frame": 5, "box": [0, 0, 1, 1]}]
    masks = [{"frame": 0, "bounds": [1, 1, 11, 11]}]
    out = agreement(dets, masks)
    assert out == {"sentinel_boxes": 3, "on_sam_frames": 2, "overlapped_by_sam": 1, "share": 0.5}
