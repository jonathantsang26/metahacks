/** Minimal stroke icons for the chrome. Paths are 24×24, drawn with currentColor. */
const PATHS: Record<string, string> = {
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
  drone: 'M6 6h.01M18 6h.01M6 18h.01M18 18h.01M8 8l3 3m5-3-3 3m-5 5 3-3m5 3-3-3M10 10h4v4h-4zM6 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm12 0a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM6 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm12 0a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
  truck: 'M3 7h11v9H3zm11 3h4l3 3v3h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4m8-4v4',
  chart: 'M4 20h16M7 16v-5m4 5V8m4 8v-3m4 3V6',
  share: 'M8.6 13.5 15.4 17.5M15.4 6.5 8.6 10.5M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  chevron: 'm6 9 6 6 6-6',
  play: 'M7 5v14l11-7z',
  pause: 'M7 5h4v14H7zm6 0h4v14h-4z',
  stepFwd: 'M6 5v14l9-7zm11 0v14',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5m11-5v5h-5',
  plus: 'M12 5v14M5 12h14',
  dots: 'M12 6h.01M12 12h.01M12 18h.01'
};

export function Icon({name, size = 16, className = ''}: {name: keyof typeof PATHS | string; size?: number; className?: string}) {
  const d = PATHS[name];
  const filled = name === 'play' || name === 'pause' || name === 'stepFwd';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

/** Our own mark (not the reference's logo): an ember over a ridge line. */
export function Logo({size = 26}: {size?: number}) {
  return (
    <svg width={size} height={size * 0.75} viewBox="0 0 32 24" aria-hidden>
      <path d="M1 22 L11 11 L16 16 L22 8 L31 22 Z" fill="#7c5a43" />
      <path d="M16 4 C18 7 21 8.5 21 12 A5 5 0 0 1 11 12 C11 9.5 13 9 13.5 6.5 C14.5 8 15.2 8.4 16 4 Z" fill="var(--accent)" />
    </svg>
  );
}
