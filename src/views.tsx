// Display views. Each view takes the resolved entity states (filtered down
// to config.entities) and renders them in a specific layout. index.tsx
// picks one based on config.view.

import React from 'react';
import type { HAStateObject, HAArea, HAPluginConfig } from './types';
import { entityDomain } from './types';
import { friendlyName, formatValue, relativeTime, isActiveState, isAlertState } from './utils';
import { Icon, iconFor } from './icons';
import { EntityCard, type CardCommand } from './cards';
import { fetchCameraSnapshot } from './api';

interface ViewProps {
  states: HAStateObject[];
  config: HAPluginConfig;
  areas?: HAArea[];
  onCommand?: CardCommand;
  // Set by the config-modal preview pane. Views that do expensive polling
  // (snapshots, streams) should throttle or disable live fetches so that
  // opening the modal doesn't multiply network load.
  preview?: boolean;
}

// ── Card Grid ───────────────────────────────────────────────────────────────

export function CardGridView({ states, config, onCommand }: ViewProps) {
  const cols = Math.max(1, Math.min(4, config.columns ?? 2));
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gap: 10,
        padding: '8px 14px 14px',
      }}
    >
      {states.map((s) => (
        <EntityCard key={s.entity_id} state={s} compact={config.compactMode} onCommand={onCommand} />
      ))}
    </div>
  );
}

// ── Status Board ────────────────────────────────────────────────────────────

const DOMAIN_LABELS: Record<string, string> = {
  light: 'Lights', switch: 'Switches', sensor: 'Sensors', binary_sensor: 'Binary Sensors',
  climate: 'Climate', media_player: 'Media', cover: 'Covers', lock: 'Locks',
  person: 'People', weather: 'Weather', fan: 'Fans', camera: 'Cameras',
  scene: 'Scenes', automation: 'Automations', input_boolean: 'Toggles',
};

export function StatusBoardView({ states }: ViewProps) {
  const groups = new Map<string, HAStateObject[]>();
  for (const s of states) {
    const d = entityDomain(s.entity_id);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(s);
  }
  const ordered = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div style={{ padding: '6px 12px 14px' }}>
      {ordered.map(([domain, entities]) => {
        const activeCount = entities.filter(isActiveState).length;
        return (
          <div key={domain} style={{ marginTop: 12 }}>
            <div style={{
              fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em',
              color: 'rgba(255,255,255,0.45)', padding: '4px 8px',
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>{DOMAIN_LABELS[domain] ?? capitalizeDomain(domain)}</span>
              <span>{entities.length}{activeCount > 0 && ` · ${activeCount} active`}</span>
            </div>
            {entities.map((s, i) => (
              <StatusRow key={s.entity_id} state={s} first={i === 0} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function StatusRow({ state, first }: { state: HAStateObject; first: boolean }) {
  const active = isActiveState(state);
  const alert = isAlertState(state);
  const color = alert ? '#f87171' : active ? '#fbbf24' : 'rgba(255,255,255,0.5)';
  const dot = alert ? '#ef4444' : active ? '#22c55e' : 'rgba(255,255,255,0.15)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
      borderTop: first ? 'none' : '1px solid rgba(255,255,255,0.04)',
    }}>
      <Icon name={iconFor(state)} size={15} style={{ color, flexShrink: 0 }} />
      <span style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {friendlyName(state)}
      </span>
      <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', fontVariantNumeric: 'tabular-nums' }}>
        {formatValue(state)}
      </span>
      <span style={{
        width: 6, height: 6, borderRadius: 99, background: dot,
        boxShadow: active || alert ? `0 0 6px ${dot}` : undefined,
      }} />
    </div>
  );
}

function capitalizeDomain(d: string): string {
  return d.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Room View ───────────────────────────────────────────────────────────────

export function RoomView({ states, config, areas, onCommand }: ViewProps) {
  const byEntityId = new Map(states.map((s) => [s.entity_id, s]));
  const selectedSet = new Set(config.entities);

  // Build groups: { areaName → entities chosen that live in that area }
  const groups: { name: string; entities: HAStateObject[] }[] = [];
  const claimed = new Set<string>();

  // Restrict to a single area when the user selected one in config.
  const areaScope = config.area && areas
    ? areas.filter((a) => a.area_id === config.area)
    : areas;

  if (areaScope) {
    for (const area of areaScope) {
      const rooms: HAStateObject[] = [];
      for (const eid of area.entities) {
        if (!selectedSet.has(eid)) continue;
        const s = byEntityId.get(eid);
        if (s) { rooms.push(s); claimed.add(eid); }
      }
      if (rooms.length > 0) groups.push({ name: area.name, entities: rooms });
    }
  }
  // Unassigned fallback — skip when a specific area is selected; anything
  // outside the chosen area should be hidden, not relabeled as "Other".
  if (!config.area) {
    const other = states.filter((s) => !claimed.has(s.entity_id));
    if (other.length > 0) groups.push({ name: 'Other', entities: other });
  }

  return (
    <div style={{ padding: '6px 14px 14px' }}>
      {groups.map((g) => (
        <div key={g.name} style={{ marginTop: 14 }}>
          <div style={{
            fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em',
            padding: '2px 2px 8px', display: 'flex', alignItems: 'baseline', gap: 8,
          }}>
            <span>{g.name}</span>
            <span style={{
              fontSize: 10, color: 'rgba(255,255,255,0.45)',
              background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: 99,
              letterSpacing: '0.04em',
            }}>{g.entities.length} {g.entities.length === 1 ? 'entity' : 'entities'}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {g.entities.map((s) => (
              <EntityCard key={s.entity_id} state={s} compact onCommand={onCommand} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Single Entity Card ──────────────────────────────────────────────────────

export function EntityCardView({ states }: ViewProps) {
  const s = states[0];
  if (!s) return <EmptyState message="Pick an entity in the module config." />;
  return (
    <div style={{
      height: '100%', padding: '28px 24px',
      display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.16em',
        color: 'rgba(255,255,255,0.45)',
      }}>
        <Icon name={iconFor(s)} size={20} style={{ color: '#fb923c' }} />
        <span>{friendlyName(s)}</span>
      </div>
      <div style={{
        fontSize: 72, fontWeight: 600, letterSpacing: '-0.04em', lineHeight: 0.95,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {formatValue(s)}
      </div>
      <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13 }}>
        {relativeTime(s.last_changed)}
      </div>
    </div>
  );
}

// ── Single Row ──────────────────────────────────────────────────────────────

export function EntityRowView({ states }: ViewProps) {
  const s = states[0];
  if (!s) return <EmptyState message="Pick an entity in the module config." />;
  return (
    <div style={{
      height: '100%', padding: '0 18px',
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <Icon name={iconFor(s)} size={22} style={{ color: isActiveState(s) ? '#fbbf24' : 'rgba(255,255,255,0.55)', flexShrink: 0 }} />
      <span style={{ fontSize: 14, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {friendlyName(s)}
      </span>
      <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
        {formatValue(s)}
      </span>
    </div>
  );
}

// ── Climate Dedicated ───────────────────────────────────────────────────────

export function ClimateView({ states }: ViewProps) {
  const climate = states.find((s) => entityDomain(s.entity_id) === 'climate');
  if (!climate) return <EmptyState message="Pick a climate entity in the module config." />;
  const cur = climate.attributes.current_temperature;
  const target = climate.attributes.temperature;
  const action = climate.attributes.hvac_action ?? climate.state;
  const humidity = climate.attributes.current_humidity;
  const modes = climate.attributes.hvac_modes ?? ['heat', 'cool', 'auto', 'off'];

  // Arc progress range: prefer the entity's own min_temp / max_temp (always
  // expressed in the entity's native unit). Fall back to a crude reading-
  // based heuristic only when the attributes are missing — a livable indoor
  // °C reading never exceeds ~45, while °F is always ≥45. Using the entity's
  // own bounds fixes edge cases (outdoor -5°C, boiler 60°C) that break the
  // heuristic.
  const attrMin = climate.attributes.min_temp;
  const attrMax = climate.attributes.max_temp;
  const fahrenheitGuess = typeof cur === 'number' && cur > 45;
  const min = typeof attrMin === 'number' ? attrMin : fahrenheitGuess ? 60 : 15;
  const max = typeof attrMax === 'number' ? attrMax : fahrenheitGuess ? 85 : 30;
  const span = max - min;
  const pct = cur != null && span > 0
    ? Math.max(0, Math.min(1, (cur - min) / span))
    : 0.5;
  const dash = 220;
  const filled = dash * pct;
  const grad = action === 'cooling' ? '#38bdf8' : '#fb923c';

  return (
    <div style={{
      padding: '20px 18px', display: 'flex', flexDirection: 'column',
      alignItems: 'center', gap: 14, height: '100%',
    }}>
      <div style={{
        fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.16em',
        color: 'rgba(255,255,255,0.45)',
      }}>{friendlyName(climate)}</div>

      <div style={{ position: 'relative', width: 200, height: 200 }}>
        <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%', transform: 'rotate(135deg)' }}>
          <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6"
            strokeDasharray={`${dash} 100`} strokeLinecap="round" />
          <circle cx="50" cy="50" r="44" fill="none" stroke={grad} strokeWidth="6"
            strokeDasharray={`${filled} 500`} strokeLinecap="round" />
        </svg>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 2,
        }}>
          <div style={{ fontSize: 52, fontWeight: 600, letterSpacing: '-0.04em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {cur != null ? `${cur}°` : '—'}
          </div>
          {target != null && (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 4 }}>
              target {target}°
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
        {pickVisibleModes(modes, climate.state).map((mode) => {
          const active = mode === climate.state;
          return (
            <span key={mode} style={{
              padding: '6px 12px', borderRadius: 10,
              background: active ? 'rgba(251, 146, 60, 0.15)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${active ? 'rgba(251, 146, 60, 0.4)' : 'rgba(255,255,255,0.1)'}`,
              color: active ? '#fdba74' : 'rgba(255,255,255,0.55)',
              fontSize: 11, letterSpacing: '-0.01em', textTransform: 'capitalize',
            }}>{mode.replace(/_/g, ' ')}</span>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 18, color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>
        {typeof humidity === 'number' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Icon name="droplet" size={12} />{humidity}%
          </span>
        )}
        <span style={{ textTransform: 'capitalize' }}>{action}</span>
      </div>
    </div>
  );
}

// ── Media Dedicated ─────────────────────────────────────────────────────────

// HA returns `entity_picture` as a string it controls. Before interpolating
// it into a CSS `background-image` we validate the shape — only http(s) or
// root-relative paths — to keep a hostile/compromised HA from injecting CSS
// payloads or `javascript:` URLs. Root-relative paths (the common case for
// HA media_player artwork: `/api/media-player-image/...`) are resolved
// against haUrl so the browser hits the HA origin, not the Home Screens
// host app — otherwise the host 404s the image and the gradient fallback
// shows silently.
//
// The returned string is guaranteed not to contain any CSS-structural
// character, so callers can safely wrap it in `url("…")`.
function safeArtworkUrl(raw: unknown, haUrl: string): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url) return null;
  // Reject parens/quotes/whitespace (url-token terminators), semicolons
  // (declaration terminators), angle brackets, backslashes, and all ASCII
  // control characters. Anything past this filter is safe to drop into a
  // quoted url("…") value.
  if (/[()"'\s;<>\\]/.test(url)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(url)) return null;
  if (url.startsWith('/')) {
    if (!haUrl) return null;
    return haUrl.replace(/\/+$/, '') + url;
  }
  return /^https?:\/\//i.test(url) ? url : null;
}

export function MediaView({ states, config }: ViewProps) {
  const mp = states.find((s) => entityDomain(s.entity_id) === 'media_player');
  if (!mp) return <EmptyState message="Pick a media_player entity." />;
  const art = safeArtworkUrl(mp.attributes.entity_picture, config.haUrl);
  const title = mp.attributes.media_title || friendlyName(mp);
  const artist = mp.attributes.media_artist;
  const album = mp.attributes.media_album_name;
  const playing = mp.state === 'playing';
  const pos = mp.attributes.media_position;
  const dur = mp.attributes.media_duration;
  const posUpdatedAt = mp.attributes.media_position_updated_at;

  // HA pushes media_position only on state transitions (play/pause/skip), so
  // between polls the bar looks frozen. Tick a 1 Hz counter while playing to
  // force re-renders, and extrapolate `pos` from media_position_updated_at
  // in real time.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!playing) return;
    // Deps intentionally minimal: the tick just bumps a counter, and every
    // render re-reads the freshest `mp` attributes — a track skip or entity
    // swap doesn't need to spin the interval down and back up.
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [playing]);

  let effectivePos = pos;
  if (typeof pos === 'number' && playing && typeof posUpdatedAt === 'string') {
    const anchored = Date.parse(posUpdatedAt);
    if (!Number.isNaN(anchored)) {
      const elapsed = Math.max(0, (Date.now() - anchored) / 1000);
      effectivePos = typeof dur === 'number' ? Math.min(dur, pos + elapsed) : pos + elapsed;
    }
  }

  // Use longhand background-image with a quoted url("…") so the validated
  // URL is delivered as an encoded attribute string rather than spliced into
  // the shorthand parser — defense in depth against CSS injection.
  const artBg: React.CSSProperties = art
    ? {
        backgroundImage: `url("${art}")`,
        backgroundPosition: 'center',
        backgroundSize: 'cover',
        backgroundRepeat: 'no-repeat',
      }
    : {};
  return (
    <div style={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', inset: 0,
        ...(art ? artBg : {
          backgroundImage: 'linear-gradient(135deg, #4338ca, #7e22ce 40%, #db2777)',
        }),
        filter: 'blur(32px) saturate(1.2)', transform: 'scale(1.2)', opacity: 0.55,
      }} />
      <div style={{
        position: 'relative', display: 'flex', flexDirection: 'column',
        alignItems: 'center', padding: 22, gap: 14, height: '100%',
        background: 'linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.7) 100%)',
      }}>
        <div style={{
          width: 160, height: 160, borderRadius: 12,
          ...(art ? artBg : {
            backgroundImage: 'linear-gradient(135deg, #4338ca, #db2777)',
          }),
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'rgba(255,255,255,0.5)', fontSize: 40, fontWeight: 300,
        }}>
          {!art && '♪'}
        </div>
        <div style={{ textAlign: 'center', maxWidth: '90%' }}>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
          {artist && (
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', marginTop: 2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {artist}{album ? ` · ${album}` : ''}
            </div>
          )}
        </div>
        {typeof effectivePos === 'number' && typeof dur === 'number' && dur > 0 && (
          <div style={{ width: '80%', display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 10, color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>
            <span>{fmtTime(effectivePos)}</span>
            <div style={{ flex: 1, height: 3, background: 'rgba(255,255,255,0.15)', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, (effectivePos / dur) * 100)}%`, height: '100%', background: '#fff' }} />
            </div>
            <span>{fmtTime(dur)}</span>
          </div>
        )}
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', textTransform: 'capitalize' }}>
          {playing ? 'Playing' : mp.state}
        </div>
      </div>
    </div>
  );
}

// Keep the pill strip at 4 entries, but never drop the active mode off the
// end — if the current mode is beyond the cap, swap it in.
function pickVisibleModes(modes: string[], current: string): string[] {
  const head = modes.slice(0, 4);
  if (!modes.includes(current) || head.includes(current)) return head;
  return [...head.slice(0, 3), current];
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ── Cameras ─────────────────────────────────────────────────────────────────

export function CameraView({ states, config, preview }: ViewProps) {
  const cams = states.filter((s) => entityDomain(s.entity_id) === 'camera');
  if (cams.length === 0) return <EmptyState message="No camera entities selected." />;
  // Camera snapshots are expensive — poll at roughly the configured interval
  // but floor at 5 s so a user with refreshInterval=15 doesn't hammer HA.
  // In the config-modal preview, cap at 60 s and skip MJPEG streams so
  // opening the modal doesn't multiply camera load N× while the user browses
  // entities.
  const refreshMs = preview
    ? 60_000
    : Math.max(5_000, (config.refreshInterval ?? 30) * 1000);
  return (
    <div style={{
      padding: 12, height: '100%',
      display: 'grid', gap: 8,
      gridTemplateColumns: `repeat(${cams.length > 1 ? 2 : 1}, 1fr)`,
    }}>
      {cams.map((s) => (
        <CameraTile key={s.entity_id} state={s} haUrl={config.haUrl}
          refreshMs={refreshMs} preview={preview} />
      ))}
    </div>
  );
}

// CameraTile tries MJPEG streaming first (what Lovelace does) and falls back
// to snapshot polling if the entity doesn't expose an access_token or if the
// stream <img> errors out.
//
// MJPEG path: HA camera entities publish a short-lived `access_token`
// attribute on /api/states. Combined with /api/camera_proxy_stream/<id> and
// the token-as-query-param auth that endpoint supports, we can hand a URL
// straight to <img src>. The browser renders multipart/x-mixed-replace as a
// live video stream — no hls.js, no WebRTC, no host proxy changes. The token
// rotates every few minutes; changing the `key` on the <img> forces a clean
// reconnect when a new state arrives with a new token.
//
// Snapshot fallback: DIY camera entities sometimes don't expose
// access_token. For those we reuse the original blob-fetch loop, routed
// through our pluginFetch proxy with the bearer token server-side.
function CameraTile({ state, haUrl, refreshMs, preview }: {
  state: HAStateObject; haUrl: string; refreshMs: number; preview?: boolean;
}) {
  const token = typeof state.attributes.access_token === 'string'
    ? state.attributes.access_token : undefined;

  // imgFailed flips if the MJPEG <img> emits an onError — the stream endpoint
  // might be unavailable (camera offline, stream integration not enabled).
  // When that happens we fall back to the snapshot loop for this mount.
  const [imgFailed, setImgFailed] = React.useState(false);
  // HA rotates `access_token` every few minutes, and a fresh token means a
  // fresh chance at MJPEG — without this reset a single transient stream
  // failure would lock the tile on snapshot polling for the life of the
  // component, even after the camera recovers.
  React.useEffect(() => { setImgFailed(false); }, [token]);
  // Skip live MJPEG in the preview pane — the stream keeps a socket open
  // for every preview render, which is wasteful while the modal is open.
  const useStream = !preview && token && !imgFailed;

  const streamSrc = useStream
    ? buildStreamUrl(haUrl, state.entity_id, token!)
    : null;

  return (
    <TileShell state={state}>
      {useStream ? (
        <img
          key={token}
          src={streamSrc!}
          alt={friendlyName(state)}
          onError={() => {
            // Log so DevTools shows the URL that failed — most likely
            // explanation when this fires is that the browser refused
            // the cross-origin MJPEG or HA returned 503/401 for that token.
            // eslint-disable-next-line no-console
            console.warn('[home-assistant plugin] MJPEG stream failed for',
              state.entity_id, '— falling back to snapshot polling.',
              'URL was:', streamSrc);
            setImgFailed(true);
          }}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            objectFit: 'cover', display: 'block',
          }}
        />
      ) : (
        <SnapshotImage state={state} haUrl={haUrl} refreshMs={refreshMs}
          tokenMissing={!token} />
      )}
    </TileShell>
  );
}

function buildStreamUrl(haUrl: string, entityId: string, token: string): string {
  // interval=0.1 → HA emits one frame every 100ms (~10 FPS). For cameras
  // that don't expose native MJPEG (UniFi Protect, most modern IP cams),
  // HA synthesizes the stream from still snapshots at this cadence. Lower
  // is smoother; too low (<0.05) just overruns HA's snapshot pipeline.
  const base = haUrl.replace(/\/+$/, '');
  return `${base}/api/camera_proxy_stream/${encodeURIComponent(entityId)}`
    + `?token=${encodeURIComponent(token)}`
    + `&interval=0.1`;
}

function SnapshotImage({ state, haUrl, refreshMs, tokenMissing }: {
  state: HAStateObject; haUrl: string; refreshMs: number; tokenMissing?: boolean;
}) {
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    // Shared across overlapping load() calls — a fetch slower than refreshMs
    // can otherwise leak an object URL if two tasks stomp on each other's
    // local `currentUrl`. The ref is the single source of truth.
    const currentUrlRef = { value: null as string | null };
    let inflight = false;

    async function load() {
      if (inflight || cancelled) return;
      inflight = true;
      try {
        const blob = await fetchCameraSnapshot(haUrl, state.entity_id);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        const previous = currentUrlRef.value;
        currentUrlRef.value = url;
        setObjectUrl(url);
        setError(null);
        if (previous) URL.revokeObjectURL(previous);
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : 'Failed to load snapshot';
          setError(msg);
          // Intentionally leave `objectUrl` set — when a camera blips mid-
          // session we'd rather show the last-known frame than flash an
          // "unavailable" card. The fallback tile only renders when there
          // was never a successful fetch (`error && !objectUrl`).
          // eslint-disable-next-line no-console
          console.warn('[home-assistant plugin] snapshot failed for', state.entity_id, msg);
        }
      } finally {
        inflight = false;
      }
    }

    load();
    const id = setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (currentUrlRef.value) URL.revokeObjectURL(currentUrlRef.value);
    };
  }, [haUrl, state.entity_id, refreshMs]);

  if (state.state === 'unavailable') {
    return <TileFallback>Camera offline</TileFallback>;
  }
  if (error && !objectUrl) {
    return <TileFallback>
      {tokenMissing ? 'No access token — check camera entity' : 'Camera unavailable'}
    </TileFallback>;
  }
  if (!objectUrl) {
    return <TileFallback>Loading…</TileFallback>;
  }
  return (
    <img
      src={objectUrl}
      alt={friendlyName(state)}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        objectFit: 'cover', display: 'block',
      }}
    />
  );
}

function TileFallback({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, padding: 12,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'rgba(255,255,255,0.4)', fontSize: 11, textAlign: 'center',
    }}>{children}</div>
  );
}

function TileShell({ state, children }: { state: HAStateObject; children: React.ReactNode }) {
  return (
    <div style={{
      position: 'relative', borderRadius: 10, overflow: 'hidden',
      background: 'linear-gradient(135deg, #1f2937, #0f172a)',
      border: '1px solid rgba(255,255,255,0.08)',
      minHeight: 100, aspectRatio: '16/9',
    }}>
      {children}
      {state.state === 'recording' && (
        <span style={{
          position: 'absolute', top: 8, right: 8, width: 8, height: 8,
          background: '#ef4444', borderRadius: 99, boxShadow: '0 0 8px #ef4444',
        }} />
      )}
      <span style={{
        position: 'absolute', bottom: 8, left: 8,
        fontSize: 11, fontWeight: 500, color: '#fff',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        padding: '3px 8px', borderRadius: 6,
      }}>{friendlyName(state)}</span>
    </div>
  );
}

// ── Empty state shared ──────────────────────────────────────────────────────

export function EmptyState({ message }: { message: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', padding: 24, color: 'rgba(255,255,255,0.45)',
      fontSize: 13, textAlign: 'center', lineHeight: 1.5,
    }}>
      {message}
    </div>
  );
}
