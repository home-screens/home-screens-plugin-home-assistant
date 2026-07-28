// Display views. Each view takes the resolved entity states (filtered down
// to config.entities) and renders them in a specific layout. index.tsx
// picks one based on config.view.

import React from 'react';
import type { HAStateObject, HAArea, HAPluginConfig, CardCommand } from './types';
import { entityDomain } from './types';
import {
  friendlyName, formatValue, relativeTime, isActiveState, isAlertState,
  formatHistoryRange, formatMeasurement,
} from './utils';
import { Icon, iconFor, type IconName } from './icons';
import { EntityCard } from './cards';
import { lookAccent, type ResolvedLook } from './rules';
import { fetchCameraSnapshot } from './api';
import { safeEntityPicture, pictureBackground } from './artwork';
import { sparkPaths, sparkY, type HistorySeries } from './history';
import { pickPowerEntity, powerAverage } from './power';
import { ThickSlider, useEntityPress, HOLD_TO_RUN_MS } from './controls';
import { entityInteraction, NO_INTERACTION, type EntityInteraction } from './interaction';
import { lockActionLabel } from './lock';
import { gaugeBounds, hvacModes, hvacModeLabel, climateStatusLabel } from './climate';
import {
  supportsPlayPause, supportsPrevious, supportsNext, supportsVolumeSlider,
  transportAvailable, supportsAnyTransport, volumeFraction, volumeFromFraction,
  mediaStateLabel,
} from './media';
import {
  collectBatteries, countNeedingCharge, batteryTone, type BatteryTone,
} from './batteries';
import { tr } from './i18n';
import { useScale } from './scale';
import { useTheme, withAlpha, type Theme } from './theme';

interface ViewProps {
  states: HAStateObject[];
  /** Every entity the poll returned, not just the configured ones. Only the
   *  batteries view uses it — it discovers its own entities. */
  allStates?: HAStateObject[];
  config: HAPluginConfig;
  areas?: HAArea[];
  onCommand?: CardCommand;
  /** Long-press detail sheet opener, present when controls are enabled. */
  onOpenDetail?: (state: HAStateObject) => void;
  /** 24h sparkline series by entity id, present when showHistory is on. */
  history?: Record<string, HistorySeries>;
  /** Look-rule resolver (item #4), present when any rules are configured.
   *  Returns the matched overrides for an entity, or undefined for "keep
   *  the normal look". */
  lookFor?: (s: HAStateObject) => ResolvedLook | undefined;
  // Set by the config-modal preview pane. Views that do expensive polling
  // (snapshots, streams) should throttle or disable live fetches so that
  // opening the modal doesn't multiply network load.
  preview?: boolean;
}

// ── Card Grid ───────────────────────────────────────────────────────────────

export function CardGridView({ states, config, onCommand, onOpenDetail, history, lookFor }: ViewProps) {
  const u = useScale();
  const cols = Math.max(1, Math.min(4, config.columns ?? 2));
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gap: u(10),
        padding: `${u(8)}px ${u(14)}px ${u(14)}px`,
      }}
    >
      {states.map((s) => (
        <EntityCard key={s.entity_id} state={s} compact={config.compactMode}
          onCommand={onCommand} onOpenDetail={onOpenDetail}
          history={history?.[s.entity_id]} look={lookFor?.(s)} haUrl={config.haUrl} />
      ))}
    </div>
  );
}

// ── Status Board ────────────────────────────────────────────────────────────

/** Group headings on the status board. These are the plugin's own words for
 *  a Home Assistant domain, not Home Assistant's, so they translate. A
 *  domain with no entry falls back to a title-cased form of the domain id,
 *  which stays English by nature. */
const DOMAIN_LABELS: Record<string, [key: string, english: string]> = {
  light: ['domain.light', 'Lights'],
  switch: ['domain.switch', 'Switches'],
  sensor: ['domain.sensor', 'Sensors'],
  binary_sensor: ['domain.binarySensor', 'Binary Sensors'],
  climate: ['domain.climate', 'Climate'],
  media_player: ['domain.mediaPlayer', 'Media'],
  cover: ['domain.cover', 'Covers'],
  lock: ['domain.lock', 'Locks'],
  person: ['domain.person', 'People'],
  weather: ['domain.weather', 'Weather'],
  fan: ['domain.fan', 'Fans'],
  camera: ['domain.camera', 'Cameras'],
  scene: ['domain.scene', 'Scenes'],
  automation: ['domain.automation', 'Automations'],
  input_boolean: ['domain.inputBoolean', 'Toggles'],
};

function domainLabel(domain: string): string {
  const entry = DOMAIN_LABELS[domain];
  return entry ? tr(entry[0], entry[1]) : capitalizeDomain(domain);
}

export function StatusBoardView({ states, lookFor }: ViewProps) {
  const u = useScale();
  const t = useTheme();
  const groups = new Map<string, HAStateObject[]>();
  for (const s of states) {
    const d = entityDomain(s.entity_id);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(s);
  }
  const ordered = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div style={{ padding: `${u(6)}px ${u(12)}px ${u(14)}px` }}>
      {ordered.map(([domain, entities]) => {
        const activeCount = entities.filter(isActiveState).length;
        return (
          <div key={domain} style={{ marginTop: u(12) }}>
            <div style={{
              fontSize: u(10), textTransform: 'uppercase', letterSpacing: '0.12em',
              color: t.fg(0.45), padding: `${u(4)}px ${u(8)}px`,
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>{domainLabel(domain)}</span>
              <span>{entities.length}{activeCount > 0
                && ` · ${tr('board.active', '{count} active', { count: activeCount })}`}</span>
            </div>
            {entities.map((s, i) => (
              <StatusRow key={s.entity_id} state={s} first={i === 0} look={lookFor?.(s)} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function StatusRow({ state, first, look }: {
  state: HAStateObject; first: boolean; look?: ResolvedLook;
}) {
  const u = useScale();
  const t = useTheme();
  const active = isActiveState(state);
  const alert = isAlertState(state);
  // A matched look rule's tone recolors the whole row signal path: icon,
  // value text, and the dot (which also gets the "needs attention" glow).
  const accent = lookAccent(look, t);
  const color = accent ?? (alert ? t.accent.red.base : active ? t.accent.amber.base : t.fg(0.5));
  const dot = accent ?? (alert ? t.danger : active ? t.ok : t.fg(0.15));
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: u(10), padding: `${u(8)}px ${u(10)}px`,
      borderTop: first ? 'none' : `1px solid ${t.fg(0.04)}`,
    }}>
      <Icon name={look?.icon ?? iconFor(state)} size={u(15)} style={{ color, flexShrink: 0 }} />
      <span style={{ fontSize: u(13), flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {friendlyName(state)}
      </span>
      <span style={{
        fontSize: u(13), fontVariantNumeric: 'tabular-nums',
        color: accent ?? t.fg(0.6),
      }}>
        {look?.label ?? formatValue(state)}
      </span>
      <span style={{
        width: u(6), height: u(6), borderRadius: 99, background: dot,
        boxShadow: active || alert || accent ? `0 0 ${u(6)}px ${dot}` : undefined,
      }} />
    </div>
  );
}

function capitalizeDomain(d: string): string {
  return d.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Room View ───────────────────────────────────────────────────────────────

export function RoomView({ states, config, areas, onCommand, onOpenDetail, history, lookFor }: ViewProps) {
  const u = useScale();
  const t = useTheme();
  const byEntityId = new Map(states.map((s) => [s.entity_id, s]));
  const selectedSet = new Set(config.entities);

  // Build groups: { areaName → entities chosen that live in that area }
  const groups: { name: string; entities: HAStateObject[] }[] = [];
  const claimed = new Set<string>();

  // Restrict to a single area when the user selected one in config.
  const areaScope = config.area && areas
    ? areas.filter((a) => a.area_id === config.area)
    : areas;

  if (areaScope) {
    for (const area of areaScope) {
      const rooms: HAStateObject[] = [];
      for (const eid of area.entities) {
        if (!selectedSet.has(eid)) continue;
        const s = byEntityId.get(eid);
        if (s) { rooms.push(s); claimed.add(eid); }
      }
      if (rooms.length > 0) groups.push({ name: area.name, entities: rooms });
    }
  }
  // Unassigned fallback — skip when a specific area is selected; anything
  // outside the chosen area should be hidden, not relabeled as "Other".
  if (!config.area) {
    const other = states.filter((s) => !claimed.has(s.entity_id));
    if (other.length > 0) groups.push({ name: tr('room.other', 'Other'), entities: other });
  }

  return (
    <div style={{ padding: `${u(6)}px ${u(14)}px ${u(14)}px` }}>
      {groups.map((g) => (
        <div key={g.name} style={{ marginTop: u(14) }}>
          <div style={{
            fontSize: u(13), fontWeight: 600, letterSpacing: '-0.01em',
            padding: `${u(2)}px ${u(2)}px ${u(8)}px`,
            display: 'flex', alignItems: 'baseline', gap: u(8),
          }}>
            <span>{g.name}</span>
            <span style={{
              fontSize: u(10), color: t.fg(0.45),
              background: t.fg(0.05),
              padding: `${u(2)}px ${u(6)}px`, borderRadius: 99,
              letterSpacing: '0.04em',
            }}>{g.entities.length === 1
              ? tr('room.oneEntity', '1 entity')
              : tr('room.entityCount', '{count} entities', { count: g.entities.length })}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: u(8) }}>
            {g.entities.map((s) => (
              <EntityCard key={s.entity_id} state={s} compact
                onCommand={onCommand} onOpenDetail={onOpenDetail}
                history={history?.[s.entity_id]} look={lookFor?.(s)} haUrl={config.haUrl} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Hero sparkline backdrop ─────────────────────────────────────────────────

/** viewBox height for the backdrop chart. The element is stretched to
 *  whatever the module is tall, so this only sets the aspect the path math
 *  works in — 40 keeps the curve legible without exaggerating small wobbles
 *  into mountains. */
const HERO_CHART_H = 40;

/**
 * The 24h series drawn full-bleed behind a hero number, instead of as a
 * strip inside a card. At the size a single-entity module runs, the chart
 * has room to be context rather than decoration: the number stays the thing
 * you read, and the shape behind it answers "is that high for today?".
 *
 * Rendered as a sibling BEFORE the content, which carries `position:
 * relative` — so everything here (chart and scrim both) sits underneath the
 * text without any z-index bookkeeping.
 */
function HeroSparkline({ series, color, avg }: {
  series: HistorySeries;
  color: string;
  /** Draws a dashed line at this value on the chart's own scale. */
  avg?: number;
}) {
  const t = useTheme();
  const gradientId = React.useId();
  const { line, area } = sparkPaths(series, 100, HERO_CHART_H, 2);
  const avgY = avg != null ? sparkY(series, avg, HERO_CHART_H, 2) : null;
  return (
    <>
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, height: '62%',
        pointerEvents: 'none',
      }}>
        <svg
          viewBox={`0 0 100 ${HERO_CHART_H}`} preserveAspectRatio="none"
          style={{ display: 'block', width: '100%', height: '100%' }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.3" />
              <stop offset="1" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradientId})`} />
          <path d={line} fill="none" stroke={color} strokeOpacity={0.5}
            strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          {avgY != null && (
            <path d={`M0,${avgY} L100,${avgY}`} stroke={color} strokeOpacity={0.45}
              strokeWidth={1} strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      </div>
      {/* Legibility scrim over the whole card, not just the chart: bounding
          it to the chart put a hard edge across the module where the
          gradient's first stop began. Darkest where the value's baseline and
          the footer row sit, clear through the middle where the curve is the
          thing worth seeing. */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: `linear-gradient(180deg, ${t.shade(0)} 26%,`
          + ` ${t.shade(0.3)} 46%, ${t.shade(0.04)} 68%, ${t.shade(0.26)} 100%)`,
      }} />
    </>
  );
}

/**
 * The big number a hero view leads with, sized against the module's own
 * width rather than fixed at 72px. A module 300px wide — an ordinary size
 * for "just show me the CO2" — wrapped `617 ppm` after the number and pushed
 * the footer out through the bottom of the card. Requires `containerType:
 * inline-size` on the frame, which HeroFrame sets.
 */
function HeroValue({ color, children }: {
  color?: string; children: React.ReactNode;
}) {
  const u = useScale();
  return (
    <div style={{
      // The clamp bounds scale with the host's Text size; the cqw term
      // between them keeps sizing against the module's own width.
      fontSize: `clamp(${u(30)}px, 13cqw, ${u(72)}px)`,
      fontWeight: 600, letterSpacing: '-0.04em', lineHeight: 0.95,
      fontVariantNumeric: 'tabular-nums', color,
      // A measurement and its unit are one word; breaking them apart reads
      // as two facts.
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    }}>
      {children}
    </div>
  );
}

/** Positioning + container context shared by the hero views: the backdrop
 *  chart absolutely fills this, the content sits on top of it. */
function HeroFrame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'relative', height: '100%', overflow: 'hidden',
      containerType: 'inline-size',
    }}>
      {children}
    </div>
  );
}

/** The label + icon line above a hero number. */
function HeroHeader({ icon, color, name }: {
  icon: IconName; color?: string; name: string;
}) {
  const u = useScale();
  const t = useTheme();
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: u(10),
      fontSize: u(11), textTransform: 'uppercase', letterSpacing: '0.16em',
      color: t.fg(0.45), minWidth: 0,
    }}>
      <Icon name={icon} size={u(20)} style={{ color: color ?? t.accent.orange.base, flexShrink: 0 }} />
      <span style={{
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{name}</span>
    </div>
  );
}

/** Footer strip under a hero number: relative time on the left, the day's
 *  range on the right once there's a chart to explain. */
function HeroFooter({ children }: { children: React.ReactNode }) {
  const u = useScale();
  const t = useTheme();
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      gap: u(12), color: t.fg(0.55), fontSize: u(13),
      fontVariantNumeric: 'tabular-nums',
    }}>
      {children}
    </div>
  );
}

// ── Single Entity Card ──────────────────────────────────────────────────────

// One entity, filling the module — and driving it. A hero tile is the most
// deliberate thing a person can point at on a wall panel, so it carries the
// same gestures its card does: tap runs the entity's action, hold opens the
// sheet, and a lock takes the guarded 1s hold with its sweep. Read-only
// entities (sensors, weather, people) stay inert, as they do everywhere.
export function EntityCardView({ states, lookFor, history, onCommand, onOpenDetail }: ViewProps) {
  const u = useScale();
  const t = useTheme();
  const s = states[0];
  const gestures = s && onCommand ? entityInteraction(s) : NO_INTERACTION;
  const press = useEntityPress({
    tap: s && onCommand && gestures.tapService
      ? () => onCommand(s, gestures.tapService!) : undefined,
    hold: s && onCommand && onOpenDetail && gestures.opensSheet
      ? () => onOpenDetail(s) : undefined,
    guarded: s && onCommand && gestures.guardedService
      ? () => onCommand(s, gestures.guardedService!) : undefined,
  });
  // Hooks above run before this gate, so an empty module can't change the
  // hook order on the render where an entity arrives.
  if (!s) return <EmptyState message={tr('empty.pickEntity', 'Pick an entity in the module config.')} />;
  const look = lookFor?.(s);
  const accent = lookAccent(look, t);
  const series = history?.[s.entity_id];
  const hint = touchHint(s, gestures, press.holding);
  const sweepFrom = withAlpha(t.accent.amber.base, 0.12);
  const sweepTo = withAlpha(t.accent.amber.base, 0.32);
  return (
    <HeroFrame>
      {series && <HeroSparkline series={series} color={accent ?? t.accent.orange.base} />}
      {gestures.guardedService && (
        <div style={{
          position: 'absolute', top: 0, bottom: 0, left: 0,
          width: press.holding ? '100%' : '0%',
          transition: press.holding ? `width ${HOLD_TO_RUN_MS}ms linear` : 'none',
          background: `linear-gradient(90deg, ${sweepFrom}, ${sweepTo})`,
          pointerEvents: 'none',
        }} />
      )}
      <div
        onClick={press.onClick}
        {...press.pressProps}
        style={{
          position: 'relative', height: '100%', padding: `${u(28)}px ${u(24)}px`,
          display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: u(14),
          boxSizing: 'border-box',
          cursor: press.onClick || press.pressProps ? 'pointer' : undefined,
          // The hold must own the gesture or touch scroll steals the pointer.
          touchAction: press.pressProps ? 'none' : undefined,
        }}
      >
        <HeroHeader icon={look?.icon ?? iconFor(s)} color={accent} name={friendlyName(s)} />
        <HeroValue color={accent}>{look?.label ?? formatValue(s)}</HeroValue>
        <HeroFooter>
          <span>{relativeTime(s.last_changed)}</span>
          {series
            ? <span>{formatHistoryRange(s, series.min, series.max)}</span>
            : hint && <span>{hint}</span>}
        </HeroFooter>
      </div>
    </HeroFrame>
  );
}

/** The line that tells a family this tile answers to touch. Nothing for a
 *  plain toggle: "On" flipping to "Off" under a finger teaches that faster
 *  than a label can, and a hint on every tile is a hint nobody reads. */
function touchHint(
  s: HAStateObject, gestures: EntityInteraction, holding: boolean,
): string | null {
  if (gestures.guardedService) {
    return holding ? tr('buttons.keepHolding', 'Keep holding…') : lockActionLabel(s);
  }
  if (!gestures.opensSheet) return null;
  // Deliberately not the climate view's "Tap to adjust": a vacuum stuck under
  // the couch lands on this branch too (no tap action left, sheet still worth
  // opening), and "adjust" is the wrong word for dock and locate.
  return gestures.tapService
    ? tr('hero.holdForControls', 'Hold for controls')
    : tr('hero.tapForControls', 'Tap for controls');
}

// ── Power Now ───────────────────────────────────────────────────────────────

// What the house is pulling right now, against the day behind it. The full
// HA energy dashboard needs WebSocket-only long-term statistics; this is the
// part a kiosk actually reads from across the room.

export function PowerView({ states, history }: ViewProps) {
  const u = useScale();
  const t = useTheme();
  const s = pickPowerEntity(states);
  if (!s) return <EmptyState message={tr('empty.pickPowerSensor', 'Pick a power sensor in the module config.')} />;
  const series = history?.[s.entity_id];
  // Low and High are the series' own extremes: the drawn curve's, so the
  // labels name points the chart actually reaches.
  const stats = series
    ? { min: series.min, max: series.max, avg: powerAverage(series) }
    : null;
  const color = t.accent.amber.base;
  return (
    <HeroFrame>
      {series && <HeroSparkline series={series} color={color} avg={stats?.avg} />}
      <div style={{
        position: 'relative', height: '100%', padding: `${u(26)}px ${u(24)}px`,
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: u(12),
        boxSizing: 'border-box',
      }}>
        <HeroHeader icon={iconFor(s)} color={color} name={friendlyName(s)} />
        <HeroValue>{formatValue(s)}</HeroValue>
        {stats ? (
          // The relative time rides along at the end of this row rather than
          // getting a line of its own: a fourth row does not fit a short
          // module, and the column's flex shrink crushed the hero number to a
          // sliver of digits to make room. It has to be here somewhere — an
          // energy meter that stopped reporting at 3pm still has a full day
          // of cached history behind it, and without this the card shows a
          // confident number with nothing to say it is four hours old.
          <div style={{
            display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap',
            columnGap: `clamp(${u(10)}px, 4cqw, ${u(22)}px)`, rowGap: u(6),
          }}>
            <PowerStat label={tr('power.low', 'Low')}
              value={formatMeasurement(s, stats.min, stats.max)} />
            <PowerStat label={tr('power.average', 'Average')}
              value={formatMeasurement(s, stats.avg, stats.max)} dashed color={color} />
            <PowerStat label={tr('power.high', 'High')}
              value={formatMeasurement(s, stats.max, stats.max)} />
            <span style={{
              marginLeft: 'auto', fontSize: `clamp(${u(10)}px, 4cqw, ${u(13)}px)`,
              color: t.fg(0.55), fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}>
              {relativeTime(s.last_changed)}
            </span>
          </div>
        ) : (
          <HeroFooter>
            <span>{relativeTime(s.last_changed)}</span>
          </HeroFooter>
        )}
      </div>
    </HeroFrame>
  );
}

/** One of the day's three numbers. The average carries a dashed swatch that
 *  matches the dashed line on the chart — otherwise a line across the middle
 *  of a chart is just a line.
 *
 *  Sized against the module width like HeroValue, for the same reason: three
 *  nowrap numbers at a fixed 14px overflow a ~200px-wide module, and the
 *  frame clips rather than scrolls, so "High" lost its last digits. */
function PowerStat({ label, value, dashed, color }: {
  label: string; value: string; dashed?: boolean; color?: string;
}) {
  const u = useScale();
  const t = useTheme();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: u(2), minWidth: 0 }}>
      <span style={{
        fontSize: `clamp(${u(8)}px, 3cqw, ${u(9)}px)`,
        textTransform: 'uppercase', letterSpacing: '0.14em',
        // Lighter than the card labels elsewhere: these sit over the chart,
        // not over flat module background.
        color: t.fg(0.6),
        display: 'flex', alignItems: 'center', gap: u(5),
      }}>
        {dashed && (
          <span style={{
            width: u(12), height: 0, flexShrink: 0,
            borderTop: `1.5px dashed ${color ?? 'currentColor'}`,
          }} />
        )}
        {label}
      </span>
      <span style={{
        fontSize: `clamp(${u(11)}px, 5cqw, ${u(14)}px)`, fontWeight: 600, letterSpacing: '-0.01em',
        color: t.fg(), fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  );
}

// ── Single Row ──────────────────────────────────────────────────────────────

// The row is the hero view's one-line twin, so it answers to touch the same
// way. It has no room for a hint line — the whole view is one line — so what
// it can do is only discoverable by pressing it, which is the trade the
// shape itself makes.
export function EntityRowView({ states, lookFor, onCommand, onOpenDetail }: ViewProps) {
  const u = useScale();
  const t = useTheme();
  const s = states[0];
  const gestures = s && onCommand ? entityInteraction(s) : NO_INTERACTION;
  const press = useEntityPress({
    tap: s && onCommand && gestures.tapService
      ? () => onCommand(s, gestures.tapService!) : undefined,
    hold: s && onCommand && onOpenDetail && gestures.opensSheet
      ? () => onOpenDetail(s) : undefined,
    guarded: s && onCommand && gestures.guardedService
      ? () => onCommand(s, gestures.guardedService!) : undefined,
  });
  if (!s) return <EmptyState message={tr('empty.pickEntity', 'Pick an entity in the module config.')} />;
  const look = lookFor?.(s);
  const accent = lookAccent(look, t);
  return (
    <div
      onClick={press.onClick}
      {...press.pressProps}
      style={{
        height: '100%', padding: `0 ${u(18)}px`,
        display: 'flex', alignItems: 'center', gap: u(12),
        cursor: press.onClick || press.pressProps ? 'pointer' : undefined,
        touchAction: press.pressProps ? 'none' : undefined,
        // The guarded sweep needs a box to fill and a clip to stay inside.
        position: 'relative', overflow: 'hidden', isolation: 'isolate',
      }}>
      {gestures.guardedService && (
        <div style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, zIndex: -1,
          width: press.holding ? '100%' : '0%',
          transition: press.holding ? `width ${HOLD_TO_RUN_MS}ms linear` : 'none',
          background: `linear-gradient(90deg, ${withAlpha(t.accent.amber.base, 0.12)}, ${withAlpha(t.accent.amber.base, 0.32)})`,
          pointerEvents: 'none',
        }} />
      )}
      <Icon name={look?.icon ?? iconFor(s)} size={u(22)} style={{
        color: accent ?? (isActiveState(s) ? t.accent.amber.base : t.fg(0.55)), flexShrink: 0,
      }} />
      <span style={{ fontSize: u(14), flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {friendlyName(s)}
      </span>
      <span style={{
        fontSize: u(20), fontWeight: 600, letterSpacing: '-0.02em',
        fontVariantNumeric: 'tabular-nums', color: accent,
      }}>
        {look?.label ?? formatValue(s)}
      </span>
    </div>
  );
}

// ── Climate Dedicated ───────────────────────────────────────────────────────

export function ClimateView({ states, onOpenDetail }: ViewProps) {
  const u = useScale();
  const t = useTheme();
  const climate = states.find((s) => entityDomain(s.entity_id) === 'climate');
  if (!climate) return <EmptyState message={tr('empty.pickClimate', 'Pick a climate entity in the module config.')} />;
  const cur = climate.attributes.current_temperature;
  const target = climate.attributes.temperature;
  const action = climate.attributes.hvac_action ?? climate.state;
  const humidity = climate.attributes.current_humidity;
  const reportedModes = hvacModes(climate);
  // The pills here are decorative (only the sheet commits a mode), so a
  // placeholder strip beats an empty gap when the entity reports none.
  const modes = reportedModes.length > 0 ? reportedModes : ['heat', 'cool', 'auto', 'off'];

  // Arc progress range: entity min/max with a °C-vs-°F fallback heuristic
  // (display-only; see climate.ts).
  const { min, max } = gaugeBounds(climate);
  const span = max - min;
  const pct = cur != null && span > 0
    ? Math.max(0, Math.min(1, (cur - min) / span))
    : 0.5;
  const dash = 220;
  const filled = dash * pct;
  const grad = action === 'cooling' ? t.accent.sky.base : t.accent.orange.base;

  return (
    // The whole view is one big tap target for the control sheet — climate
    // has no competing tap action, and a kiosk needs targets, not precision.
    <div
      onClick={onOpenDetail ? () => onOpenDetail(climate) : undefined}
      style={{
        padding: `${u(20)}px ${u(18)}px`, display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: u(14), height: '100%',
        cursor: onOpenDetail ? 'pointer' : undefined,
      }}>
      <div style={{
        fontSize: u(11), textTransform: 'uppercase', letterSpacing: '0.16em',
        color: t.fg(0.45),
      }}>{friendlyName(climate)}</div>

      {/* The gauge is the view's one fixed-size element; it caps at the
          module's own width so a scaled-up dial can't push the mode pills
          and the footer out through the bottom of a narrow module. */}
      <div style={{
        position: 'relative', width: `min(100%, ${u(200)}px)`,
        aspectRatio: '1 / 1', flexShrink: 0,
      }}>
        {/* display:block — an inline SVG sits on a text baseline, and the
            descender space under it becomes 3px of extra height now that the
            dial's height comes from its aspect ratio rather than a literal. */}
        <svg viewBox="0 0 100 100" style={{
          display: 'block', width: '100%', height: '100%', transform: 'rotate(135deg)',
        }}>
          <circle cx="50" cy="50" r="44" fill="none" stroke={t.fg(0.08)} strokeWidth="6"
            strokeDasharray={`${dash} 100`} strokeLinecap="round" />
          <circle cx="50" cy="50" r="44" fill="none" stroke={grad} strokeWidth="6"
            strokeDasharray={`${filled} 500`} strokeLinecap="round" />
        </svg>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: u(2),
        }}>
          <div style={{ fontSize: u(52), fontWeight: 600, letterSpacing: '-0.04em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {cur != null ? `${cur}°` : '—'}
          </div>
          {target != null && (
            <div style={{ fontSize: u(12), color: t.fg(0.55), marginTop: u(4) }}>
              {tr('card.target', 'target {temp}°', { temp: String(target) })}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: u(6), flexWrap: 'wrap', justifyContent: 'center' }}>
        {pickVisibleModes(modes, climate.state).map((mode) => {
          const active = mode === climate.state;
          return (
            <span key={mode} style={{
              padding: `${u(6)}px ${u(12)}px`, borderRadius: u(10),
              background: active ? withAlpha(t.accent.orange.base, 0.15) : t.fg(0.05),
              border: `1px solid ${active ? withAlpha(t.accent.orange.base, 0.4) : t.fg(0.1)}`,
              color: active ? t.accent.orange.loud : t.fg(0.55),
              fontSize: u(11), letterSpacing: '-0.01em',
            }}>{hvacModeLabel(mode)}</span>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: u(18), color: t.fg(0.55), fontSize: u(12) }}>
        {typeof humidity === 'number' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: u(4) }}>
            <Icon name="droplet" size={u(12)} />{humidity}%
          </span>
        )}
        <span>{climateStatusLabel(climate)}</span>
        {onOpenDetail && (
          <span style={{ color: t.fg(0.35) }}>{tr('climate.tapToAdjust', 'Tap to adjust')}</span>
        )}
      </div>
    </div>
  );
}

// ── Media Dedicated ─────────────────────────────────────────────────────────

const VOLUME_HIDE_MS = 5_000;

export function MediaView({ states, config, onCommand }: ViewProps) {
  const u = useScale();
  const mp = states.find((s) => entityDomain(s.entity_id) === 'media_player');
  // Every hook precedes the !mp early-return — an entity appearing on a
  // later poll must not change the hook order of a mounted view.
  const playing = mp?.state === 'playing';

  // HA pushes media_position only on state transitions (play/pause/skip), so
  // between polls the bar looks frozen. Tick a 1 Hz counter while playing to
  // force re-renders, and extrapolate `pos` from media_position_updated_at
  // in real time.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!playing) return;
    // Deps intentionally minimal: the tick just bumps a counter, and every
    // render re-reads the freshest `mp` attributes — a track skip or entity
    // swap doesn't need to spin the interval down and back up.
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [playing]);

  // Tap-to-reveal volume: the speaker button shows the slider, which
  // collapses on its own 5s after the last touch — a kiosk shouldn't keep a
  // volume control armed where a passing elbow can blast the house.
  const [volumeOpen, setVolumeOpen] = React.useState(false);
  const volumeTimer = React.useRef<number | null>(null);
  const clearVolumeTimer = React.useCallback(() => {
    if (volumeTimer.current != null) {
      clearTimeout(volumeTimer.current);
      volumeTimer.current = null;
    }
  }, []);
  React.useEffect(() => clearVolumeTimer, [clearVolumeTimer]);
  const pokeVolume = React.useCallback(() => {
    clearVolumeTimer();
    volumeTimer.current = window.setTimeout(() => {
      volumeTimer.current = null;
      setVolumeOpen(false);
    }, VOLUME_HIDE_MS);
  }, [clearVolumeTimer]);
  const toggleVolume = () => {
    if (volumeOpen) {
      clearVolumeTimer();
      setVolumeOpen(false);
    } else {
      setVolumeOpen(true);
      pokeVolume();
    }
  };

  if (!mp) return <EmptyState message={tr('empty.pickMediaPlayer', 'Pick a media player entity in the module config.')} />;
  const art = safeEntityPicture(mp.attributes.entity_picture, config.haUrl);
  const title = mp.attributes.media_title || friendlyName(mp);
  const artist = mp.attributes.media_artist;
  const album = mp.attributes.media_album_name;
  const pos = mp.attributes.media_position;
  const dur = mp.attributes.media_duration;
  const posUpdatedAt = mp.attributes.media_position_updated_at;

  let effectivePos = pos;
  if (typeof pos === 'number' && playing && typeof posUpdatedAt === 'string') {
    const anchored = Date.parse(posUpdatedAt);
    if (!Number.isNaN(anchored)) {
      const elapsed = Math.max(0, (Date.now() - anchored) / 1000);
      effectivePos = typeof dur === 'number' ? Math.min(dur, pos + elapsed) : pos + elapsed;
    }
  }

  const controls = onCommand != null && transportAvailable(mp) && supportsAnyTransport(mp);
  const showVolume = controls && volumeOpen && supportsVolumeSlider(mp);

  const artBg: React.CSSProperties = art ? pictureBackground(art) : {};
  return (
    <div style={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', inset: 0,
        ...(art ? artBg : {
          backgroundImage: 'linear-gradient(135deg, #4338ca, #7e22ce 40%, #db2777)',
        }),
        filter: 'blur(32px) saturate(1.2)', transform: 'scale(1.2)', opacity: 0.55,
      }} />
      {/* From here down the colors are deliberately fixed rather than themed.
          This view covers itself with blurred album art and a dark scrim, so
          its text sits on the artwork, not on the module surface — the host's
          Text color would be answering a question nobody asked, and a dark
          one would vanish into the scrim. */}
      <div style={{
        position: 'relative', display: 'flex', flexDirection: 'column',
        alignItems: 'center', padding: u(22), gap: u(14), height: '100%',
        background: 'linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.7) 100%)',
      }}>
        <div style={{
          // Same cap as the climate gauge: grows with the Text size, never
          // past the module's own width.
          width: `min(70%, ${u(160)}px)`, aspectRatio: '1 / 1',
          flexShrink: 0, borderRadius: u(12),
          ...(art ? artBg : {
            backgroundImage: 'linear-gradient(135deg, #4338ca, #db2777)',
          }),
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'rgba(255,255,255,0.5)', fontSize: u(40), fontWeight: 300,
        }}>
          {!art && '♪'}
        </div>
        <div style={{ textAlign: 'center', maxWidth: '90%' }}>
          <div style={{ fontSize: u(17), fontWeight: 600, letterSpacing: '-0.02em',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
          {artist && (
            <div style={{ fontSize: u(13), color: 'rgba(255,255,255,0.6)', marginTop: u(2),
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {artist}{album ? ` · ${album}` : ''}
            </div>
          )}
        </div>
        {typeof effectivePos === 'number' && typeof dur === 'number' && dur > 0 && (
          <div style={{ width: '80%', display: 'flex', alignItems: 'center', gap: u(8),
            fontSize: u(10), color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>
            <span>{fmtTime(effectivePos)}</span>
            <div style={{ flex: 1, height: u(3), background: 'rgba(255,255,255,0.15)', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, (effectivePos / dur) * 100)}%`, height: '100%', background: '#fff' }} />
            </div>
            <span>{fmtTime(dur)}</span>
          </div>
        )}
        {controls && (
          <div style={{ display: 'flex', alignItems: 'center', gap: u(16) }}>
            {supportsPrevious(mp) && (
              <TransportButton label={tr('media.previous', 'Previous')}
                onClick={() => onCommand!(mp, 'media_previous_track')}>
                <svg width={u(18)} height={u(18)} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 6h2v12H6z" /><path d="M20 6l-10 6 10 6z" />
                </svg>
              </TransportButton>
            )}
            {supportsPlayPause(mp) && (
              <TransportButton big label={playing ? tr('media.pause', 'Pause') : tr('media.play', 'Play')}
                onClick={() => onCommand!(mp, 'media_play_pause')}>
                {playing ? (
                  <svg width={u(22)} height={u(22)} viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7 5h4v14H7z" /><path d="M13 5h4v14h-4z" />
                  </svg>
                ) : (
                  <svg width={u(22)} height={u(22)} viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </TransportButton>
            )}
            {supportsNext(mp) && (
              <TransportButton label={tr('media.next', 'Next')}
                onClick={() => onCommand!(mp, 'media_next_track')}>
                <svg width={u(18)} height={u(18)} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16 6h2v12h-2z" /><path d="M4 6l10 6-10 6z" />
                </svg>
              </TransportButton>
            )}
            {supportsVolumeSlider(mp) && (
              <TransportButton label={tr('media.volume', 'Volume')} active={volumeOpen} onClick={toggleVolume}>
                <svg width={u(18)} height={u(18)} viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                  strokeLinejoin="round">
                  <path d="M11 5L6 9H3v6h3l5 4z" fill="currentColor" stroke="none" />
                  <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                  <path d="M18.5 5.5a9 9 0 0 1 0 13" />
                </svg>
              </TransportButton>
            )}
          </div>
        )}
        {showVolume ? (
          <div style={{ width: '80%' }}>
            <ThickSlider
              fraction={volumeFraction(mp) ?? 0}
              showFill
              onInteract={pokeVolume}
              // The auto-hide must not fire under a held finger — that
              // would unmount the slider mid-drag and drop the commit.
              onDragActive={(active) => (active ? clearVolumeTimer() : pokeVolume())}
              onCommit={(f) => {
                pokeVolume();
                onCommand!(mp, 'volume_set', { volume_level: volumeFromFraction(f) });
              }}
            />
          </div>
        ) : (
          <div style={{ fontSize: u(11), color: 'rgba(255,255,255,0.55)', textTransform: 'capitalize' }}>
            {mediaStateLabel(mp.state)}
          </div>
        )}
      </div>
    </div>
  );
}

function TransportButton({ label, big, active, onClick, children }: {
  label: string; big?: boolean; active?: boolean;
  onClick: () => void; children: React.ReactNode;
}) {
  const u = useScale();
  const size = u.touch(big ? 56 : 44);
  return (
    <button
      onClick={onClick}
      aria-label={label}
      style={{
        width: size, height: size, borderRadius: 99,
        flexShrink: 0, padding: 0, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: big ? 'rgba(255,255,255,0.92)'
          : active ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.1)',
        border: `1px solid ${active ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.14)'}`,
        color: big ? '#0b0f1a' : '#fff',
        boxShadow: big ? '0 6px 18px rgba(0,0,0,0.35)' : undefined,
      }}
    >{children}</button>
  );
}

// Keep the pill strip at 4 entries, but never drop the active mode off the
// end — if the current mode is beyond the cap, swap it in.
function pickVisibleModes(modes: string[], current: string): string[] {
  const head = modes.slice(0, 4);
  if (!modes.includes(current) || head.includes(current)) return head;
  return [...head.slice(0, 3), current];
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ── Batteries ───────────────────────────────────────────────────────────────

// The one view that picks its own entities: every battery sensor Home
// Assistant reports, emptiest first. Nobody wants to hand-pick sixteen
// battery sensors, and a new sensor should show up on its own — so this
// view reads the full poll (`allStates`) and ignores the entity list.

/** Charge level to color. Resolved per theme rather than as a constant —
 *  "nearly flat" has to stay legible on a light module too. */
function batteryColor(tone: BatteryTone, t: Theme): string {
  switch (tone) {
    case 'low': return t.accent.red.base;
    case 'warn': return t.accent.amber.base;
    case 'ok': return t.fg(0.55);
  }
}

export function BatteriesView({ states, allStates, config }: ViewProps) {
  const u = useScale();
  const t = useTheme();
  const entries = collectBatteries(allStates ?? states);
  if (entries.length === 0) {
    return <EmptyState message={tr('empty.noBatteries', 'No battery levels found. Home Assistant reports these for phones, door sensors, remotes, and the like.')} />;
  }
  const needing = countNeedingCharge(entries);
  const compact = config.compactMode;
  return (
    <div style={{
      flex: 1, minHeight: 0, overflowY: 'auto',
      padding: compact
        ? `${u(4)}px ${u(12)}px ${u(12)}px`
        : `${u(6)}px ${u(14)}px ${u(14)}px`,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        padding: `${u(4)}px ${u(2)}px ${u(8)}px`, fontSize: u(12),
        color: needing > 0 ? t.accent.red.loud : t.fg(0.5),
      }}>
        <span style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>
          {needing === 0
            ? tr('batteries.allCharged', 'All charged')
            : needing === 1
              ? tr('batteries.oneNeedsCharging', '1 needs charging')
              : tr('batteries.needCharging', '{count} need charging', { count: needing })}
        </span>
        <span style={{ fontSize: u(11), color: t.fg(0.35) }}>
          {entries.length}
        </span>
      </div>
      {entries.map(({ state, level }, i) => (
        <BatteryRow key={state.entity_id} state={state} level={level}
          first={i === 0} compact={compact} />
      ))}
    </div>
  );
}

function BatteryRow({ state, level, first, compact }: {
  state: HAStateObject; level: number; first: boolean; compact?: boolean;
}) {
  const u = useScale();
  const t = useTheme();
  const color = batteryColor(batteryTone(level), t);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: u(10),
      padding: compact ? `${u(6)}px ${u(4)}px` : `${u(9)}px ${u(4)}px`,
      borderTop: first ? 'none' : `1px solid ${t.fg(0.05)}`,
    }}>
      <BatteryGlyph level={level} color={color} />
      <span style={{
        fontSize: u(13), flex: 1, minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {friendlyName(state)}
      </span>
      <span style={{
        fontSize: u(13), fontWeight: 600, color,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {Math.round(level)}%
      </span>
    </div>
  );
}

/** Battery outline with the charge drawn inside — same shape at every size,
 *  filled left-to-right so a glance down the column reads as a bar chart. */
function BatteryGlyph({ level, color }: { level: number; color: string }) {
  const u = useScale();
  const t = useTheme();
  // 17 wide at x=3 ends at 20, leaving the same 1.5 gap to the outline's
  // inner edge (21.5) that the fill has on the left and top/bottom — any
  // less and a 100% battery reads as not-quite-full down the column.
  const inner = Math.max(0, Math.min(1, level / 100)) * 17;
  return (
    <svg width={u(26)} height={u(14)} viewBox="0 0 26 14" fill="none" aria-hidden="true"
      style={{ flexShrink: 0 }}>
      <rect x="0.75" y="0.75" width="21.5" height="12.5" rx="3"
        stroke={t.fg(0.25)} strokeWidth="1.5" />
      <path d="M24 5v4" stroke={t.fg(0.25)} strokeWidth="1.5"
        strokeLinecap="round" />
      {inner > 0 && (
        <rect x="3" y="3" width={inner} height="8" rx="1.5" fill={color} />
      )}
    </svg>
  );
}

// ── Cameras ─────────────────────────────────────────────────────────────────

export function CameraView({ states, config, preview }: ViewProps) {
  const u = useScale();
  const cams = states.filter((s) => entityDomain(s.entity_id) === 'camera');
  if (cams.length === 0) return <EmptyState message={tr('empty.noCameras', 'No camera entities selected.')} />;
  // Camera snapshots are expensive — poll at roughly the configured interval
  // but floor at 5 s so a user with refreshInterval=15 doesn't hammer HA.
  // In the config-modal preview, cap at 60 s and skip MJPEG streams so
  // opening the modal doesn't multiply camera load N× while the user browses
  // entities.
  const refreshMs = preview
    ? 60_000
    : Math.max(5_000, (config.refreshInterval ?? 30) * 1000);
  return (
    <div style={{
      padding: u(12), height: '100%',
      display: 'grid', gap: u(8),
      gridTemplateColumns: `repeat(${cams.length > 1 ? 2 : 1}, 1fr)`,
    }}>
      {cams.map((s) => (
        <CameraTile key={s.entity_id} state={s} haUrl={config.haUrl}
          refreshMs={refreshMs} preview={preview} />
      ))}
    </div>
  );
}

// CameraTile tries MJPEG streaming first (what Lovelace does) and falls back
// to snapshot polling if the entity doesn't expose an access_token or if the
// stream <img> errors out.
//
// MJPEG path: HA camera entities publish a short-lived `access_token`
// attribute on /api/states. Combined with /api/camera_proxy_stream/<id> and
// the token-as-query-param auth that endpoint supports, we can hand a URL
// straight to <img src>. The browser renders multipart/x-mixed-replace as a
// live video stream — no hls.js, no WebRTC, no host proxy changes. The token
// rotates every few minutes; changing the `key` on the <img> forces a clean
// reconnect when a new state arrives with a new token.
//
// Snapshot fallback: DIY camera entities sometimes don't expose
// access_token. For those we reuse the original blob-fetch loop, routed
// through our pluginFetch proxy with the bearer token server-side.
function CameraTile({ state, haUrl, refreshMs, preview }: {
  state: HAStateObject; haUrl: string; refreshMs: number; preview?: boolean;
}) {
  const token = typeof state.attributes.access_token === 'string'
    ? state.attributes.access_token : undefined;

  // imgFailed flips if the MJPEG <img> emits an onError — the stream endpoint
  // might be unavailable (camera offline, stream integration not enabled).
  // When that happens we fall back to the snapshot loop for this mount.
  const [imgFailed, setImgFailed] = React.useState(false);
  // HA rotates `access_token` every few minutes, and a fresh token means a
  // fresh chance at MJPEG — without this reset a single transient stream
  // failure would lock the tile on snapshot polling for the life of the
  // component, even after the camera recovers.
  React.useEffect(() => { setImgFailed(false); }, [token]);
  // Skip live MJPEG in the preview pane — the stream keeps a socket open
  // for every preview render, which is wasteful while the modal is open.
  const useStream = !preview && token && !imgFailed;

  const streamSrc = useStream
    ? buildStreamUrl(haUrl, state.entity_id, token!)
    : null;

  return (
    <TileShell state={state}>
      {useStream ? (
        <img
          key={token}
          src={streamSrc!}
          alt={friendlyName(state)}
          onError={() => {
            // Log so DevTools shows the URL that failed — most likely
            // explanation when this fires is that the browser refused
            // the cross-origin MJPEG or HA returned 503/401 for that token.
            // eslint-disable-next-line no-console
            console.warn('[home-assistant plugin] MJPEG stream failed for',
              state.entity_id, '— falling back to snapshot polling.',
              'URL was:', streamSrc);
            setImgFailed(true);
          }}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            objectFit: 'cover', display: 'block',
          }}
        />
      ) : (
        <SnapshotImage state={state} haUrl={haUrl} refreshMs={refreshMs}
          tokenMissing={!token} />
      )}
    </TileShell>
  );
}

function buildStreamUrl(haUrl: string, entityId: string, token: string): string {
  // interval=0.1 → HA emits one frame every 100ms (~10 FPS). For cameras
  // that don't expose native MJPEG (UniFi Protect, most modern IP cams),
  // HA synthesizes the stream from still snapshots at this cadence. Lower
  // is smoother; too low (<0.05) just overruns HA's snapshot pipeline.
  const base = haUrl.replace(/\/+$/, '');
  return `${base}/api/camera_proxy_stream/${encodeURIComponent(entityId)}`
    + `?token=${encodeURIComponent(token)}`
    + `&interval=0.1`;
}

function SnapshotImage({ state, haUrl, refreshMs, tokenMissing }: {
  state: HAStateObject; haUrl: string; refreshMs: number; tokenMissing?: boolean;
}) {
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    // Shared across overlapping load() calls — a fetch slower than refreshMs
    // can otherwise leak an object URL if two tasks stomp on each other's
    // local `currentUrl`. The ref is the single source of truth.
    const currentUrlRef = { value: null as string | null };
    let inflight = false;

    async function load() {
      if (inflight || cancelled) return;
      inflight = true;
      try {
        const blob = await fetchCameraSnapshot(haUrl, state.entity_id);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        const previous = currentUrlRef.value;
        currentUrlRef.value = url;
        setObjectUrl(url);
        setError(null);
        if (previous) URL.revokeObjectURL(previous);
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : 'Failed to load snapshot';
          setError(msg);
          // Intentionally leave `objectUrl` set — when a camera blips mid-
          // session we'd rather show the last-known frame than flash an
          // "unavailable" card. The fallback tile only renders when there
          // was never a successful fetch (`error && !objectUrl`).
          // eslint-disable-next-line no-console
          console.warn('[home-assistant plugin] snapshot failed for', state.entity_id, msg);
        }
      } finally {
        inflight = false;
      }
    }

    load();
    const id = setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (currentUrlRef.value) URL.revokeObjectURL(currentUrlRef.value);
    };
  }, [haUrl, state.entity_id, refreshMs]);

  if (state.state === 'unavailable') {
    return <TileFallback>{tr('camera.offline', 'Camera offline')}</TileFallback>;
  }
  if (error && !objectUrl) {
    return <TileFallback>
      {tokenMissing
        ? tr('camera.noToken', 'No access token, check the camera entity')
        : tr('camera.unavailable', 'Camera unavailable')}
    </TileFallback>;
  }
  if (!objectUrl) {
    return <TileFallback>{tr('camera.loading', 'Loading…')}</TileFallback>;
  }
  return (
    <img
      src={objectUrl}
      alt={friendlyName(state)}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        objectFit: 'cover', display: 'block',
      }}
    />
  );
}

function TileFallback({ children }: { children: React.ReactNode }) {
  const u = useScale();
  const t = useTheme();
  return (
    <div style={{
      position: 'absolute', inset: 0, padding: u(12),
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: t.fg(0.4), fontSize: u(11), textAlign: 'center',
    }}>{children}</div>
  );
}

function TileShell({ state, children }: { state: HAStateObject; children: React.ReactNode }) {
  const u = useScale();
  const t = useTheme();
  return (
    <div style={{
      position: 'relative', borderRadius: u(10), overflow: 'hidden',
      background: 'linear-gradient(135deg, #1f2937, #0f172a)',
      border: `1px solid ${t.fg(0.08)}`,
      minHeight: u(100), aspectRatio: '16/9',
    }}>
      {children}
      {state.state === 'recording' && (
        <span style={{
          position: 'absolute', top: u(8), right: u(8), width: u(8), height: u(8),
          background: t.danger, borderRadius: 99, boxShadow: `0 0 ${u(8)}px ${t.danger}`,
        }} />
      )}
      <span style={{
        position: 'absolute', bottom: u(8), left: u(8),
        fontSize: u(11), fontWeight: 500, color: '#fff',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        padding: `${u(3)}px ${u(8)}px`, borderRadius: u(6),
      }}>{friendlyName(state)}</span>
    </div>
  );
}

// ── Empty state shared ──────────────────────────────────────────────────────

export function EmptyState({ message }: { message: string }) {
  const u = useScale();
  const t = useTheme();
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', padding: u(24), color: t.fg(0.45),
      fontSize: u(13), textAlign: 'center', lineHeight: 1.5,
    }}>
      {message}
    </div>
  );
}
