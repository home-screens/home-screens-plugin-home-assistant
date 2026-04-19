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
import type { HAStateObject, HAArea, HAPluginConfig } from './types';
import { fetchStates, fetchAreas, callService } from './api';
import {
  getCachedStates, setCachedStates,
  getCachedAreas, setCachedAreas, patchCachedStates,
} from './cache';
import {
  CardGridView, StatusBoardView, RoomView,
  EntityCardView, EntityRowView, ClimateView, MediaView, CameraView, EmptyState,
} from './views';
import { ConfigSection } from './ConfigSection';

export default function HomeAssistantPlugin({ config: rawConfig, style }: PluginComponentProps) {
  const config = normalizeConfig(rawConfig);
  const [states, setStates] = React.useState<HAStateObject[] | null>(() =>
    config.haUrl ? getCachedStates(config.haUrl) : null);
  const [areas, setAreas] = React.useState<HAArea[] | null>(() =>
    config.haUrl ? getCachedAreas(config.haUrl) : null);
  const [error, setError] = React.useState<string | null>(null);

  // Data loop — poll /api/states on the configured interval. The server-side
  // proxy + display cache make repeat polls across multiple module instances
  // cheap, but we still debounce here to avoid piling up in flight.
  // Floor at 5 s so nobody accidentally configures a DoS loop; cap at 1 h
  // since that's the upstream proxy's own cacheTtl ceiling.
  const refreshMs = Math.max(5, Math.min(3600, config.refreshInterval ?? 30)) * 1000;
  React.useEffect(() => {
    if (!config.haUrl) return;
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
  }, [config.haUrl, refreshMs]);

  // Area fetch — only when the room view needs it. 60s TTL.
  React.useEffect(() => {
    if (!config.haUrl || config.view !== 'room') return;
    let cancelled = false;
    (async () => {
      try {
        const a = await fetchAreas(config.haUrl);
        if (!cancelled) { setAreas(a); setCachedAreas(config.haUrl, a, 60_000); }
      } catch {
        // Non-fatal — RoomView falls back to "Other" grouping.
      }
    })();
    return () => { cancelled = true; };
  }, [config.haUrl, config.view]);

  // Filter states down to the configured entities. For single-entity views
  // we let the view pick the first match of the right domain.
  const entitySet = React.useMemo(() => new Set(config.entities), [config.entities]);
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

  // Service caller with optimistic cache-patch. Views pass this down to
  // cards; cards invoke it on tap. Disabled when showControls is off.
  const onCommand = React.useCallback(async (
    state: HAStateObject, service: string, data: Record<string, unknown> = {},
  ) => {
    const domain = state.entity_id.split('.')[0];
    try {
      const updated = await callService(config.haUrl, domain, service, state.entity_id, data);
      if (updated.length > 0) {
        patchCachedStates(config.haUrl, updated);
        const fresh = getCachedStates(config.haUrl);
        if (fresh) setStates(fresh);
      }
    } catch (e) {
      window.__HS_SDK__.emit({ type: 'log', level: 'warn',
        message: `HA ${domain}.${service} failed: ${e instanceof Error ? e.message : 'unknown'}` });
    }
  }, [config.haUrl]);

  return (
    <RootFrame style={style}>
      {config.showHeader && <Header config={config} error={error} loaded={states != null} />}
      {renderBody({ config, visibleStates, areas, rawStates: states, error, onCommand })}
    </RootFrame>
  );
}

// Re-export so the host loader can pick up the config section under its
// named export (matches "exports.configSection" in manifest.json).
export { ConfigSection };

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeConfig(raw: Record<string, unknown>): HAPluginConfig {
  return {
    view: ((raw.view as string) || 'card-grid') as HAPluginConfig['view'],
    haUrl: (raw.haUrl as string) || '',
    entities: Array.isArray(raw.entities) ? (raw.entities as string[]) : [],
    area: (raw.area as string | null | undefined) ?? null,
    refreshInterval: typeof raw.refreshInterval === 'number' ? raw.refreshInterval : 30,
    showHeader: raw.showHeader !== false,
    columns: typeof raw.columns === 'number' ? raw.columns : 2,
    showControls: raw.showControls !== false,
    compactMode: raw.compactMode === true,
  };
}

function RootFrame({ style, children }: { style: ModuleStyle; children: React.ReactNode }) {
  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
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
  }
}

function renderBody(args: {
  config: HAPluginConfig;
  visibleStates: HAStateObject[];
  areas: HAArea[] | null;
  rawStates: HAStateObject[] | null;
  error: string | null;
  onCommand: (state: HAStateObject, service: string, data?: Record<string, unknown>) => void;
}) {
  const { config, visibleStates, areas, rawStates, error, onCommand } = args;

  if (!config.haUrl) {
    return <EmptyState message="Configure a Home Assistant URL and token in the editor to get started." />;
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
