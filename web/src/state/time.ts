import {create} from 'zustand';

/** Fire-time hours advanced per wall-clock second at 1×. */
const HOURS_PER_SECOND = 2;
export const SPEEDS = [1, 2, 4, 8] as const;

type TimeState = {
  /** Replay window, epoch ms (UTC). */
  start: number;
  end: number;
  /** The one global time every panel reads (BUILD.md §3). */
  t: number;
  playing: boolean;
  speed: (typeof SPEEDS)[number];
  setRange: (start: number, end: number) => void;
  setTime: (t: number) => void;
  toggle: () => void;
  step: () => void;
  setSpeed: (speed: (typeof SPEEDS)[number]) => void;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const useTime = create<TimeState>((set, get) => ({
  start: 0,
  end: 1,
  t: 0,
  playing: false,
  speed: 1,
  setRange: (start, end) => set({start, end, t: start}),
  setTime: t => set({t: clamp(t, get().start, get().end)}),
  toggle: () => {
    const {playing, t, end, start} = get();
    // Pressing play at the end restarts the replay.
    set({playing: !playing, t: !playing && t >= end ? start : t});
  },
  step: () => {
    const {t, end} = get();
    set({t: Math.min(end, t + 3600_000), playing: false});
  },
  setSpeed: speed => set({speed})
}));

/** Normalized replay position in [0, 1]. */
export const useProgress = () =>
  useTime(s => (s.end > s.start ? (s.t - s.start) / (s.end - s.start) : 0));

let raf = 0;
let last = 0;

/** Starts the playback loop once; safe to call from an effect. */
export function startClock(): () => void {
  const tick = (now: number) => {
    const s = useTime.getState();
    if (s.playing && last) {
      const dt = (now - last) / 1000;
      const next = s.t + dt * HOURS_PER_SECOND * s.speed * 3600_000;
      if (next >= s.end) useTime.setState({t: s.end, playing: false});
      else useTime.setState({t: next});
    }
    last = now;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
