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
import type { HAPluginConfig, HAStateObject, HAAlertRule } from './types';
import { Icon, isIconName } from './icons';
import {
  evaluateAlerts, acknowledgeAlert, readAcks, writeAcks, type AlertAcks,
} from './rules';
import { friendlyName, formatValue } from './utils';
import { tr } from './i18n';
import { useScale } from './scale';
import { useTheme, withAlpha, type Theme } from './theme';

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
  const u = useScale();
  const t = useTheme();
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
    // Persist the ack synchronously at tap time. If we deferred it into the
    // flash timer, a screen rotation within the 800ms flash would unmount the
    // view and clear the timer, silently discarding an acknowledgement the UI
    // already confirmed. The timer now only clears the visual "Got it!" beat.
    setFlashing((f) => (f[rule.id] ? f : { ...f, [rule.id]: true }));
    setAcks((prev) => {
      const next = acknowledgeAlert(prev, rule, state);
      writeAcks(next);
      return next;
    });
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      setFlashing((f) => {
        if (!f[rule.id]) return f;
        const next = { ...f };
        delete next[rule.id];
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

  // A just-tapped tile is acked synchronously, which drops it from `visible`
  // right away; keep rendering its "Got it!" beat until the flash timer clears
  // the flashing flag, so the confirmation the user tapped stays on screen.
  const visibleIds = new Set(evaluation.visible.map((v) => v.rule.id));
  const byId = new Map((states ?? []).map((s) => [s.entity_id, s]));
  const flashingExtra = config.alerts
    .filter((rule) => flashing[rule.id] && !visibleIds.has(rule.id))
    .map((rule) => ({ rule, state: byId.get(rule.entityId) as HAStateObject | undefined }));
  const shownList = [...evaluation.visible, ...flashingExtra];
  if (shownList.length === 0) return null;
  const shown = shownList.slice(0, ALERT_VISIBLE_CAP);
  const overflow = shownList.length - shown.length;

  return (
    <Stack compact={config.compactMode}>
      {shown.map(({ rule, state }) => (
        <AlertTile
          key={rule.id} rule={rule} state={state} compact={config.compactMode}
          flashing={flashing[rule.id] === true}
          onTap={state && !flashing[rule.id] ? () => acknowledge(rule, state) : undefined}
        />
      ))}
      {overflow > 0 && (
        <div style={{
          fontSize: u(11), color: t.fg(0.6), textAlign: 'center',
          textShadow: `0 1px 4px ${t.shade(0.6)}`, padding: `${u(2)}px 0`,
        }}>
          {tr('alerts.more', 'and {count} more', { count: overflow })}
        </div>
      )}
    </Stack>
  );
}

function Stack({ compact, children }: { compact: boolean; children: React.ReactNode }) {
  const u = useScale();
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      gap: compact ? u(8) : u(10), padding: `${u(8)}px ${u(10)}px`,
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
  const u = useScale();
  const t = useTheme();
  const tone = flashing ? ackedTone(t) : (t.alertTone[rule.tone] ?? t.alertTone.default);
  const iconName = isIconName(rule.icon) ? rule.icon : 'bolt';
  const sub = state
    ? `${friendlyName(state)} · ${formatValue(state)} ${forDuration(state.last_changed)}`
    : tr('alerts.waiting', 'Waiting for Home Assistant');
  const title = flashing ? tr('alerts.gotIt', 'Got it!') : rule.title;

  const base: React.CSSProperties = {
    position: 'relative', overflow: 'hidden',
    display: 'flex', alignItems: 'center',
    background: flashing ? t.alertTile.acked : t.alertTile.surface,
    backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
    borderWidth: 1, borderStyle: 'solid',
    borderColor: flashing ? t.alertTile.ackedBorder : t.alertTile.border,
    boxShadow: t.alertTile.shadow,
    cursor: onTap ? 'pointer' : 'default',
    userSelect: 'none', WebkitUserSelect: 'none',
    transition: 'background 0.2s ease, border-color 0.2s ease',
  };

  if (compact) {
    return (
      <div onClick={flashing ? undefined : onTap}
        style={{ ...base, gap: u(10), padding: `${u(8)}px ${u(12)}px`, borderRadius: 99 }}>
        <span style={{
          width: u(30), height: u(30), borderRadius: 99, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: tone.chipBg, color: tone.accent,
        }}>
          {flashing ? <CheckGlyph size={u(14)} /> : <Icon name={iconName} size={u(16)} />}
        </span>
        <span style={{
          minWidth: 0, display: 'flex', alignItems: 'baseline', gap: u(8),
          whiteSpace: 'nowrap', overflow: 'hidden',
        }}>
          <span style={{
            fontSize: u(12.5), fontWeight: 600, letterSpacing: '-0.01em',
            color: tone.title, overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title}</span>
          {state && !flashing && (
            <span style={{ fontSize: u(11), color: t.fg(0.5), flexShrink: 0 }}>
              {bareDuration(state.last_changed)}
            </span>
          )}
        </span>
        <span style={{
          marginLeft: 'auto', flexShrink: 0,
          color: t.fg(0.4),
          display: 'flex', alignItems: 'center',
        }}><CheckGlyph size={u(10)} /></span>
      </div>
    );
  }

  return (
    <div onClick={flashing ? undefined : onTap}
      style={{ ...base, gap: u(12), padding: `${u(12)}px ${u(14)}px`, borderRadius: u(14) }}>
      {/* Tone edge — the left glow strip from the mockup. */}
      <span style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: u(4),
        background: tone.accent,
        boxShadow: `0 0 ${u(12)}px ${tone.accent}`,
      }} />
      <span style={{
        width: u(42), height: u(42), borderRadius: u(12), flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: tone.chipBg, color: tone.accent,
      }}>
        {flashing ? <CheckGlyph size={u(20)} /> : <Icon name={iconName} size={u(21)} />}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{
          display: 'block', fontSize: u(14.5), fontWeight: 600,
          letterSpacing: '-0.01em', lineHeight: 1.2, color: tone.title,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</span>
        <span style={{
          display: 'block', fontSize: u(11), color: t.fg(0.5),
          marginTop: u(3), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{flashing ? tr('alerts.clearing', 'clearing…') : sub}</span>
      </span>
      {!flashing && (
        <span style={{
          flexShrink: 0, fontSize: u(9.5), letterSpacing: '0.04em',
          color: t.fg(0.4),
          borderWidth: 1, borderStyle: 'solid', borderColor: t.fg(0.14),
          padding: `${u(4)}px ${u(9)}px`, borderRadius: 99,
          display: 'flex', alignItems: 'center', gap: u(5),
        }}>
          <CheckGlyph size={u(9)} />
          {tr('alerts.tapWhenDone', 'Tap when done')}
        </span>
      )}
    </div>
  );
}

// ── Tone palette ────────────────────────────────────────────────────────────
//
// Same six tones as buttons, but alerts also tint the title so a tile reads
// urgent at a glance (mockup section 1).

/** A cleared tile flashes green regardless of the rule's own tone. */
function ackedTone(t: Theme): { accent: string; chipBg: string; title: string } {
  return {
    accent: t.accent.green.base,
    chipBg: withAlpha(t.accent.green.base, 0.18),
    title: t.accent.green.text,
  };
}

/** "for 12m" / "just now" — how long the state has been what it is. */
function forDuration(iso: string, now = Date.now()): string {
  const { unit, count } = durationSince(iso, now);
  if (unit === 'none') return '';
  if (unit === 'justNow') return tr('time.justNow', 'just now');
  if (unit === 'minutes') return tr('alerts.forMinutes', 'for {count}m', { count });
  if (unit === 'hours') return tr('alerts.forHours', 'for {count}h', { count });
  return tr('alerts.forDays', 'for {count}d', { count });
}

/** "12m" / "just now" — the same duration with no "for", for the compact pill
 *  where it sits beside the title in a nowrap strip with no room for one.
 *  Stripping the prefix off `forDuration` would only ever work in English. */
function bareDuration(iso: string, now = Date.now()): string {
  const { unit, count } = durationSince(iso, now);
  if (unit === 'none') return '';
  if (unit === 'justNow') return tr('time.justNow', 'just now');
  if (unit === 'minutes') return tr('time.minutes', '{count}m', { count });
  if (unit === 'hours') return tr('time.hours', '{count}h', { count });
  return tr('time.days', '{count}d', { count });
}

/** How long ago `iso` was, as a unit and a count — the choice of unit, with
 *  no wording attached, so the two phrasings above can't drift apart. */
function durationSince(iso: string, now: number): {
  unit: 'none' | 'justNow' | 'minutes' | 'hours' | 'days'; count: number;
} {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { unit: 'none', count: 0 };
  const sec = Math.floor(Math.max(0, now - t) / 1000);
  if (sec < 60) return { unit: 'justNow', count: 0 };
  const min = Math.floor(sec / 60);
  if (min < 60) return { unit: 'minutes', count: min };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { unit: 'hours', count: hr };
  return { unit: 'days', count: Math.floor(hr / 24) };
}

function CheckGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
