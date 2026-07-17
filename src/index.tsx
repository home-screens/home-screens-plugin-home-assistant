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
import { ButtonsView } from './ButtonsView';
import { subscribeFastPoll } from './fast-poll';
import {
  getCachedStates, setCachedStates,
  getCachedAreas, setCachedAreas, patchCachedStates,
  getCachedHistory, setCachedHistory,
} from './cache';
import { isHistoryEligible, HISTORY_TTL_MS, type HistorySeries } from './history';
import {
  CardGridView, StatusBoardView, RoomView,
  EntityCardView, EntityRowView, ClimateView, MediaView, CameraView, EmptyState,
} from './views';
import { LightDetailSheet } from './controls';
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
  // Buttons are small row objects; a JSON key is the cheapest stable
  // value-compare (same trick as entitiesKey, which can't cover objects).
  const buttonsKey = rawConfig.buttons != null ? JSON.stringify(rawConfig.buttons) : '';
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
    ],
  );
  const [states, setStates] = React.useState<HAStateObject[] | null>(() =>
    config.haUrl ? getCachedStates(config.haUrl) : null);
  const [areas, setAreas] = React.useState<HAArea[] | null>(() =>
    config.haUrl ? getCachedAreas(config.haUrl) : null);
  const [error, setError] = React.useState<string | null>(null);

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
        const next = await fetchStates(config.haUrl, refreshMs);
        if (!cancelled) {
          setStates(next);
          setCachedStates(config.haUrl, next, refreshMs);
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
  }, [config.haUrl, refreshMs, config.view]);

  // Fast lane — a shared 2s state-only poll (see fast-poll.ts) that merges
  // fresh `state` values into the full-poll snapshot, so bus publishes and
  // card badges flip near-immediately instead of waiting out refreshInterval.
  // Merge-only by design: entities unseen by the full poll are skipped (a
  // state-only stub without attributes would break card rendering), and the
  // first full poll runs at mount so that window is tiny. `config.entities`
  // is referentially stable via the entitiesKey memo above.
  React.useEffect(() => {
    if (!config.fastUpdates || !config.haUrl) return;
    const ids = config.entities.filter(isPublishableEntityId);
    if (ids.length === 0) return;
    return subscribeFastPoll(config.haUrl, ids, (updates) => {
      if (!isMountedRef.current) return;
      setStates((prev) => {
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
          return { ...s, state: value };
        });
        return changed ? next : prev;
      });
    });
  }, [config.fastUpdates, config.haUrl, config.entities]);

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
        setStates((prev) => {
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
  }, [config.haUrl]);

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

  return (
    <RootFrame style={style}>
      {config.showHeader && (
        <Header config={config} error={error}
          loaded={states != null || config.view === 'buttons'} />
      )}
      {renderBody({ config, visibleStates, areas, rawStates: states, error, onCommand, onOpenDetail, onInvokeButton, history })}
      {detailState && (
        <LightDetailSheet state={detailState} onCommand={onCommand} onClose={closeDetail} />
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
  };
}

function RootFrame({ style, children }: { style: ModuleStyle; children: React.ReactNode }) {
  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      // Anchors the absolutely-positioned detail-sheet overlay.
      position: 'relative',
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      color: style.textColor,
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      padding: style.padding,
      opacity: style.opacity,
      backdropFilter: `blur(${style.backdropBlur ?? 0}px)`,
      WebkitBackdropFilter: `blur(${style.backdropBlur ?? 0}px)`,
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
}) {
  const { config, visibleStates, areas, rawStates, error, onCommand, onOpenDetail, onInvokeButton, history } = args;

  if (!config.haUrl) {
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
