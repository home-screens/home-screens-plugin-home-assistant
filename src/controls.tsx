// Interactive controls: the in-module detail sheets (light, climate, cover,
// fan, vacuum) and the long-press hook that opens them. Composed at module level by
// index.tsx (the overlay must cover the whole module, so it can't live
// inside a card).
//
// Interaction contract: quick tap on a card keeps its shipped action
// (lights/covers/fans toggle, vacuums start or pause); holding ~450ms opens
// the sheet — climate, with no tap action to protect, opens on plain tap. The sheet closes on the ✕, on
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
  setpointModel, tempStep, tempBounds, stepValue, formatTemp, hvacModes, hvacModeLabel,
  climateStateLine, hvacModeColor, setTemperaturePayload,
} from './climate';
import {
  supportsPosition, supportsStop, supportsOpen, supportsClose,
  positionFraction, positionFromFraction, coverStateLine,
} from './cover';
import {
  supportsSpeed, speedStep, speedFraction, percentageFromFraction, fanStateLine,
} from './fan';
import {
  isMower, vacuumActions, vacuumService, vacuumStateLine,
  fanSpeedList, currentFanSpeed, fanSpeedLabel, type VacuumAction,
} from './vacuum';
import { useScale } from './scale';
import { useTheme, withAlpha } from './theme';
import { tr } from './i18n';

const HOLD_MS = 450;
/** Guarded actions — the ones that move a bolt or a garage door — take a
 *  full second of deliberate holding, with a sweep showing the progress.
 *  Shared by the buttons view's hold-to-run tiles and the lock card. */
export const HOLD_TO_RUN_MS = 1_000;
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

interface LongPressOptions {
  /** Override the 450ms sheet-opening hold. Guarded actions that fire on
   *  their own (the lock card) use the 1s hold the buttons view uses. */
  holdMs?: number;
  /** Called true while the hold is counting down and false the moment it
   *  ends by any path — fires, is released early, or is cancelled by a
   *  drag. Drives the hold sweep on cards that show one. */
  onHoldChange?: (holding: boolean) => void;
}

/** Pointer handlers distinguishing tap from hold. Replaces onClick entirely
 *  on cards that support a detail sheet: pointerup before the hold timer
 *  fires is the tap; movement past the slop cancels both (drag/scroll). */
export function useLongPress(
  onHold: () => void, onTap?: () => void, options?: LongPressOptions,
) {
  const holdMs = options?.holdMs ?? HOLD_MS;
  const timer = React.useRef<number | null>(null);
  const origin = React.useRef<{ x: number; y: number } | null>(null);
  // The finger that owns the hold. A kiosk display is multi-touch, so without
  // this a second finger landing anywhere restarts the countdown and its
  // release cancels a hold the first finger is still making.
  const activePointer = React.useRef<number | null>(null);
  // Read through a ref so the effect cleanup below stays timer-only — an
  // unmount must not push state into a component on its way out.
  const onHoldChange = React.useRef(options?.onHoldChange);
  onHoldChange.current = options?.onHoldChange;
  // Likewise the action itself: a poll can land mid-hold and take the action
  // away (a lock that starts locking on its own has no service to call, and
  // the card drops its sweep and its handlers). Firing the closure captured
  // at pointer-down would run the action a second later against a state that
  // no longer offers it, with nothing on screen still counting down.
  const onHoldRef = React.useRef(onHold);
  onHoldRef.current = onHold;

  // Window-level release fallback, the same guard ThickSlider needs: a card
  // can stop receiving pointer events mid-hold (a poll changes the entity's
  // state and the card re-renders without its handlers). Without this the
  // release never lands, the timer keeps counting, and a guarded action the
  // user let go of fires anyway.
  const windowEnd = React.useRef<((e: PointerEvent) => void) | null>(null);
  const detachWindowEnd = React.useCallback(() => {
    if (!windowEnd.current) return;
    window.removeEventListener('pointerup', windowEnd.current);
    window.removeEventListener('pointercancel', windowEnd.current);
    windowEnd.current = null;
  }, []);

  const clear = React.useCallback(() => {
    detachWindowEnd();
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, [detachWindowEnd]);
  React.useEffect(() => clear, [clear]);

  const cancel = React.useCallback(() => {
    const wasHolding = timer.current != null;
    clear();
    origin.current = null;
    activePointer.current = null;
    if (wasHolding) onHoldChange.current?.(false);
  }, [clear]);

  /** Every path that ends a hold: only the owning finger may take it. */
  const cancelFor = React.useCallback((pointerId: number) => {
    if (pointerId !== activePointer.current) return;
    cancel();
  }, [cancel]);

  return {
    onPointerDown: (e: React.PointerEvent) => {
      // A second finger while a hold is running is a rested palm, not a new
      // gesture — the first finger keeps its countdown.
      if (activePointer.current != null) return;
      activePointer.current = e.pointerId;
      origin.current = { x: e.clientX, y: e.clientY };
      clear();
      onHoldChange.current?.(true);
      timer.current = window.setTimeout(() => {
        detachWindowEnd();
        timer.current = null;
        origin.current = null;
        activePointer.current = null;
        onHoldChange.current?.(false);
        onHoldRef.current();
      }, holdMs);
      // The element's own handlers run first (React's root listener sits
      // below window), so this only ever fires for a release the element
      // never saw.
      windowEnd.current = (ev: PointerEvent) => cancelFor(ev.pointerId);
      window.addEventListener('pointerup', windowEnd.current);
      window.addEventListener('pointercancel', windowEnd.current);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (e.pointerId !== activePointer.current) return;
      if (origin.current == null || timer.current == null) return;
      const dx = e.clientX - origin.current.x;
      const dy = e.clientY - origin.current.y;
      if (exceedsSlop(dx, dy)) cancel();
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (e.pointerId !== activePointer.current) return;
      if (timer.current != null && origin.current != null) {
        cancel();
        onTap?.();
      }
    },
    onPointerLeave: (e: React.PointerEvent) => cancelFor(e.pointerId),
    onPointerCancel: (e: React.PointerEvent) => cancelFor(e.pointerId),
    // Chromium fires contextmenu on touch long-press; that would drop a
    // browser menu on top of the sheet we just opened.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}

/**
 * The gesture contract from interaction.ts, wired to handlers — used by any
 * surface that isn't a card (the hero views). Returns either pointer
 * handlers (when a hold is in play) or a plain onClick, plus the hold flag a
 * guarded action needs to paint its sweep.
 *
 * Hooks run unconditionally, so the noop branch covers entities with no
 * hold: `usesPress` decides which half of the result the caller uses.
 */
export function useEntityPress({ tap, hold, guarded }: {
  tap?: () => void; hold?: () => void; guarded?: () => void;
}) {
  const [holding, setHolding] = React.useState(false);
  // A guarded action owns the whole gesture: no tap, a full second of hold,
  // and a sweep. Otherwise a hold is only a hold when there is also a tap to
  // protect — a lone sheet opens on the plain tap instead.
  const split = tap != null && hold != null;
  const holdAction = guarded ?? (split ? hold : undefined);
  const pressProps = useLongPress(
    holdAction ?? (() => {}),
    guarded ? undefined : (split ? tap : undefined),
    {
      holdMs: guarded ? HOLD_TO_RUN_MS : HOLD_MS,
      onHoldChange: guarded ? setHolding : undefined,
    },
  );
  const usesPress = holdAction != null;
  return {
    pressProps: usesPress ? pressProps : undefined,
    onClick: usesPress ? undefined : (tap ?? hold),
    holding,
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
  const u = useScale();
  const t = useTheme();
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
        position: 'relative', height: u.touch(44), borderRadius: u(12),
        background: t.fg(0.07),
        border: `1px solid ${t.fg(0.08)}`,
        overflow: 'hidden', touchAction: 'none', cursor: 'pointer',
        ...trackStyle,
      }}
    >
      {showFill && (
        <div style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, width: pctCss,
          background: `linear-gradient(90deg, ${withAlpha(t.accent.amber.base, 0.25)}, ${withAlpha(t.accent.amber.base, 0.55)})`,
        }} />
      )}
      <div style={{
        position: 'absolute', top: u(6), bottom: u(6),
        left: `calc(${pctCss} - ${u(3)}px)`,
        width: u(5), borderRadius: 99, background: t.fg(),
        boxShadow: `0 0 8px ${t.shade(0.6)}`,
        outline: showFill ? undefined : `${u(3)}px solid ${t.shade(0.7)}`,
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
  const u = useScale();
  const t = useTheme();
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
        background: t.sheet.backdrop,
        backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: u(18),
      }}
    >
      <div style={{
        width: '100%', maxWidth: u(480),
        // The sheet grows with the Text size, and the module it lives in
        // does not — a scaled-up sheet in a short module would otherwise
        // clip its own ✕ and leave the backdrop tap as the only way out.
        maxHeight: '100%', overflowY: 'auto',
        background: t.sheet.panel,
        border: t.sheet.border,
        borderRadius: u(18), padding: u(18),
        display: 'flex', flexDirection: 'column', gap: u(16),
        boxShadow: t.sheet.shadow,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: u(10) }}>
          {leading}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: u(15), fontWeight: 600, letterSpacing: '-0.01em', color: t.fg(),
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{friendlyName(state)}</div>
            <div style={{ fontSize: u(11), color: t.fg(0.5), marginTop: u(2) }}>
              {stateLine}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={tr('sheet.close', 'Close')}
            style={{
              width: u.touch(44), height: u.touch(44), borderRadius: u(12), flexShrink: 0,
              background: t.fg(0.06), border: `1px solid ${t.fg(0.1)}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: t.fg(0.7), fontSize: u(18), cursor: 'pointer', padding: 0,
            }}
          >✕</button>
        </div>

        {children(bumpIdle)}

        <div style={{ fontSize: u(10), color: t.fg(0.35), textAlign: 'center' }}>
          {tr('sheet.autoCloses', 'Closes on its own after 15 seconds')}
        </div>
      </div>
    </div>
  );
}

// ── Light sheet ─────────────────────────────────────────────────────────────

/** Sheet header toggle for domains whose sheet has an on/off to protect
 *  (light, fan) — the leading slot's twin of the ✕ on the trailing side. */
function PowerButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  const u = useScale();
  const t = useTheme();
  return (
    <button
      onClick={onClick}
      aria-label={on ? tr('sheet.turnOff', 'Turn off') : tr('sheet.turnOn', 'Turn on')}
      style={{
        width: u.touch(44), height: u.touch(44), borderRadius: u(12), flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', padding: 0,
        background: on ? withAlpha(t.accent.amber.base, 0.16) : t.fg(0.06),
        border: `1px solid ${on ? withAlpha(t.accent.amber.base, 0.45) : t.fg(0.1)}`,
        color: on ? t.accent.amber.base : t.fg(0.6),
        boxShadow: on ? `0 0 14px ${withAlpha(t.accent.amber.base, 0.25)}` : undefined,
      }}
    >
      <svg width={u(20)} height={u(20)} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round">
        <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
        <line x1="12" y1="2" x2="12" y2="12" />
      </svg>
    </button>
  );
}

function LightDetailSheet({ state, onCommand, onClose }: DetailSheetProps) {
  const u = useScale();
  const t = useTheme();
  const on = state.state === 'on';
  const dimmable = supportsBrightness(state);
  const tunable = supportsColorTemp(state);
  const colorful = supportsColor(state);
  const kelvinRange = colorTempRange(state);

  const pct = brightnessPct(state) ?? 0;
  const kelvin = currentKelvin(state) ?? Math.round((kelvinRange.min + kelvinRange.max) / 2);
  const selected = colorful ? activeSwatch(state) : null;

  return (
    <SheetFrame state={state} stateLine={lightStateLine(state)}
      leading={<PowerButton on={on} onClick={() => onCommand(state, 'toggle')} />}
      onClose={onClose}>
      {(bumpIdle) => (<>
        {dimmable && (
          <div>
            <ControlLabel label={tr('sheet.brightness', 'Brightness')}
              value={on ? `${pct}%` : tr('common.off', 'Off')} />
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
            <ControlLabel label={tr('sheet.warmth', 'Warmth')} value={`${kelvin}K`} />
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
          <div style={{ display: 'flex', gap: u(10), flexWrap: 'wrap' }}>
            {LIGHT_SWATCHES.map((sw) => {
              const isSelected = selected?.name === sw.name;
              return (
                <button
                  key={sw.name}
                  aria-label={sw.name}
                  onClick={() => onCommand(state, 'turn_on', { rgb_color: sw.rgb })}
                  style={{
                    width: u.touch(44), height: u.touch(44), borderRadius: 99, padding: 0,
                    background: sw.css, cursor: 'pointer',
                    border: `2px solid ${isSelected ? t.fg() : t.fg(0.15)}`,
                    boxShadow: isSelected ? `0 0 0 ${u(3)}px ${t.fg(0.25)}` : undefined,
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
  const u = useScale();
  const t = useTheme();
  return (
    <button
      onClick={onClick}
      aria-label={label}
      style={{
        width: u.touch(52), height: u.touch(52), borderRadius: u(14), flexShrink: 0,
        background: t.fg(0.07), border: `1px solid ${t.fg(0.12)}`,
        color: t.fg(0.85), fontSize: u(26), fontWeight: 400,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', padding: 0, lineHeight: 1,
      }}
    >{sign}</button>
  );
}

function Stepper({ label, value, accent, onStep }: {
  label: string; value: number; accent?: string; onStep: (dir: 1 | -1) => void;
}) {
  const u = useScale();
  const t = useTheme();
  return (
    <div>
      <ControlLabel label={label} value="" />
      <div style={{ display: 'flex', alignItems: 'center', gap: u(12) }}>
        <StepButton sign="−" label={tr('sheet.lower', '{label}: lower', { label })}
          onClick={() => onStep(-1)} />
        <div style={{
          flex: 1, textAlign: 'center', fontSize: u(40), fontWeight: 600,
          letterSpacing: '-0.03em', lineHeight: 1, fontVariantNumeric: 'tabular-nums',
          color: accent ?? t.fg(),
        }}>{formatTemp(value)}°</div>
        <StepButton sign="+" label={tr('sheet.raise', '{label}: raise', { label })}
          onClick={() => onStep(1)} />
      </div>
    </div>
  );
}

// ── Climate sheet ───────────────────────────────────────────────────────────

function ClimateDetailSheet({ state, onCommand, onClose }: DetailSheetProps) {
  const u = useScale();
  const t = useTheme();
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
          <Stepper label={tr('sheet.setTo', 'Set to')} value={single.shown}
            onStep={(dir) => {
              bumpIdle();
              single.bump(stepValue(single.shown, dir, step, bounds));
            }} />
        )}

        {model?.kind === 'range' && (<>
          <Stepper label={tr('sheet.heatTo', 'Heat to')} value={range.shown.low} accent={t.accent.orange.base}
            onStep={(dir) => {
              bumpIdle();
              // The pair may never cross: low tops out at the cool bound.
              range.bump({
                ...range.shown,
                low: Math.min(stepValue(range.shown.low, dir, step, bounds), range.shown.high),
              });
            }} />
          <Stepper label={tr('sheet.coolTo', 'Cool to')} value={range.shown.high} accent={t.accent.sky.base}
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
            <ControlLabel label={tr('sheet.mode', 'Mode')} value="" />
            <div style={{ display: 'flex', gap: u(8), flexWrap: 'wrap' }}>
              {modes.map((mode) => {
                const active = mode === state.state;
                const color = hvacModeColor(mode, t);
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
                      padding: `0 ${u(16)}px`, height: u.touch(44), borderRadius: u(12),
                      background: active
                        ? withAlpha(color, 0.16)
                        : t.fg(0.06),
                      border: `1px solid ${active
                        ? withAlpha(color, 0.5)
                        : t.fg(0.1)}`,
                      color: active ? color : t.fg(0.6),
                      fontSize: u(13), fontWeight: active ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >{hvacModeLabel(mode)}</button>
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
  const u = useScale();
  const t = useTheme();
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, height: u.touch(44), borderRadius: u(12),
        background: t.fg(0.06), border: `1px solid ${t.fg(0.1)}`,
        color: t.fg(0.8), fontSize: u(13), fontWeight: 600,
        cursor: 'pointer',
      }}
    >{label}</button>
  );
}

function CoverDetailSheet({ state, onCommand, onClose }: DetailSheetProps) {
  const u = useScale();
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
            <ControlLabel label={tr('sheet.position', 'Position')}
              value={pct === 0
                ? tr('cover.closed', 'Closed')
                : pct === 100
                  ? tr('cover.open', 'Open')
                  : tr('card.percentOpen', '{percent}% open', { percent: pct })} />
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
          <div style={{ display: 'flex', gap: u(10) }}>
            {canOpen && (
              <SheetActionButton label={tr('sheet.open', 'Open')}
                onClick={() => { bumpIdle(); onCommand(state, 'open_cover'); }} />
            )}
            {stoppable && (
              <SheetActionButton label={tr('sheet.stop', 'Stop')}
                onClick={() => { bumpIdle(); onCommand(state, 'stop_cover'); }} />
            )}
            {canClose && (
              <SheetActionButton label={tr('sheet.closeCover', 'Close')}
                onClick={() => { bumpIdle(); onCommand(state, 'close_cover'); }} />
            )}
          </div>
        )}
      </>)}
    </SheetFrame>
  );
}

// ── Fan sheet ───────────────────────────────────────────────────────────────

function FanDetailSheet({ state, onCommand, onClose }: DetailSheetProps) {
  const on = state.state === 'on';
  const adjustable = supportsSpeed(state);
  const step = speedStep(state);
  const fraction = speedFraction(state);
  const pct = Math.round(fraction * 100);

  return (
    <SheetFrame state={state} stateLine={fanStateLine(state)}
      leading={<PowerButton on={on} onClick={() => onCommand(state, 'toggle')} />}
      onClose={onClose}>
      {(bumpIdle) => (
        adjustable ? (
          <div>
            <ControlLabel label={tr('sheet.speed', 'Speed')}
              value={on ? `${pct}%` : tr('common.off', 'Off')} />
            <ThickSlider
              fraction={fraction}
              showFill
              onInteract={bumpIdle}
              // Snapping to the entity's own steps keeps a 3-speed fan on
              // 33/67/100 instead of committing a value it will round away.
              onCommit={(f) => onCommand(state, 'set_percentage', {
                percentage: percentageFromFraction(f, step),
              })}
            />
          </div>
        ) : null
      )}
    </SheetFrame>
  );
}

// ── Vacuum sheet ────────────────────────────────────────────────────────────

/** Plain words for each action, in the order vacuumActions returns them. */
function vacuumActionLabel(action: VacuumAction, mower: boolean): string {
  switch (action) {
    case 'start': return mower ? tr('sheet.startMowing', 'Mow') : tr('sheet.start', 'Start');
    case 'pause': return tr('sheet.pause', 'Pause');
    case 'stop': return tr('sheet.stop', 'Stop');
    case 'dock': return tr('sheet.dock', 'Send home');
    case 'locate': return tr('sheet.locate', 'Find it');
  }
}

function VacuumDetailSheet({ state, onCommand, onClose }: DetailSheetProps) {
  const u = useScale();
  const t = useTheme();
  const mower = isMower(state);
  const actions = vacuumActions(state);
  // Three at most per row: five 44px buttons across a 2-column module would
  // each be narrower than the word inside them.
  const rows = [actions.slice(0, 3), actions.slice(3)].filter((r) => r.length > 0);
  const speeds = fanSpeedList(state);
  const speed = currentFanSpeed(state);

  return (
    <SheetFrame state={state} stateLine={vacuumStateLine(state)} onClose={onClose}>
      {(bumpIdle) => (<>
        {rows.map((row) => (
          <div key={row.join()} style={{ display: 'flex', gap: u(10) }}>
            {row.map((action) => (
              <SheetActionButton key={action} label={vacuumActionLabel(action, mower)}
                onClick={() => {
                  bumpIdle();
                  const service = vacuumService(state, action);
                  if (service) onCommand(state, service);
                }} />
            ))}
          </div>
        ))}

        {speeds.length > 0 && (
          <div>
            <ControlLabel label={tr('sheet.suction', 'Suction')} value="" />
            <div style={{ display: 'flex', gap: u(8), flexWrap: 'wrap' }}>
              {speeds.map((option) => {
                const active = option === speed;
                return (
                  <button
                    key={option}
                    onClick={() => {
                      bumpIdle();
                      onCommand(state, 'set_fan_speed', { fan_speed: option });
                    }}
                    style={{
                      padding: `0 ${u(16)}px`, height: u.touch(44), borderRadius: u(12),
                      background: active ? withAlpha(t.accent.blue.base, 0.16) : t.fg(0.06),
                      border: `1px solid ${active ? withAlpha(t.accent.blue.base, 0.5) : t.fg(0.1)}`,
                      color: active ? t.accent.blue.base : t.fg(0.6),
                      fontSize: u(13), fontWeight: active ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >{fanSpeedLabel(option)}</button>
                );
              })}
            </div>
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
    case 'fan': return <FanDetailSheet state={state} onCommand={onCommand} onClose={onClose} />;
    case 'vacuum': case 'lawn_mower':
      return <VacuumDetailSheet state={state} onCommand={onCommand} onClose={onClose} />;
    default: return null;
  }
}

function ControlLabel({ label, value }: { label: string; value: string }) {
  const u = useScale();
  const t = useTheme();
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      fontSize: u(11), textTransform: 'uppercase', letterSpacing: '0.08em',
      color: t.fg(0.55), marginBottom: u(8),
    }}>
      <span>{label}</span>
      <span style={{
        fontSize: u(13), color: t.fg(), fontWeight: 600,
        letterSpacing: 0, textTransform: 'none', fontVariantNumeric: 'tabular-nums',
      }}>{value}</span>
    </div>
  );
}
