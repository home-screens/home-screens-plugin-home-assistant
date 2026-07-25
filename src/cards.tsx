// Entity cards — domain-aware visual representations of an HA state.
// Each card exports its own component; `EntityCard` at the bottom routes
// by domain. Cards are read-only here; interactive controls live in
// controls.tsx and are composed in by views when config.showControls is on.

import React from 'react';
import type { HAStateObject, CardCommand, HAButtonTone } from './types';
import { entityDomain } from './types';
import { friendlyName, formatValue, relativeTime, isActiveState, isAlertState, batteryAlert, formatHistoryRange } from './utils';
import { Icon, iconFor } from './icons';
import { lookAccent, type ResolvedLook } from './rules';
import { safeEntityPicture, pictureBackground } from './artwork';
import { useLongPress, HOLD_TO_RUN_MS } from './controls';
import { sparkPaths, type HistorySeries } from './history';
import { lockService, lockActionLabel } from './lock';
import { supportsSpeed } from './fan';
import { tr } from './i18n';

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

const TONE_STYLES: Record<NonNullable<CardShellProps['tone']>, React.CSSProperties> = {
  default: {
    background: 'rgba(255, 255, 255, 0.04)',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    color: 'rgba(255, 255, 255, 0.75)',
  },
  on: {
    background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.12), rgba(255, 255, 255, 0.03))',
    borderColor: 'rgba(251, 191, 36, 0.22)',
    color: '#fef3c7',
  },
  active: {
    background: 'linear-gradient(135deg, rgba(251, 146, 60, 0.14), rgba(251, 146, 60, 0.04))',
    borderColor: 'rgba(251, 146, 60, 0.28)',
    color: '#fed7aa',
  },
  alert: {
    background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.12), rgba(239, 68, 68, 0.02))',
    borderColor: 'rgba(239, 68, 68, 0.26)',
    color: '#fecaca',
  },
};

/** Look-rule tone surfaces — the buttons/alerts palette expressed in the
 *  card gradient language (amber intentionally matches the 'on' tone, red
 *  the 'alert' tone, so rule-tinted and domain-tinted cards sit together). */
export const RULE_TONE_STYLES: Record<Exclude<HAButtonTone, 'default'>, React.CSSProperties> = {
  amber: TONE_STYLES.on,
  red: TONE_STYLES.alert,
  blue: {
    background: 'linear-gradient(135deg, rgba(96, 165, 250, 0.13), rgba(96, 165, 250, 0.02))',
    borderColor: 'rgba(96, 165, 250, 0.28)',
    color: '#bfdbfe',
  },
  green: {
    background: 'linear-gradient(135deg, rgba(74, 222, 128, 0.12), rgba(74, 222, 128, 0.02))',
    borderColor: 'rgba(74, 222, 128, 0.26)',
    color: '#bbf7d0',
  },
  purple: {
    background: 'linear-gradient(135deg, rgba(192, 132, 252, 0.13), rgba(192, 132, 252, 0.02))',
    borderColor: 'rgba(192, 132, 252, 0.28)',
    color: '#e9d5ff',
  },
};

export function CardShell({ state, compact, spanFull, onClick, pressProps, children, tone = 'default', look }: CardShellProps) {
  const toneStyle = look?.tone ? RULE_TONE_STYLES[look.tone] : TONE_STYLES[tone];
  return (
    <div
      onClick={onClick}
      {...pressProps}
      style={{
        ...toneStyle,
        border: `1px solid ${toneStyle.borderColor}`,
        borderRadius: 12,
        // Anchors and clips overlays drawn inside a card (the lock's hold
        // sweep); harmless for the cards that draw none. `isolate` makes the
        // shell a stacking context so a z-index:-1 overlay lands above the
        // card background and below the text, without every text element
        // needing its own positioning.
        position: 'relative',
        overflow: 'hidden',
        isolation: 'isolate',
        padding: compact ? 10 : 14,
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 4 : 6,
        minHeight: compact ? 72 : 100,
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
  const accent = lookAccent(look);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: accent ?? color ?? 'currentColor' }}>
      <Icon name={look?.icon ?? iconFor(state)} size={18} />
      <span
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'rgba(255, 255, 255, 0.6)',
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
  return (
    <div
      style={{
        fontSize: compact ? 20 : 24,
        fontWeight: 600,
        letterSpacing: '-0.02em',
        lineHeight: 1.15,
        color: faint ? 'rgba(255, 255, 255, 0.55)' : '#fff',
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
  return (
    <div
      style={{
        fontSize: 11,
        color: 'rgba(255, 255, 255, 0.45)',
        marginTop: 'auto',
        display: 'flex',
        justifyContent: 'space-between',
        gap: 6,
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
  const gradientId = React.useId();
  const color = alert ? '#f87171' : '#fbbf24';
  const { line, area, endX, endY } = sparkPaths(series);
  return (
    <>
      <svg
        viewBox="0 0 100 30" preserveAspectRatio="none"
        style={{ display: 'block', width: '100%', height: compact ? 22 : 30, marginTop: 2 }}
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
        fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 1,
        fontVariantNumeric: 'tabular-nums',
      }}>
        <span>24h</span>
        <span>{formatHistoryRange(state, series.min, series.max)}</span>
      </div>
    </>
  );
}

function BinarySensorCard({ state, compact, look }: ReadOnlyCardProps) {
  const alert = isAlertState(state);
  const on = state.state === 'on';
  return (
    <CardShell state={state} compact={compact} tone={alert ? 'alert' : on ? 'on' : 'default'} look={look}>
      <CardHeader state={state} look={look} />
      <BigValue compact={compact} faint={state.state === 'off' && !look?.label}>{look?.label ?? formatValue(state)}</BigValue>
      <SubText>
        <span>{relativeTime(state.last_changed)}</span>
        {alert && <span style={{ color: '#f87171' }}>● alert</span>}
      </SubText>
    </CardShell>
  );
}

function LightCard({ state, compact, onTap, look, onOpenDetail }: CardProps & { onOpenDetail?: () => void }) {
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
        {look?.label ?? (on ? 'On' : 'Off')}
        {!look?.label && on && brightness != null && (
          <span style={{ fontSize: 14, fontWeight: 400, color: 'rgba(255,255,255,0.55)', marginLeft: 6 }}>
            · {brightness}%
          </span>
        )}
      </BigValue>
      <SubText>
        {on && temp
          ? <span>Warm · {temp}K</span>
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
        <span>{target != null ? `target ${target}°` : ''}</span>
        <span style={{ textTransform: 'capitalize' }}>{action || state.state}</span>
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
        <span style={{ textTransform: 'capitalize' }}>{state.state.replace(/-/g, ' ')}</span>
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
  const active = isActiveState(state);
  const title = state.attributes.media_title;
  const artist = state.attributes.media_artist;
  return (
    <CardShell state={state} compact={compact} spanFull tone={active ? 'active' : 'default'} onClick={onTap} look={look}>
      <CardHeader state={state} look={look} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {look?.label ?? (title || formatValue(state))}
        </div>
        {artist && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{artist}</div>}
      </div>
      <SubText><span style={{ textTransform: 'capitalize' }}>{state.state}</span></SubText>
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
      <SubText>{typeof pos === 'number' && <span>{pos}% open</span>}</SubText>
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
  const unlocked = state.state === 'unlocked';
  const jammed = state.state === 'jammed';
  const [holding, setHolding] = React.useState(false);
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
          background: 'linear-gradient(90deg, rgba(251,191,36,0.12), rgba(251,191,36,0.32))',
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
        {look?.label ?? (on ? 'On' : 'Off')}
        {!look?.label && on && typeof pct === 'number' && (
          <span style={{ fontSize: 14, fontWeight: 400, color: 'rgba(255,255,255,0.55)', marginLeft: 6 }}>
            · {pct}%
          </span>
        )}
      </BigValue>
    </CardShell>
  );
}

function SceneCard({ state, compact, onTap, look }: CardProps) {
  return (
    <CardShell state={state} compact={compact} tone="default" onClick={onTap} look={look}>
      <CardHeader state={state} look={look} />
      <BigValue compact={compact} faint={!onTap && !look?.label}>
        {look?.label ?? (onTap ? 'Activate' : 'Scene')}
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

// Default tap action by domain. null = tap is a no-op (read-only domain).
function defaultTapService(d: string): string | null {
  switch (d) {
    case 'light': case 'switch': case 'fan': case 'input_boolean': case 'automation':
      return 'toggle';
    case 'scene':
      return 'turn_on';
    case 'media_player':
      return 'media_play_pause';
    case 'cover':
      return 'toggle';
    default:
      return null;
  }
}

export function EntityCard({ state, compact, onCommand, onOpenDetail, history, look, haUrl }: EntityCardProps) {
  if (state.state === 'unavailable') {
    return (
      <CardShell state={state} compact={compact} tone="default">
        <CardHeader state={state} />
        <div style={{
          fontSize: 13, color: 'rgba(255,255,255,0.35)',
          fontStyle: 'italic', marginTop: 'auto',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          Unavailable
        </div>
      </CardShell>
    );
  }
  const d = entityDomain(state.entity_id);
  const tapService = onCommand ? defaultTapService(d) : null;
  const onTap = tapService ? () => onCommand!(state, tapService) : undefined;

  switch (d) {
    case 'sensor': return <SensorCard state={state} compact={compact} look={look} history={history} />;
    case 'binary_sensor': return <BinarySensorCard state={state} compact={compact} look={look} />;
    case 'light': return (
      <LightCard state={state} compact={compact} onTap={onTap} look={look}
        onOpenDetail={onCommand && onOpenDetail ? () => onOpenDetail(state) : undefined} />
    );
    case 'switch': case 'input_boolean': case 'automation': return <SwitchCard state={state} compact={compact} onTap={onTap} look={look} />;
    case 'climate': return (
      <ClimateCard state={state} compact={compact} look={look}
        onOpenDetail={onCommand && onOpenDetail ? () => onOpenDetail(state) : undefined} />
    );
    case 'weather': return <WeatherCard state={state} compact={compact} look={look} />;
    case 'person': return <PersonCard state={state} compact={compact} look={look} haUrl={haUrl} />;
    case 'media_player': return <MediaPlayerCard state={state} compact={compact} onTap={onTap} look={look} />;
    case 'cover': return (
      <CoverCard state={state} compact={compact} onTap={onTap} look={look}
        onOpenDetail={onCommand && onOpenDetail ? () => onOpenDetail(state) : undefined} />
    );
    case 'lock': return (
      <LockCard state={state} compact={compact} look={look}
        onRun={onCommand && lockService(state)
          ? () => onCommand!(state, lockService(state)!)
          : undefined} />
    );
    case 'fan': return (
      <FanCard state={state} compact={compact} onTap={onTap} look={look}
        // A fan with no speed to set has an empty sheet, and wiring the hold
        // would cost the tap-toggle for that gesture to open it.
        onOpenDetail={onCommand && onOpenDetail && supportsSpeed(state)
          ? () => onOpenDetail(state)
          : undefined} />
    );
    case 'scene': return <SceneCard state={state} compact={compact} onTap={onTap} look={look} />;
    default: return <GenericCard state={state} compact={compact} look={look} />;
  }
}
