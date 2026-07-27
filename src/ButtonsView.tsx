// The `buttons` view: a grid of configured momentary buttons, each firing
// one HA service call. Unlike every other view this renders config rows,
// not entities — the interaction state machine is per-tile and local:
//
//   idle → (holdToRun? holding →) in-flight → success | failed → idle
//
// Feedback contract (mockup section 2): pressed scale-down; hold-to-run
// sweeps a tone-colored fill left-to-right for 1s (release early cancels —
// no call); the spinner only appears when the call takes >250ms; success
// flashes green 1.5s; failure flashes red and returns to idle. The panel
// always settles back to idle.

import React from 'react';
import type { HAPluginConfig, HAButtonRow } from './types';
import { Icon, isIconName } from './icons';
import { buttonSubtitle, holdSweepColor } from './buttons';
import { exceedsSlop, HOLD_TO_RUN_MS } from './controls';
import { tr } from './i18n';
import { useScale } from './scale';
import { useTheme, withAlpha } from './theme';

const SPINNER_DELAY_MS = 250;
const SUCCESS_FLASH_MS = 1_500;
const FAILED_FLASH_MS = 1_800;

interface ButtonsViewProps {
  config: HAPluginConfig;
  /** Absent in the config-modal preview and when controls are off — tiles
   *  render but presses are inert. */
  onInvoke?: (row: HAButtonRow) => Promise<void>;
}

export function ButtonsView({ config, onInvoke }: ButtonsViewProps) {
  const u = useScale();
  const cols = Math.max(1, Math.min(4, config.columns ?? 2));
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      gap: u(10),
      padding: `${u(8)}px ${u(14)}px ${u(14)}px`,
    }}>
      {config.buttons.map((row) => (
        <ButtonTile key={row.id} row={row} compact={config.compactMode} onInvoke={onInvoke} />
      ))}
    </div>
  );
}

// ── Tile ────────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'holding' | 'calling' | 'success' | 'failed';

function ButtonTile({ row, compact, onInvoke }: {
  row: HAButtonRow; compact: boolean; onInvoke?: (row: HAButtonRow) => Promise<void>;
}) {
  const u = useScale();
  const t = useTheme();
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [pressed, setPressed] = React.useState(false);

  const holdTimer = React.useRef<number | null>(null);
  const spinnerTimer = React.useRef<number | null>(null);
  const settleTimer = React.useRef<number | null>(null);
  const origin = React.useRef<{ x: number; y: number } | null>(null);
  const inflight = React.useRef(false);
  const mounted = React.useRef(true);

  const clearHold = React.useCallback(() => {
    if (holdTimer.current != null) { clearTimeout(holdTimer.current); holdTimer.current = null; }
  }, []);
  React.useEffect(() => () => {
    mounted.current = false;
    clearHold();
    if (spinnerTimer.current != null) clearTimeout(spinnerTimer.current);
    if (settleTimer.current != null) clearTimeout(settleTimer.current);
  }, [clearHold]);

  const fire = React.useCallback(async () => {
    if (!onInvoke || inflight.current) return;
    inflight.current = true;
    // Quick calls skip the spinner entirely — only show it past the delay.
    spinnerTimer.current = window.setTimeout(() => {
      spinnerTimer.current = null;
      if (mounted.current) setPhase('calling');
    }, SPINNER_DELAY_MS);
    let ok = true;
    try {
      await onInvoke(row);
    } catch {
      ok = false;
    }
    inflight.current = false;
    if (spinnerTimer.current != null) { clearTimeout(spinnerTimer.current); spinnerTimer.current = null; }
    if (!mounted.current) return;
    setPhase(ok ? 'success' : 'failed');
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      if (mounted.current) setPhase('idle');
    }, ok ? SUCCESS_FLASH_MS : FAILED_FLASH_MS);
  }, [onInvoke, row]);

  // A tile busy with feedback ignores new presses until it settles.
  const interactive = Boolean(onInvoke) && (phase === 'idle' || phase === 'holding');

  const handlers = interactive ? {
    onPointerDown: (e: React.PointerEvent) => {
      if (inflight.current || phase !== 'idle') return;
      origin.current = { x: e.clientX, y: e.clientY };
      setPressed(true);
      if (row.holdToRun) {
        setPhase('holding');
        clearHold();
        holdTimer.current = window.setTimeout(() => {
          holdTimer.current = null;
          origin.current = null;
          // The finger is still down, but fire() advances the phase out of
          // idle/holding, which detaches every pointer handler, so the
          // eventual release can no longer reset `pressed`. Clear it here or
          // the tile stays visually stuck (scale-down + pressed fill).
          setPressed(false);
          setPhase('idle');
          fire();
        }, HOLD_TO_RUN_MS);
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (origin.current == null) return;
      const dx = e.clientX - origin.current.x;
      const dy = e.clientY - origin.current.y;
      if (exceedsSlop(dx, dy)) cancelPress();
    },
    onPointerUp: () => {
      if (origin.current == null) { setPressed(false); return; }
      origin.current = null;
      setPressed(false);
      if (row.holdToRun) {
        // Released before the sweep finished — cancel, no call.
        if (holdTimer.current != null) { clearHold(); setPhase('idle'); }
      } else {
        fire();
      }
    },
    onPointerLeave: cancelPress,
    onPointerCancel: cancelPress,
    // Chromium fires contextmenu on touch long-press.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  } : {};

  function cancelPress() {
    origin.current = null;
    setPressed(false);
    if (holdTimer.current != null) { clearHold(); setPhase('idle'); }
  }

  const tone = t.buttonTone[row.tone] ?? t.buttonTone.default;
  const sweep = holdSweepColor(row.tone, t);
  const holding = phase === 'holding';

  // Phase-driven surfaces (mockup section 2).
  const surface: React.CSSProperties = phase === 'success' ? {
    background: `linear-gradient(135deg, ${withAlpha(t.accent.green.base, 0.12)}, ${t.fg(0.03)})`,
    borderColor: withAlpha(t.accent.green.base, 0.35),
  } : phase === 'failed' ? {
    background: `linear-gradient(135deg, ${withAlpha(t.accent.red.base, 0.10)}, ${t.fg(0.03)})`,
    borderColor: withAlpha(t.accent.red.base, 0.35),
  } : holding ? {
    borderColor: `${sweep}66`,
  } : pressed ? {
    background: t.fg(0.09),
    borderColor: t.fg(0.16),
  } : {};

  const chip = phase === 'success'
    ? { bg: withAlpha(t.accent.green.base, 0.16), fg: t.accent.green.base }
    : phase === 'failed'
      ? { bg: withAlpha(t.accent.red.base, 0.16), fg: t.accent.red.base }
      : { bg: tone.chipBg, fg: tone.accent };

  const label = phase === 'success' ? tr('buttons.done', 'Done!')
    : phase === 'failed' ? tr('buttons.didntWork', "Didn't work")
    : holding ? tr('buttons.keepHolding', 'Keep holding…')
    : row.label;
  const labelColor = phase === 'success' ? t.accent.green.text
    : phase === 'failed' ? t.accent.red.text
    : holding ? tone.holdText
    : t.fg(0.85);

  const chipContent = phase === 'calling' ? <Spinner size={u(compact ? 16 : 20)} />
    : phase === 'success' ? <CheckGlyph size={u(compact ? 16 : 22)} />
    : phase === 'failed' ? <CrossGlyph size={u(compact ? 16 : 22)} />
    : <Icon name={isIconName(row.icon) ? row.icon : 'bolt'} size={u(compact ? 18 : 22)} />;

  const holdFill = row.holdToRun && (
    <div style={{
      position: 'absolute', top: 0, bottom: 0, left: 0,
      width: holding ? '100%' : '0%',
      transition: holding ? `width ${HOLD_TO_RUN_MS}ms linear` : 'none',
      background: `linear-gradient(90deg, ${sweep}1a, ${sweep}47)`,
      pointerEvents: 'none',
    }} />
  );

  const holdBadge = row.holdToRun && phase !== 'success' && phase !== 'failed' && (
    <span style={{
      ...(compact
        ? { marginLeft: 'auto', flexShrink: 0 }
        : { position: 'absolute', top: u(7), right: u(7) }),
      width: u(16), height: u(16), borderRadius: 99,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: t.fg(0.07), color: t.fg(0.45),
    }}>
      <ClockGlyph size={u(9)} />
    </span>
  );

  const base: React.CSSProperties = {
    position: 'relative', overflow: 'hidden',
    background: t.fg(0.04),
    // Longhand on purpose: `surface` overrides borderColor per phase, and
    // React warns (and can mis-style) when a shorthand and its longhand mix.
    borderWidth: 1, borderStyle: 'solid', borderColor: t.fg(0.08),
    borderRadius: u(12),
    transform: pressed && !holding ? 'scale(0.96)' : 'scale(1)',
    transition: 'transform 0.1s ease, background 0.15s ease, border-color 0.15s ease',
    cursor: interactive ? 'pointer' : 'default',
    touchAction: 'pan-y',
    userSelect: 'none', WebkitUserSelect: 'none',
    ...surface,
  };

  if (compact) {
    const sub = phase === 'failed' ? tr('buttons.tryAgain', 'Try again')
      : row.holdToRun && phase === 'idle' ? tr('buttons.holdToRun', 'Hold to run')
      : phase === 'idle' ? buttonSubtitle(row) : null;
    return (
      <div {...handlers} style={{
        ...base, minHeight: u.touch(56), padding: `${u(8)}px ${u(12)}px`,
        display: 'flex', alignItems: 'center', gap: u(11),
      }}>
        {holdFill}
        <span style={{
          position: 'relative', width: u(36), height: u(36), borderRadius: u(10), flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: chip.bg, color: chip.fg,
        }}>{chipContent}</span>
        <span style={{ position: 'relative', minWidth: 0 }}>
          <span style={{
            display: 'block', fontSize: u(12.5), fontWeight: 600, letterSpacing: '-0.01em',
            color: labelColor,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{label}</span>
          {sub && (
            <span style={{
              display: 'block', fontSize: u(9.5), marginTop: u(2),
              color: phase === 'failed' ? withAlpha(t.accent.red.loud, 0.6) : t.fg(0.38),
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{sub}</span>
          )}
        </span>
        {holdBadge}
      </div>
    );
  }

  return (
    <div {...handlers} style={{
      ...base, minHeight: u.touch(108), padding: `${u(14)}px ${u(10)}px ${u(12)}px`,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: u(9),
      textAlign: 'center',
    }}>
      {holdFill}
      {holdBadge}
      <span style={{
        position: 'relative', width: u(44), height: u(44), borderRadius: u(12),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: chip.bg, color: chip.fg,
      }}>{chipContent}</span>
      <span style={{ position: 'relative', width: '100%' }}>
        <span style={{
          display: 'block', fontSize: u(12), fontWeight: 600, letterSpacing: '-0.01em',
          color: labelColor, lineHeight: 1.25,
          overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{label}</span>
        {phase === 'failed' && (
          <span style={{
            display: 'block', fontSize: u(9.5), marginTop: u(2),
            color: withAlpha(t.accent.red.loud, 0.6),
          }}>{tr('buttons.tryAgain', 'Try again')}</span>
        )}
      </span>
    </div>
  );
}

// ── Glyphs ──────────────────────────────────────────────────────────────────

/** Inline-style components can't declare CSS keyframes, so the spinner is an
 *  SVG arc rotated via SMIL — no stylesheet needed. */
function Spinner({ size }: { size: number }) {
  const t = useTheme();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke={t.fg(0.15)} strokeWidth="2.5" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke={t.fg(0.75)}
        strokeWidth="2.5" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate"
          from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

function CheckGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CrossGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ClockGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}
