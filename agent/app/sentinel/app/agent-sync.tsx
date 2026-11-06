/**
 * The incident screen's side of context awareness (docs/CONTRACTS.md):
 * - IncidentSync feeds the `navigation` state (through useIncidentNav, written by
 *   app/hooks/use-navigation-state.ts) and keeps the shareable URL params (`fire`, `t`, `tab`) in
 *   step with the map, in both directions: the agent's set-search-params moves the map too.
 * - MapCommands consumes the agent's one-shot `map-command` key and deletes it.
 */
import {useSemanticNavigationState} from '@agent-native/core/client/navigation';
import {useEffect, useRef} from 'react';
import {useNavigate, useSearchParams} from 'react-router';
import {TAB_ID} from '@/lib/tab-id';
import {selectDrone, setIncidentNav} from '../agent/context';
import {isFireId, type FireData} from '../data/fire';
import {useTime} from '../state/time';
import {isLayerId, isTab, LAYER_IDS, useUi, type LayerId} from '../state/ui';

/** Scrubbing settles for this long before the agent hears about it… */
const DEBOUNCE_MS = 300;
/** …but during playback it still hears at least this often. */
const MAX_WAIT_MS = 2000;

/** ISO UTC to the second, the form the actions take. */
export const isoSecond = (ms: number) => new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

function snapshot(fire: string) {
  const {t} = useTime.getState();
  const {tab, layers} = useUi.getState();
  return {
    view: 'incident' as const,
    fire,
    t: isoSecond(t),
    tab,
    visibleLayers: LAYER_IDS.filter(id => layers[id].visible && layers[id].ready)
  };
}

export function IncidentSync({fire}: {fire: FireData}) {
  const [params, setParams] = useSearchParams();
  // The URL values this tab wrote last, so a change the agent made is told apart from our own.
  const written = useRef<{t: string | null; tab: string | null}>({t: params.get('t'), tab: params.get('tab')});
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;

  // Store → navigation state + URL, debounced with a max wait.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let firstPending = 0;
    const flush = () => {
      timer = null;
      firstPending = 0;
      const nav = snapshot(fire.id);
      setIncidentNav(nav);
      const tabParam = nav.tab === 'incident' ? null : nav.tab;
      if (written.current.t === nav.t && written.current.tab === tabParam) return;
      written.current = {t: nav.t, tab: tabParam};
      setParamsRef.current(
        prev => {
          const next = new URLSearchParams(prev);
          next.set('fire', fire.id);
          next.set('t', nav.t);
          if (tabParam) next.set('tab', tabParam);
          else next.delete('tab');
          return next;
        },
        {replace: true, preventScrollReset: true}
      );
    };
    const schedule = () => {
      const now = Date.now();
      if (!firstPending) firstPending = now;
      if (timer) clearTimeout(timer);
      const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstPending + MAX_WAIT_MS - now));
      timer = setTimeout(flush, wait);
    };
    flush();
    const unsubTime = useTime.subscribe((s, p) => s.t !== p.t && schedule());
    const unsubUi = useUi.subscribe((s, p) => (s.tab !== p.tab || s.layers !== p.layers) && schedule());
    return () => {
      unsubTime();
      unsubUi();
      if (timer) clearTimeout(timer);
      setIncidentNav(null);
    };
  }, [fire.id]);

  // URL → store, when something other than this tab changed `t` or `tab` (the agent's
  // set-search-params tool, the browser's back button).
  const tParam = params.get('t');
  const tabParam = params.get('tab');
  useEffect(() => {
    if (tParam !== written.current.t) {
      written.current.t = tParam;
      const ms = Date.parse(tParam ?? '');
      if (Number.isFinite(ms) && Math.abs(ms - useTime.getState().t) >= 1000) {
        useTime.setState({playing: false});
        useTime.getState().setTime(ms);
      }
    }
    if (tabParam !== written.current.tab) {
      written.current.tab = tabParam;
      const tab = tabParam ?? 'incident';
      if (isTab(tab) && tab !== useUi.getState().tab) useUi.getState().setTab(tab);
    }
  }, [tParam, tabParam]);

  return null;
}

export type MapCommand =
  | {kind: 'set-time'; t: string; _writeId?: string}
  | {kind: 'set-fire'; fire: string; _writeId?: string}
  | {kind: 'set-tab'; tab: string; _writeId?: string}
  | {kind: 'set-layers'; show?: string[]; hide?: string[]; _writeId?: string}
  | {kind: 'fly-to'; lon: number; lat: number; zoom?: number; _writeId?: string}
  | {kind: 'select-drone'; planId: string; droneId: string; _writeId?: string};

/** Applies one agent map command to the screen's stores. Returns false for an unusable command. */
export function applyMapCommand(cmd: MapCommand, navigate: (to: string) => void): boolean {
  switch (cmd?.kind) {
    case 'set-time': {
      const ms = Date.parse(cmd.t);
      if (!Number.isFinite(ms)) return false;
      useTime.setState({playing: false});
      useTime.getState().setTime(ms);
      return true;
    }
    case 'set-fire': {
      if (!isFireId(cmd.fire)) return false;
      const current = new URLSearchParams(window.location.search).get('fire') ?? 'eaton';
      if (cmd.fire !== current) navigate(`/incident?fire=${cmd.fire}`);
      return true;
    }
    case 'set-tab':
      if (!isTab(cmd.tab)) return false;
      useUi.getState().setTab(cmd.tab);
      return true;
    case 'set-layers': {
      const show = (cmd.show ?? []).filter(isLayerId) as LayerId[];
      const hide = (cmd.hide ?? []).filter(isLayerId) as LayerId[];
      useUi.getState().setLayersVisible(show, hide);
      return true;
    }
    case 'fly-to':
      if (!Number.isFinite(cmd.lon) || !Number.isFinite(cmd.lat)) return false;
      useUi.getState().requestFlyTo(cmd.lon, cmd.lat, cmd.zoom);
      return true;
    case 'select-drone':
      if (!cmd.planId || !cmd.droneId) return false;
      selectDrone({planId: cmd.planId, droneId: cmd.droneId});
      return true;
    default:
      return false;
  }
}

/**
 * Consumes `map-command:<TAB_ID>` (and the unscoped key, for a command written outside a tab's
 * request), then deletes it. useDbSync invalidates the ['app-state', 'map-command', …] query when
 * the key changes, so a command lands within a sync tick; the interval is a fallback.
 */
const COMMAND_KEYS = [`map-command:${TAB_ID}`, 'map-command'];
const COMMAND_QUERY_KEY = ['app-state', 'map-command', TAB_ID];
const NO_NAVIGATION_KEYS: string[] = [];

export function MapCommands() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useSemanticNavigationState<null, MapCommand>({
    state: null,
    navigationKeys: NO_NAVIGATION_KEYS,
    commandKeys: COMMAND_KEYS,
    commandQueryKey: COMMAND_QUERY_KEY,
    browserTabId: TAB_ID,
    requestSource: TAB_ID,
    commandRefetchInterval: 4000,
    onCommand: cmd => {
      if (!applyMapCommand(cmd, to => navigateRef.current(to)))
        console.warn('Ignored an unusable map-command', cmd);
    }
  });
  return null;
}
