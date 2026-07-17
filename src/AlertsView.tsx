// The `alerts` view: rule-driven banner tiles with tap-to-clear (item #1).
// Unlike every other view the module is INVISIBLE while idle — no header, no
// background, nothing rendered — so it lives naturally over a photo screen
// and only speaks up while a rule matches and nobody has tapped it away.
//
// Clearing is stateful (mockup section 2): a tap flashes "Got it!" for a
// beat, then stores the entity's last_changed in localStorage via rules.ts.
// The tile stays hidden across refreshes until Home Assistant reports a new
// transition into the matching state (enum rules) or the value leaves and
// re-enters the range (numeric rules). Each kiosk clears independently —
// localStorage is per-device by nature.

import React from 'react';
import type { HAPluginConfig, HAStateObject, HAAlertRule, HAButtonTone } from './types';
import { Icon, isIconName } from './icons';
import { BUTTON_TONES } from './buttons';
import {
  evaluateAlerts, acknowledgeAlert, readAcks, writeAcks, type AlertAcks,
} from './rules';
import { friendlyName, formatValue } from './utils';

const GOT_IT_FLASH_MS = 800;
/** At most this many tiles stack before a quiet "and N more" line. */
export const ALERT_VISIBLE_CAP = 4;

interface AlertsViewProps {
  config: HAPluginConfig;
  /** ALL polled states (alert entities aren't in config.entities). Null
   *  while connecting — the view renders nothing rather than a spinner. */
  states: HAStateObject[] | null;
  /** Config-modal preview: show every configured tile regardless of live
   *  state, with taps inert, so the user can style tiles that aren't
   *  currently firing. */
  preview?: boolean;
}

export function AlertsView({ config, states, preview }: AlertsViewProps) {
  const [acks, setAcks] = React.useState<AlertAcks>(() => (preview ? {} : readAcks()));
  // Rules mid-flash: still rendered (in "Got it!" dress) but already tapped.
  const [flashing, setFlashing] = React.useState<Record<string, true>>({});
  const timers = React.useRef<Set<number>>(new Set());
  React.useEffect(() => () => { timers.current.forEach((id) => clearTimeout(id)); }, []);

  const evaluation = React.useMemo(
    () => evaluateAlerts(config.alerts, states ?? [], acks),
    [config.alerts, states, acks],
  );

  // Persist pruning (rule left the matching state, new transition, rule
  // removed from config) as a side effect — never during render.
  React.useEffect(() => {
    if (preview || evaluation.acks === acks) return;
    setAcks(evaluation.acks);
    writeAcks(evaluation.acks);
  }, [evaluation.acks, acks, preview]);

  // Alerts sit on screen for a while — tick so "for 12m" stays honest.
  const anyVisible = preview || evaluation.visible.length > 0;
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!anyVisible) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [anyVisible]);

  const acknowledge = React.useCallback((rule: HAAlertRule, state: HAStateObject) => {
    setFlashing((f) => (f[rule.id] ? f : { ...f, [rule.id]: true }));
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      setFlashing((f) => {
        if (!f[rule.id]) return f;
        const next = { ...f };
        delete next[rule.id];
        return next;
      });
      setAcks((prev) => {
        const next = acknowledgeAlert(prev, rule, state);
        writeAcks(next);
        return next;
      });
    }, GOT_IT_FLASH_MS);
    timers.current.add(id);
  }, []);

  if (preview) {
    const byId = new Map((states ?? []).map((s) => [s.entity_id, s]));
    return (
      <Stack compact={config.compactMode}>
        {config.alerts.map((rule) => (
          <AlertTile key={rule.id} rule={rule} state={byId.get(rule.entityId)}
            compact={config.compactMode} />
        ))}
      </Stack>
    );
  }

  if (evaluation.visible.length === 0) return null;
  const shown = evaluation.visible.slice(0, ALERT_VISIBLE_CAP);
  const overflow = evaluation.visible.length - shown.length;

  return (
    <Stack compact={config.compactMode}>
      {shown.map(({ rule, state }) => (
        <AlertTile
          key={rule.id} rule={rule} state={state} compact={config.compactMode}
          flashing={flashing[rule.id] === true}
          onTap={() => acknowledge(rule, state)}
        />
      ))}
      {overflow > 0 && (
        <div style={{
          fontSize: 11, color: 'rgba(255,255,255,0.6)', textAlign: 'center',
          textShadow: '0 1px 4px rgba(0,0,0,0.6)', padding: '2px 0',
        }}>
          and {overflow} more
        </div>
      )}
    </Stack>
  );
}

function Stack({ compact, children }: { compact: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      gap: compact ? 8 : 10, padding: '8px 10px',
    }}>
      {children}
    </div>
  );
}

// ── One tile ────────────────────────────────────────────────────────────────

function AlertTile({ rule, state, compact, flashing, onTap }: {
  rule: HAAlertRule;
  /** Absent only in preview when the entity hasn't loaded yet. */
  state?: HAStateObject;
  compact: boolean;
  flashing?: boolean;
  onTap?: () => void;
}) {
  const tone = flashing ? ACKED_TONE : (ALERT_TONES[rule.tone] ?? ALERT_TONES.default);
  const iconName = isIconName(rule.icon) ? rule.icon : 'bolt';
  const sub = state
    ? `${friendlyName(state)} · ${formatValue(state)} ${forDuration(state.last_changed)}`
    : 'Waiting for Home Assistant';
  const title = flashing ? 'Got it!' : rule.title;

  const base: React.CSSProperties = {
    position: 'relative', overflow: 'hidden',
    display: 'flex', alignItems: 'center',
    background: flashing ? 'rgba(20, 35, 26, 0.8)' : 'rgba(13, 18, 32, 0.72)',
    backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
    borderWidth: 1, borderStyle: 'solid',
    borderColor: flashing ? 'rgba(74,222,128,0.35)' : 'rgba(255,255,255,0.1)',
    boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
    cursor: onTap ? 'pointer' : 'default',
    userSelect: 'none', WebkitUserSelect: 'none',
    transition: 'background 0.2s ease, border-color 0.2s ease',
  };

  if (compact) {
    return (
      <div onClick={flashing ? undefined : onTap}
        style={{ ...base, gap: 10, padding: '8px 12px', borderRadius: 99 }}>
        <span style={{
          width: 30, height: 30, borderRadius: 99, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: tone.chipBg, color: tone.accent,
        }}>
          {flashing ? <CheckGlyph size={14} /> : <Icon name={iconName} size={16} />}
        </span>
        <span style={{
          minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8,
          whiteSpace: 'nowrap', overflow: 'hidden',
        }}>
          <span style={{
            fontSize: 12.5, fontWeight: 600, letterSpacing: '-0.01em',
            color: tone.title, overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title}</span>
          {state && !flashing && (
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>
              {forDuration(state.last_changed).replace(/^for /, '')}
            </span>
          )}
        </span>
        <span style={{
          marginLeft: 'auto', flexShrink: 0,
          color: 'rgba(255,255,255,0.4)',
          display: 'flex', alignItems: 'center',
        }}><CheckGlyph size={10} /></span>
      </div>
    );
  }

  return (
    <div onClick={flashing ? undefined : onTap}
      style={{ ...base, gap: 12, padding: '12px 14px', borderRadius: 14 }}>
      {/* Tone edge — the left glow strip from the mockup. */}
      <span style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 4,
        background: tone.accent,
        boxShadow: `0 0 12px ${tone.accent}`,
      }} />
      <span style={{
        width: 42, height: 42, borderRadius: 12, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: tone.chipBg, color: tone.accent,
      }}>
        {flashing ? <CheckGlyph size={20} /> : <Icon name={iconName} size={21} />}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{
          display: 'block', fontSize: 14.5, fontWeight: 600,
          letterSpacing: '-0.01em', lineHeight: 1.2, color: tone.title,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</span>
        <span style={{
          display: 'block', fontSize: 11, color: 'rgba(255,255,255,0.5)',
          marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{flashing ? 'clearing…' : sub}</span>
      </span>
      {!flashing && (
        <span style={{
          flexShrink: 0, fontSize: 9.5, letterSpacing: '0.04em',
          color: 'rgba(255,255,255,0.4)',
          borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(255,255,255,0.14)',
          padding: '4px 9px', borderRadius: 99,
          display: 'flex', alignItems: 'center', gap: 5,
        }}>
          <CheckGlyph size={9} />
          Tap when done
        </span>
      )}
    </div>
  );
}

// ── Tone palette ────────────────────────────────────────────────────────────
//
// Same six tones as buttons, but alerts also tint the title so a tile reads
// urgent at a glance (mockup section 1).

interface AlertTone { accent: string; chipBg: string; title: string }

const ALERT_TONES: Record<HAButtonTone, AlertTone> = {
  default: { accent: 'rgba(255,255,255,0.6)', chipBg: 'rgba(255,255,255,0.08)', title: '#fff' },
  amber: { accent: BUTTON_TONES.amber.accent, chipBg: 'rgba(251,191,36,0.16)', title: '#fde68a' },
  blue: { accent: BUTTON_TONES.blue.accent, chipBg: 'rgba(96,165,250,0.16)', title: '#bfdbfe' },
  green: { accent: BUTTON_TONES.green.accent, chipBg: 'rgba(74,222,128,0.16)', title: '#bbf7d0' },
  purple: { accent: BUTTON_TONES.purple.accent, chipBg: 'rgba(192,132,252,0.16)', title: '#e9d5ff' },
  red: { accent: BUTTON_TONES.red.accent, chipBg: 'rgba(248,113,113,0.16)', title: '#fecaca' },
};

const ACKED_TONE: AlertTone = {
  accent: '#4ade80', chipBg: 'rgba(74,222,128,0.18)', title: '#bbf7d0',
};

/** "for 12m" / "just now" — how long the state has been what it is. */
function forDuration(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const sec = Math.floor(Math.max(0, now - t) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `for ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `for ${hr}h`;
  return `for ${Math.floor(hr / 24)}d`;
}

function CheckGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
