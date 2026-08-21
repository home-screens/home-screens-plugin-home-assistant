// Entity cards — domain-aware visual representations of an HA state.
// Each card exports its own component; `EntityCard` at the bottom routes
// by domain. Cards are read-only here; interactive controls live in
// controls.tsx and are composed in by views when config.showControls is on.

import React from 'react';
import type { HAStateObject, CardCommand } from './types';
import { entityDomain } from './types';
import {
  friendlyName, formatValue, relativeTime, isActiveState, isAlertState,
  batteryAlert, formatHistoryRange, weatherLabel,
} from './utils';
import { Icon, iconFor } from './icons';
import { lookAccent, type ResolvedLook } from './rules';
import { safeEntityPicture, pictureBackground } from './artwork';
import { useLongPress, HOLD_TO_RUN_MS } from './controls';
import { sparkPaths, type HistorySeries } from './history';
import { lockActionLabel } from './lock';
import {
  isRunning, vacuumBattery, currentFanSpeed, fanSpeedLabel, vacuumStateLabel,
} from './vacuum';
import { entityInteraction } from './interaction';
import { climateStatusLabel } from './climate';
import { mediaStateLabel } from './media';
import { tr } from './i18n';
import { useScale } from './scale';
import { useTheme, withAlpha } from './theme';

// ── Shared CardShell ────────────────────────────────────────────────────────

interface CardShellProps {
  state: HAStateObject;
  compact?: boolean;
  spanFull?: boolean;
  onClick?: () => void;
  /** Raw pointer handlers (from useLongPress) for cards that distinguish
   *  tap from hold. Mutually exclusive with onClick. */
  pressProps?: React.DOMAttributes<HTMLDivElement>;
  children: React.ReactNode;
  tone?: 'default' | 'on' | 'active' | 'alert';
  /** Matched look rule (item #4): its tone wins over the domain tone. */
  look?: ResolvedLook;
}

// Tone surfaces now live in theme.tsx: the same "on" amber has to read on a
// light module as well as a dark one, and only the theme knows which it is.

export function CardShell({ state, compact, spanFull, onClick, pressProps, children, tone = 'default', look }: CardShellProps) {
  const u = useScale();
  const t = useTheme();
  const toneStyle = look?.tone ? t.ruleTone[look.tone] : t.cardTone[tone];
  return (
    <div
      onClick={onClick}
      {...pressProps}
      style={{
        ...toneStyle,
        border: `1px solid ${toneStyle.borderColor}`,
        borderRadius: u(12),
        // Anchors and clips overlays drawn inside a card (the lock's hold
        // sweep); harmless for the cards that draw none. `isolate` makes the
        // shell a stacking context so a z-index:-1 overlay lands above the
        // card background and below the text, without every text element
        // needing its own positioning.
        position: 'relative',
        overflow: 'hidden',
        isolation: 'isolate',
        padding: compact ? u(10) : u(14),
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? u(4) : u(6),
        minHeight: compact ? u(72) : u(100),
        gridColumn: spanFull ? '1 / -1' : undefined,
        cursor: onClick || pressProps ? 'pointer' : 'default',
        // Long-press cards must own the gesture — otherwise touch scroll
        // steals the pointer and the hold never fires on the kiosk.
        touchAction: pressProps ? 'none' : undefined,
        transition: 'transform 0.12s ease, background 0.15s ease',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </div>
  );
}

function CardHeader({ state, color, look }: {
  state: HAStateObject; color?: string; look?: ResolvedLook;
}) {
  const u = useScale();
  const t = useTheme();
  const accent = lookAccent(look, t);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: u(8), color: accent ?? color ?? 'currentColor' }}>
      <Icon name={look?.icon ?? iconFor(state)} size={u(18)} />
      <span
        style={{
          fontSize: u(10),
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: t.fg(0.6),
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {friendlyName(state)}
      </span>
    </div>
  );
}

// Convention for every domain card: the big value renders `look?.label ??
// <its domain default>`, and toggled domains guard their fade with
// `&& !look?.label` — a custom label from a look rule must never render faint.
function BigValue({ children, faint, compact }: {
  children: React.ReactNode; faint?: boolean; compact?: boolean;
}) {
  const u = useScale();
  const t = useTheme();
  return (
    <div
      style={{
        fontSize: compact ? u(20) : u(24),
        fontWeight: 600,
        letterSpacing: '-0.02em',
        lineHeight: 1.15,
        color: faint ? t.fg(0.55) : t.fg(),
        fontVariantNumeric: 'tabular-nums',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

function SubText({ children }: { children: React.ReactNode }) {
  const u = useScale();
  const t = useTheme();
  return (
    <div
      style={{
        fontSize: u(11),
        color: t.fg(0.45),
        marginTop: 'auto',
        display: 'flex',
        justifyContent: 'space-between',
        gap: u(6),
      }}
    >
      {children}
    </div>
  );
}

// ── Individual cards ────────────────────────────────────────────────────────
//
// Cards that accept an optional `onTap` become tappable when the host config
// has showControls=true. Read-only domains (sensor, binary_sensor, weather,
// person) never use onTap — tapping should do nothing.

type CardProps = { state: HAStateObject; compact?: boolean; onTap?: () => void; look?: ResolvedLook };
type ReadOnlyCardProps = { state: HAStateObject; compact?: boolean; look?: ResolvedLook };

function SensorCard({ state, compact, look, history }: ReadOnlyCardProps & { history?: HistorySeries }) {
  const alert = batteryAlert(state);
  return (
    <CardShell state={state} compact={compact} tone={alert ? 'alert' : 'default'} look={look}>
      <CardHeader state={state} look={look} />
      <BigValue compact={compact}>{look?.label ?? formatValue(state)}</BigValue>
      {history ? (
        <Sparkline state={state} series={history} alert={alert} compact={compact} />
      ) : (
        <SubText>
          <span>{relativeTime(state.last_changed)}</span>
        </SubText>
      )}
    </CardShell>
  );
}

// 24h inline sparkline: line + soft gradient fill + a dot at "now". The
// min–max footer replaces the relative-time line — with a full day of
// context on screen, "4m ago" says less than the day's range.
function Sparkline({ state, series, alert, compact }: {
  state: HAStateObject; series: HistorySeries; alert?: boolean; compact?: boolean;
}) {
  const u = useScale();
  const t = useTheme();
  const gradientId = React.useId();
  const color = alert ? t.accent.red.base : t.accent.amber.base;
  const { line, area, endX, endY } = sparkPaths(series);
  return (
    <>
      <svg
        viewBox="0 0 100 30" preserveAspectRatio="none"
        style={{ display: 'block', width: '100%', height: compact ? u(22) : u(30), marginTop: u(2) }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke={color} strokeWidth={1.6}
          vectorEffect="non-scaling-stroke" />
        {/* Zero-length round-cap stroke instead of <circle>: the viewBox is
            stretched (preserveAspectRatio none), which would smear a circle
            into an ellipse; non-scaling-stroke keeps the cap round. */}
        <path d={`M${endX},${endY} l0.01,0`} stroke={color} strokeWidth={4.8}
          strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: u(9), color: t.fg(0.3), marginTop: u(1),
        fontVariantNumeric: 'tabular-nums',
      }}>
        <span>{tr('card.dayWindow', '24h')}</span>
        <span>{formatHistoryRange(state, series.min, series.max)}</span>
      </div>
    </>
  );
}

function BinarySensorCard({ state, compact, look }: ReadOnlyCardProps) {
  const t = useTheme();
  const alert = isAlertState(state);
  const on = state.state === 'on';
  return (
    <CardShell state={state} compact={compact} tone={alert ? 'alert' : on ? 'on' : 'default'} look={look}>
      <CardHeader state={state} look={look} />
      <BigValue compact={compact} faint={state.state === 'off' && !look?.label}>{look?.label ?? formatValue(state)}</BigValue>
      <SubText>
        <span>{relativeTime(state.last_changed)}</span>
        {alert && <span style={{ color: t.accent.red.base }}>{`● ${tr('card.alert', 'alert')}`}</span>}
      </SubText>
    </CardShell>
  );
}

function LightCard({ state, compact, onTap, look, onOpenDetail }: CardProps & { onOpenDetail?: () => void }) {
  const u = useScale();
  const t = useTheme();
  const on = state.state === 'on';
  const brightness = typeof state.attributes.brightness === 'number'
    ? Math.round((state.attributes.brightness / 255) * 100)
    : null;
  const temp = state.attributes.color_temp_kelvin;
  // With a detail sheet available, the pointer handlers own the gesture:
  // quick tap keeps toggling, holding opens the sheet. Hooks must run
  // unconditionally, so the noop branch just goes unused.
  const pressProps = useLongPress(onOpenDetail ?? (() => {}), onTap);
  const holdable = onOpenDetail != null && onTap != null;
  return (
    <CardShell
      state={state} compact={compact} tone={on ? 'on' : 'default'} look={look}
      onClick={holdable ? undefined : onTap}
      pressProps={holdable ? pressProps : undefined}
    >
      <CardHeader state={state} look={look} />
      <BigValue compact={compact} faint={!on && !look?.label}>
        {look?.label ?? (on ? tr('common.on', 'On') : tr('common.off', 'Off'))}
        {!look?.label && on && brightness != null && (
          <span style={{ fontSize: u(14), fontWeight: 400, color: t.fg(0.55), marginLeft: u(6) }}>
            · {brightness}%
          </span>
        )}
      </BigValue>
      <SubText>
        {on && temp
          ? <span>{tr('card.warm', 'Warm · {kelvin}K', { kelvin: String(temp) })}</span>
          : <span>{relativeTime(state.last_changed)}</span>}
      </SubText>
    </CardShell>
  );
}

function SwitchCard({ state, compact, onTap, look }: CardProps) {
  const on = state.state === 'on';
  return (
    <CardShell state={state} compact={compact} tone={on ? 'on' : 'default'} onClick={onTap} look={look}>
      <CardHeader state={state} look={look} />
      <BigValue compact={compact} faint={!on && !look?.label}>{look?.label ?? formatValue(state)}</BigValue>
      <SubText><span>{relativeTime(state.last_changed)}</span></SubText>
    </CardShell>
  );
}

function ClimateCard({ state, compact, look, onOpenDetail }: ReadOnlyCardProps & {
  onOpenDetail?: () => void;
}) {
  const active = isActiveState(state);
  const current = state.attributes.current_temperature;
  const target = state.attributes.temperature;
  const action = state.attributes.hvac_action;
  return (
    // Climate has no tap action to protect, so a plain tap opens the detail
    // sheet — no long-press needed.
    <CardShell state={state} compact={compact} tone={active ? 'active' : 'default'} look={look}
      onClick={onOpenDetail}>
      <CardHeader state={state} look={look} />
      <BigValue compact={compact}>
        {look?.label ?? (current != null ? `${current}°` : formatValue(state))}
      </BigValue>
      <SubText>
        <span>{target != null ? tr('card.target', 'target {temp}°', { temp: String(target) }) : ''}</span>
        <span>{climateStatusLabel(state)}</span>
      </SubText>
    </CardShell>
  );
}

function WeatherCard({ state, compact, look }: ReadOnlyCardProps) {
  const temp = state.attributes.temperature;
  return (
    <CardShell state={state} compact={compact} tone="default" look={look}>
      <CardHeader state={state} look={look} />
      <BigValue compact={compact}>{look?.label ?? (temp != null ? `${temp}°` : formatValue(state))}</BigValue>
      <SubText>
        <span>{weatherLabel(state.state)}</span>
        {typeof state.attributes.humidity === 'number' && <span>{state.attributes.humidity}% RH</span>}
      </SubText>
    </CardShell>
  );
}

// People are the one domain where the card can show WHO rather than describe
// them. When Home Assistant has a picture for someone, it fills the right of
// the tile and dissolves into the card on its way to the text — greyed and
// dimmed while they're out, so a glance down the grid reads as faces present
// and faces away.
//
// Anchored right rather than full-bleed: these cards are roughly twice as
// wide as they are tall, so a `cover` background of a portrait photo crops to
// a band across the eyes and puts the face directly under the state text.
// Fitting the picture to the card's height and feathering its left edge keeps
// the head intact and leaves the text column clean.
function PersonCard({ state, compact, look, haUrl }: ReadOnlyCardProps & {
  haUrl?: string;
}) {
  const home = state.state === 'home';
  const portrait = safeEntityPicture(state.attributes.entity_picture, haUrl ?? '');
  // The picture covers this band exactly, so the mask's fade lands on the
  // image rather than on empty space beside it — with `auto 100%` sizing the
  // image would be as wide as the card is tall, which is narrower than any
  // band we can name in CSS, and the leftover gap turns the feather into a
  // hard edge. `center 30%` keeps heads in frame on the vertical crop.
  const fade = 'linear-gradient(90deg, transparent 0%, #000 62%)';
  return (
    <CardShell state={state} compact={compact} tone={home ? 'on' : 'default'} look={look}>
      {portrait && (
        // zIndex -1 against CardShell's `isolation: isolate` puts the picture
        // above the card fill and below the text — the same trick the lock's
        // hold sweep uses.
        <div style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: '58%', zIndex: -1,
          ...pictureBackground(portrait, { position: 'center 30%' }),
          opacity: home ? 0.85 : 0.42,
          filter: home ? undefined : 'grayscale(0.8)',
          maskImage: fade, WebkitMaskImage: fade,
          pointerEvents: 'none',
        }} />
      )}
      <CardHeader state={state} look={look} />
      <BigValue compact={compact} faint={!home && !look?.label}>
        {look?.label ?? formatValue(state)}
      </BigValue>
      <SubText><span>{relativeTime(state.last_changed)}</span></SubText>
    </CardShell>
  );
}

function MediaPlayerCard({ state, compact, onTap, look }: CardProps) {
  const u = useScale();
  const t = useTheme();
  const active = isActiveState(state);
  const title = state.attributes.media_title;
  const artist = state.attributes.media_artist;
  return (
    <CardShell state={state} compact={compact} spanFull tone={active ? 'active' : 'default'} onClick={onTap} look={look}>
      <CardHeader state={state} look={look} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: u(2) }}>
        <div style={{ fontSize: u(15), fontWeight: 600, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {look?.label ?? (title || formatValue(state))}
        </div>
        {artist && <div style={{ fontSize: u(12), color: t.fg(0.55) }}>{artist}</div>}
      </div>
      <SubText><span>{mediaStateLabel(state.state)}</span></SubText>
    </CardShell>
  );
}

function CoverCard({ state, compact, onTap, look, onOpenDetail }: CardProps & {
  onOpenDetail?: () => void;
}) {
  const open = state.state === 'open' || state.state === 'opening';
  const pos = state.attributes.current_position;
  // Same gesture split as LightCard: quick tap keeps toggling, holding
  // opens the position sheet. Hooks must run unconditionally.
  const pressProps = useLongPress(onOpenDetail ?? (() => {}), onTap);
  const holdable = onOpenDetail != null && onTap != null;
  return (
    <CardShell state={state} compact={compact} tone={open ? 'on' : 'default'} look={look}
      onClick={holdable ? undefined : onTap}
      pressProps={holdable ? pressProps : undefined}>
      <CardHeader state={state} look={look} />
      <BigValue compact={compact} faint={!open && !look?.label}>{look?.label ?? formatValue(state)}</BigValue>
      <SubText>{typeof pos === 'number' && <span>{tr('card.percentOpen', '{percent}% open', { percent: pos })}</span>}</SubText>
    </CardShell>
  );
}

// A lock is the one card where an accidental brush must not do anything, so
// its action is the same 1s hold-to-run the buttons view uses for the garage
// door: a sweep fills the card while the finger stays down, and letting go
// early cancels with no service call. Locks that want a PIN (`code_format`)
// get no action at all until there's a keypad to ask with.
function LockCard({ state, compact, look, onRun }: ReadOnlyCardProps & {
  onRun?: () => void;
}) {
  const t = useTheme();
  const unlocked = state.state === 'unlocked';
  const jammed = state.state === 'jammed';
  const [holding, setHolding] = React.useState(false);
  // The sweep has to stay visible against whatever the card is tinted, so it
  // rides the amber accent at the two alphas the buttons view uses.
  const sweepFrom = withAlpha(t.accent.amber.base, 0.12);
  const sweepTo = withAlpha(t.accent.amber.base, 0.32);
  // Hooks run unconditionally. The noop branch covers both a lock whose state
  // offers no action and one that loses its action mid-hold: useLongPress
  // fires whatever this render passes, so the countdown ends in nothing
  // rather than in a service call the card stopped offering.
  const pressProps = useLongPress(onRun ?? (() => {}), undefined, {
    holdMs: HOLD_TO_RUN_MS,
    onHoldChange: setHolding,
  });
  const hint = onRun ? lockActionLabel(state) : null;
  return (
    <CardShell state={state} compact={compact} tone={jammed ? 'alert' : unlocked ? 'on' : 'default'} look={look}
      pressProps={onRun ? pressProps : undefined}>
      {onRun && (
        <div style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, zIndex: -1,
          width: holding ? '100%' : '0%',
          transition: holding ? `width ${HOLD_TO_RUN_MS}ms linear` : 'none',
          background: `linear-gradient(90deg, ${sweepFrom}, ${sweepTo})`,
          pointerEvents: 'none',
        }} />
      )}
      <CardHeader state={state} look={look} />
      <BigValue compact={compact} faint={!unlocked && !jammed && !look?.label}>
        {look?.label ?? formatValue(state)}
      </BigValue>
      {/* The hold feedback replaces the hint on the sub line rather than the
          value: BigValue is 24px and ellipsized, and a card two columns wide
          cuts "Keep holding…" to "Keep hold…" in English and worse in German.
          The sweep filling the card is the loud half of the feedback anyway. */}
      <SubText>
        <span>
          {holding
            ? tr('buttons.keepHolding', 'Keep holding…')
            : hint ?? relativeTime(state.last_changed)}
        </span>
      </SubText>
    </CardShell>
  );
}

function FanCard({ state, compact, onTap, look, onOpenDetail }: CardProps & {
  onOpenDetail?: () => void;
}) {
  const u = useScale();
  const t = useTheme();
  const on = state.state === 'on';
  const pct = state.attributes.percentage;
  // Same gesture split as LightCard: quick tap toggles, holding opens the
  // speed sheet. Hooks must run unconditionally.
  const pressProps = useLongPress(onOpenDetail ?? (() => {}), onTap);
  const holdable = onOpenDetail != null && onTap != null;
  return (
    <CardShell state={state} compact={compact} tone={on ? 'on' : 'default'} look={look}
      onClick={holdable ? undefined : onTap}
      pressProps={holdable ? pressProps : undefined}>
      <CardHeader state={state} look={look} />
      <BigValue compact={compact} faint={!on && !look?.label}>
        {look?.label ?? (on ? tr('common.on', 'On') : tr('common.off', 'Off'))}
        {!look?.label && on && typeof pct === 'number' && (
          <span style={{ fontSize: u(14), fontWeight: 400, color: t.fg(0.55), marginLeft: u(6) }}>
            · {pct}%
          </span>
        )}
      </BigValue>
    </CardShell>
  );
}

// Robot vacuums and mowers: the card says what the machine is doing and how
// much charge it has left, which is the whole question a family asks of one
// in passing. Tap sends it out or pauses it (vacuumTapAction picks by state);
// holding opens the sheet with dock, locate, and suction.
function VacuumCard({ state, compact, onTap, look, onOpenDetail }: CardProps & {
  onOpenDetail?: () => void;
}) {
  const t = useTheme();
  const running = isRunning(state);
  const error = state.state === 'error';
  const battery = vacuumBattery(state);
  const speed = currentFanSpeed(state);
  const pressProps = useLongPress(onOpenDetail ?? (() => {}), onTap);
  // Only a robot with a tap action needs the gesture split. A stuck one has
  // no tap to protect, so its tap opens the sheet directly (the climate
  // card's arrangement) — the state where you most want dock and locate
  // must not be the state where the sheet is hardest to reach.
  const holdable = onOpenDetail != null && onTap != null;
  return (
    <CardShell
      state={state} compact={compact} look={look}
      tone={error ? 'alert' : running ? 'active' : 'default'}
      onClick={holdable ? undefined : onTap ?? onOpenDetail}
      pressProps={holdable ? pressProps : undefined}>
      <CardHeader state={state} look={look} />
      {/* Docked is this domain's "off" — the robot is parked and there is
          nothing to read. Paused stays full strength: it is a job the family
          left half-finished. */}
      <BigValue compact={compact} faint={!running && !error && state.state !== 'paused' && !look?.label}>
        {look?.label ?? vacuumStateLabel(state)}
      </BigValue>
      <SubText>
        {battery != null && (
          <span style={{ color: battery <= 20 ? t.accent.red.base : undefined }}>
            {tr('vacuum.battery', '{percent}% battery', { percent: battery })}
          </span>
        )}
        {speed && <span>{fanSpeedLabel(speed)}</span>}
        {/* Battery often lives on a separate sensor entity, and a mower has
            no fan speed at all. Without this the card would sit in a grid of
            timestamps with a blank strip under its state word. */}
        {battery == null && !speed && <span>{relativeTime(state.last_changed)}</span>}
      </SubText>
    </CardShell>
  );
}

function SceneCard({ state, compact, onTap, look }: CardProps) {
  return (
    <CardShell state={state} compact={compact} tone="default" onClick={onTap} look={look}>
      <CardHeader state={state} look={look} />
      <BigValue compact={compact} faint={!onTap && !look?.label}>
        {look?.label ?? (onTap ? tr('card.activate', 'Activate') : tr('card.scene', 'Scene'))}
      </BigValue>
      <SubText><span>{relativeTime(state.last_changed)}</span></SubText>
    </CardShell>
  );
}

function GenericCard({ state, compact, look }: ReadOnlyCardProps) {
  return (
    <CardShell state={state} compact={compact} look={look}>
      <CardHeader state={state} look={look} />
      <BigValue compact={compact}>{look?.label ?? formatValue(state)}</BigValue>
      <SubText><span>{relativeTime(state.last_changed)}</span></SubText>
    </CardShell>
  );
}


// ── Chip ────────────────────────────────────────────────────────────────────

/** The small pill the full-screen views put their summaries in ("3 home",
 *  "Exporting 1.6 kW", a temperature). `dot` draws a glowing status dot
 *  before the text; `color` tints the text for a green or red verdict. */
export function Chip({ color, dot, children }: {
  color?: string; dot?: string; children: React.ReactNode;
}) {
  const u = useScale();
  const t = useTheme();
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: u(6),
      padding: `${u(4)}px ${u(10)}px`, borderRadius: 99,
      background: t.fg(0.06), border: `1px solid ${t.fg(0.08)}`,
      fontSize: u(12), fontWeight: 500, color: color ?? t.fg(0.85),
      fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
    }}>
      {dot && (
        <span style={{
          width: u(7), height: u(7), borderRadius: 99, background: dot, flexShrink: 0,
          boxShadow: `0 0 ${u(6)}px ${withAlpha(dot, 0.7)}`,
        }} />
      )}
      {children}
    </span>
  );
}

// ── Domain router ──────────────────────────────────────────────────────────

interface EntityCardProps {
  state: HAStateObject;
  compact?: boolean;
  onCommand?: CardCommand;
  /** Opens the entity's detail sheet (light/cover/fan: long-press; climate:
   *  tap). Only passed when controls are enabled. */
  onOpenDetail?: (state: HAStateObject) => void;
  /** 24h series for this entity, when showHistory is on and it qualifies. */
  history?: HistorySeries;
  /** Matched look rule for this entity (tone / icon / label overrides). */
  look?: ResolvedLook;
  /** Connection URL, for resolving root-relative `entity_picture` paths
   *  (person portraits) against the HA origin. */
  haUrl?: string;
}

export function EntityCard({ state, compact, onCommand, onOpenDetail, history, look, haUrl }: EntityCardProps) {
  const u = useScale();
  const t = useTheme();
  if (state.state === 'unavailable') {
    return (
      <CardShell state={state} compact={compact} tone="default">
        <CardHeader state={state} />
        <div style={{
          fontSize: u(13), color: t.fg(0.35),
          fontStyle: 'italic', marginTop: 'auto',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {tr('common.unavailable', 'Unavailable')}
        </div>
      </CardShell>
    );
  }
  const d = entityDomain(state.entity_id);
  // What touch does for this entity is decided in interaction.ts, so the
  // hero views offer the same gestures without restating the rules.
  const gestures = entityInteraction(state);
  const onTap = onCommand && gestures.tapService
    ? () => onCommand(state, gestures.tapService!)
    : undefined;
  const openSheet = onCommand && onOpenDetail && gestures.opensSheet
    ? () => onOpenDetail(state)
    : undefined;
  const onRun = onCommand && gestures.guardedService
    ? () => onCommand(state, gestures.guardedService!)
    : undefined;

  switch (d) {
    case 'sensor': return <SensorCard state={state} compact={compact} look={look} history={history} />;
    case 'binary_sensor': return <BinarySensorCard state={state} compact={compact} look={look} />;
    case 'light': return (
      <LightCard state={state} compact={compact} onTap={onTap} look={look}
        onOpenDetail={openSheet} />
    );
    case 'switch': case 'input_boolean': case 'automation': return <SwitchCard state={state} compact={compact} onTap={onTap} look={look} />;
    case 'climate': return (
      <ClimateCard state={state} compact={compact} look={look}
        onOpenDetail={openSheet} />
    );
    case 'weather': return <WeatherCard state={state} compact={compact} look={look} />;
    case 'person': return <PersonCard state={state} compact={compact} look={look} haUrl={haUrl} />;
    case 'media_player': return <MediaPlayerCard state={state} compact={compact} onTap={onTap} look={look} />;
    case 'cover': return (
      <CoverCard state={state} compact={compact} onTap={onTap} look={look}
        onOpenDetail={openSheet} />
    );
    case 'lock': return (
      <LockCard state={state} compact={compact} look={look} onRun={onRun} />
    );
    case 'fan': return (
      <FanCard state={state} compact={compact} onTap={onTap} look={look}
        onOpenDetail={openSheet} />
    );
    case 'vacuum': case 'lawn_mower': return (
      <VacuumCard state={state} compact={compact} onTap={onTap} look={look}
        onOpenDetail={openSheet} />
    );
    case 'scene': return <SceneCard state={state} compact={compact} onTap={onTap} look={look} />;
    default: return <GenericCard state={state} compact={compact} look={look} />;
  }
}
