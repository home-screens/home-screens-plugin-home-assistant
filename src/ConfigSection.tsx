// Home Assistant plugin — custom ConfigSection.
//
// Architecture: the sidebar panel is too narrow (~280px) to hold the rich
// connection + entity-browser UI this plugin needs. The mockup was drawn at
// ~960px for a reason. So the sidebar shows a compact summary + a single
// "Configure…" button, and the full UI opens in a modal rendered via
// React.createPortal at document.body level. ESC / backdrop / close button
// all dismiss it.

import React from 'react';
import ReactDOM from 'react-dom';
import type { PluginConfigSectionProps } from './hs-plugin';
import type { HAStateObject, HAArea, HAPluginConfig, HAView } from './types';
import {
  entityDomain, CONTROL_VIEWS, ENTITY_VIEWS, COMPACT_VIEWS, HISTORY_VIEWS, FULL_SCREEN_VIEWS, headerShown } from './types';
import {
  VIEW_ENTITIES, acceptsAnything, unusedEntityIds,
} from './view-entities';
import { testConnection, fetchStates, fetchAreas, ConnectionResult } from './api';
import { fetchSecretStatus, saveHaToken } from './secrets';
import { friendlyName, entityStateSummary } from './utils';
import { settingsHaUrl, saveSettingsHaUrl } from './settings';
import { Icon, iconFor } from './icons';
import {
  INPUT, HINT, secondaryBtn, SectionTitle, Field,
  SettingRow, SettingsGrid,
} from './config-ui';
import { ButtonsEditor } from './ButtonsEditor';
import { ButtonsView } from './ButtonsView';
import { AlertsEditor, LookRulesEditor } from './RulesEditor';
import { AlertsView } from './AlertsView';
import { normalizeButtons } from './buttons';
import { normalizeAlerts, normalizeLookRules, makeLookResolver } from './rules';
import {
  CardGridView, StatusBoardView, RoomView, EntityCardView, EntityRowView,
  ClimateView, MediaView, CameraView, BatteriesView, PowerView, EmptyState,
} from './views';
import { DashboardView } from './DashboardView';
import { autoDashboardEntities } from './dashboard';
import { EnergyFlowView } from './EnergyFlowView';
import { TimelineView } from './TimelineView';

const FULL_SCREEN_NOTE = 'Made to fill the whole screen: put it on a screen of'
  + ' its own, drag it to the full size, and set Text size to about 24 on a'
  + ' 1080p display (40 on 4K). The module header starts off here; the view'
  + ' carries its own title.';

const VIEWS: { value: HAView; label: string }[] = [
  { value: 'card-grid', label: 'Card Grid' },
  { value: 'status-board', label: 'Status Board' },
  { value: 'room', label: 'By Area' },
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'entity-card', label: 'Entity Card' },
  { value: 'entity-row', label: 'Entity Row' },
  { value: 'climate', label: 'Climate' },
  { value: 'media', label: 'Media' },
  { value: 'cameras', label: 'Cameras' },
  { value: 'buttons', label: 'Buttons' },
  { value: 'alerts', label: 'Alerts' },
  { value: 'batteries', label: 'Batteries' },
  { value: 'power', label: 'Power' },
  { value: 'energy-flow', label: 'Energy Flow' },
  { value: 'timeline', label: 'Timeline' },
];

/** Views that pick their own content — the entity browser has nothing to
 *  do for them. */
const SELF_SOURCED_VIEWS: ReadonlySet<HAView> = new Set<HAView>([
  'buttons', 'alerts', 'batteries',
]);

/**
 * What "Show controls" gives each view it appears on, one line each.
 *
 * These describe the gesture in the words of the view drawing it, because
 * they render directly under the switch rather than in a shared paragraph:
 * a card grid has cards to press, the hero views are one widget. Keep them
 * to a single line at the SettingRow column width.
 *
 * Buttons runs its own action rather than the entity gestures, but the switch
 * still decides whether its tiles can be pressed at all, so it belongs here.
 * Alerts is the one touchable-looking view that is absent: an alert tile is
 * cleared, not controlled, and it is invisible while the house is calm.
 */
const CONTROL_NOTES: Partial<Record<HAView, string>> = {
  'card-grid': 'Tap and hold a card to operate it.',
  room: 'Tap and hold a card to operate it.',
  dashboard: 'Tap and hold a tile to operate it.',
  'entity-card': 'Tap and hold to operate this widget.',
  'entity-row': 'Tap and hold to operate this widget.',
  climate: 'Tap to set the temperature and the mode.',
  media: 'Puts play, skip, and volume on this widget.',
  buttons: 'Press a tile to run what it does.',
};

// Covers both the entity widgets and the buttons board, so it stays away from
// "what is happening": a button tile shows what it would do, not a state.
const CONTROLS_OFF_NOTE = 'Shows information only, touch does nothing.';

/**
 * The display switches this view offers, in render order.
 *
 * Each entry appears only where something reads the value, so the list runs
 * from two settings (Cameras, Power) to six (Card Grid). The sets live in
 * types.ts next to the consumers they were derived from.
 *
 * Descriptions must fit one line in a SettingRow, which at this column width
 * is roughly 45 characters. A wrapped description costs the whole block a row
 * of height, which is what the old shared paragraph did wrong at scale.
 */
function displaySettings(config: HAPluginConfig): Array<{
  key: 'showHeader' | 'showControls' | 'compactMode' | 'fastUpdates'
    | 'showHistory' | 'autoTones' | 'heroColumn';
  label: string;
  /** Lower-case name for the collapsed summary, where the settings run
   *  together in one line and "Show header" would read as a sentence start. */
  short: string;
  desc: string;
  checked: boolean;
}> {
  const view = config.view;
  const rows = [];

  // Alerts are invisible while idle, so a header has nothing to sit above.
  // index.tsx skips it on the same condition.
  if (view !== 'alerts') {
    rows.push({
      key: 'showHeader' as const,
      label: 'Show header',
      short: 'header',
      desc: 'Entity name and icon above the value.',
      // Missing key = on for widgets, off for full-screen views; the same
      // rule normalizeConfig applies on the display.
      checked: headerShown(view, config.showHeader),
    });
  }
  if (CONTROL_VIEWS.has(view)) {
    rows.push({
      key: 'showControls' as const,
      label: 'Show controls',
      short: 'controls',
      // Missing key = on, matching normalizeConfig's `!== false`.
      desc: config.showControls !== false ? CONTROL_NOTES[view] ?? '' : CONTROLS_OFF_NOTE,
      checked: config.showControls !== false,
    });
  }
  if (COMPACT_VIEWS.has(view)) {
    rows.push({
      key: 'compactMode' as const,
      label: 'Compact mode',
      short: 'compact',
      desc: 'Tighter spacing, so more fits.',
      checked: config.compactMode,
    });
  }
  // Missing key = on, matching normalizeConfig's `!== false`.
  rows.push({
    key: 'fastUpdates' as const,
    label: 'Fast updates',
    short: 'fast updates',
    desc: 'Every 2 seconds, beyond the refresh above.',
    checked: config.fastUpdates !== false,
  });
  // Missing key = off, matching normalizeConfig's `=== true`.
  if (HISTORY_VIEWS.has(view)) {
    rows.push({
      key: 'showHistory' as const,
      label: '24-hour history',
      short: 'history',
      desc: 'Trend line behind measuring sensors.',
      checked: config.showHistory === true,
    });
  }
  if (view === 'dashboard') {
    rows.push({
      key: 'heroColumn' as const,
      label: 'At-a-glance column',
      short: 'glance column',
      desc: 'Weather, people, power, and scenes on the left.',
      checked: config.heroColumn === true,
    });
  }
  if (ENTITY_VIEWS.has(view)) {
    rows.push({
      key: 'autoTones' as const,
      label: 'Automatic colors',
      short: 'colors',
      // The rules editor below states that your own rules win; repeating it
      // here would wrap the line, which costs the block a whole row.
      desc: 'Tints what is worth noticing.',
      checked: config.autoTones !== false,
    });
  }
  return rows;
}

/**
 * Connection status, living in the modal header rather than in a row at the
 * top of the scrolling body.
 *
 * Two reasons it belongs here. The header never scrolls, so the status stays
 * readable while you work down the entity list, which the old collapsed row
 * did not. And once the connection is settled there is nothing left to do
 * with it, so it should cost a corner of a row that was already empty rather
 * than the first row of the body.
 *
 * It is also the only status indicator in the modal: the preview label used
 * to draw its own green dot for the same condition, two dots for one fact.
 */
function ConnectionChip({ conn, tokenConfigured, tokenStatus, open, onClick }: {
  conn: ConnectionResult | null;
  tokenConfigured: boolean;
  tokenStatus: TokenStatus;
  open: boolean;
  onClick: () => void;
}) {
  const ready = Boolean(conn?.ok) && tokenConfigured;
  const checking = tokenStatus === 'loading' || tokenStatus === 'saving';
  const tone = ready ? { fg: '#86efac', bg: 'rgba(34,197,94,0.10)', bd: 'rgba(34,197,94,0.30)', dot: '#22c55e' }
    : checking ? { fg: 'rgba(255,255,255,0.6)', bg: 'rgba(255,255,255,0.05)', bd: 'rgba(255,255,255,0.12)', dot: 'rgba(255,255,255,0.3)' }
    : tokenStatus === 'error' || conn?.ok === false
      ? { fg: '#fca5a5', bg: 'rgba(239,68,68,0.10)', bd: 'rgba(239,68,68,0.32)', dot: '#ef4444' }
      : { fg: '#fcd34d', bg: 'rgba(245,158,11,0.10)', bd: 'rgba(245,158,11,0.32)', dot: '#f59e0b' };

  const label = ready
    ? <>{conn?.version && <>HA <VersionChip version={conn.version} /> · </>}{conn?.entityCount} entities</>
    : checking ? 'Checking…'
    : tokenStatus === 'error' ? "Can't check token"
    : !tokenConfigured ? 'Token not configured'
    : 'Not connected';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      // Named for what it opens, not for what it says: a screen reader hitting
      // "HA 2026.7.3 · 547 entities" has no way to know it is a button.
      aria-label="Connection settings"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '6px 12px', borderRadius: 99, cursor: 'pointer',
        fontSize: 11.5, fontFamily: 'inherit',
        background: tone.bg, border: `1px solid ${tone.bd}`, color: tone.fg,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: 99, background: tone.dot, flexShrink: 0,
        boxShadow: ready ? `0 0 4px ${tone.dot}` : undefined,
      }} />
      <span>{label}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ opacity: 0.6, marginLeft: 2, flexShrink: 0 }} aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
      </svg>
    </button>
  );
}

/** Missing key = 30s, matching normalizeConfig's fallback. The editor reads
 *  the stored config, not the normalized one, so a config saved before this
 *  field existed arrives here as undefined. */
const DEFAULT_REFRESH = 30;

/** Refresh interval in the shortest form that still reads as a duration. */
function refreshLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = seconds / 60;
  return mins < 60 ? `${mins}m` : `${mins / 60}h`;
}

/**
 * What the Display section says about itself while collapsed.
 *
 * This is the whole point of collapsing: the settings still have to be
 * readable at a glance, or the section has just become a place things hide.
 * It names the switches that are ON rather than counting them, because "4
 * options on" answers a question nobody asked. The names come from the same
 * list that renders the rows, so they cannot drift apart.
 */
function DisplaySummary({ config }: { config: HAPluginConfig }) {
  const viewLabel = VIEWS.find((v) => v.value === config.view)?.label ?? config.view;
  const on = displaySettings(config).filter((s) => s.checked).map((s) => s.short);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <strong style={{ color: 'rgba(255,255,255,0.8)', fontWeight: 500 }}>{viewLabel}</strong>
      <span style={{ opacity: 0.4 }}>·</span>
      <span>{refreshLabel(config.refreshInterval ?? DEFAULT_REFRESH)}</span>
      <span style={{ opacity: 0.4 }}>·</span>
      {/* Nothing on is worth saying out loud: it is the one state where the
          collapsed row would otherwise look identical to a full one. */}
      <span>{on.length ? on.join(', ') : 'no options on'}</span>
    </span>
  );
}

/**
 * Views that show entities but are meant for reading. This sits directly
 * under the View picker, not down with the toggles, because it explains the
 * view the person just chose rather than a setting they can change.
 */
const READ_ONLY_NOTES: Partial<Record<HAView, string>> = {
  'status-board': 'The status board is for reading at a glance. Its rows are'
    + ' too small to press safely, so pick Card Grid if you want to switch'
    + ' things on and off.',
  batteries: 'Battery levels are for reading. There is nothing here to switch.',
  power: 'The power chart is for reading. There is nothing here to switch.',
  cameras: 'Cameras show live pictures only.',
  'energy-flow': 'The energy flow is for reading. Pick your solar, grid, battery,'
    + ' and house power sensors and it sorts them out by name.',
  timeline: 'The timeline is for reading. Pick the lights, doors, locks, and'
    + ' people whose day you want to see.',
};

const DOMAIN_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'light', label: 'Lights' },
  { key: 'sensor', label: 'Sensors' },
  { key: 'binary_sensor', label: 'Binary' },
  { key: 'switch', label: 'Switches' },
  { key: 'climate', label: 'Climate' },
  { key: 'media_player', label: 'Media' },
  { key: 'cover', label: 'Covers' },
  { key: 'lock', label: 'Locks' },
  { key: 'other', label: 'Other' },
] as const;

type FilterKey = typeof DOMAIN_FILTERS[number]['key'] | 'selected';
type TokenStatus = 'loading' | 'configured' | 'empty' | 'saving' | 'saved' | 'error';

// ═══════════════════════════════════════════════════════════════════════════
// Top-level: sidebar summary + modal trigger
// ═══════════════════════════════════════════════════════════════════════════

export function ConfigSection(props: PluginConfigSectionProps) {
  const config = props.config as unknown as HAPluginConfig;
  const [open, setOpen] = React.useState(false);
  // Token status is owned here so the sidebar summary and the modal stay in
  // lockstep — the modal used to poll the secrets endpoint independently,
  // which could disagree with the summary until the next open/close cycle.
  const [tokenStatus, setTokenStatus] = React.useState<TokenStatus>('loading');
  const [tokenError, setTokenError] = React.useState<string | null>(null);

  // Refetch secret status on mount and whenever the modal opens/closes so a
  // save inside the modal is reflected immediately on dismiss. The functional
  // update preserves transitional ('saving'/'saved') states so a slow GET
  // firing after an in-flight PUT can't clobber the result.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchSecretStatus();
      if (cancelled) return;
      if (result.ok) {
        setTokenError(null);
        const fetched: TokenStatus = result.configured ? 'configured' : 'empty';
        setTokenStatus((prev) =>
          prev === 'saving' || prev === 'saved' ? prev : fetched);
      } else {
        setTokenError(result.error);
        setTokenStatus((prev) =>
          prev === 'saving' || prev === 'saved' ? prev : 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  return (
    <>
      <Summary
        config={config}
        tokenStatus={tokenStatus}
        tokenError={tokenError}
        onOpen={() => setOpen(true)}
      />
      {open && (
        <ConfigModal
          {...props}
          tokenStatus={tokenStatus}
          setTokenStatus={setTokenStatus}
          tokenError={tokenError}
          setTokenError={setTokenError}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ─── Compact summary shown in the narrow sidebar ────────────────────────────

function Summary({
  config, tokenStatus, tokenError, onOpen,
}: {
  config: HAPluginConfig;
  tokenStatus: TokenStatus;
  tokenError: string | null;
  onOpen: () => void;
}) {
  const loading = tokenStatus === 'loading';
  const errored = tokenStatus === 'error';
  const tokenConfigured = tokenStatus === 'configured' || tokenStatus === 'saved';
  // The connection lives at plugin scope, shared by every widget.
  const haUrl = settingsHaUrl();
  const ready = Boolean(haUrl) && tokenConfigured;
  const dotColor = ready ? '#22c55e'
    : errored ? '#ef4444'
    : loading ? 'rgba(255,255,255,0.3)'
    : '#f59e0b';

  const viewLabel = VIEWS.find((v) => v.value === config.view)?.label ?? config.view;
  const summaryText = ready ? 'Connected to Home Assistant'
    : errored ? (tokenError ?? "Couldn't check the saved token")
    : haUrl ? 'Token not configured'
    : 'Not configured';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10,
      padding: 12, borderRadius: 8,
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.08)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: 99, background: dotColor,
          boxShadow: ready ? `0 0 6px ${dotColor}` : undefined, flexShrink: 0,
        }} />
        <span style={{ fontSize: 12, color: ready ? '#86efac' : 'rgba(255,255,255,0.75)' }}>
          {summaryText}
        </span>
      </div>

      {haUrl && (
        <div style={{
          fontSize: 11, color: 'rgba(255,255,255,0.55)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {haUrl}
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
        <span><strong style={{ color: '#fff' }}>{viewLabel}</strong> view</span>
        <span>·</span>
        <span><strong style={{ color: '#fff' }}>{config.entities.length}</strong> entities</span>
      </div>

      <button
        onClick={onOpen}
        style={{
          marginTop: 2, padding: '9px 14px',
          background: '#3b82f6', border: '1px solid #3b82f6', color: '#fff',
          borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        Configure Home Assistant…
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// The modal — all the real UI lives here
// ═══════════════════════════════════════════════════════════════════════════

function ConfigModal({
  config: rawConfig, onChange, onClose, tokenStatus, setTokenStatus,
  tokenError, setTokenError,
}: PluginConfigSectionProps & {
  onClose: () => void;
  tokenStatus: TokenStatus;
  setTokenStatus: React.Dispatch<React.SetStateAction<TokenStatus>>;
  tokenError: string | null;
  setTokenError: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const config = rawConfig as unknown as HAPluginConfig;
  // The connection is plugin-level and edited RIGHT HERE: the URL input
  // binds a local draft; committing (blur / Enter) saves to the plugin-wide
  // settings store through the host SDK, so every widget, condition search,
  // and automatic state sharing pick it up at once. `savedUrl` mirrors what
  // is stored — the auto-test effect keys on committed values, never on
  // keystrokes.
  const [savedUrl, setSavedUrl] = React.useState<string>(() => settingsHaUrl());
  const [urlDraft, setUrlDraft] = React.useState<string>(() => settingsHaUrl());
  const [urlSaveError, setUrlSaveError] = React.useState<string | null>(null);
  const haUrl = savedUrl;

  const [conn, setConn] = React.useState<ConnectionResult | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [states, setStates] = React.useState<HAStateObject[] | null>(null);
  const [areas, setAreas] = React.useState<HAArea[]>([]);
  const [query, setQuery] = React.useState('');
  const [activeFilter, setActiveFilter] = React.useState<FilterKey>('all');

  const [tokenDraft, setTokenDraft] = React.useState<string>('');
  const [showTokenInput, setShowTokenInput] = React.useState<boolean>(false);
  // Generation counter for runTest — each call bumps it; in-flight results
  // are dropped if a newer call has started, so a URL change mid-test can't
  // splash data from the old URL onto the new one's panel.
  const testGenRef = React.useRef(0);
  // Timer that flips 'saved' → 'configured' after a beat. Cleared on unmount
  // or on a subsequent save so it can't fire against a dead component.
  const statusResetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Body scroll lock + ESC-to-close.
  React.useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clean up the pending status-reset timer on unmount.
  React.useEffect(() => () => {
    if (statusResetTimerRef.current) clearTimeout(statusResetTimerRef.current);
  }, []);

  // Reveal the token input automatically when we learn no token is saved;
  // hide it once one is configured. Transitional states ('loading', 'saving',
  // 'saved', 'error') don't touch visibility so the UI doesn't flicker.
  React.useEffect(() => {
    if (tokenStatus === 'empty') setShowTokenInput(true);
    else if (tokenStatus === 'configured') setShowTokenInput(false);
  }, [tokenStatus]);

  async function commitUrl() {
    const trimmed = urlDraft.trim();
    if (trimmed === savedUrl) return;
    const result = await saveSettingsHaUrl(trimmed);
    if (!result.ok) {
      setUrlSaveError(result.error);
      return;
    }
    setUrlSaveError(null);
    // Flipping savedUrl retriggers the auto-test effect below.
    setSavedUrl(trimmed);
  }

  async function saveToken() {
    const trimmed = tokenDraft.trim();
    if (!trimmed) return;
    setTokenStatus('saving');
    const result = await saveHaToken(trimmed);
    if (!result.ok) {
      setTokenError(result.error);
      setTokenStatus('error');
      return;
    }
    setTokenDraft('');
    setTokenError(null);
    // 'saved' triggers the URL-change useEffect below to auto-run a
    // connection test; after a beat, settle back to 'configured' so the
    // transient banner doesn't stay on forever.
    setTokenStatus('saved');
    setShowTokenInput(false);
    if (statusResetTimerRef.current) clearTimeout(statusResetTimerRef.current);
    statusResetTimerRef.current = setTimeout(
      () => setTokenStatus('configured'),
      1500,
    );
  }

  async function runTest() {
    if (!haUrl) return;
    const gen = ++testGenRef.current;
    const url = haUrl;
    setTesting(true);
    try {
      const r = await testConnection(url);
      if (gen !== testGenRef.current) return;
      setConn(r);
      if (r.ok) {
        try {
          const s = await fetchStates(url, 10_000);
          if (gen !== testGenRef.current) return;
          setStates(s);
          const a = await fetchAreas(url);
          if (gen !== testGenRef.current) return;
          setAreas(a);
        } catch { /* non-fatal */ }
      }
    } finally {
      if (gen === testGenRef.current) setTesting(false);
    }
  }

  // Auto-test when URL changes (debounced) once the token exists. While
  // tokenStatus is still 'loading' (secrets GET in flight), leave existing
  // conn/states alone — wiping them would flash "Not connected" under the
  // user's cursor on every modal reopen.
  React.useEffect(() => {
    if (!haUrl) { setConn(null); setStates(null); return; }
    if (tokenStatus === 'loading') return;
    if (tokenStatus !== 'configured' && tokenStatus !== 'saved') {
      setConn(null); setStates(null); return;
    }
    const id = setTimeout(() => { runTest(); }, 500);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [haUrl, tokenStatus]);

  function patch(updates: Partial<HAPluginConfig>) {
    onChange(updates as Record<string, unknown>);
  }

  // What the current view can draw, and how many. Drives the browser's
  // filtering, its tabs, and whether a row is a checkbox or a radio.
  const spec = VIEW_ENTITIES[config.view];
  const single = spec.max === 1;
  const restricted = !acceptsAnything(config.view);

  /**
   * Escape hatch out of the per-view filter.
   *
   * Domain is a good guess, not a law: people expose cameras through the
   * `image` domain, template sensors land wherever their author put them, and
   * `pickPowerEntity` falls back to any sensor for exactly this reason. So the
   * filter is a default, never a wall.
   */
  const [showAll, setShowAll] = React.useState(false);

  function toggleEntity(entityId: string) {
    const has = config.entities.includes(entityId);
    patch({
      entities: has
        ? config.entities.filter((e) => e !== entityId)
        : [...config.entities, entityId],
    });
  }

  /**
   * A pick on a single-entity view replaces the selection rather than adding
   * to it, because the view renders one entity and silently drops the rest.
   * The row draws as a radio, so this is what it already looks like it does.
   *
   * Unpicking still removes only the row you clicked. On the Selected tab a
   * single-entity view can be showing picks it doesn't draw (left over from
   * another view), and clearing those should not take the drawn one with them.
   */
  function chooseEntity(entityId: string) {
    if (!single || config.entities.includes(entityId)) {
      toggleEntity(entityId);
      return;
    }
    patch({ entities: [entityId] });
  }

  function selectAllInArea() {
    if (!config.area || !areas.length || !states) return;
    const target = areas.find((a) => a.area_id === config.area);
    if (!target) return;
    const available = new Set(states.map((s) => s.entity_id));
    const toAdd = target.entities.filter((e) => available.has(e));
    patch({ entities: Array.from(new Set([...config.entities, ...toAdd])) });
  }

  // The list the browser offers: everything this view can draw, unless the
  // user has asked to see the rest. The Selected tab deliberately reads
  // `states` instead, so a pick made under a different view is never hidden.
  const browseStates = React.useMemo(() => {
    if (!states) return null;
    return showAll ? states : states.filter(spec.accepts);
  }, [states, showAll, spec]);

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { all: browseStates?.length ?? 0 };
    if (browseStates) {
      for (const s of browseStates) {
        const d = entityDomain(s.entity_id);
        c[d] = (c[d] ?? 0) + 1;
      }
      const knownDomains = new Set<string>(
        DOMAIN_FILTERS.filter((f) => f.key !== 'all' && f.key !== 'other').map((f) => f.key),
      );
      c.other = browseStates.filter((s) => !knownDomains.has(entityDomain(s.entity_id))).length;
    }
    return c;
  }, [browseStates]);

  // Domain tabs are worth a row only when there is a choice to make. On a view
  // that accepts one domain they restate the tab beside them, so the strip is
  // just the set name and the way out of it.
  const domainTabsShown = React.useMemo(() => {
    if (!browseStates) return false;
    const seen = new Set<string>();
    for (const s of browseStates) {
      seen.add(entityDomain(s.entity_id));
      if (seen.size > 1) return true;
    }
    return false;
  }, [browseStates]);

  // Set lookup so each EntityRow's `picked` check is O(1) rather than O(n)
  // over config.entities — matters when the user has hundreds of entities
  // selected and is scrolling the up-to-300 filtered list.
  const pickedSet = React.useMemo(() => new Set(config.entities), [config.entities]);

  // The Selected tab also lists picked entities Home Assistant no longer
  // reports (renamed, removed, integration offline) — they'd otherwise be
  // impossible to find and unselect.
  const { filtered, missingSelected, totalMatch } = React.useMemo(() => {
    const none = { filtered: [] as HAStateObject[], missingSelected: [] as string[], totalMatch: 0 };
    if (!states || !browseStates) return none;
    const q = query.trim().toLowerCase();
    if (activeFilter === 'selected') {
      const byId = new Map(states.map((s) => [s.entity_id, s]));
      const present: HAStateObject[] = [];
      const missing: string[] = [];
      for (const id of config.entities) {
        const s = byId.get(id);
        if (s) {
          if (!q || s.entity_id.toLowerCase().includes(q)
            || friendlyName(s).toLowerCase().includes(q)) present.push(s);
        } else if (!q || id.toLowerCase().includes(q)) {
          missing.push(id);
        }
      }
      return {
        filtered: present.slice(0, 300),
        missingSelected: missing,
        totalMatch: present.length,
      };
    }
    const knownDomains = new Set<string>(
      DOMAIN_FILTERS.filter((f) => f.key !== 'all' && f.key !== 'other').map((f) => f.key),
    );
    const matched = browseStates.filter((s) => {
      const d = entityDomain(s.entity_id);
      if (activeFilter === 'other') {
        if (knownDomains.has(d)) return false;
      } else if (activeFilter !== 'all' && d !== activeFilter) {
        return false;
      }
      if (!q) return true;
      return s.entity_id.toLowerCase().includes(q) || friendlyName(s).toLowerCase().includes(q);
    });
    // The entity the view reaches for first should be the one you see first:
    // on Power that puts the house meter above ninety-eight other sensors,
    // where the fallback rule used to decide it out of sight.
    const ordered = spec.prefers && !showAll
      ? [...matched.filter(spec.prefers), ...matched.filter((s) => !spec.prefers!(s))]
      : matched;
    return { filtered: ordered.slice(0, 300), missingSelected: [], totalMatch: ordered.length };
  }, [states, browseStates, query, activeFilter, config.entities, spec, showAll]);

  // Picks this view will not draw — wrong kind for it, or past the one entity
  // it shows. Marks the rows, and offers to clear them in one go.
  const unused = React.useMemo(
    () => new Set(unusedEntityIds(config.view, config.entities, states ?? [])),
    [config.view, config.entities, states],
  );

  // The Selected tab hides itself when the last entity is unselected —
  // fall back to All so the user isn't stranded on an invisible tab.
  React.useEffect(() => {
    if (activeFilter === 'selected' && config.entities.length === 0) {
      setActiveFilter('all');
    }
  }, [activeFilter, config.entities.length]);

  // A new view brings a different list, and usually different tabs: the
  // Lights tab you were on may not exist on Cameras, which would leave the
  // browser looking empty. Start each view on its own full list.
  React.useEffect(() => {
    setActiveFilter('all');
    setShowAll(false);
  }, [config.view]);

  const tokenConfigured = tokenStatus === 'configured' || tokenStatus === 'saved';

  /**
   * The connection section shows while there is something to do about it, or
   * while the chip has been used to open it on purpose.
   *
   * `connOpen` is only ever an override for a settled connection: an unsettled
   * one shows regardless, so a token that expires while the modal is open
   * brings the fields back without the chip having to be found first. It also
   * means closing is not sticky while it is broken, which is correct. Nobody
   * should be able to dismiss their way out of a connection that does not work.
   */
  const connectionSettled = Boolean(conn?.ok) && tokenConfigured;
  const [connOpen, setConnOpen] = React.useState(false);
  const connectionShown = !connectionSettled || connOpen;

  const modal = (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '5vh 20px', overflowY: 'auto',
        fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 1240,
          maxHeight: '90vh',
          display: 'flex', flexDirection: 'column',
          background: '#111114',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16, overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6)',
          color: '#f5f5f7',
        }}
      >
        {/* ── Modal header ─────────────────────────────────────── */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '18px 24px', borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>
              Home Assistant
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
              Configure connection, display, and entities
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto' }}>
            <ConnectionChip
              conn={conn}
              tokenConfigured={tokenConfigured}
              tokenStatus={tokenStatus}
              open={connectionShown}
              onClick={() => setConnOpen((o) => !o)}
            />
            <button onClick={onClose} aria-label="Close" style={closeBtn}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            </button>
          </div>
        </div>

        {/* ── Body (2-column: config + live preview) ──────────── */}
        <div style={{
          flex: 1, overflowY: 'auto',
          display: 'flex', gap: 24,
          padding: '24px 28px',
          alignItems: 'flex-start',
        }}>
          <div style={{
            flex: '2 1 480px', minWidth: 0,
            display: 'flex', flexDirection: 'column', gap: 22,
          }}>

          {/* ── CONNECTION ──────────────────────────────────────
              Not a section of the body once it is settled: the header chip
              is its whole representation, and this renders only while there
              is something to do. Anything that needs fixing (no token, a
              failed test) forces it open on its own, so the one state that
              costs a row is the state that has earned one. */}
          {connectionShown && (
          <section>
            <SectionTitle>Connection</SectionTitle>
            <div style={GRID_TWO}>
              <Field label="Home Assistant URL">
                <input
                  style={INPUT}
                  value={urlDraft}
                  placeholder="http://homeassistant.local:8123"
                  onChange={(e) => setUrlDraft(e.target.value)}
                  onBlur={commitUrl}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitUrl(); }}
                />
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>
                  One connection for everything: every Home Assistant widget,
                  condition search, and automatic state sharing use it.
                </div>
                {urlSaveError && (
                  <div style={{ fontSize: 10, color: '#f87171', marginTop: 4 }}>
                    Couldn&apos;t save the address: {urlSaveError}
                  </div>
                )}
              </Field>

              <Field label="Long-Lived Access Token">
                {showTokenInput ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="password"
                      style={{ ...INPUT, flex: 1, minWidth: 0 }}
                      value={tokenDraft}
                      placeholder="eyJhbGciOiJIUzI1NiIs..."
                      onChange={(e) => setTokenDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveToken(); }}
                    />
                    <button onClick={saveToken}
                      disabled={!tokenDraft.trim() || tokenStatus === 'saving'}
                      style={secondaryBtn(!tokenDraft.trim() || tokenStatus === 'saving')}>
                      {tokenStatus === 'saving' ? 'Saving...' : 'Save'}
                    </button>
                    {tokenStatus === 'configured' && (
                      <button onClick={() => { setShowTokenInput(false); setTokenDraft(''); }}
                        style={secondaryBtn(false)}>Cancel</button>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <div style={{
                      flex: 1, minWidth: 0,
                      padding: '8px 12px', borderRadius: 6,
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: 'rgba(255,255,255,0.55)',
                      fontSize: 12, letterSpacing: '0.25em',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      overflow: 'hidden',
                    }}>●●●●●●●●●●●●●●●●</div>
                    <button onClick={() => { setShowTokenInput(true); setTokenDraft(''); }}
                      style={secondaryBtn(false)}>Change</button>
                  </div>
                )}
              </Field>
            </div>

            <div style={HINT}>
              Create one in Home Assistant at <code>Profile → Security → Long-Lived Access Tokens</code>
              {' '}(bottom of the page). Valid for 10 years.
            </div>

            <ConnectionBanner
              conn={conn} testing={testing} onRetry={runTest}
              hasUrl={Boolean(haUrl)}
              tokenConfigured={tokenConfigured}
              tokenStatus={tokenStatus}
              tokenError={tokenError}
            />
          </section>
          )}

          {/* ── DISPLAY (open by default; collapsing is opt-in) ── */}
          <Accordion
            title="Display"
            defaultOpen
            summary={<DisplaySummary config={config} />}
          >
            <div style={GRID_THREE}>
              <Field label="View">
                <select style={INPUT} value={config.view}
                  // A fresh module carries showHeader from the manifest's
                  // defaults, so the per-view default only lands if picking
                  // the view sets it: header off for a full-screen view, on
                  // for a widget. Flip the switch afterwards to override.
                  onChange={(e) => {
                    const view = e.target.value as HAView;
                    patch({ view, showHeader: headerShown(view, undefined) });
                  }}>
                  <optgroup label="Widgets">
                    {VIEWS.filter((v) => !FULL_SCREEN_VIEWS.has(v.value)).map((v) => (
                      <option key={v.value} value={v.value}>{v.label}</option>))}
                  </optgroup>
                  <optgroup label="Full screen">
                    {VIEWS.filter((v) => FULL_SCREEN_VIEWS.has(v.value)).map((v) => (
                      <option key={v.value} value={v.value}>{v.label}</option>))}
                  </optgroup>
                </select>
              </Field>

              {(config.view === 'card-grid' || config.view === 'buttons'
                || config.view === 'dashboard' || config.view === 'timeline') && (
                <Field label="Columns">
                  <ColumnsSlider
                    value={config.columns}
                    onChange={(n) => patch({ columns: n })}
                  />
                </Field>
              )}

              <Field label="Refresh interval">
                <select style={INPUT} value={config.refreshInterval ?? DEFAULT_REFRESH}
                  onChange={(e) => patch({ refreshInterval: Number(e.target.value) })}>
                  <optgroup label="Live">
                    <option value={5}>5 seconds</option>
                    <option value={10}>10 seconds</option>
                  </optgroup>
                  <optgroup label="Balanced">
                    <option value={15}>15 seconds</option>
                    <option value={30}>30 seconds</option>
                    <option value={60}>1 minute</option>
                    <option value={120}>2 minutes</option>
                  </optgroup>
                  <optgroup label="Low traffic">
                    <option value={300}>5 minutes</option>
                    <option value={600}>10 minutes</option>
                    <option value={1800}>30 minutes</option>
                    <option value={3600}>1 hour</option>
                  </optgroup>
                </select>
              </Field>
            </div>

            {/* Sits with the View picker, not with the toggles: it describes
                the view just chosen, and there is no switch to change it. */}
            {READ_ONLY_NOTES[config.view] && (
              <p style={{ margin: '8px 0 0', fontSize: 11, opacity: 0.55, maxWidth: 520 }}>
                {READ_ONLY_NOTES[config.view]}
              </p>
            )}

            {FULL_SCREEN_VIEWS.has(config.view) && (
              <p style={{ margin: '8px 0 0', fontSize: 11, opacity: 0.7, maxWidth: 520 }}>
                {FULL_SCREEN_NOTE}
              </p>
            )}
            {config.view === 'dashboard' && (
              <p style={{ margin: '8px 0 0', fontSize: 11, opacity: 0.55, maxWidth: 520 }}>
                With nothing picked below, the dashboard shows everything in your areas. Pick entities to narrow it down.
              </p>
            )}
            {(config.view === 'room' || config.view === 'dashboard') && areas.length > 0 && (
              <div style={{ marginTop: 12, maxWidth: 320 }}>
                <Field label="Area">
                  <select style={INPUT} value={config.area ?? ''}
                    onChange={(e) => patch({ area: e.target.value || null })}>
                    <option value="">All areas</option>
                    {areas.map((a) => <option key={a.area_id} value={a.area_id}>{a.name}</option>)}
                  </select>
                </Field>
              </div>
            )}

            <SettingsGrid>
              {displaySettings(config).map((s, i, all) => (
                <SettingRow
                  key={s.key}
                  label={s.label}
                  desc={s.desc}
                  checked={s.checked}
                  onChange={(v) => patch({ [s.key]: v })}
                  // Both cells of the final full row, whatever the parity: with
                  // an odd count the right-hand cell of that row has an empty
                  // cell under it, so its divider would hang.
                  last={i >= all.length - 2} />
              ))}
            </SettingsGrid>
          </Accordion>

          {/* ── BUTTONS (buttons view replaces the entity browser) ── */}
          {config.view === 'buttons' && (
            <ButtonsEditor
              buttons={config.buttons ?? []}
              onChange={(buttons) => patch({ buttons })}
              states={states}
              connected={Boolean(conn?.ok)}
              haUrl={haUrl}
            />
          )}

          {/* ── ALERTS (alerts view replaces the entity browser too) ── */}
          {config.view === 'alerts' && (
            <AlertsEditor
              alerts={config.alerts ?? []}
              onChange={(alerts) => patch({ alerts })}
              states={states}
              connected={Boolean(conn?.ok)}
            />
          )}

          {/* ── ENTITIES ────────────────────────────────────── */}
          {!SELF_SOURCED_VIEWS.has(config.view) && (
          <section>
            <SectionTitle>
              Entities <span style={{ color: 'rgba(255,255,255,0.4)' }}>· {config.entities.length} selected</span>
            </SectionTitle>
            <div style={HINT}>
              {single
                ? 'This view shows one entity, so picking one replaces the current choice.'
                : 'Checking entities here only picks what this widget shows on screen.'}
              {' '}Conditions and Text widget values find any entity by search on their
              own, so they don&rsquo;t need anything checked here.
            </div>
            {!conn?.ok && (
              <div style={HINT}>Connect to Home Assistant to browse entities.</div>
            )}
            {conn?.ok && states && (
              <>
                <UnusedNotice
                  viewLabel={VIEWS.find((v) => v.value === config.view)?.label ?? config.view}
                  used={config.entities.length - unused.size}
                  total={config.entities.length}
                  onTrim={() => patch({
                    entities: config.entities.filter((e) => !unused.has(e)),
                  })}
                />
                <SearchInput value={query} onChange={setQuery} />
                <div style={TAB_BAR}>
                <div style={TABS}>
                  {config.entities.length > 0 && (
                    <button
                      onClick={() => setActiveFilter('selected')}
                      style={tabStyle(activeFilter === 'selected')}
                    >
                      Selected{' '}
                      <span style={tabCountStyle(activeFilter === 'selected')}>
                        {config.entities.length}
                      </span>
                    </button>
                  )}
                  {DOMAIN_FILTERS.map((f) => {
                    // The "All" tab names the set it is showing, so a filtered
                    // view says what it accepts instead of claiming to list
                    // everything. The domain tabs under it are worth the row
                    // only where more than one domain qualifies.
                    if (f.key !== 'all' && !domainTabsShown) return null;
                    const count = counts[f.key] ?? 0;
                    if (count === 0 && f.key !== 'all') return null;
                    const active = activeFilter === f.key;
                    const label = f.key === 'all' && !showAll
                      ? spec.label ?? f.label : f.label;
                    return (
                      <button key={f.key} onClick={() => setActiveFilter(f.key)} style={tabStyle(active)}>
                        {label} <span style={tabCountStyle(active)}>{count}</span>
                      </button>
                    );
                  })}
                </div>
                {/* Outside the scrolling strip on purpose: with every domain
                    tab back on screen this is the only way to return to the
                    view's own list, and it was scrolling out of reach. */}
                {restricted && (
                  <button
                    onClick={() => { setShowAll((v) => !v); setActiveFilter('all'); }}
                    style={{ ...tabStyle(false), flexShrink: 0, opacity: 0.75 }}
                  >
                    {showAll ? 'Show what this view uses' : 'Show everything'}
                  </button>
                )}
                </div>
                <div style={LIST}>
                  {filtered.length === 0 && missingSelected.length === 0 && (
                    <div style={{ padding: 16, color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>
                      No entities match.
                    </div>
                  )}
                  {filtered.map((s) => (
                    <EntityRow key={s.entity_id} state={s}
                      picked={pickedSet.has(s.entity_id)}
                      single={single}
                      unused={pickedSet.has(s.entity_id) && unused.has(s.entity_id)}
                      onToggle={() => chooseEntity(s.entity_id)} />
                  ))}
                  {missingSelected.map((id) => (
                    <MissingEntityRow key={id} entityId={id}
                      onToggle={() => toggleEntity(id)} />
                  ))}
                  {totalMatch > filtered.length && (
                    <div style={{
                      padding: '10px 12px', color: 'rgba(255,255,255,0.45)',
                      fontSize: 11, textAlign: 'center',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                    }}>
                      Showing {filtered.length} of {totalMatch} — narrow your search to see more.
                    </div>
                  )}
                </div>
                <div style={{
                  marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
                    {config.entities.length} selected · {browseStates?.length ?? 0}{' '}
                    {restricted && !showAll
                      ? `${(spec.label ?? 'entities').toLowerCase()} to choose from`
                      : 'entities to choose from'}
                  </span>
                  {config.area && (
                    <button onClick={selectAllInArea} style={secondaryBtn(false)}>
                      Select all in area
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
          )}

          {/* ── LOOK RULES (entity views only) ───────────────── */}
          {ENTITY_VIEWS.has(config.view) && (
            <LookRulesEditor
              rules={config.lookRules ?? []}
              onChange={(lookRules) => patch({ lookRules })}
              states={states}
              connected={Boolean(conn?.ok)}
            />
          )}

          {/* The key/value reference panel that lived here is gone: the
              host's condition builder (any module → Visibility → Conditions)
              now searches entities by name and offers each one's raw values
              directly, via this plugin's searchStateKeys export. */}
          </div>

          {/* ── Preview column (sticky) ─────────────────────── */}
          <div style={{ flex: '1 1 320px', minWidth: 280, maxWidth: 360 }}>
            <div style={{ position: 'sticky', top: 0 }}>
              <PreviewPane config={config} states={states} areas={areas} />
            </div>
          </div>

        </div>

        {/* ── Footer ─────────────────────────────────────────── */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '14px 24px',
          background: 'rgba(255,255,255,0.02)',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}>
          <button onClick={onClose} style={primaryBtn}>Done</button>
        </div>
      </div>
    </div>
  );

  return ReactDOM.createPortal(modal, document.body);
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-components
// ═══════════════════════════════════════════════════════════════════════════

// ─── Live preview (mini-display of the selected view) ───────────────────────
//
// Renders the actual view components against the filtered entity states, so
// users see their selections and view/layout changes reflected in real time
// without leaving the modal. Taps don't invoke services (no onCommand) —
// this is a visual preview, not an interactive mirror.

function PreviewPane({ config, states, areas }: {
  config: HAPluginConfig;
  states: HAStateObject[] | null;
  areas: HAArea[];
}) {
  const entitySet = React.useMemo(() => new Set(config.entities), [config.entities]);
  const visible = React.useMemo(() => {
    if (!states) return [];
    // Same rule as the display: an unpicked dashboard draws the house.
    if (config.view === 'dashboard' && config.entities.length === 0) {
      return autoDashboardEntities(states, areas, config.area);
    }
    return states
      .filter((s) => entitySet.has(s.entity_id))
      .sort((a, b) =>
        config.entities.indexOf(a.entity_id) - config.entities.indexOf(b.entity_id));
  }, [states, entitySet, config.entities, config.view, config.area, areas]);

  // Fixed-size frame mimicking the default module dimensions. Views inside
  // are naturally responsive; we clip anything that overflows.
  const PREVIEW_WIDTH = 320;
  const PREVIEW_HEIGHT = 420;

  return (
    <div>
      <div style={{
        fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em',
        color: 'rgba(255,255,255,0.45)', marginBottom: 10,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {/* No status dot here. The header chip already reports whether the
            connection is live, and this drew a second green dot for the same
            fact. When it is not live the preview shows its own empty state,
            which says more than a grey dot did. */}
        <span>Preview</span>
      </div>

      <div style={{
        width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT,
        background: 'rgba(0,0,0,0.45)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12, overflow: 'auto',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(255,255,255,0.2) transparent',
      }}>
        <PreviewBody config={config} visible={visible} states={states} areas={areas} />
      </div>

      <div style={{
        marginTop: 8, fontSize: 10, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5,
      }}>
        Mirrors what will render on your display. Polls live data; taps are disabled in preview.
      </div>
    </div>
  );
}

function PreviewBody({ config, visible, states, areas }: {
  config: HAPluginConfig;
  visible: HAStateObject[];
  states: HAStateObject[] | null;
  areas: HAArea[];
}) {
  // Buttons preview needs no entities — it renders config rows. Taps stay
  // inert (no onInvoke), mirroring the other views' no-onCommand contract.
  if (config.view === 'buttons') {
    if (!config.buttons?.length) {
      return <EmptyState message="Add a button to see a preview." />;
    }
    return (
      <ButtonsView config={{
        ...config,
        haUrl: settingsHaUrl(),
        // Raw module config reaches the preview un-normalized; the display
        // path runs this inside normalizeConfig.
        buttons: normalizeButtons(config.buttons),
        // Keep the user's tile/pill choice — forcing compact here would hide
        // the layout they're actually configuring.
        columns: Math.min(config.columns ?? 2, 2),
      }} />
    );
  }
  // Alerts preview shows every configured tile regardless of live state —
  // the user needs to style tiles that aren't currently firing. On the
  // display the module is invisible while idle.
  if (config.view === 'alerts') {
    const alerts = normalizeAlerts(config.alerts);
    if (alerts.length === 0) {
      return <EmptyState message="Add an alert to see a preview. On the display, this widget stays invisible until an alert goes off." />;
    }
    return (
      <AlertsView preview states={states}
        config={{ ...config, haUrl: settingsHaUrl(), alerts }} />
    );
  }
  if (states == null) {
    return <EmptyState message="Connect to Home Assistant to preview." />;
  }
  // Batteries finds its own entities — an empty selection is normal there.
  if (visible.length === 0
    && config.view !== 'cameras' && config.view !== 'batteries') {
    return <EmptyState message="Select some entities to see a preview." />;
  }
  // The preview frame is 320px wide — force compact card styling regardless
  // of the user's compactMode choice, and cap card-grid columns at 2 so the
  // cards have room to breathe. We pass a cloned config so the live display
  // keeps the user's actual preferences.
  const previewConfig: HAPluginConfig = {
    ...config,
    // The display path injects the plugin-settings URL inside
    // normalizeConfig; the preview renders from raw module config, so apply
    // the same injection here (CameraView builds URLs from config.haUrl).
    haUrl: settingsHaUrl(),
    compactMode: true,
    columns: Math.min(config.columns ?? 2, 2),
  };
  // Look rules and automatic colors render live in the preview so "garage
  // open → red" can be styled against the real current state.
  const lookFor = makeLookResolver(
    normalizeLookRules(config.lookRules), config.autoTones !== false);
  const viewProps = {
    states: visible, allStates: states ?? undefined, config: previewConfig,
    areas, preview: true, lookFor,
  };
  switch (config.view) {
    case 'card-grid': return <CardGridView {...viewProps} />;
    case 'status-board': return <StatusBoardView {...viewProps} />;
    case 'room': return <RoomView {...viewProps} />;
    case 'entity-card': return <EntityCardView {...viewProps} />;
    case 'entity-row': return <EntityRowView {...viewProps} />;
    case 'climate': return <ClimateView {...viewProps} />;
    case 'media': return <MediaView {...viewProps} />;
    case 'cameras': return <CameraView {...viewProps} />;
    case 'batteries': return <BatteriesView {...viewProps} />;
    // No history in the preview (it never fetches any), so this shows the
    // live number and the day's chart appears on the display. Same gap the
    // 24-hour history toggle has always had on sensor cards.
    case 'power': return <PowerView {...viewProps} />;
    case 'dashboard': return <DashboardView {...viewProps} />;
    case 'energy-flow': return <EnergyFlowView {...viewProps} />;
    case 'timeline': return <TimelineView {...viewProps} />;
    default: return <CardGridView {...viewProps} />;
  }
}

// CONNECTION section accordion — tucks itself away once HA is happy.
//
// Subtlety: `defaultOpen` is driven by async state (connection test result +
// token-loaded flag). When the modal first mounts, both are still pending,
// so the initial `defaultOpen` is true (we assume "not connected" until we
// know otherwise). If we only read it on mount, the section stays open
// forever even after the async checks succeed.
//
// So: we track the user's own toggles separately. Before they've clicked
// once, `open` follows `defaultOpen` reactively (so it collapses as soon as
// the connection resolves). Once they click, their choice wins for the rest
// of the modal session — no more yanking it open/closed under their cursor.
function Accordion({ title, summary, defaultOpen, children }: {
  title: string;
  summary?: React.ReactNode;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const userToggled = React.useRef(false);
  React.useEffect(() => {
    if (!userToggled.current) setOpen(defaultOpen);
  }, [defaultOpen]);
  const handleToggle = () => {
    userToggled.current = true;
    setOpen((o) => !o);
  };
  return (
    <section>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          background: 'transparent', border: 'none', padding: 0, margin: '0 0 12px',
          cursor: 'pointer', color: 'inherit', fontFamily: 'inherit',
        }}
      >
        <svg
          width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round"
          style={{
            color: 'rgba(255,255,255,0.5)',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease',
            flexShrink: 0,
          }}
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span style={{
          fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em',
          color: 'rgba(255,255,255,0.55)',
        }}>{title}</span>
        {!open && summary && (
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginLeft: 4 }}>
            {summary}
          </span>
        )}
      </button>
      {open && <div>{children}</div>}
    </section>
  );
}

function ConnectionBanner({
  conn, testing, onRetry, hasUrl, tokenConfigured, tokenStatus, tokenError,
}: {
  conn: ConnectionResult | null; testing: boolean; onRetry: () => void;
  hasUrl: boolean; tokenConfigured: boolean;
  tokenStatus: TokenStatus; tokenError: string | null;
}) {
  if (!hasUrl) return null;
  if (tokenStatus === 'error') {
    return <div style={bannerStyle('err')}>
      <span>✗ Couldn't reach the secrets endpoint{tokenError ? ` — ${tokenError}` : ''}.</span>
    </div>;
  }
  if (tokenStatus === 'loading') {
    return <div style={bannerStyle('info')}><span>Checking token…</span></div>;
  }
  if (!tokenConfigured) {
    return <div style={bannerStyle('info')}>
      <span>⚠ Configure your token above to connect.</span>
    </div>;
  }
  if (testing) {
    return <div style={bannerStyle('info')}><span>Testing connection…</span></div>;
  }
  if (!conn) return null;
  if (conn.ok) {
    return (
      <div style={bannerStyle('ok')}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, flexWrap: 'wrap' }}>
          <CheckIcon />
          <span>Connected — HA</span>
          <VersionChip version={conn.version ?? ''} />
          <span style={{ opacity: 0.75 }}>· {conn.unitSystem}</span>
          <span><strong>{conn.entityCount}</strong> entities</span>
          {conn.locationName && <span style={{ opacity: 0.75 }}>· {conn.locationName}</span>}
        </span>
        <button style={secondaryBtn(false)} onClick={onRetry}>Test again</button>
      </div>
    );
  }
  return (
    <div style={bannerStyle('err')}>
      <span>✗ {conn.error}</span>
      <button style={secondaryBtn(false)} onClick={onRetry}>Retry</button>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function VersionChip({ version }: { version: string }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 500,
      background: 'rgba(255,255,255,0.08)',
      color: 'rgba(255,255,255,0.85)',
      padding: '1px 7px', borderRadius: 5,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    }}>{version}</span>
  );
}

function ColumnsSlider({ value, onChange }: {
  value: number; onChange: (v: number) => void;
}) {
  const clamped = Math.max(1, Math.min(4, value));
  return (
    <div>
      <input
        type="range" min={1} max={4} step={1}
        value={clamped}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#3b82f6' }}
      />
      <div style={{
        marginTop: 4, fontSize: 11,
        color: 'rgba(255,255,255,0.45)',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>1</span>
        <span style={{ color: 'rgba(255,255,255,0.75)' }}>{clamped} of 4</span>
        <span>4</span>
      </div>
    </div>
  );
}

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ position: 'relative', marginBottom: 10 }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{
          position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
          color: 'rgba(255,255,255,0.35)', pointerEvents: 'none',
        }} aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        style={{ ...INPUT, paddingLeft: 34 }}
        value={value}
        placeholder="Search entities by name or ID..."
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * One browsable entity.
 *
 * `single` swaps the checkbox for a radio, because on a one-entity view that
 * is what picking does — the selection is replaced, not added to. A box you
 * can tick eight times on a view that draws the first one is a lie the widget
 * then tells silently.
 *
 * `unused` marks a pick this view has no use for. It only ever shows on the
 * Selected tab, which is the one place selections made under another view
 * stay visible.
 */
function EntityRow({ state, picked, single, unused, onToggle }: {
  state: HAStateObject; picked: boolean; onToggle: () => void;
  single?: boolean; unused?: boolean;
}) {
  // A pick this view ignores is marked in grey, not in the accent: three lit
  // radios on a one-entity view would each claim to be the choice.
  const mark = unused ? 'rgba(255,255,255,0.35)' : '#3b82f6';
  return (
    <div onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
        borderRadius: 6, cursor: 'pointer',
        background: picked ? 'rgba(59, 130, 246, 0.10)' : 'transparent',
        transition: 'background 0.1s ease',
        opacity: unused ? 0.6 : 1,
      }}
    >
      <div style={{
        width: 16, height: 16, borderRadius: single ? 99 : 3, flexShrink: 0,
        background: picked && !single ? mark : 'transparent',
        border: `1px solid ${picked ? mark : 'rgba(255,255,255,0.15)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {picked && (single ? (
          <span style={{ width: 8, height: 8, borderRadius: 99, background: mark }} />
        ) : (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff"
            strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ))}
      </div>
      <Icon name={iconFor(state)} size={16} style={{
        color: picked ? '#93c5fd' : 'rgba(255,255,255,0.5)', flexShrink: 0,
      }} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{
          fontSize: 13, color: '#fff',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {friendlyName(state)}
        </span>
        <span style={{
          fontSize: 11, color: 'rgba(255,255,255,0.35)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
        }}>
          {state.entity_id}
        </span>
      </span>
      {unused && (
        <span style={{
          fontSize: 10, color: 'rgba(255,255,255,0.5)', flexShrink: 0,
          background: 'rgba(255,255,255,0.06)', padding: '2px 7px', borderRadius: 99,
        }}>
          Not shown here
        </span>
      )}
      <span style={{
        fontSize: 12, color: stateColor(state),
        fontVariantNumeric: 'tabular-nums', flexShrink: 0,
      }}>
        {entityStateSummary(state)}
      </span>
    </div>
  );
}

/**
 * "Media only shows 1 of the 6 entities you picked."
 *
 * Switching views is the one way to end up with picks nothing draws, and
 * without this the widget summary still counts them: six entities configured,
 * one on screen, no explanation anywhere. Clearing them is offered, never
 * done automatically — switching back should find the selection intact.
 */
function UnusedNotice({ viewLabel, used, total, onTrim }: {
  viewLabel: string; used: number; total: number; onTrim: () => void;
}) {
  if (total === 0 || used === total) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 10, flexWrap: 'wrap', marginBottom: 10,
      background: 'rgba(245, 158, 11, 0.08)',
      border: '1px solid rgba(245, 158, 11, 0.22)',
      color: '#fcd34d', padding: '8px 12px', borderRadius: 8, fontSize: 12,
    }}>
      <span>
        {total === 1 && used === 0
          ? `${viewLabel} can't show the entity you picked.`
          : <>{viewLabel} shows {used === 0 ? 'none' : used} of the {total} entities
        you picked{used === 0 ? ''
          : total - used === 1 ? ' — the other one stays hidden'
          : ` — the other ${total - used} stay hidden`}.</>}
      </span>
      <button onClick={onTrim} style={secondaryBtn(false)}>
        {used === 0 ? 'Clear them' : 'Remove the rest'}
      </button>
    </div>
  );
}

// A picked entity Home Assistant no longer reports. Shown only on the
// Selected tab, checked, so one click removes it.
function MissingEntityRow({ entityId, onToggle }: {
  entityId: string; onToggle: () => void;
}) {
  return (
    <div onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
        borderRadius: 6, cursor: 'pointer',
        background: 'rgba(245, 158, 11, 0.06)',
        transition: 'background 0.1s ease',
      }}
    >
      <div style={{
        width: 16, height: 16, borderRadius: 3, flexShrink: 0,
        background: '#3b82f6', border: '1px solid #3b82f6',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff"
          strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{
          fontSize: 12, color: 'rgba(255,255,255,0.55)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {entityId}
        </span>
      </span>
      <span style={{ fontSize: 11, color: '#fbbf24', flexShrink: 0 }}>
        Not found in Home Assistant
      </span>
    </div>
  );
}

function stateColor(s: HAStateObject): string {
  const d = entityDomain(s.entity_id);
  if (d === 'binary_sensor' && s.state === 'on') {
    const dc = s.attributes.device_class;
    if (dc === 'door' || dc === 'garage_door' || dc === 'window'
      || dc === 'smoke' || dc === 'gas' || dc === 'moisture' || dc === 'problem') {
      return '#f87171';
    }
  }
  if (s.state === 'unavailable') return 'rgba(255,255,255,0.3)';
  if (s.state === 'on' || s.state === 'open' || s.state === 'unlocked' || s.state === 'playing') {
    return '#86efac';
  }
  return 'rgba(255,255,255,0.55)';
}

// ═══════════════════════════════════════════════════════════════════════════
// Styles
// ═══════════════════════════════════════════════════════════════════════════

const GRID_TWO: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16,
};

const GRID_THREE: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16,
};

// The tabs scroll; the row they sit in does not. Anything that must stay
// reachable (the "Show everything" escape) belongs in the row, not the strip.
const TAB_BAR: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', gap: 8,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  marginBottom: 10,
};

const TABS: React.CSSProperties = {
  display: 'flex', gap: 2,
  flex: 1, minWidth: 0, overflowX: 'auto',
};

function tabStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 12, padding: '8px 10px',
    border: 'none', background: 'transparent',
    borderBottom: `2px solid ${active ? '#3b82f6' : 'transparent'}`,
    marginBottom: -1,
    color: active ? '#fff' : 'rgba(255,255,255,0.55)',
    cursor: 'pointer', whiteSpace: 'nowrap',
    display: 'inline-flex', alignItems: 'center', gap: 6,
    fontFamily: 'inherit', fontWeight: active ? 600 : 400,
  };
}

function tabCountStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 10, padding: '1px 6px', borderRadius: 99,
    background: active ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255,255,255,0.05)',
    color: 'inherit', fontWeight: 500,
  };
}

const LIST: React.CSSProperties = {
  maxHeight: 340, overflowY: 'auto',
  // Keeps wheel scrolling that reaches the top/bottom of the entity list
  // from bleeding into the modal body underneath.
  overscrollBehavior: 'contain',
  display: 'flex', flexDirection: 'column', gap: 1,
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8, padding: 4, marginTop: 4,
};

function bannerStyle(kind: 'ok' | 'info' | 'err'): React.CSSProperties {
  const colors = {
    ok: { bg: 'rgba(34, 197, 94, 0.08)', border: 'rgba(34, 197, 94, 0.22)', fg: '#86efac' },
    info: { bg: 'rgba(59, 130, 246, 0.08)', border: 'rgba(59, 130, 246, 0.22)', fg: '#93c5fd' },
    err: { bg: 'rgba(239, 68, 68, 0.08)', border: 'rgba(239, 68, 68, 0.22)', fg: '#fca5a5' },
  }[kind];
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    background: colors.bg, border: `1px solid ${colors.border}`,
    color: colors.fg, padding: '10px 14px', borderRadius: 8,
    fontSize: 12, marginTop: 12, flexWrap: 'wrap',
  };
}

const primaryBtn: React.CSSProperties = {
  background: '#3b82f6', border: '1px solid #3b82f6', color: '#fff',
  fontSize: 13, padding: '8px 18px', borderRadius: 6,
  cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
};

const closeBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid rgba(255,255,255,0.12)',
  color: 'rgba(255,255,255,0.6)',
  width: 32, height: 32, borderRadius: 8, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 0,
};
