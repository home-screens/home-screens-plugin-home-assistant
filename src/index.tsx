// Home Assistant plugin for Home Screens.
//
// Architecture:
//   index.tsx (this file) owns the data lifecycle — polling HA states +
//   areas on config.refreshInterval, applying display-cache sharing so a
//   screen with N HA modules only makes one /api/states call per tick.
//   It then routes to a view in views.tsx based on config.view.
//
//   All HTTP goes through window.__HS_SDK__.pluginFetch (see api.ts).
//   The plugin declares `localNetwork` permission in manifest.json so the
//   host's proxy allows RFC1918 / mDNS targets (HA typically lives at
//   homeassistant.local:8123 or 192.168.x.x).

import React from 'react';
import type { PluginComponentProps, ModuleStyle } from './hs-plugin';
import type { HAStateObject, HAArea, HAPluginConfig, HAView, HAButtonRow } from './types';
import { fetchStates, fetchAreas, fetchHistory, callService, invokeService } from './api';
import { normalizeButtons, buildServicePayload } from './buttons';
import { normalizeAlerts, normalizeLookRules, resolveLook, type ResolvedLook } from './rules';
import { ButtonsView } from './ButtonsView';
import { AlertsView } from './AlertsView';
import { subscribeFastPoll, getFastPollValues } from './fast-poll';
import {
  getCachedStates, setCachedStates,
  getCachedAreas, setCachedAreas, patchCachedStates, reconcileStates,
  getCachedHistory, setCachedHistory,
} from './cache';
import { isHistoryEligible, HISTORY_TTL_MS, type HistorySeries } from './history';
import {
  CardGridView, StatusBoardView, RoomView,
  EntityCardView, EntityRowView, ClimateView, MediaView, CameraView, EmptyState,
} from './views';
import { DetailSheet } from './controls';
import { ConfigSection } from './ConfigSection';
import { isPublishableEntityId } from './shared-state';
import { settingsHaUrl } from './settings';

export default function HomeAssistantPlugin({ config: rawConfig, style }: PluginComponentProps) {
  // Memo on the primitive fields (compared by value) + a joined entities key
  // so a fresh rawConfig object reference doesn't invalidate the result when
  // the actual contents are unchanged. Without this, every parent render
  // would rebuild `config` and retrigger downstream effects / memos.
  const entitiesKey = Array.isArray(rawConfig.entities)
    ? (rawConfig.entities as string[]).join('\n') : '';
  // Buttons/alerts/look rules are small row objects; a JSON key is the
  // cheapest stable value-compare (same trick as entitiesKey, which can't
  // cover objects).
  const buttonsKey = rawConfig.buttons != null ? JSON.stringify(rawConfig.buttons) : '';
  const alertsKey = rawConfig.alerts != null ? JSON.stringify(rawConfig.alerts) : '';
  const lookRulesKey = rawConfig.lookRules != null ? JSON.stringify(rawConfig.lookRules) : '';
  // Read the plugin-level URL once per render and feed it to the memo: it is
  // host state, not part of rawConfig, so without this dep a plugin-settings
  // change would leave already-mounted widgets polling the old server until
  // remount while the StateProvider (which gets settings as a prop) had
  // already switched.
  const settingsUrl = settingsHaUrl();
  const config = React.useMemo(
    () => normalizeConfig(rawConfig),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      rawConfig.view, rawConfig.area,
      rawConfig.refreshInterval, rawConfig.showHeader, rawConfig.columns,
      rawConfig.showControls, rawConfig.compactMode, rawConfig.fastUpdates,
      rawConfig.showHistory, settingsUrl, entitiesKey, buttonsKey,
      alertsKey, lookRulesKey,
    ],
  );
  const [states, setStates] = React.useState<HAStateObject[] | null>(() =>
    config.haUrl ? getCachedStates(config.haUrl) : null);
  // Authoritative copy of `states`, updated synchronously by applyStates so
  // code running outside render — the poll tick's reconcile, the fast-merge
  // listener, optimistic patches — always reads the latest applied array. A
  // mirror synced by effect lags a render behind, which let a poll response
  // landing right after an optimistic patch reconcile against the pre-patch
  // array and wipe the patch. Every write to `states` goes through
  // applyStates; never call setStates directly.
  const statesRef = React.useRef(states);
  const applyStates = React.useCallback((
    update: HAStateObject[] | null
      | ((prev: HAStateObject[] | null) => HAStateObject[] | null),
  ) => {
    const next = typeof update === 'function' ? update(statesRef.current) : update;
    if (next === statesRef.current) return;
    statesRef.current = next;
    setStates(next);
  }, []);
  const [areas, setAreas] = React.useState<HAArea[] | null>(() =>
    config.haUrl ? getCachedAreas(config.haUrl) : null);
  const [error, setError] = React.useState<string | null>(null);

  // The plugin-level URL can change without a remount (see the settingsUrl
  // memo dep above). The held snapshot describes the previous server, and
  // reconcileStates compares last_updated stamps that only order cleanly
  // within one server — carrying it over would let old-server entities win
  // reconciles against the new server (and get cached under its URL). Drop
  // it and reseed from the new URL's cache before its first poll lands.
  const prevUrlRef = React.useRef(config.haUrl);
  React.useEffect(() => {
    if (prevUrlRef.current === config.haUrl) return;
    prevUrlRef.current = config.haUrl;
    applyStates(config.haUrl ? getCachedStates(config.haUrl) : null);
    setAreas(config.haUrl ? getCachedAreas(config.haUrl) : null);
    setError(null);
  }, [config.haUrl, applyStates]);

  // Data loop — poll /api/states on the configured interval. The server-side
  // proxy + display cache make repeat polls across multiple module instances
  // cheap, but we still debounce here to avoid piling up in flight.
  // normalizeConfig already clamps refreshInterval to [5, 3600] seconds.
  const refreshMs = config.refreshInterval * 1000;

  // Guards setState calls after an optimistic service invocation — a user
  // tapping a card right before the module unmounts (screen change, config
  // save) would otherwise trip a React warning and worse, invoke setStates
  // on a dead component.
  const isMountedRef = React.useRef(true);
  React.useEffect(() => () => { isMountedRef.current = false; }, []);
  React.useEffect(() => {
    // The buttons view renders config rows, not entities — polling every HA
    // state each interval would be pure waste for it.
    if (!config.haUrl || config.view === 'buttons') return;
    let cancelled = false;
    let inflight = false;
    async function tick() {
      if (inflight || cancelled) return;
      inflight = true;
      try {
        // Proxy TTL kept strictly below the interval — with TTL equal to the
        // interval each tick would re-serve the previous tick's snapshot
        // (same rule as the StateProvider's full poll). The interval/2 floor
        // covers the 5s minimum interval, where interval minus 5s hits zero.
        const next = await fetchStates(
          config.haUrl, Math.max(refreshMs / 2, refreshMs - 5_000));
        if (!cancelled) {
          // A snapshot can still predate a service call's optimistic patch or
          // a fast-lane merge (the proxy cache is shared across modules and
          // displays); reconcile instead of replacing wholesale so a stale
          // snapshot can't flip freshly-changed entities backwards.
          const fast = config.fastUpdates ? getFastPollValues(config.haUrl) : null;
          const merged = reconcileStates(statesRef.current, next, fast);
          applyStates(merged);
          setCachedStates(config.haUrl, merged, refreshMs);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Fetch failed');
      } finally {
        inflight = false;
      }
    }
    tick();
    const id = setInterval(tick, refreshMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [config.haUrl, refreshMs, config.view, config.fastUpdates, applyStates]);

  // Fast lane — a shared 2s state-only poll (see fast-poll.ts) that merges
  // fresh `state` values into the full-poll snapshot, so bus publishes and
  // card badges flip near-immediately instead of waiting out refreshInterval.
  // Merge-only by design: entities unseen by the full poll are skipped (a
  // state-only stub without attributes would break card rendering), and the
  // first full poll runs at mount so that window is tiny. `config.entities`
  // is referentially stable via the entitiesKey memo above.
  // The alerts view watches its rules' entities instead of config.entities
  // (which stays empty for it) — a firing alert should pop within the 2s
  // lane, not wait out the refresh interval.
  const fastIds = React.useMemo(() => {
    const ids = config.view === 'alerts'
      ? config.alerts.map((a) => a.entityId)
      : config.entities;
    return Array.from(new Set(ids)).filter(isPublishableEntityId);
  }, [config.view, config.alerts, config.entities]);
  React.useEffect(() => {
    if (!config.fastUpdates || !config.haUrl) return;
    const ids = fastIds;
    if (ids.length === 0) return;
    return subscribeFastPoll(config.haUrl, ids, (updates) => {
      if (!isMountedRef.current) return;
      applyStates((prev) => {
        if (!prev) return prev;
        // The hub notifies every subscriber of every changed ref on the
        // loop; attribute refs (StateProvider demand) carry attribute
        // values, so only plain state refs may merge into card state.
        const fresh = new Map(
          updates.filter((u) => !u.ref.includes(':')).map((u) => [u.ref, u.value]),
        );
        let changed = false;
        const next = prev.map((s) => {
          const value = fresh.get(s.entity_id);
          if (value === undefined || value === s.state) return s;
          changed = true;
          // The state-only lane doesn't carry last_changed; stamp the merge
          // time as an upper bound on the real transition. Cards' relative
          // times read truer, and alert acks recorded against this stamp
          // stay valid when the full poll brings the (earlier) real value.
          return { ...s, state: value, last_changed: new Date().toISOString() };
        });
        return changed ? next : prev;
      });
    });
  }, [config.fastUpdates, config.haUrl, fastIds, applyStates]);

  // Area fetch — only when the room view needs it.
  React.useEffect(() => {
    if (!config.haUrl || config.view !== 'room') return;
    let cancelled = false;
    (async () => {
      try {
        const a = await fetchAreas(config.haUrl);
        if (!cancelled) { setAreas(a); setCachedAreas(config.haUrl, a, AREAS_TTL_MS); }
      } catch (e) {
        // Non-fatal — RoomView falls back to "Other" grouping. Log so an
        // admin debugging a missing-areas bug can see why instead of
        // staring at silently-empty groups.
        window.__HS_SDK__?.emit({
          type: 'log', level: 'warn',
          message: `HA areas fetch failed: ${e instanceof Error ? e.message : 'unknown'}`,
        });
      }
    })();
    return () => { cancelled = true; };
  }, [config.haUrl, config.view]);

  // Filter states down to the configured entities. For single-entity views
  // we let the view pick the first match of the right domain.
  const entitySet = React.useMemo(() => new Set(config.entities), [config.entities]);

  // Sparkline history — one batched call for every eligible entity, shared
  // across modules via the display cache, never on the fast lane. The 60s
  // re-check mostly probes the cache; a real refetch happens only when the
  // 15-minute TTL lapses (and the quantized window keeps the URL stable so
  // the host proxy's GET cache dedupes across displays too).
  const historyIdsKey = React.useMemo(() => {
    if (!config.showHistory || !states) return '';
    return states
      .filter((s) => entitySet.has(s.entity_id) && isHistoryEligible(s))
      .map((s) => s.entity_id)
      .sort()
      .join(',');
  }, [config.showHistory, states, entitySet]);
  const [history, setHistory] = React.useState<Record<string, HistorySeries> | null>(null);
  React.useEffect(() => {
    if (!config.haUrl || !historyIdsKey) { setHistory(null); return; }
    let cancelled = false;
    let inflight = false;
    async function load() {
      if (inflight || cancelled) return;
      const cached = getCachedHistory(config.haUrl, historyIdsKey);
      if (cached) { setHistory(cached); return; }
      inflight = true;
      try {
        const h = await fetchHistory(config.haUrl, historyIdsKey.split(','));
        if (!cancelled) {
          setHistory(h);
          setCachedHistory(config.haUrl, historyIdsKey, h, HISTORY_TTL_MS);
        }
      } catch (e) {
        // Non-fatal: cards simply render without sparklines until a later
        // pass succeeds. Log for the admin debugging a missing-history bug.
        if (!cancelled) {
          window.__HS_SDK__?.emit({
            type: 'log', level: 'warn',
            message: `HA history fetch failed: ${e instanceof Error ? e.message : 'unknown'}`,
          });
        }
      } finally {
        inflight = false;
      }
    }
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [config.haUrl, historyIdsKey]);
  const visibleStates = React.useMemo(() => {
    if (!states) return [];
    return states
      .filter((s) => entitySet.has(s.entity_id))
      .sort((a, b) => {
        const ai = config.entities.indexOf(a.entity_id);
        const bi = config.entities.indexOf(b.entity_id);
        return ai - bi;
      });
  }, [states, entitySet, config.entities]);

  // NOTE: this component no longer publishes to the shared-state bus. The
  // headless StateProvider (manifest `exports.stateProvider`, mounted once
  // by the host) is the sole publisher, fed the demand-driven key set — the
  // whole visible-instance publish path, its cross-instance clear
  // arbitration, and the `backgroundProvider` setup it required are gone.

  // Service caller with optimistic cache-patch. Views pass this down to
  // cards; cards invoke it on tap. Disabled when showControls is off.
  // Per-entity monotonic tokens make the merge last-action-wins: two quick
  // slider releases can resolve out of order, and without the token the
  // earlier response would overwrite the later command's value until the
  // next full poll (the fast lane never repairs attributes).
  const commandSeq = React.useRef(new Map<string, number>());
  const onCommand = React.useCallback(async (
    state: HAStateObject, service: string, data: Record<string, unknown> = {},
  ) => {
    const domain = state.entity_id.split('.')[0];
    const seq = (commandSeq.current.get(state.entity_id) ?? 0) + 1;
    commandSeq.current.set(state.entity_id, seq);
    try {
      const updated = await callService(config.haUrl, domain, service, state.entity_id, data);
      if (!isMountedRef.current) return;
      if (commandSeq.current.get(state.entity_id) !== seq) return;
      if (updated.length > 0) {
        patchCachedStates(config.haUrl, updated);
        // Apply directly to local state too — patchCachedStates silently
        // drops the patch when the cache entry has expired (TTL = refresh
        // interval), which would swallow the optimistic UI flip until the
        // next poll. Merging into `states` here keeps the tap responsive.
        applyStates((prev) => {
          if (!prev) return prev;
          const byId = new Map(prev.map((s) => [s.entity_id, s]));
          for (const u of updated) byId.set(u.entity_id, u);
          return Array.from(byId.values());
        });
      }
    } catch (e) {
      if (!isMountedRef.current) return;
      window.__HS_SDK__?.emit({ type: 'log', level: 'warn',
        message: `HA ${domain}.${service} failed: ${e instanceof Error ? e.message : 'unknown'}` });
    }
  }, [config.haUrl, applyStates]);

  // Buttons view — invoke a configured row's service. Rejections propagate
  // to the tile (it owns the "Didn't work" flash); the log line is for the
  // admin debugging a button that never works.
  const onInvokeButton = React.useCallback(async (row: HAButtonRow) => {
    try {
      const updated = await invokeService(
        config.haUrl, row.domain, row.service, buildServicePayload(row));
      if (!isMountedRef.current) return;
      // Changed states flow into the shared cache so entity views on the
      // same display flip instantly.
      if (updated.length > 0) patchCachedStates(config.haUrl, updated);
    } catch (e) {
      window.__HS_SDK__?.emit({ type: 'log', level: 'warn',
        message: `HA button ${row.domain}.${row.service} failed: ${e instanceof Error ? e.message : 'unknown'}` });
      throw e;
    }
  }, [config.haUrl]);

  // Long-press detail sheet. Track the entity id (not the state object) so
  // the open sheet always renders the freshest state from the poll/fast-lane
  // merges — sliders and the power button reflect live changes.
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const onOpenDetail = React.useCallback(
    (s: HAStateObject) => setDetailId(s.entity_id), []);
  const closeDetail = React.useCallback(() => setDetailId(null), []);
  const detailState = detailId != null && config.showControls
    ? states?.find((s) => s.entity_id === detailId) ?? null
    : null;

  // Look rules recolor entities wherever they render; absent rules keep the
  // hot path allocation-free (views skip the lookup entirely).
  const lookFor = React.useMemo(() => {
    if (config.lookRules.length === 0) return undefined;
    return (s: HAStateObject) => resolveLook(config.lookRules, s);
  }, [config.lookRules]);

  return (
    <RootFrame style={style} chromeless={config.view === 'alerts'}>
      {/* The alerts view is invisible while idle — chrome would betray it. */}
      {config.showHeader && config.view !== 'alerts' && (
        <Header config={config} error={error}
          loaded={states != null || config.view === 'buttons'} />
      )}
      {renderBody({ config, visibleStates, areas, rawStates: states, error, onCommand, onOpenDetail, onInvokeButton, history, lookFor })}
      {detailState && (
        <DetailSheet state={detailState} onCommand={onCommand} onClose={closeDetail} />
      )}
    </RootFrame>
  );
}

// Re-export so the host loader can pick up the config section and state
// provider under their named exports (matching "exports.configSection" /
// "exports.stateProvider" in manifest.json), plus the conventional named
// exports read directly off the IIFE (no manifest entries):
// deriveProvidedKeys feeds the editor's static key picker, searchStateKeys
// powers its friendly condition-builder search.
export { ConfigSection };
export { StateProvider } from './StateProvider';
export { deriveProvidedKeys } from './shared-state';
export { searchStateKeys } from './search';

// ── Helpers ────────────────────────────────────────────────────────────────

const AREAS_TTL_MS = 60_000;

const VALID_VIEWS: ReadonlySet<HAView> = new Set<HAView>([
  'card-grid', 'status-board', 'room',
  'entity-card', 'entity-row', 'climate', 'media', 'cameras', 'buttons',
  'alerts',
]);

function normalizeConfig(raw: Record<string, unknown>): HAPluginConfig {
  const rawView = raw.view;
  const view: HAView = typeof rawView === 'string' && VALID_VIEWS.has(rawView as HAView)
    ? (rawView as HAView)
    : 'card-grid';
  const rawRefresh = typeof raw.refreshInterval === 'number' ? raw.refreshInterval : 30;
  const rawColumns = typeof raw.columns === 'number' ? raw.columns : 2;
  return {
    view,
    // The plugin-level setting is the ONLY connection source (modules carry
    // no connection config). Injected here — the single normalization choke
    // point — so the settings-sourced URL flows to every haUrl consumer
    // (fast-poll hub keys, display cache keys, camera URLs) without a second
    // connection-identity concept.
    haUrl: settingsHaUrl(),
    entities: Array.isArray(raw.entities) ? (raw.entities as string[]) : [],
    area: (raw.area as string | null | undefined) ?? null,
    // Clamp centrally so every consumer (polling loop, cameras view, preview
    // pane) gets the same range. Floor at 5 s to prevent a DoS loop; cap at
    // 1 h to match the upstream proxy's cacheTtl ceiling.
    refreshInterval: Math.max(5, Math.min(3600, rawRefresh)),
    showHeader: raw.showHeader !== false,
    columns: Math.max(1, Math.min(4, rawColumns)),
    showControls: raw.showControls !== false,
    compactMode: raw.compactMode === true,
    fastUpdates: raw.fastUpdates !== false,
    showHistory: raw.showHistory === true,
    buttons: normalizeButtons(raw.buttons),
    alerts: normalizeAlerts(raw.alerts),
    lookRules: normalizeLookRules(raw.lookRules),
  };
}

function RootFrame({ style, chromeless, children }: {
  style: ModuleStyle;
  /** Alerts view: suppress the module surface (background, blur) so the
   *  module is truly invisible while idle — the tiles paint their own
   *  scrims. The host style's background would otherwise leave a dark
   *  rounded rectangle sitting over the photo screen. */
  chromeless?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      // Anchors the absolutely-positioned detail-sheet overlay.
      position: 'relative',
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      color: style.textColor,
      backgroundColor: chromeless ? 'transparent' : style.backgroundColor,
      borderRadius: style.borderRadius,
      padding: style.padding,
      opacity: style.opacity,
      backdropFilter: chromeless ? undefined : `blur(${style.backdropBlur ?? 0}px)`,
      WebkitBackdropFilter: chromeless ? undefined : `blur(${style.backdropBlur ?? 0}px)`,
      boxSizing: 'border-box',
    }}>
      {children}
    </div>
  );
}

function Header({ config, error, loaded }: { config: HAPluginConfig; error: string | null; loaded: boolean }) {
  const dotColor = error ? '#ef4444' : loaded ? '#22c55e' : 'rgba(255,255,255,0.3)';
  const title = labelForView(config.view);
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '14px 16px 6px', fontSize: 10, letterSpacing: '0.14em',
      color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase',
      flexShrink: 0,
    }}>
      <span>{title}</span>
      <span title={error ?? 'Connected'} style={{
        width: 6, height: 6, borderRadius: 99, background: dotColor,
        boxShadow: dotColor !== 'rgba(255,255,255,0.3)' ? `0 0 6px ${dotColor}` : undefined,
      }} />
    </div>
  );
}

function labelForView(v: HAPluginConfig['view']): string {
  switch (v) {
    case 'entity-card': return 'Entity';
    case 'entity-row': return 'Entity';
    case 'card-grid': return 'Home Assistant';
    case 'status-board': return 'Status Board';
    case 'room': return 'By Area';
    case 'climate': return 'Climate';
    case 'media': return 'Now Playing';
    case 'cameras': return 'Cameras';
    case 'buttons': return 'Buttons';
    case 'alerts': return 'Alerts';
    default: {
      // A new HAView that isn't handled here is a compile-time error.
      const _exhaustive: never = v;
      void _exhaustive;
      return 'Home Assistant';
    }
  }
}

function renderBody(args: {
  config: HAPluginConfig;
  visibleStates: HAStateObject[];
  areas: HAArea[] | null;
  rawStates: HAStateObject[] | null;
  error: string | null;
  onCommand: (state: HAStateObject, service: string, data?: Record<string, unknown>) => void;
  onOpenDetail: (state: HAStateObject) => void;
  onInvokeButton: (row: HAButtonRow) => Promise<void>;
  history: Record<string, HistorySeries> | null;
  lookFor?: (s: HAStateObject) => ResolvedLook | undefined;
}) {
  const { config, visibleStates, areas, rawStates, error, onCommand, onOpenDetail, onInvokeButton, history, lookFor } = args;

  if (!config.haUrl) {
    // Alerts stay invisible even unconfigured — a setup hint painted over a
    // photo screen would defeat the whole "nothing rendered" contract. The
    // editor preview is where an unconfigured alerts module explains itself.
    if (config.view === 'alerts') return null;
    return <EmptyState message="Connect Home Assistant in this widget's settings to get started." />;
  }
  // Buttons need no entity states — skip the loading/empty gates below.
  if (config.view === 'buttons') {
    if (config.buttons.length === 0) {
      return <EmptyState message="Add some buttons in this widget's settings to get started." />;
    }
    return (
      <ButtonsView config={config}
        onInvoke={config.showControls ? onInvokeButton : undefined} />
    );
  }
  // Alerts render nothing while connecting, erroring, or idle — the view
  // owns the whole "invisible until a rule fires" contract.
  if (config.view === 'alerts') {
    return <AlertsView config={config} states={rawStates} />;
  }
  if (rawStates == null && error) {
    return <EmptyState message={`Couldn't reach Home Assistant: ${error}`} />;
  }
  if (rawStates == null) {
    return <EmptyState message="Connecting…" />;
  }
  if (visibleStates.length === 0 && config.view !== 'cameras') {
    return <EmptyState message="No entities selected yet. Pick some in the module config." />;
  }

  const viewProps = {
    states: visibleStates,
    config,
    areas: areas ?? undefined,
    onCommand: config.showControls ? onCommand : undefined,
    onOpenDetail: config.showControls ? onOpenDetail : undefined,
    history: config.showHistory ? history ?? undefined : undefined,
    lookFor,
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
    default: return <CardGridView {...viewProps} />;
  }
}
