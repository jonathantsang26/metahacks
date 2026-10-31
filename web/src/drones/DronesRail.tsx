import type {FireData} from '../data/fire';
import {useFireJson} from '../data/files';
import {Button, Card, Chip, Missing, Row, Stat, SubHead} from '../rail/ui';
import {Icon} from '../ui/Icon';
import {fmtClock, fmtPct, useClipOverlays, useClips, useFootage, useSelectedClip, type Clip, type DetectorEval} from './footage';

function ClipRow({clip, active, onClick}: {clip: Clip; active: boolean; onClick: () => void}) {
  const length = clip.window_s ? clip.window_s[1] - clip.window_s[0] : null;
  return (
    <li>
      <button
        onClick={onClick}
        className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${active ? 'bg-selected' : 'hover:bg-tabgroup'}`}
      >
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${active ? 'bg-accent text-white' : 'bg-tabgroup text-ink'}`}>
          <Icon name="drone" size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{clip.title}</span>
          <span className="block truncate text-xs text-muted">{clip.note}</span>
        </span>
        {length !== null && <span className="shrink-0 text-xs tabular-nums text-muted">{fmtClock(length)}</span>}
      </button>
    </li>
  );
}

function ClipDetail({fire, clip}: {fire: FireData; clip: Clip}) {
  const {detections, masks} = useClipOverlays(fire, clip);
  const {expanded, setExpanded} = useFootage();
  const objects = masks ? new Set(masks.map(m => m.object_id)).size : null;
  const length = clip.window_s ? clip.window_s[1] - clip.window_s[0] : null;
  return (
    <Card title={clip.title} aside={<Chip tone={clip.publish ? 'real' : 'muted'}>{clip.publish ? 'OUR FOOTAGE' : 'NOT THIS FIRE'}</Chip>}>
      <div className="grid grid-cols-3 gap-x-3 gap-y-2 px-3 py-2">
        <Stat label="Length" value={length !== null ? fmtClock(length) : '–'} sub={clip.window_s ? `from ${fmtClock(clip.window_s[0])}` : undefined} />
        <Stat label="Frame rate" value={clip.fps.toFixed(0)} sub="fps" />
        <Stat label="Frame" value={`${clip.width}×${clip.height}`} sub="px" />
        <Stat label="Sentinel boxes" value={detections ? detections.length.toLocaleString() : '…'} sub={clip.sentinel ? `${clip.sentinel.fps} fps · ≥ ${clip.sentinel.conf}` : undefined} />
        <Stat label="SAM objects" value={objects ?? '…'} sub={masks ? `${masks.length.toLocaleString()} masks` : undefined} />
        <Stat label="Weights" value={<span className="text-sm">{clip.sentinel?.weights.replace('.pt', '') ?? '–'}</span>} />
      </div>
      <div className="pb-2">
        <Row k="Source" v={clip.source} />
        <Row k="Window" v="Busiest 30 s for Sentinel, sent to SAM 3.1" />
      </div>
      <div className="flex gap-2 px-3 pb-3">
        <Button primary onClick={() => setExpanded(!expanded)}>
          ⤢ {expanded ? 'Back to PiP' : 'Full camera view'}
        </Button>
      </div>
    </Card>
  );
}

function Metric({label, e}: {label: string; e: {precision: number | null; recall: number | null; f1: number} | undefined}) {
  return (
    <div className="grid grid-cols-[1fr_repeat(3,44px)] items-baseline gap-1 px-3 py-[3px] text-sm">
      <span className="truncate">{label}</span>
      <span className="text-right tabular-nums">{fmtPct(e?.precision)}</span>
      <span className="text-right tabular-nums">{fmtPct(e?.recall)}</span>
      <span className="text-right tabular-nums">{e ? e.f1.toFixed(2) : '–'}</span>
    </div>
  );
}

/** Steps 12b and 12c: frame-level precision and recall for Sentinel (shipped and fine-tuned) and SAM 3.1. */
function EvalCard({fire}: {fire: FireData}) {
  const sentinel = useFireJson<DetectorEval>(fire, 'eval/sentinel.json');
  const sam = useFireJson<DetectorEval>(fire, 'eval/sam_video.json');
  const s = sentinel.data;
  return (
    <Card title="Detector Evaluation" aside={<Chip tone="real">REAL</Chip>}>
      {!s ? (
        <Missing file="eval/sentinel.json" error={sentinel.error} />
      ) : (
        <>
          <div className="px-3 pt-2 text-xs text-muted">
            {s.dataset.name} · {s.n.toLocaleString()} frames ({s.n_positive.toLocaleString()} with fire or smoke) · fire-or-smoke, conf ≥ {s.threshold}
          </div>
          <div className="grid grid-cols-[1fr_repeat(3,44px)] gap-1 px-3 pt-2 text-2xs text-muted">
            <span />
            <span className="text-right">Precision</span>
            <span className="text-right">Recall</span>
            <span className="text-right">F1</span>
          </div>
          {s.baseline && <Metric label={`Sentinel as shipped`} e={s.baseline.any} />}
          <Metric label={s.weights?.training ? 'Sentinel fine-tuned' : 'Sentinel'} e={s.any} />
          {sam.data?.any && <Metric label="SAM 3.1" e={sam.data.any} />}
          {sam.data?.any && sam.data.dataset.name !== s.dataset.name && (
            <div className="px-3 text-2xs text-muted">SAM 3.1 scored on {sam.data.dataset.name} ({sam.data.n} frames)</div>
          )}
          <SubHead>Notes</SubHead>
          <ul className="list-disc space-y-1 py-2 pl-7 pr-3 text-xs text-muted">
            {s.baseline && s.baseline.weights.fire_classes.length === 0 && (
              <li>Sentinel's shipped weights are the stock COCO YOLOv8n with no fire or smoke class, so they detect nothing.</li>
            )}
            {s.weights?.training && (
              <li>
                Fine-tuned from those weights for {s.weights.training.epochs} epochs on public fire boxes (val mAP50{' '}
                {s.weights.training.val.map50.toFixed(2)}).
              </li>
            )}
            {s.weights?.fire_classes.includes('smoke') && s.smoke.tp === 0 && (
              <li>Smoke recall is {fmtPct(s.smoke.recall)}: the training boxes are flame only, so smoke-only frames are missed.</li>
            )}
            {s.dataset.kind !== 'flame2' && <li>The test frames are ground-level photos, not drone footage.</li>}
            <li>Frame-level scores: a frame counts as detected when any box clears the threshold. The labels have no boxes.</li>
          </ul>
        </>
      )}
    </Card>
  );
}

/** Drones tab rail: the processed clips, the selected clip's detail, and the detector evaluation. */
export function DronesRail({fire}: {fire: FireData}) {
  const clips = useClips(fire);
  const clip = useSelectedClip(fire);
  const {clipId, select} = useFootage();
  return (
    <>
      <Card title="Drone Footage" aside={clips.data && <span className="text-xs text-muted">{clips.data.length} clips</span>}>
        {!clips.data ? (
          clips.error ? (
            <div className="px-3 py-4 text-sm text-muted">
              No footage has been processed for this build yet. Pipeline steps 12 (Sentinel) and 12c (SAM 3.1) write
              <span className="font-mono text-xs"> footage/clips.json</span>.
            </div>
          ) : (
            <Missing file="footage/clips.json" error={null} />
          )
        ) : (
          <>
            {!clip && (
              <div className="px-3 pt-2 text-xs text-muted">
                Select a clip to open its camera view. Boxes come from Sentinel (YOLOv8), masks from SAM 3.1.
              </div>
            )}
            <ul className="py-1">
              {clips.data.map(c => (
                <ClipRow key={c.id} clip={c} active={c.id === clipId} onClick={() => select(c.id === clipId ? null : c.id)} />
              ))}
            </ul>
          </>
        )}
      </Card>
      {clip && <ClipDetail fire={fire} clip={clip} />}
      <EvalCard fire={fire} />
    </>
  );
}
