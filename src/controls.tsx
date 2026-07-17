// Interactive controls: the in-module light detail sheet and the long-press
// hook that opens it. Composed at module level by index.tsx (the overlay must
// cover the whole module, so it can't live inside a card).
//
// Interaction contract: quick tap on a light card still toggles (unchanged
// shipped behavior); holding ~450ms opens this sheet. The sheet closes on the
// ✕, on a backdrop tap, or on its own after 15s without touches. One service
// call per slider gesture — commit on release, never while dragging — so a
// long drag can't burn the plugin's proxy rate budget.

import React from 'react';
import type { HAStateObject, CardCommand } from './types';
import { friendlyName } from './utils';
import {
  supportsBrightness, supportsColorTemp, supportsColor,
  colorTempRange, brightnessPct, currentKelvin,
  rangeFraction, kelvinFromFraction, brightnessFromFraction,
  lightStateLine, LIGHT_SWATCHES, activeSwatch,
} from './light';

const HOLD_MS = 450;
const HOLD_MOVE_SLOP_PX = 8;
const AUTO_DISMISS_MS = 15_000;
/** How long a released slider thumb may wait for live state to catch up
 *  before snapping back — covers a failed service call, where it never
 *  will. */
const COMMIT_SETTLE_MS = 4_000;

/** True when pointer travel exceeds the hold-cancel slop radius (the user
 *  is dragging or scrolling, not holding). Pure so the geometry is unit-
 *  testable without pointer events. */
export function exceedsSlop(dx: number, dy: number, slopPx = HOLD_MOVE_SLOP_PX): boolean {
  return dx * dx + dy * dy > slopPx * slopPx;
}

// ── Long-press detection ────────────────────────────────────────────────────

/** Pointer handlers distinguishing tap from hold. Replaces onClick entirely
 *  on cards that support a detail sheet: pointerup before the hold timer
 *  fires is the tap; movement past the slop cancels both (drag/scroll). */
export function useLongPress(onHold: () => void, onTap?: () => void) {
  const timer = React.useRef<number | null>(null);
  const origin = React.useRef<{ x: number; y: number } | null>(null);

  const clear = React.useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  React.useEffect(() => clear, [clear]);

  return {
    onPointerDown: (e: React.PointerEvent) => {
      origin.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        origin.current = null;
        onHold();
      }, HOLD_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (origin.current == null || timer.current == null) return;
      const dx = e.clientX - origin.current.x;
      const dy = e.clientY - origin.current.y;
      if (exceedsSlop(dx, dy)) {
        clear();
        origin.current = null;
      }
    },
    onPointerUp: () => {
      if (timer.current != null && origin.current != null) {
        clear();
        origin.current = null;
        onTap?.();
      }
    },
    onPointerLeave: () => { clear(); origin.current = null; },
    onPointerCancel: () => { clear(); origin.current = null; },
    // Chromium fires contextmenu on touch long-press; that would drop a
    // browser menu on top of the sheet we just opened.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}

// ── Thick touch slider ──────────────────────────────────────────────────────

/** 0–1 track fraction for a pointer at clientX on a track spanning
 *  [rectLeft, rectLeft + rectWidth], clamped. A degenerate width (mid-layout
 *  measurement, hidden track) falls back to the live fraction rather than
 *  dividing by zero. Pure so it is unit-testable without pointer events. */
export function fractionFromX(
  clientX: number, rectLeft: number, rectWidth: number, fallback: number,
): number {
  if (rectWidth <= 0) return fallback;
  return Math.max(0, Math.min(1, (clientX - rectLeft) / rectWidth));
}

interface ThickSliderProps {
  /** 0–1 position of the thumb from live entity state. */
  fraction: number;
  /** Called once, on gesture release, with the final 0–1 fraction. */
  onCommit: (fraction: number) => void;
  /** Amber fill behind the thumb (brightness). Omitted for gradient tracks
   *  (warmth) where the track itself is the scale. */
  showFill?: boolean;
  trackStyle?: React.CSSProperties;
  onInteract: () => void;
}

function ThickSlider({ fraction, onCommit, showFill, trackStyle, onInteract }: ThickSliderProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [dragFraction, setDragFraction] = React.useState<number | null>(null);
  const dragRef = React.useRef<number | null>(null);
  const settleTimer = React.useRef<number | null>(null);

  const clearSettleTimer = React.useCallback(() => {
    if (settleTimer.current != null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  }, []);
  React.useEffect(() => clearSettleTimer, [clearSettleTimer]);

  // A released thumb keeps showing the committed position until live entity
  // state catches up (the optimistic merge after the service call). Clearing
  // on pointer-up instead would snap the thumb back to the stale pre-drag
  // value for the whole round-trip. Mid-drag fraction churn (polls) must not
  // steal the thumb, hence the dragRef gate.
  React.useEffect(() => {
    if (dragRef.current != null) return;
    clearSettleTimer();
    setDragFraction(null);
  }, [fraction, clearSettleTimer]);

  const fractionFromEvent = (e: React.PointerEvent): number => {
    const rect = ref.current!.getBoundingClientRect();
    return fractionFromX(e.clientX, rect.left, rect.width, fraction);
  };

  // Shared end-of-gesture paths, used by the element handlers AND by the
  // window-level fallback below. When setPointerCapture fails (synthetic
  // events, odd touch drivers) a release outside the track never reaches the
  // element's handlers — without the fallback the thumb wedges at the drag
  // position forever with no commit. The element handlers run first (bubble
  // order) and null dragRef, so the fallback firing after them is a no-op.
  const finishDrag = React.useCallback((commit: boolean) => {
    if (dragRef.current == null) return;
    if (commit) {
      onCommit(dragRef.current);
      dragRef.current = null;
      // Hold the committed position; the fraction effect releases it when
      // live state catches up, the timer if it never does (failed call).
      clearSettleTimer();
      settleTimer.current = window.setTimeout(() => {
        settleTimer.current = null;
        setDragFraction(null);
      }, COMMIT_SETTLE_MS);
    } else {
      dragRef.current = null;
      setDragFraction(null);
    }
  }, [onCommit, clearSettleTimer]);

  const windowUp = React.useRef<(() => void) | null>(null);
  const windowCancel = React.useRef<(() => void) | null>(null);
  const detachWindowFallback = React.useCallback(() => {
    if (windowUp.current) window.removeEventListener('pointerup', windowUp.current);
    if (windowCancel.current) window.removeEventListener('pointercancel', windowCancel.current);
    windowUp.current = null;
    windowCancel.current = null;
  }, []);
  React.useEffect(() => detachWindowFallback, [detachWindowFallback]);

  const shown = dragFraction ?? fraction;
  const pctCss = `${(shown * 100).toFixed(1)}%`;

  return (
    <div
      ref={ref}
      onPointerDown={(e) => {
        onInteract();
        // Capture keeps the drag alive when the finger wanders off the
        // track. Best-effort: a capture failure (synthetic events, odd
        // touch drivers) must not abort the gesture itself.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
        clearSettleTimer();
        const f = fractionFromEvent(e);
        dragRef.current = f;
        setDragFraction(f);
        detachWindowFallback();
        windowUp.current = () => { detachWindowFallback(); finishDrag(true); };
        windowCancel.current = () => { detachWindowFallback(); finishDrag(false); };
        window.addEventListener('pointerup', windowUp.current);
        window.addEventListener('pointercancel', windowCancel.current);
      }}
      onPointerMove={(e) => {
        if (dragRef.current == null) return;
        const f = fractionFromEvent(e);
        dragRef.current = f;
        setDragFraction(f);
      }}
      onPointerUp={() => {
        detachWindowFallback();
        finishDrag(true);
      }}
      onPointerCancel={() => {
        detachWindowFallback();
        finishDrag(false);
      }}
      style={{
        position: 'relative', height: 44, borderRadius: 12,
        background: 'rgba(255,255,255,0.07)',
        border: '1px solid rgba(255,255,255,0.08)',
        overflow: 'hidden', touchAction: 'none', cursor: 'pointer',
        ...trackStyle,
      }}
    >
      {showFill && (
        <div style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, width: pctCss,
          background: 'linear-gradient(90deg, rgba(251,191,36,0.25), rgba(251,191,36,0.55))',
        }} />
      )}
      <div style={{
        position: 'absolute', top: 6, bottom: 6, left: `calc(${pctCss} - 3px)`,
        width: 5, borderRadius: 99, background: '#fff',
        boxShadow: '0 0 8px rgba(0,0,0,0.6)',
        outline: showFill ? undefined : '3px solid rgba(10,14,26,0.7)',
      }} />
    </div>
  );
}

// ── Detail sheet ────────────────────────────────────────────────────────────

interface LightDetailSheetProps {
  state: HAStateObject;
  onCommand: CardCommand;
  onClose: () => void;
}

export function LightDetailSheet({ state, onCommand, onClose }: LightDetailSheetProps) {
  const on = state.state === 'on';
  const dimmable = supportsBrightness(state);
  const tunable = supportsColorTemp(state);
  const colorful = supportsColor(state);
  const kelvinRange = colorTempRange(state);

  // Idle auto-dismiss: any touch on the sheet re-arms the 15s timer.
  const [idleKey, bumpIdle] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const id = setTimeout(onClose, AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [idleKey, onClose]);

  const pct = brightnessPct(state) ?? 0;
  const kelvin = currentKelvin(state) ?? Math.round((kelvinRange.min + kelvinRange.max) / 2);
  const selected = colorful ? activeSwatch(state) : null;

  return (
    <div
      onPointerDown={bumpIdle}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'absolute', inset: 0, zIndex: 5,
        background: 'rgba(8,11,20,0.72)',
        backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 18,
      }}
    >
      <div style={{
        width: '100%', maxWidth: 480,
        background: 'linear-gradient(180deg, rgba(30,36,54,0.96), rgba(21,26,40,0.98))',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 18, padding: 18,
        display: 'flex', flexDirection: 'column', gap: 16,
        boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={() => onCommand(state, 'toggle')}
            aria-label={on ? 'Turn off' : 'Turn on'}
            style={{
              width: 44, height: 44, borderRadius: 12, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', padding: 0,
              background: on ? 'rgba(251,191,36,0.16)' : 'rgba(255,255,255,0.06)',
              border: `1px solid ${on ? 'rgba(251,191,36,0.45)' : 'rgba(255,255,255,0.1)'}`,
              color: on ? '#fbbf24' : 'rgba(255,255,255,0.6)',
              boxShadow: on ? '0 0 14px rgba(251,191,36,0.25)' : undefined,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
              <line x1="12" y1="2" x2="12" y2="12" />
            </svg>
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: '#fff',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{friendlyName(state)}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
              {lightStateLine(state)}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 44, height: 44, borderRadius: 12, flexShrink: 0,
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'rgba(255,255,255,0.7)', fontSize: 18, cursor: 'pointer', padding: 0,
            }}
          >✕</button>
        </div>

        {dimmable && (
          <div>
            <ControlLabel label="Brightness" value={on ? `${pct}%` : 'Off'} />
            <ThickSlider
              fraction={pct / 100}
              showFill
              onInteract={bumpIdle}
              onCommit={(f) => onCommand(state, 'turn_on', {
                brightness_pct: brightnessFromFraction(f),
              })}
            />
          </div>
        )}

        {tunable && (
          <div>
            <ControlLabel label="Warmth" value={`${kelvin}K`} />
            <ThickSlider
              fraction={rangeFraction(kelvin, kelvinRange.min, kelvinRange.max)}
              onInteract={bumpIdle}
              trackStyle={{
                background: 'linear-gradient(90deg, #ff9d45 0%, #ffd9a3 45%, #eef4ff 75%, #bcd8ff 100%)',
                opacity: 0.85,
              }}
              onCommit={(f) => onCommand(state, 'turn_on', {
                color_temp_kelvin: kelvinFromFraction(f, kelvinRange),
              })}
            />
          </div>
        )}

        {colorful && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {LIGHT_SWATCHES.map((sw) => {
              const isSelected = selected?.name === sw.name;
              return (
                <button
                  key={sw.name}
                  aria-label={sw.name}
                  onClick={() => onCommand(state, 'turn_on', { rgb_color: sw.rgb })}
                  style={{
                    width: 44, height: 44, borderRadius: 99, padding: 0,
                    background: sw.css, cursor: 'pointer',
                    border: `2px solid ${isSelected ? '#fff' : 'rgba(255,255,255,0.15)'}`,
                    boxShadow: isSelected ? '0 0 0 3px rgba(255,255,255,0.25)' : undefined,
                  }}
                />
              );
            })}
          </div>
        )}

        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>
          Closes on its own after 15 seconds
        </div>
      </div>
    </div>
  );
}

function ControlLabel({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em',
      color: 'rgba(255,255,255,0.55)', marginBottom: 8,
    }}>
      <span>{label}</span>
      <span style={{
        fontSize: 13, color: '#fff', fontWeight: 600,
        letterSpacing: 0, textTransform: 'none', fontVariantNumeric: 'tabular-nums',
      }}>{value}</span>
    </div>
  );
}
