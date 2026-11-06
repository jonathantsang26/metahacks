/**
 * Small primitives in the Meta build's rail style (web/src/rail/ui.tsx, DESIGN.md §5): warm paper
 * cards, hairline borders, mono status chips, one red-orange accent. Colours are local CSS
 * variables so these panels look right whether or not the ported Meta tokens are loaded.
 */
import type {CSSProperties, ReactNode} from 'react';
import {cn} from '@/lib/utils';

export const PLAN_VARS = {
  '--pl-card': '#dedace',
  '--pl-section': '#d3ccbc',
  '--pl-tab': '#d1cebf',
  '--pl-tab-active': '#f2efe6',
  '--pl-selected': '#dccabc',
  '--pl-ink': '#29251a',
  '--pl-muted': '#6f6858',
  '--pl-hair': 'rgba(41, 37, 26, 0.12)',
  '--pl-hair-strong': 'rgba(41, 37, 26, 0.22)',
  '--pl-accent': '#d1654b',
  '--pl-live': '#b53536',
  '--pl-ok': '#55703f',
  '--pl-ok-bg': '#dce3cf',
  '--pl-hud': 'rgba(39, 35, 26, 0.92)'
} as CSSProperties;

export const ACCENT_RGB: [number, number, number] = [209, 101, 75];

export function Card({title, aside, children, className = ''}: {title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string | undefined}) {
  return (
    <section style={PLAN_VARS} className={`overflow-hidden rounded-md bg-[var(--pl-card)] text-[13px] leading-[18px] text-[var(--pl-ink)] shadow-[0_0_0_1px_var(--pl-hair)] ${className}`}>
      <div className="flex items-center justify-between gap-2 bg-[var(--pl-section)] px-3 py-2">
        <h2 className="min-w-0 truncate text-[13px] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Small-caps label above a number or list. */
export function Label({children, className = ''}: {children: ReactNode; className?: string}) {
  return <div className={`text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--pl-muted)] ${className}`}>{children}</div>;
}

const TONES = {
  ok: 'bg-[var(--pl-ok-bg)] text-[var(--pl-ok)]',
  modeled: 'bg-[var(--pl-tab)] text-[var(--pl-ink)]',
  live: 'bg-[var(--pl-selected)] text-[var(--pl-live)]',
  accent: 'bg-[var(--pl-accent)] text-white',
  muted: 'bg-[var(--pl-tab)] text-[var(--pl-muted)]',
  /** Outlined honesty tag: the default for MODELED / CACHED / SIM (at most once per card). */
  ghost: 'text-[var(--pl-muted)] shadow-[inset_0_0_0_1px_var(--pl-hair-strong)]'
} as const;

/** Status chip: SIM / CACHED / MODELED / APPROVED. */
export function Chip({tone = 'modeled', children, title}: {tone?: keyof typeof TONES; children: ReactNode; title?: string}) {
  return (
    <span title={title} className={`inline-block shrink-0 rounded px-1.5 font-mono text-[10px] leading-[16px] ${TONES[tone]}`}>
      {children}
    </span>
  );
}

const BTN_VARIANTS = {
  /** The one accent control on screen (the current guide step's button). */
  accent: 'bg-[var(--pl-accent)] text-white hover:opacity-90',
  /** Outlined paper button. */
  plain: 'bg-[var(--pl-tab-active)] text-[var(--pl-ink)] shadow-[0_0_0_1px_var(--pl-hair)] hover:bg-white',
  /** Text-only, for secondary actions. */
  quiet: 'text-[var(--pl-muted)] hover:bg-[var(--pl-tab-active)]/70 hover:text-[var(--pl-ink)]'
} as const;

export type BtnVariant = keyof typeof BTN_VARIANTS;

export function Btn({
  onClick,
  children,
  primary,
  variant,
  disabled,
  title,
  className = '',
  type = 'button'
}: {
  onClick?: () => void;
  children: ReactNode;
  /** Shorthand for variant="accent". */
  primary?: boolean;
  variant?: BtnVariant;
  disabled?: boolean;
  title?: string;
  className?: string;
  type?: 'button' | 'submit';
}) {
  const v = variant ?? (primary ? 'accent' : 'plain');
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] font-medium transition-[opacity,background-color] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--pl-accent)] disabled:cursor-not-allowed disabled:opacity-45',
        BTN_VARIANTS[v],
        className
      )}
    >
      {children}
    </button>
  );
}

/** "agent" / "you" marker for who made a change. */
export function ByChip({by}: {by: 'agent' | 'person' | null}) {
  if (!by) return null;
  return (
    <Chip tone="ghost" title={by === 'agent' ? 'Last changed by the agent' : 'Last changed by a person in this app'}>
      {by === 'agent' ? 'AGENT' : 'PERSON'}
    </Chip>
  );
}

/** The per-row "agent" / "you" word: quieter than a chip, same meaning. */
export function ByWord({by}: {by: 'agent' | 'person' | null}) {
  if (!by) return null;
  return (
    <span className="shrink-0 text-[10px] leading-[16px] text-[var(--pl-muted)]" title={by === 'agent' ? 'Last changed by the agent' : 'Last changed by a person in this app'}>
      {by === 'agent' ? 'agent' : 'you'}
    </span>
  );
}

export function Spinner({className = ''}: {className?: string}) {
  return <span aria-hidden className={`inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent ${className}`} />;
}
