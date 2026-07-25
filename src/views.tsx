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
import { pickPowerEntity, powerStats } from './power';
import { ThickSlider } from './controls';
import { gaugeBounds, hvacModes } from './climate';
import {
  supportsPlayPause, supportsPrevious, supportsNext, supportsVolumeSlider,
  transportAvailable, supportsAnyTransport, volumeFraction, volumeFromFraction,
} from './media';
import {
  collectBatteries, countNeedingCharge, batteryTone, type BatteryTone,
} from './batteries';
import { tr } from './i18n';

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
  const cols = Math.max(1, Math.min(4, config.columns ?? 2));
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gap: 10,
        padding: '8px 14px 14px',
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

const DOMAIN_LABELS: Record<string, string> = {
  light: 'Lights', switch: 'Switches', sensor: 'Sensors', binary_sensor: 'Binary Sensors',
  climate: 'Climate', media_player: 'Media', cover: 'Covers', lock: 'Locks',
  person: 'People', weather: 'Weather', fan: 'Fans', camera: 'Cameras',
  scene: 'Scenes', automation: 'Automations', input_boolean: 'Toggles',
};

export function StatusBoardView({ states, lookFor }: ViewProps) {
  const groups = new Map<string, HAStateObject[]>();
  for (const s of states) {
    const d = entityDomain(s.entity_id);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(s);
  }
  const ordered = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div style={{ padding: '6px 12px 14px' }}>
      {ordered.map(([domain, entities]) => {
        const activeCount = entities.filter(isActiveState).length;
        return (
          <div key={domain} style={{ marginTop: 12 }}>
            <div style={{
              fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em',
              color: 'rgba(255,255,255,0.45)', padding: '4px 8px',
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>{DOMAIN_LABELS[domain] ?? capitalizeDomain(domain)}</span>
              <span>{entities.length}{activeCount > 0 && ` · ${activeCount} active`}</span>
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
  const active = isActiveState(state);
  const alert = isAlertState(state);
  // A matched look rule's tone recolors the whole row signal path: icon,
  // value text, and the dot (which also gets the "needs attention" glow).
  const accent = lookAccent(look);
  const color = accent ?? (alert ? '#f87171' : active ? '#fbbf24' : 'rgba(255,255,255,0.5)');
  const dot = accent ?? (alert ? '#ef4444' : active ? '#22c55e' : 'rgba(255,255,255,0.15)');
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
      borderTop: first ? 'none' : '1px solid rgba(255,255,255,0.04)',
    }}>
      <Icon name={look?.icon ?? iconFor(state)} size={15} style={{ color, flexShrink: 0 }} />
      <span style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {friendlyName(state)}
      </span>
      <span style={{
        fontSize: 13, fontVariantNumeric: 'tabular-nums',
        color: accent ?? 'rgba(255,255,255,0.6)',
      }}>
        {look?.label ?? formatValue(state)}
      </span>
      <span style={{
        width: 6, height: 6, borderRadius: 99, background: dot,
        boxShadow: active || alert || accent ? `0 0 6px ${dot}` : undefined,
      }} />
    </div>
  );
}

function capitalizeDomain(d: string): string {
  return d.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Room View ───────────────────────────────────────────────────────────────

export function RoomView({ states, config, areas, onCommand, onOpenDetail, history, lookFor }: ViewProps) {
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
    if (other.length > 0) groups.push({ name: 'Other', entities: other });
  }

  return (
    <div style={{ padding: '6px 14px 14px' }}>
      {groups.map((g) => (
        <div key={g.name} style={{ marginTop: 14 }}>
          <div style={{
            fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em',
            padding: '2px 2px 8px', display: 'flex', alignItems: 'baseline', gap: 8,
          }}>
            <span>{g.name}</span>
            <span style={{
              fontSize: 10, color: 'rgba(255,255,255,0.45)',
              background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: 99,
              letterSpacing: '0.04em',
            }}>{g.entities.length} {g.entities.length === 1 ? 'entity' : 'entities'}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
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
        background: 'linear-gradient(180deg, rgba(0,0,0,0) 26%,'
          + ' rgba(0,0,0,0.3) 46%, rgba(0,0,0,0.04) 68%, rgba(0,0,0,0.26) 100%)',
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
  return (
    <div style={{
      fontSize: 'clamp(30px, 13cqw, 72px)',
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
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.16em',
      color: 'rgba(255,255,255,0.45)', minWidth: 0,
    }}>
      <Icon name={icon} size={20} style={{ color: color ?? '#fb923c', flexShrink: 0 }} />
      <span style={{
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{name}</span>
    </div>
  );
}

/** Footer strip under a hero number: relative time on the left, the day's
 *  range on the right once there's a chart to explain. */
function HeroFooter({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      gap: 12, color: 'rgba(255,255,255,0.55)', fontSize: 13,
      fontVariantNumeric: 'tabular-nums',
    }}>
      {children}
    </div>
  );
}

// ── Single Entity Card ──────────────────────────────────────────────────────

export function EntityCardView({ states, lookFor, history }: ViewProps) {
  const s = states[0];
  if (!s) return <EmptyState message="Pick an entity in the module config." />;
  const look = lookFor?.(s);
  const accent = lookAccent(look);
  const series = history?.[s.entity_id];
  return (
    <HeroFrame>
      {series && <HeroSparkline series={series} color={accent ?? '#fb923c'} />}
      <div style={{
        position: 'relative', height: '100%', padding: '28px 24px',
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14,
        boxSizing: 'border-box',
      }}>
        <HeroHeader icon={look?.icon ?? iconFor(s)} color={accent} name={friendlyName(s)} />
        <HeroValue color={accent}>{look?.label ?? formatValue(s)}</HeroValue>
        <HeroFooter>
          <span>{relativeTime(s.last_changed)}</span>
          {series && <span>{formatHistoryRange(s, series.min, series.max)}</span>}
        </HeroFooter>
      </div>
    </HeroFrame>
  );
}

// ── Power Now ───────────────────────────────────────────────────────────────

// What the house is pulling right now, against the day behind it. The full
// HA energy dashboard needs WebSocket-only long-term statistics; this is the
// part a kiosk actually reads from across the room.

export function PowerView({ states, history }: ViewProps) {
  const s = pickPowerEntity(states);
  if (!s) return <EmptyState message="Pick a power sensor in the module config." />;
  const series = history?.[s.entity_id];
  const stats = series ? powerStats(series) : null;
  const color = '#fbbf24';
  return (
    <HeroFrame>
      {series && <HeroSparkline series={series} color={color} avg={stats?.avg} />}
      <div style={{
        position: 'relative', height: '100%', padding: '26px 24px',
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 12,
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
            columnGap: 'clamp(10px, 4cqw, 22px)', rowGap: 6,
          }}>
            <PowerStat label={tr('power.low', 'Low')}
              value={formatMeasurement(s, stats.min, stats.max)} />
            <PowerStat label={tr('power.average', 'Average')}
              value={formatMeasurement(s, stats.avg, stats.max)} dashed color={color} />
            <PowerStat label={tr('power.high', 'High')}
              value={formatMeasurement(s, stats.max, stats.max)} />
            <span style={{
              marginLeft: 'auto', fontSize: 'clamp(10px, 4cqw, 13px)',
              color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums',
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{
        fontSize: 'clamp(8px, 3cqw, 9px)', textTransform: 'uppercase', letterSpacing: '0.14em',
        // Lighter than the card labels elsewhere: these sit over the chart,
        // not over flat module background.
        color: 'rgba(255,255,255,0.6)',
        display: 'flex', alignItems: 'center', gap: 5,
      }}>
        {dashed && (
          <span style={{
            width: 12, height: 0, flexShrink: 0,
            borderTop: `1.5px dashed ${color ?? 'currentColor'}`,
          }} />
        )}
        {label}
      </span>
      <span style={{
        fontSize: 'clamp(11px, 5cqw, 14px)', fontWeight: 600, letterSpacing: '-0.01em',
        color: '#fff', fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  );
}

// ── Single Row ──────────────────────────────────────────────────────────────

export function EntityRowView({ states, lookFor }: ViewProps) {
  const s = states[0];
  if (!s) return <EmptyState message="Pick an entity in the module config." />;
  const look = lookFor?.(s);
  const accent = lookAccent(look);
  return (
    <div style={{
      height: '100%', padding: '0 18px',
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <Icon name={look?.icon ?? iconFor(s)} size={22} style={{
        color: accent ?? (isActiveState(s) ? '#fbbf24' : 'rgba(255,255,255,0.55)'), flexShrink: 0,
      }} />
      <span style={{ fontSize: 14, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {friendlyName(s)}
      </span>
      <span style={{
        fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em',
        fontVariantNumeric: 'tabular-nums', color: accent,
      }}>
        {look?.label ?? formatValue(s)}
      </span>
    </div>
  );
}

// ── Climate Dedicated ───────────────────────────────────────────────────────

export function ClimateView({ states, onOpenDetail }: ViewProps) {
  const climate = states.find((s) => entityDomain(s.entity_id) === 'climate');
  if (!climate) return <EmptyState message="Pick a climate entity in the module config." />;
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
  const grad = action === 'cooling' ? '#38bdf8' : '#fb923c';

  return (
    // The whole view is one big tap target for the control sheet — climate
    // has no competing tap action, and a kiosk needs targets, not precision.
    <div
      onClick={onOpenDetail ? () => onOpenDetail(climate) : undefined}
      style={{
        padding: '20px 18px', display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: 14, height: '100%',
        cursor: onOpenDetail ? 'pointer' : undefined,
      }}>
      <div style={{
        fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.16em',
        color: 'rgba(255,255,255,0.45)',
      }}>{friendlyName(climate)}</div>

      <div style={{ position: 'relative', width: 200, height: 200 }}>
        <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%', transform: 'rotate(135deg)' }}>
          <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6"
            strokeDasharray={`${dash} 100`} strokeLinecap="round" />
          <circle cx="50" cy="50" r="44" fill="none" stroke={grad} strokeWidth="6"
            strokeDasharray={`${filled} 500`} strokeLinecap="round" />
        </svg>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 2,
        }}>
          <div style={{ fontSize: 52, fontWeight: 600, letterSpacing: '-0.04em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {cur != null ? `${cur}°` : '—'}
          </div>
          {target != null && (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 4 }}>
              target {target}°
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
        {pickVisibleModes(modes, climate.state).map((mode) => {
          const active = mode === climate.state;
          return (
            <span key={mode} style={{
              padding: '6px 12px', borderRadius: 10,
              background: active ? 'rgba(251, 146, 60, 0.15)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${active ? 'rgba(251, 146, 60, 0.4)' : 'rgba(255,255,255,0.1)'}`,
              color: active ? '#fdba74' : 'rgba(255,255,255,0.55)',
              fontSize: 11, letterSpacing: '-0.01em', textTransform: 'capitalize',
            }}>{mode.replace(/_/g, ' ')}</span>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 18, color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>
        {typeof humidity === 'number' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Icon name="droplet" size={12} />{humidity}%
          </span>
        )}
        <span style={{ textTransform: 'capitalize' }}>{action}</span>
        {onOpenDetail && (
          <span style={{ color: 'rgba(255,255,255,0.35)' }}>Tap to adjust</span>
        )}
      </div>
    </div>
  );
}

// ── Media Dedicated ─────────────────────────────────────────────────────────

const VOLUME_HIDE_MS = 5_000;

export function MediaView({ states, config, onCommand }: ViewProps) {
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

  if (!mp) return <EmptyState message="Pick a media_player entity." />;
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
      <div style={{
        position: 'relative', display: 'flex', flexDirection: 'column',
        alignItems: 'center', padding: 22, gap: 14, height: '100%',
        background: 'linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.7) 100%)',
      }}>
        <div style={{
          width: 160, height: 160, borderRadius: 12,
          ...(art ? artBg : {
            backgroundImage: 'linear-gradient(135deg, #4338ca, #db2777)',
          }),
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'rgba(255,255,255,0.5)', fontSize: 40, fontWeight: 300,
        }}>
          {!art && '♪'}
        </div>
        <div style={{ textAlign: 'center', maxWidth: '90%' }}>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
          {artist && (
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', marginTop: 2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {artist}{album ? ` · ${album}` : ''}
            </div>
          )}
        </div>
        {typeof effectivePos === 'number' && typeof dur === 'number' && dur > 0 && (
          <div style={{ width: '80%', display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 10, color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>
            <span>{fmtTime(effectivePos)}</span>
            <div style={{ flex: 1, height: 3, background: 'rgba(255,255,255,0.15)', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, (effectivePos / dur) * 100)}%`, height: '100%', background: '#fff' }} />
            </div>
            <span>{fmtTime(dur)}</span>
          </div>
        )}
        {controls && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {supportsPrevious(mp) && (
              <TransportButton label="Previous"
                onClick={() => onCommand!(mp, 'media_previous_track')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 6h2v12H6z" /><path d="M20 6l-10 6 10 6z" />
                </svg>
              </TransportButton>
            )}
            {supportsPlayPause(mp) && (
              <TransportButton big label={playing ? 'Pause' : 'Play'}
                onClick={() => onCommand!(mp, 'media_play_pause')}>
                {playing ? (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7 5h4v14H7z" /><path d="M13 5h4v14h-4z" />
                  </svg>
                ) : (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </TransportButton>
            )}
            {supportsNext(mp) && (
              <TransportButton label="Next"
                onClick={() => onCommand!(mp, 'media_next_track')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16 6h2v12h-2z" /><path d="M4 6l10 6-10 6z" />
                </svg>
              </TransportButton>
            )}
            {supportsVolumeSlider(mp) && (
              <TransportButton label="Volume" active={volumeOpen} onClick={toggleVolume}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
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
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', textTransform: 'capitalize' }}>
            {playing ? 'Playing' : mp.state}
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
  return (
    <button
      onClick={onClick}
      aria-label={label}
      style={{
        width: big ? 56 : 44, height: big ? 56 : 44, borderRadius: 99,
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

const BATTERY_COLORS: Record<BatteryTone, string> = {
  low: '#f87171',
  warn: '#fbbf24',
  ok: 'rgba(255,255,255,0.55)',
};

export function BatteriesView({ states, allStates, config }: ViewProps) {
  const entries = collectBatteries(allStates ?? states);
  if (entries.length === 0) {
    return <EmptyState message="No battery levels found. Home Assistant reports these for phones, door sensors, remotes, and the like." />;
  }
  const needing = countNeedingCharge(entries);
  const compact = config.compactMode;
  return (
    <div style={{
      flex: 1, minHeight: 0, overflowY: 'auto',
      padding: compact ? '4px 12px 12px' : '6px 14px 14px',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        padding: '4px 2px 8px', fontSize: 12,
        color: needing > 0 ? '#fca5a5' : 'rgba(255,255,255,0.5)',
      }}>
        <span style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>
          {needing === 0
            ? tr('batteries.allCharged', 'All charged')
            : needing === 1
              ? tr('batteries.oneNeedsCharging', '1 needs charging')
              : tr('batteries.needCharging', '{count} need charging', { count: needing })}
        </span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
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
  const color = BATTERY_COLORS[batteryTone(level)];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: compact ? '6px 4px' : '9px 4px',
      borderTop: first ? 'none' : '1px solid rgba(255,255,255,0.05)',
    }}>
      <BatteryGlyph level={level} color={color} />
      <span style={{
        fontSize: 13, flex: 1, minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {friendlyName(state)}
      </span>
      <span style={{
        fontSize: 13, fontWeight: 600, color,
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
  // 17 wide at x=3 ends at 20, leaving the same 1.5 gap to the outline's
  // inner edge (21.5) that the fill has on the left and top/bottom — any
  // less and a 100% battery reads as not-quite-full down the column.
  const inner = Math.max(0, Math.min(1, level / 100)) * 17;
  return (
    <svg width="26" height="14" viewBox="0 0 26 14" fill="none" aria-hidden="true"
      style={{ flexShrink: 0 }}>
      <rect x="0.75" y="0.75" width="21.5" height="12.5" rx="3"
        stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" />
      <path d="M24 5v4" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5"
        strokeLinecap="round" />
      {inner > 0 && (
        <rect x="3" y="3" width={inner} height="8" rx="1.5" fill={color} />
      )}
    </svg>
  );
}

// ── Cameras ─────────────────────────────────────────────────────────────────

export function CameraView({ states, config, preview }: ViewProps) {
  const cams = states.filter((s) => entityDomain(s.entity_id) === 'camera');
  if (cams.length === 0) return <EmptyState message="No camera entities selected." />;
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
      padding: 12, height: '100%',
      display: 'grid', gap: 8,
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
    return <TileFallback>Camera offline</TileFallback>;
  }
  if (error && !objectUrl) {
    return <TileFallback>
      {tokenMissing ? 'No access token — check camera entity' : 'Camera unavailable'}
    </TileFallback>;
  }
  if (!objectUrl) {
    return <TileFallback>Loading…</TileFallback>;
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
  return (
    <div style={{
      position: 'absolute', inset: 0, padding: 12,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'rgba(255,255,255,0.4)', fontSize: 11, textAlign: 'center',
    }}>{children}</div>
  );
}

function TileShell({ state, children }: { state: HAStateObject; children: React.ReactNode }) {
  return (
    <div style={{
      position: 'relative', borderRadius: 10, overflow: 'hidden',
      background: 'linear-gradient(135deg, #1f2937, #0f172a)',
      border: '1px solid rgba(255,255,255,0.08)',
      minHeight: 100, aspectRatio: '16/9',
    }}>
      {children}
      {state.state === 'recording' && (
        <span style={{
          position: 'absolute', top: 8, right: 8, width: 8, height: 8,
          background: '#ef4444', borderRadius: 99, boxShadow: '0 0 8px #ef4444',
        }} />
      )}
      <span style={{
        position: 'absolute', bottom: 8, left: 8,
        fontSize: 11, fontWeight: 500, color: '#fff',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        padding: '3px 8px', borderRadius: 6,
      }}>{friendlyName(state)}</span>
    </div>
  );
}

// ── Empty state shared ──────────────────────────────────────────────────────

export function EmptyState({ message }: { message: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', padding: 24, color: 'rgba(255,255,255,0.45)',
      fontSize: 13, textAlign: 'center', lineHeight: 1.5,
    }}>
      {message}
    </div>
  );
}
