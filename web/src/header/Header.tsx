import {useEffect, useRef, useState} from 'react';
import {FIRES, type FireData} from '../data/fire';
import {formatDate} from '../lib/format';
import {useTime} from '../state/time';
import {useUi, type Tab} from '../state/ui';
import {Icon, Logo} from '../ui/Icon';

/** Drones plays recorded footage with Sentinel boxes and SAM 3.1 masks (DESIGN.md §5.2, §9). Risk replaces the reference's Resources tab. */
const TABS: {id: Tab; label: string; icon: string; unavailable?: string}[] = [
  {id: 'incident', label: 'Incident', icon: 'map'},
  {id: 'drones', label: 'Drones', icon: 'drone'},
  {id: 'risk', label: 'Risk', icon: 'chart'}
];

function Divider({dotted = false}: {dotted?: boolean}) {
  return <span className={`mx-3 h-5 border-l ${dotted ? 'border-dotted border-muted' : 'border-hairline'}`} />;
}

/** Incident switcher: each fire is a separate page load (`?fire=<id>`), so every file reloads cleanly. */
function FirePicker({fire}: {fire: FireData}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-sm font-semibold" aria-expanded={open}>
        {fire.aoi.name}
        <Icon name="chevron" size={13} />
      </button>
      {open && (
        <ul className="absolute left-0 top-7 z-30 min-w-[160px] rounded-md bg-card py-1 shadow-[0_0_0_1px_var(--hairline),0_6px_18px_rgba(0,0,0,0.12)]">
          {FIRES.map(f => (
            <li key={f.id}>
              <a
                href={`?fire=${f.id}`}
                className={`block px-3 py-1.5 text-sm hover:bg-tabgroup ${f.id === fire.id ? 'font-semibold' : ''}`}
              >
                {f.name}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** DESIGN.md §3: one 40px row. */
export function Header({fire}: {fire: FireData}) {
  const {tab, setTab} = useUi();
  const {start, end} = useTime();
  const tz = fire.aoi.timezone;

  return (
    <header className="flex h-10 shrink-0 items-center whitespace-nowrap border-b border-hairline bg-chrome px-3">
      <Logo />
      <span className="ml-2 text-[17px] font-semibold tracking-tight">Sentinel Ember</span>
      <span className="hidden items-center lg:flex">
        <Divider />
        <span className="text-sm text-muted">Wildfire Forensic Analysis</span>
      </span>
      <Divider dotted />
      <FirePicker fire={fire} />
      <span className="ml-4 hidden truncate text-sm text-muted xl:inline">{fire.aoi.location}</span>
      <span className="ml-4 hidden items-center gap-1.5 text-sm md:flex">
        <Icon name="calendar" size={14} className="text-muted" />
        {formatDate(start, tz)} – {formatDate(end, tz)}
      </span>

      <nav className="ml-auto flex rounded-md bg-tabgroup p-0.5">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            disabled={!!t.unavailable}
            title={t.unavailable}
            className={`flex items-center gap-1.5 rounded px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${
              tab === t.id ? 'bg-tabactive font-medium text-ink shadow-[0_0_0_1px_var(--hairline)]' : 'text-muted'
            }`}
          >
            <Icon name={t.icon} size={15} />
            {t.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
