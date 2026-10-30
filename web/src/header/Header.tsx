import type {FireData} from '../data/fire';
import {formatDate} from '../lib/format';
import {useTime} from '../state/time';
import {useUi, type Tab} from '../state/ui';
import {Icon, Logo} from '../ui/Icon';

const TABS: {id: Tab; label: string; icon: string}[] = [
  {id: 'incident', label: 'Incident', icon: 'map'},
  {id: 'drones', label: 'Drones', icon: 'drone'},
  {id: 'resources', label: 'Resources', icon: 'truck'}
];

function Divider({dotted = false}: {dotted?: boolean}) {
  return <span className={`mx-3 h-5 border-l ${dotted ? 'border-dotted border-ink/40' : 'border-hairline'}`} />;
}

function MenuButton({icon, label}: {icon: string; label: string}) {
  return (
    <button className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-ink hover:bg-tabgroup">
      <Icon name={icon} size={15} />
      {label}
      <Icon name="chevron" size={12} className="text-muted" />
    </button>
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
      <button className="flex items-center gap-1 text-sm font-semibold">
        {fire.aoi.name}
        <Icon name="chevron" size={13} />
      </button>
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
            className={`flex items-center gap-1.5 rounded px-3 py-1 text-sm ${
              tab === t.id ? 'bg-tabactive font-medium text-ink shadow-[0_0_0_1px_var(--hairline)]' : 'text-muted'
            }`}
          >
            <Icon name={t.icon} size={15} />
            {t.label}
          </button>
        ))}
      </nav>

      <div className="ml-3 hidden items-center lg:flex">
        <MenuButton icon="calendar" label="View" />
        <MenuButton icon="chart" label="Analysis" />
        <MenuButton icon="share" label="Share" />
      </div>
      <Divider />
      <button className="text-ink" title="Settings">
        <Icon name="gear" size={17} />
      </button>
    </header>
  );
}
