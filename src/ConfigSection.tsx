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
import { entityDomain } from './types';
import { testConnection, fetchStates, fetchAreas, ConnectionResult } from './api';
import { fetchSecretStatus, saveHaToken } from './secrets';
import { friendlyName, entityStateSummary } from './utils';
import { Icon, iconFor } from './icons';
import {
  CardGridView, StatusBoardView, RoomView,
  EntityCardView, EntityRowView, ClimateView, MediaView, CameraView, EmptyState,
} from './views';

const VIEWS: { value: HAView; label: string }[] = [
  { value: 'card-grid', label: 'Card Grid' },
  { value: 'status-board', label: 'Status Board' },
  { value: 'room', label: 'By Area' },
  { value: 'entity-card', label: 'Entity Card' },
  { value: 'entity-row', label: 'Entity Row' },
  { value: 'climate', label: 'Climate' },
  { value: 'media', label: 'Media' },
  { value: 'cameras', label: 'Cameras' },
];

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

type FilterKey = typeof DOMAIN_FILTERS[number]['key'];
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
  const ready = Boolean(config.haUrl) && tokenConfigured;
  const dotColor = ready ? '#22c55e'
    : errored ? '#ef4444'
    : loading ? 'rgba(255,255,255,0.3)'
    : '#f59e0b';

  const viewLabel = VIEWS.find((v) => v.value === config.view)?.label ?? config.view;
  const summaryText = ready ? 'Connected to Home Assistant'
    : errored ? (tokenError ?? 'Secrets endpoint unreachable')
    : config.haUrl ? 'Token not configured'
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

      {config.haUrl && (
        <div style={{
          fontSize: 11, color: 'rgba(255,255,255,0.55)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {config.haUrl}
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
    if (!config.haUrl) return;
    const gen = ++testGenRef.current;
    const url = config.haUrl;
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
    if (!config.haUrl) { setConn(null); setStates(null); return; }
    if (tokenStatus === 'loading') return;
    if (tokenStatus !== 'configured' && tokenStatus !== 'saved') {
      setConn(null); setStates(null); return;
    }
    const id = setTimeout(() => { runTest(); }, 500);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.haUrl, tokenStatus]);

  function patch(updates: Partial<HAPluginConfig>) {
    onChange(updates as Record<string, unknown>);
  }

  function toggleEntity(entityId: string) {
    const has = config.entities.includes(entityId);
    patch({
      entities: has
        ? config.entities.filter((e) => e !== entityId)
        : [...config.entities, entityId],
    });
  }

  function selectAllInArea() {
    if (!config.area || !areas.length || !states) return;
    const target = areas.find((a) => a.area_id === config.area);
    if (!target) return;
    const available = new Set(states.map((s) => s.entity_id));
    const toAdd = target.entities.filter((e) => available.has(e));
    patch({ entities: Array.from(new Set([...config.entities, ...toAdd])) });
  }

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { all: states?.length ?? 0 };
    if (states) {
      for (const s of states) {
        const d = entityDomain(s.entity_id);
        c[d] = (c[d] ?? 0) + 1;
      }
      const knownDomains = new Set<string>(
        DOMAIN_FILTERS.filter((f) => f.key !== 'all' && f.key !== 'other').map((f) => f.key),
      );
      c.other = states.filter((s) => !knownDomains.has(entityDomain(s.entity_id))).length;
    }
    return c;
  }, [states]);

  // Set lookup so each EntityRow's `picked` check is O(1) rather than O(n)
  // over config.entities — matters when the user has hundreds of entities
  // selected and is scrolling the up-to-300 filtered list.
  const pickedSet = React.useMemo(() => new Set(config.entities), [config.entities]);

  const { filtered, totalMatch } = React.useMemo(() => {
    if (!states) return { filtered: [] as HAStateObject[], totalMatch: 0 };
    const q = query.trim().toLowerCase();
    const knownDomains = new Set<string>(
      DOMAIN_FILTERS.filter((f) => f.key !== 'all' && f.key !== 'other').map((f) => f.key),
    );
    const matched = states.filter((s) => {
      const d = entityDomain(s.entity_id);
      if (activeFilter === 'other') {
        if (knownDomains.has(d)) return false;
      } else if (activeFilter !== 'all' && d !== activeFilter) {
        return false;
      }
      if (!q) return true;
      return s.entity_id.toLowerCase().includes(q) || friendlyName(s).toLowerCase().includes(q);
    });
    return { filtered: matched.slice(0, 300), totalMatch: matched.length };
  }, [states, query, activeFilter]);

  const tokenConfigured = tokenStatus === 'configured' || tokenStatus === 'saved';

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
          <button onClick={onClose} aria-label="Close" style={closeBtn}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
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

          {/* ── CONNECTION (collapses when fully configured) ───── */}
          <Accordion
            title="Connection"
            defaultOpen={!(conn?.ok && tokenConfigured)}
            summary={
              conn?.ok && tokenConfigured ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: 99,
                    background: '#22c55e', boxShadow: '0 0 4px #22c55e',
                  }} />
                  <span style={{ color: 'rgba(255,255,255,0.65)' }}>
                    {conn.version && <>HA <VersionChip version={conn.version} /> · </>}
                    {conn.entityCount} entities
                  </span>
                </span>
              ) : !tokenConfigured ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: '#f59e0b' }} />
                  <span style={{ color: 'rgba(255,255,255,0.5)' }}>Token not configured</span>
                </span>
              ) : (
                <span style={{ color: 'rgba(255,255,255,0.5)' }}>Not connected</span>
              )
            }
          >
            <div style={GRID_TWO}>
              <Field label="Home Assistant URL">
                <input
                  style={INPUT}
                  value={config.haUrl}
                  placeholder="http://homeassistant.local:8123"
                  onChange={(e) => patch({ haUrl: e.target.value })}
                />
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
              hasUrl={Boolean(config.haUrl)}
              tokenConfigured={tokenConfigured}
              tokenStatus={tokenStatus}
              tokenError={tokenError}
            />
          </Accordion>

          {/* ── DISPLAY ─────────────────────────────────────── */}
          <section>
            <SectionTitle>Display</SectionTitle>
            <div style={GRID_THREE}>
              <Field label="View">
                <select style={INPUT} value={config.view}
                  onChange={(e) => patch({ view: e.target.value as HAView })}>
                  {VIEWS.map((v) => (<option key={v.value} value={v.value}>{v.label}</option>))}
                </select>
              </Field>

              {config.view === 'card-grid' && (
                <Field label="Columns">
                  <ColumnsSlider
                    value={config.columns}
                    onChange={(n) => patch({ columns: n })}
                  />
                </Field>
              )}

              <Field label="Refresh interval">
                <select style={INPUT} value={config.refreshInterval}
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

            {config.view === 'room' && areas.length > 0 && (
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

            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: '10px 24px',
              marginTop: 14, paddingTop: 12,
              borderTop: '1px solid rgba(255,255,255,0.06)',
            }}>
              <GreenToggle label="Show header" checked={config.showHeader}
                onChange={(v) => patch({ showHeader: v })} />
              <GreenToggle label="Show controls" checked={config.showControls}
                onChange={(v) => patch({ showControls: v })} />
              <GreenToggle label="Compact mode" checked={config.compactMode}
                onChange={(v) => patch({ compactMode: v })} />
            </div>
          </section>

          {/* ── ENTITIES ────────────────────────────────────── */}
          <section>
            <SectionTitle>
              Entities <span style={{ color: 'rgba(255,255,255,0.4)' }}>· {config.entities.length} selected</span>
            </SectionTitle>
            {!conn?.ok && (
              <div style={HINT}>Connect to Home Assistant to browse entities.</div>
            )}
            {conn?.ok && states && (
              <>
                <SearchInput value={query} onChange={setQuery} />
                <div style={TABS}>
                  {DOMAIN_FILTERS.map((f) => {
                    const count = counts[f.key] ?? 0;
                    if (count === 0 && f.key !== 'all') return null;
                    const active = activeFilter === f.key;
                    return (
                      <button key={f.key} onClick={() => setActiveFilter(f.key)} style={tabStyle(active)}>
                        {f.label} <span style={tabCountStyle(active)}>{count}</span>
                      </button>
                    );
                  })}
                </div>
                <div style={LIST}>
                  {filtered.length === 0 && (
                    <div style={{ padding: 16, color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>
                      No entities match.
                    </div>
                  )}
                  {filtered.map((s) => (
                    <EntityRow key={s.entity_id} state={s}
                      picked={pickedSet.has(s.entity_id)}
                      onToggle={() => toggleEntity(s.entity_id)} />
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
                    {config.entities.length} of {states.length} entities selected
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
    return states
      .filter((s) => entitySet.has(s.entity_id))
      .sort((a, b) =>
        config.entities.indexOf(a.entity_id) - config.entities.indexOf(b.entity_id));
  }, [states, entitySet, config.entities]);

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
        <span>Preview</span>
        <span style={{
          width: 5, height: 5, borderRadius: 99,
          background: states ? '#22c55e' : 'rgba(255,255,255,0.2)',
          boxShadow: states ? '0 0 5px #22c55e' : undefined,
        }} />
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
  if (states == null) {
    return <EmptyState message="Connect to Home Assistant to preview." />;
  }
  if (visible.length === 0 && config.view !== 'cameras') {
    return <EmptyState message="Select some entities to see a preview." />;
  }
  // The preview frame is 320px wide — force compact card styling regardless
  // of the user's compactMode choice, and cap card-grid columns at 2 so the
  // cards have room to breathe. We pass a cloned config so the live display
  // keeps the user's actual preferences.
  const previewConfig: HAPluginConfig = {
    ...config,
    compactMode: true,
    columns: Math.min(config.columns ?? 2, 2),
  };
  const viewProps = { states: visible, config: previewConfig, areas, preview: true };
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em',
      color: 'rgba(255,255,255,0.45)', marginBottom: 12,
    }}>{children}</div>
  );
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

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>{label}</span>
      {children}
    </label>
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

function GreenToggle({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  // <label> forwards clicks only to a contained <input>; since we render a
  // role="switch" <span>, clicks on the label text were previously dead. The
  // onClick on <label> handles text clicks; the span has its own handler
  // with stopPropagation so a click on the knob doesn't both fire on the
  // span AND bubble up to re-toggle via the label handler.
  return (
    <label
      onClick={() => onChange(!checked)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 10,
        cursor: 'pointer', userSelect: 'none',
        fontSize: 13, color: 'rgba(255,255,255,0.8)',
      }}>
      <span
        role="switch" aria-checked={checked} tabIndex={0}
        onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(!checked); } }}
        style={{
          width: 40, height: 22, borderRadius: 99,
          background: checked ? '#22c55e' : 'rgba(255,255,255,0.1)',
          border: `1px solid ${checked ? '#22c55e' : 'rgba(255,255,255,0.15)'}`,
          position: 'relative', flexShrink: 0,
          transition: 'background 0.15s ease, border-color 0.15s ease',
        }}
      >
        <span style={{
          position: 'absolute', top: 1, left: checked ? 19 : 1,
          width: 18, height: 18, borderRadius: 99, background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          transition: 'left 0.15s ease',
        }} />
      </span>
      {label}
    </label>
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

function EntityRow({ state, picked, onToggle }: {
  state: HAStateObject; picked: boolean; onToggle: () => void;
}) {
  return (
    <div onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
        borderRadius: 6, cursor: 'pointer',
        background: picked ? 'rgba(59, 130, 246, 0.10)' : 'transparent',
        transition: 'background 0.1s ease',
      }}
    >
      <div style={{
        width: 16, height: 16, borderRadius: 3, flexShrink: 0,
        background: picked ? '#3b82f6' : 'transparent',
        border: `1px solid ${picked ? '#3b82f6' : 'rgba(255,255,255,0.15)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {picked && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff"
            strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
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
      <span style={{
        fontSize: 12, color: stateColor(state),
        fontVariantNumeric: 'tabular-nums', flexShrink: 0,
      }}>
        {entityStateSummary(state)}
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

const INPUT: React.CSSProperties = {
  width: '100%', padding: '9px 12px', fontSize: 13,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  color: '#fff', borderRadius: 6, fontFamily: 'inherit',
  boxSizing: 'border-box', outline: 'none',
};

const HINT: React.CSSProperties = {
  fontSize: 12, color: 'rgba(255,255,255,0.45)', lineHeight: 1.5, marginTop: 10,
};

const TABS: React.CSSProperties = {
  display: 'flex', gap: 2,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  marginBottom: 10, overflowX: 'auto',
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

function secondaryBtn(disabled: boolean): React.CSSProperties {
  return {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    color: disabled ? 'rgba(255,255,255,0.3)' : '#f5f5f7',
    fontSize: 12, padding: '7px 14px', borderRadius: 6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit', fontWeight: 500,
    whiteSpace: 'nowrap', flexShrink: 0,
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
