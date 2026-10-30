import type {ReactNode} from 'react';

/** Card with a title row (DESIGN.md §5). */
export function Card({title, aside, children}: {title: ReactNode; aside?: ReactNode; children: ReactNode}) {
  return (
    <section className="mx-2 mt-2 overflow-hidden rounded-md bg-card shadow-[0_0_0_1px_var(--hairline)]">
      <div className="flex items-center justify-between bg-section px-3 py-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Pending({children}: {children: ReactNode}) {
  return <div className="px-3 py-6 text-center text-sm text-muted">{children}</div>;
}

/** The honest empty state for one panel whose file is missing or failed to load. */
export function Missing({file, error}: {file: string; error: string | null}) {
  return (
    <div className="px-3 py-4 text-center text-sm text-muted">
      {error ? (
        <>
          <span className="font-mono text-xs">{file}</span> is not available
          <div className="mt-0.5 font-mono text-2xs">{error}</div>
        </>
      ) : (
        <>Loading {file}…</>
      )}
    </div>
  );
}

export function Row({k, v}: {k: string; v: ReactNode}) {
  return (
    <div className="flex gap-3 px-3 py-[3px] text-sm">
      <span className="w-[104px] shrink-0 text-muted">{k}</span>
      <span className="min-w-0 flex-1">{v}</span>
    </div>
  );
}

const TONES = {
  real: 'bg-okbg text-ok',
  modeled: 'bg-tabgroup text-ink',
  live: 'bg-selected text-live',
  muted: 'bg-tabgroup text-muted'
} as const;

/** Small status chip (REAL / MODELED / outcome). */
export function Chip({tone, children}: {tone: keyof typeof TONES; children: ReactNode}) {
  return <span className={`inline-block rounded px-1.5 font-mono text-2xs ${TONES[tone]}`}>{children}</span>;
}

/** Sub-section heading inside a rail sub-tab. */
export function SubHead({children, aside}: {children: ReactNode; aside?: ReactNode}) {
  return (
    <div className="flex items-center justify-between border-b border-hairline px-3 pb-1 pt-3">
      <h3 className="text-sm font-semibold">{children}</h3>
      {aside}
    </div>
  );
}

/** One cell of a stat grid, like the drone detail grid (DESIGN.md §5.2). */
export function Stat({label, value, sub, tone}: {label: string; value: ReactNode; sub?: ReactNode; tone?: 'live'}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${tone === 'live' ? 'text-live' : ''}`}>{value}</div>
      {sub && <div className="text-2xs text-muted">{sub}</div>}
    </div>
  );
}

export function Button({onClick, children, primary, disabled, title}: {
  onClick: () => void;
  children: ReactNode;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md px-2.5 py-1 text-sm font-medium disabled:opacity-45 ${
        primary ? 'bg-accent text-white' : 'bg-card text-ink shadow-[0_0_0_1px_var(--hairline)]'
      }`}
    >
      {children}
    </button>
  );
}
