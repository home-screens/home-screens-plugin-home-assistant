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
import { BUTTON_TONES, buttonSubtitle, holdSweepColor } from './buttons';
import { exceedsSlop } from './controls';
import { tr } from './i18n';

export const BUTTON_HOLD_MS = 1_000;
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
  const cols = Math.max(1, Math.min(4, config.columns ?? 2));
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      gap: 10,
      padding: '8px 14px 14px',
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
        }, BUTTON_HOLD_MS);
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

  const tone = BUTTON_TONES[row.tone] ?? BUTTON_TONES.default;
  const sweep = holdSweepColor(row.tone);
  const holding = phase === 'holding';

  // Phase-driven surfaces (mockup section 2).
  const surface: React.CSSProperties = phase === 'success' ? {
    background: 'linear-gradient(135deg, rgba(74,222,128,0.12), rgba(255,255,255,0.03))',
    borderColor: 'rgba(74,222,128,0.35)',
  } : phase === 'failed' ? {
    background: 'linear-gradient(135deg, rgba(248,113,113,0.10), rgba(255,255,255,0.03))',
    borderColor: 'rgba(248,113,113,0.35)',
  } : holding ? {
    borderColor: `${sweep}66`,
  } : pressed ? {
    background: 'rgba(255,255,255,0.09)',
    borderColor: 'rgba(255,255,255,0.16)',
  } : {};

  const chip = phase === 'success'
    ? { bg: 'rgba(74,222,128,0.16)', fg: '#4ade80' }
    : phase === 'failed'
      ? { bg: 'rgba(248,113,113,0.16)', fg: '#f87171' }
      : { bg: tone.chipBg, fg: tone.accent };

  const label = phase === 'success' ? tr('buttons.done', 'Done!')
    : phase === 'failed' ? tr('buttons.didntWork', "Didn't work")
    : holding ? tr('buttons.keepHolding', 'Keep holding…')
    : row.label;
  const labelColor = phase === 'success' ? '#bbf7d0'
    : phase === 'failed' ? '#fecaca'
    : holding ? tone.holdText
    : 'rgba(255,255,255,0.85)';

  const chipContent = phase === 'calling' ? <Spinner size={compact ? 16 : 20} />
    : phase === 'success' ? <CheckGlyph size={compact ? 16 : 22} />
    : phase === 'failed' ? <CrossGlyph size={compact ? 16 : 22} />
    : <Icon name={isIconName(row.icon) ? row.icon : 'bolt'} size={compact ? 18 : 22} />;

  const holdFill = row.holdToRun && (
    <div style={{
      position: 'absolute', top: 0, bottom: 0, left: 0,
      width: holding ? '100%' : '0%',
      transition: holding ? `width ${BUTTON_HOLD_MS}ms linear` : 'none',
      background: `linear-gradient(90deg, ${sweep}1a, ${sweep}47)`,
      pointerEvents: 'none',
    }} />
  );

  const holdBadge = row.holdToRun && phase !== 'success' && phase !== 'failed' && (
    <span style={{
      ...(compact
        ? { marginLeft: 'auto', flexShrink: 0 }
        : { position: 'absolute', top: 7, right: 7 }),
      width: 16, height: 16, borderRadius: 99,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.45)',
    }}>
      <ClockGlyph />
    </span>
  );

  const base: React.CSSProperties = {
    position: 'relative', overflow: 'hidden',
    background: 'rgba(255,255,255,0.04)',
    // Longhand on purpose: `surface` overrides borderColor per phase, and
    // React warns (and can mis-style) when a shorthand and its longhand mix.
    borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
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
        ...base, minHeight: 56, padding: '8px 12px',
        display: 'flex', alignItems: 'center', gap: 11,
      }}>
        {holdFill}
        <span style={{
          position: 'relative', width: 36, height: 36, borderRadius: 10, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: chip.bg, color: chip.fg,
        }}>{chipContent}</span>
        <span style={{ position: 'relative', minWidth: 0 }}>
          <span style={{
            display: 'block', fontSize: 12.5, fontWeight: 600, letterSpacing: '-0.01em',
            color: labelColor,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{label}</span>
          {sub && (
            <span style={{
              display: 'block', fontSize: 9.5, marginTop: 2,
              color: phase === 'failed' ? 'rgba(252,165,165,0.6)' : 'rgba(255,255,255,0.38)',
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
      ...base, minHeight: 108, padding: '14px 10px 12px',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 9,
      textAlign: 'center',
    }}>
      {holdFill}
      {holdBadge}
      <span style={{
        position: 'relative', width: 44, height: 44, borderRadius: 12,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: chip.bg, color: chip.fg,
      }}>{chipContent}</span>
      <span style={{ position: 'relative', width: '100%' }}>
        <span style={{
          display: 'block', fontSize: 12, fontWeight: 600, letterSpacing: '-0.01em',
          color: labelColor, lineHeight: 1.25,
          overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{label}</span>
        {phase === 'failed' && (
          <span style={{
            display: 'block', fontSize: 9.5, marginTop: 2,
            color: 'rgba(252,165,165,0.6)',
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
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.15)" strokeWidth="2.5" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke="rgba(255,255,255,0.75)"
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

function ClockGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}
