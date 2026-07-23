// Interactive controls: the in-module detail sheets (light, climate, cover)
// and the long-press hook that opens them. Composed at module level by
// index.tsx (the overlay must cover the whole module, so it can't live
// inside a card).
//
// Interaction contract: quick tap on a card keeps its shipped action
// (lights/covers toggle); holding ~450ms opens the sheet — climate, with no
// tap action to protect, opens on plain tap. The sheet closes on the ✕, on
// a backdrop tap, or on its own after 15s without touches. One service call
// per gesture — sliders commit on release, steppers after a tap-quiet
// window — so a long drag or tap burst can't burn the proxy rate budget.

import React from 'react';
import type { HAStateObject, CardCommand } from './types';
import { entityDomain } from './types';
import { friendlyName } from './utils';
import {
  supportsBrightness, supportsColorTemp, supportsColor,
  colorTempRange, brightnessPct, currentKelvin,
  rangeFraction, kelvinFromFraction, brightnessFromFraction,
  lightStateLine, LIGHT_SWATCHES, activeSwatch,
} from './light';
import {
  setpointModel, tempStep, tempBounds, stepValue, formatTemp, hvacModes,
  climateStateLine, hvacModeColor, setTemperaturePayload,
} from './climate';
import {
  supportsPosition, supportsStop, supportsOpen, supportsClose,
  positionFraction, positionFromFraction, coverStateLine,
} from './cover';

const HOLD_MS = 450;
const HOLD_MOVE_SLOP_PX = 8;
const AUTO_DISMISS_MS = 15_000;
/** How long a released slider thumb may wait for live state to catch up
 *  before snapping back — covers a failed service call, where it never
 *  will. */
const COMMIT_SETTLE_MS = 4_000;
/** Stepper taps accumulate locally and fire one service call after this
 *  quiet window — five quick +taps must cost one set_temperature, not
 *  five. */
const STEP_COMMIT_MS = 800;

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
  /** Drag lifecycle for parents whose auto-hide timers must pause while a
   *  finger is on the track (volume) — a stationary hold fires no pointer
   *  events, so re-arming on interaction alone can't keep the slider
   *  mounted. Fires true on pointer-down, false when the gesture ends by
   *  any path (release, cancel, or the window fallback). */
  onDragActive?: (active: boolean) => void;
}

export function ThickSlider({
  fraction, onCommit, showFill, trackStyle, onInteract, onDragActive,
}: ThickSliderProps) {
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
    onDragActive?.(false);
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
  }, [onCommit, clearSettleTimer, onDragActive]);

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
        onDragActive?.(true);
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

// ── Detail sheets ───────────────────────────────────────────────────────────

interface DetailSheetProps {
  state: HAStateObject;
  onCommand: CardCommand;
  onClose: () => void;
}

/** Shared sheet chrome: backdrop, panel, header row (optional leading
 *  control + name + state line + ✕), the 15s idle auto-dismiss, and the
 *  footer hint. Children get bumpIdle for slider gestures — pointer-downs
 *  anywhere in the sheet already re-arm the timer via the backdrop. */
function SheetFrame({ state, stateLine, leading, onClose, children }: {
  state: HAStateObject;
  stateLine: string;
  leading?: React.ReactNode;
  onClose: () => void;
  children: (bumpIdle: () => void) => React.ReactNode;
}) {
  // Idle auto-dismiss: any touch on the sheet re-arms the 15s timer.
  const [idleKey, bumpIdle] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const id = setTimeout(onClose, AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [idleKey, onClose]);

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
          {leading}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: '#fff',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{friendlyName(state)}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
              {stateLine}
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

        {children(bumpIdle)}

        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>
          Closes on its own after 15 seconds
        </div>
      </div>
    </div>
  );
}

// ── Light sheet ─────────────────────────────────────────────────────────────

function LightDetailSheet({ state, onCommand, onClose }: DetailSheetProps) {
  const on = state.state === 'on';
  const dimmable = supportsBrightness(state);
  const tunable = supportsColorTemp(state);
  const colorful = supportsColor(state);
  const kelvinRange = colorTempRange(state);

  const pct = brightnessPct(state) ?? 0;
  const kelvin = currentKelvin(state) ?? Math.round((kelvinRange.min + kelvinRange.max) / 2);
  const selected = colorful ? activeSwatch(state) : null;

  const powerButton = (
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
  );

  return (
    <SheetFrame state={state} stateLine={lightStateLine(state)} leading={powerButton}
      onClose={onClose}>
      {(bumpIdle) => (<>
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
      </>)}
    </SheetFrame>
  );
}

// ── Stepper commit (climate) ────────────────────────────────────────────────

/** Local pending value for tap-steppers — the stepper twin of ThickSlider's
 *  commit-on-release. Taps accumulate into `pending`; one commit fires after
 *  the STEP_COMMIT_MS quiet window; the shown value then holds (settle)
 *  until live state catches up, or snaps back after COMMIT_SETTLE_MS if it
 *  never does (failed call). A live change mid-burst must not steal the
 *  value the user is still tapping toward, hence the debounce gate.
 *  Generic over the value so a range's low/high pair rides one debounce —
 *  a burst touching both bounds must cost one service call, not two.
 *  `flush` commits an armed pending value immediately (mode switches must
 *  not race the deferred commit); unmount flushes too, so closing the sheet
 *  mid-burst still lands the taps the user saw on screen. */
function usePendingSteps<T>(live: T, commit: (value: T) => void) {
  const [pending, setPending] = React.useState<T | null>(null);
  const pendingRef = React.useRef<T | null>(null);
  const debounceTimer = React.useRef<number | null>(null);
  const settleTimer = React.useRef<number | null>(null);

  const clearTimers = React.useCallback(() => {
    if (debounceTimer.current != null) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (settleTimer.current != null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  }, []);

  const fire = React.useCallback(() => {
    if (pendingRef.current != null) commit(pendingRef.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      pendingRef.current = null;
      setPending(null);
    }, COMMIT_SETTLE_MS);
  }, [commit]);

  const flush = React.useCallback(() => {
    if (debounceTimer.current == null) return;
    clearTimeout(debounceTimer.current);
    debounceTimer.current = null;
    fire();
  }, [fire]);

  const flushRef = React.useRef(flush);
  flushRef.current = flush;
  React.useEffect(() => () => {
    flushRef.current();
    clearTimers();
  }, [clearTimers]);

  React.useEffect(() => {
    if (debounceTimer.current != null) return;
    if (settleTimer.current != null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    pendingRef.current = null;
    setPending(null);
  }, [live]);

  const bump = React.useCallback((next: T) => {
    pendingRef.current = next;
    setPending(next);
    if (settleTimer.current != null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    if (debounceTimer.current != null) clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => {
      debounceTimer.current = null;
      fire();
    }, STEP_COMMIT_MS);
  }, [fire]);

  return { shown: pending ?? live, bump, flush };
}

function StepButton({ sign, label, onClick }: {
  sign: '−' | '+'; label: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      style={{
        width: 52, height: 52, borderRadius: 14, flexShrink: 0,
        background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)',
        color: 'rgba(255,255,255,0.85)', fontSize: 26, fontWeight: 400,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', padding: 0, lineHeight: 1,
      }}
    >{sign}</button>
  );
}

function Stepper({ label, value, accent, onStep }: {
  label: string; value: number; accent?: string; onStep: (dir: 1 | -1) => void;
}) {
  return (
    <div>
      <ControlLabel label={label} value="" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <StepButton sign="−" label={`${label}: lower`} onClick={() => onStep(-1)} />
        <div style={{
          flex: 1, textAlign: 'center', fontSize: 40, fontWeight: 600,
          letterSpacing: '-0.03em', lineHeight: 1, fontVariantNumeric: 'tabular-nums',
          color: accent ?? '#fff',
        }}>{formatTemp(value)}°</div>
        <StepButton sign="+" label={`${label}: raise`} onClick={() => onStep(1)} />
      </div>
    </div>
  );
}

// ── Climate sheet ───────────────────────────────────────────────────────────

/** rgba() tint of a #rrggbb accent — the kiosk's Chromium predates
 *  color-mix(), so pill surfaces are derived the long way. Non-hex accents
 *  (the neutral off/unknown grey) fall back to a neutral surface. */
function tint(accent: string, alpha: number, fallback: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(accent);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function ClimateDetailSheet({ state, onCommand, onClose }: DetailSheetProps) {
  const model = setpointModel(state);
  const step = tempStep(state);
  const bounds = tempBounds(state);
  const modes = hvacModes(state);

  // Hooks must run unconditionally; the unused kind's hook just idles on 0.
  const liveSingle = model?.kind === 'single' ? model.target : 0;
  const liveLow = model?.kind === 'range' ? model.low : 0;
  const liveHigh = model?.kind === 'range' ? model.high : 0;
  // Memoized so the pending-clear effect keyed on `live` sees a stable
  // identity until a bound actually changes.
  const liveRange = React.useMemo(
    () => ({ low: liveLow, high: liveHigh }), [liveLow, liveHigh]);

  const commitSingle = React.useCallback((v: number) => {
    onCommand(state, 'set_temperature', setTemperaturePayload({ kind: 'single', target: v }));
  }, [onCommand, state]);

  // Range commits always send the pair (HA rejects a lone bound). Both
  // steppers share one pending pair — and so one debounce — because a burst
  // that touches both bounds must land as one service call, not two.
  const commitRange = React.useCallback((pair: { low: number; high: number }) => {
    onCommand(state, 'set_temperature', setTemperaturePayload({
      kind: 'range', low: pair.low, high: pair.high,
    }));
  }, [onCommand, state]);

  const single = usePendingSteps(liveSingle, commitSingle);
  const range = usePendingSteps(liveRange, commitRange);

  return (
    <SheetFrame state={state} stateLine={climateStateLine(state)} onClose={onClose}>
      {(bumpIdle) => (<>
        {model?.kind === 'single' && (
          <Stepper label="Set to" value={single.shown}
            onStep={(dir) => {
              bumpIdle();
              single.bump(stepValue(single.shown, dir, step, bounds));
            }} />
        )}

        {model?.kind === 'range' && (<>
          <Stepper label="Heat to" value={range.shown.low} accent="#fb923c"
            onStep={(dir) => {
              bumpIdle();
              // The pair may never cross: low tops out at the cool bound.
              range.bump({
                ...range.shown,
                low: Math.min(stepValue(range.shown.low, dir, step, bounds), range.shown.high),
              });
            }} />
          <Stepper label="Cool to" value={range.shown.high} accent="#38bdf8"
            onStep={(dir) => {
              bumpIdle();
              range.bump({
                ...range.shown,
                high: Math.max(stepValue(range.shown.high, dir, step, bounds), range.shown.low),
              });
            }} />
        </>)}

        {modes.length > 0 && (
          <div>
            <ControlLabel label="Mode" value="" />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {modes.map((mode) => {
                const active = mode === state.state;
                const color = hvacModeColor(mode);
                return (
                  <button
                    key={mode}
                    onClick={() => {
                      bumpIdle();
                      // A pending stepper burst belongs to the outgoing
                      // mode — flush it now so the deferred set_temperature
                      // can't land after the switch and program this one.
                      single.flush();
                      range.flush();
                      onCommand(state, 'set_hvac_mode', { hvac_mode: mode });
                    }}
                    style={{
                      padding: '0 16px', height: 44, borderRadius: 12,
                      background: active
                        ? tint(color, 0.16, 'rgba(255,255,255,0.14)')
                        : 'rgba(255,255,255,0.06)',
                      border: `1px solid ${active
                        ? tint(color, 0.5, 'rgba(255,255,255,0.4)')
                        : 'rgba(255,255,255,0.1)'}`,
                      color: active ? color : 'rgba(255,255,255,0.6)',
                      fontSize: 13, fontWeight: active ? 600 : 400,
                      textTransform: 'capitalize', cursor: 'pointer',
                    }}
                  >{mode.replace(/_/g, ' ')}</button>
                );
              })}
            </div>
          </div>
        )}
      </>)}
    </SheetFrame>
  );
}

// ── Cover sheet ─────────────────────────────────────────────────────────────

function SheetActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, height: 44, borderRadius: 12,
        background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
        color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: 600,
        cursor: 'pointer',
      }}
    >{label}</button>
  );
}

function CoverDetailSheet({ state, onCommand, onClose }: DetailSheetProps) {
  const positional = supportsPosition(state);
  const stoppable = supportsStop(state);
  const canOpen = supportsOpen(state);
  const canClose = supportsClose(state);
  const fraction = positionFraction(state);
  const pct = Math.round(fraction * 100);

  return (
    <SheetFrame state={state} stateLine={coverStateLine(state)} onClose={onClose}>
      {(bumpIdle) => (<>
        {positional && (
          <div>
            <ControlLabel label="Position"
              value={pct === 0 ? 'Closed' : pct === 100 ? 'Open' : `${pct}% open`} />
            <ThickSlider
              fraction={fraction}
              showFill
              onInteract={bumpIdle}
              onCommit={(f) => onCommand(state, 'set_cover_position', {
                position: positionFromFraction(f),
              })}
            />
          </div>
        )}

        {(canOpen || canClose || stoppable) && (
          <div style={{ display: 'flex', gap: 10 }}>
            {canOpen && (
              <SheetActionButton label="Open"
                onClick={() => { bumpIdle(); onCommand(state, 'open_cover'); }} />
            )}
            {stoppable && (
              <SheetActionButton label="Stop"
                onClick={() => { bumpIdle(); onCommand(state, 'stop_cover'); }} />
            )}
            {canClose && (
              <SheetActionButton label="Close"
                onClick={() => { bumpIdle(); onCommand(state, 'close_cover'); }} />
            )}
          </div>
        )}
      </>)}
    </SheetFrame>
  );
}

// ── Domain router ───────────────────────────────────────────────────────────

/** The one detail-sheet entry point index.tsx renders. Unsupported domains
 *  return null — an open detailId for one can only happen if a view wired
 *  onOpenDetail somewhere it shouldn't, and rendering nothing beats a
 *  half-broken sheet. */
export function DetailSheet({ state, onCommand, onClose }: DetailSheetProps) {
  switch (entityDomain(state.entity_id)) {
    case 'light': return <LightDetailSheet state={state} onCommand={onCommand} onClose={onClose} />;
    case 'climate': return <ClimateDetailSheet state={state} onCommand={onCommand} onClose={onClose} />;
    case 'cover': return <CoverDetailSheet state={state} onCommand={onCommand} onClose={onClose} />;
    default: return null;
  }
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
