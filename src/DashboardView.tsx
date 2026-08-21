// Dashboard view: the whole house on one screen. Rooms become sections of
// horizontal tiles, the top strip answers "what time is it, how warm is
// it, who is home, are the doors locked", and an optional at-a-glance
// column on the left carries weather, people, house power, and scenes.
// The pure decisions (grouping, stats, tones, state lines, summaries) live
// in dashboard.ts; this file only draws them.

import React from 'react';
import type { HAStateObject, CardCommand } from './types';
import { entityDomain } from './types';
import { EmptyState, type ViewProps } from './views';
import { Chip } from './cards';
import {
  groupByArea, sectionStats, partitionHero, lockSummary, peopleSummary,
  houseClimate, tileTone, tileStateLine, dailyForecast,
  initials, formatDegrees, type DashboardSection, type TileTone,
} from './dashboard';
import {
  friendlyName, formatValue, formatHistoryRange, formatMeasurement, weatherLabel, formatClock,
} from './utils';
import { Icon, iconFor, type IconName } from './icons';
import { lookAccent, type ResolvedLook } from './rules';
import { safeEntityPicture, pictureBackground } from './artwork';
import { sparkPaths, isHistoryEligible, type HistorySeries } from './history';
import { powerAverage } from './power';
import {
  useEntityPress, usePendingSteps, useReleaseCommit, fractionFromX, exceedsSlop, HOLD_TO_RUN_MS,
} from './controls';
import { entityInteraction, NO_INTERACTION } from './interaction';
import { brightnessPct, brightnessFromFraction } from './light';
import { setpointModel, tempStep, tempBounds, stepValue, formatTemp, setTemperaturePayload } from './climate';
import { hostTimezone } from './settings';
import { fetchForecast, FORECAST_POLL_MS } from './api';
import { tr } from './i18n';
import { useScale } from './scale';
import { useTheme, withAlpha, type Theme } from './theme';

// ── View ────────────────────────────────────────────────────────────────────

export function DashboardView(props: ViewProps) {
  const { states, config, areas } = props;
  const u = useScale();
  const t = useTheme();
  const cols = Math.max(1, Math.min(4, config.columns ?? 2));

  const hero = config.heroColumn ? partitionHero(states) : null;
  const roomStates = hero ? hero.rest : states;
  const sections = groupByArea(roomStates, areas, config.area);
  const areaName = config.area && areas
    ? areas.find((a) => a.area_id === config.area)?.name ?? null
    : null;

  const heroHasPanels = hero != null
    && (hero.weather != null || hero.people.length > 0 || hero.power != null || hero.scenes.length > 0);

  if (states.length === 0) {
    return <EmptyState message={tr('empty.pickEntities', 'No entities selected yet. Pick some in the module config.')} />;
  }

  return (
    <div style={{
      height: '100%', overflowY: 'auto', boxSizing: 'border-box',
      padding: `${u(12)}px ${u(14)}px ${u(16)}px`,
      display: 'flex', flexDirection: 'column', gap: u(14),
      color: t.fg(0.85),
    }}>
      <TopStrip states={states} title={areaName ?? tr('dashboard.home', 'Home')} haUrl={config.haUrl}
        // The column already shows the weather and the people; repeating
        // them as chips would say the same thing twice on one screen.
        hideClimate={hero?.weather != null} hidePeople={(hero?.people.length ?? 0) > 0} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: u(18), alignItems: 'flex-start' }}>
        {hero && heroHasPanels && (
          <div style={{
            // A fixed-width column on a wide screen; on a narrow module it
            // wraps above the rooms instead of squeezing them to a sliver.
            flex: `1 1 ${u(300)}px`, maxWidth: '100%', minWidth: 0,
            display: 'flex', flexDirection: 'column', gap: u(12),
          }}>
            {hero.weather && <WeatherPanel state={hero.weather} haUrl={config.haUrl} preview={props.preview} />}
            {hero.people.length > 0 && <PeoplePanel people={hero.people} haUrl={config.haUrl} />}
            {hero.power && <PowerPanel state={hero.power} series={props.history?.[hero.power.entity_id]} />}
            {hero.scenes.length > 0 && <SceneRow scenes={hero.scenes} onCommand={props.onCommand} lookFor={props.lookFor} />}
          </div>
        )}
        <div style={{
          flex: `999 1 ${u(320)}px`, minWidth: 0,
          // Never reserve columns no section will fill: one room on a
          // two-column board should take the whole width, not half of it.
          display: 'grid', gridTemplateColumns: `repeat(${Math.min(cols, Math.max(1, sections.length))}, minmax(0, 1fr))`,
          gap: `${u(18)}px ${u(20)}px`, alignContent: 'start',
        }}>
          {sections.map((section) => (
            <Section key={section.title ?? '__other'} section={section} {...props} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Top strip ───────────────────────────────────────────────────────────────

/** The clock that re-renders on the minute. Armed to the next minute
 *  boundary rather than every 60 s from mount, so the minute flips when the
 *  real one does. */
function useMinuteClock(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    let id = 0;
    const arm = () => {
      const ms = 60_000 - (Date.now() % 60_000);
      id = window.setTimeout(() => { setNow(Date.now()); arm(); }, ms);
    };
    arm();
    return () => clearTimeout(id);
  }, []);
  return now;
}

function TopStrip({ states, title, haUrl, hideClimate, hidePeople }: {
  states: HAStateObject[]; title: string; haUrl: string; hideClimate: boolean; hidePeople: boolean;
}) {
  const u = useScale();
  const t = useTheme();
  const now = useMinuteClock();
  const climate = houseClimate(states);
  const people = peopleSummary(states);
  const locks = lockSummary(states);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      flexWrap: 'wrap', gap: `${u(8)}px ${u(14)}px`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: u(10), flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontSize: u(22), fontWeight: 600, letterSpacing: '-0.02em', color: t.fg() }}>{title}</span>
        <span style={{ fontSize: u(12), color: t.fg(0.45), fontVariantNumeric: 'tabular-nums' }}>
          {formatClock(now, hostTimezone(), { shape: 'date' })} · {formatClock(now, hostTimezone())}
        </span>
      </div>
      <div style={{ display: 'flex', gap: u(6), flexWrap: 'wrap' }}>
        {!hideClimate && climate.temperature && (
          <Chip><Icon name="thermometer" size={u(13)} style={{ color: t.accent.red.base }} />{climate.temperature}</Chip>
        )}
        {!hideClimate && climate.humidity && (
          <Chip><Icon name="droplet" size={u(13)} style={{ color: t.accent.blue.base }} />{climate.humidity}</Chip>
        )}
        {!hidePeople && people.people.length > 0 && (
          <Chip>
            <span style={{ display: 'flex' }}>
              {people.home.slice(0, 4).map((p, i) => (
                <Avatar key={p.entity_id} state={p} size={u(18)} haUrl={haUrl} ring={t.shade(0.6)}
                  style={{ marginLeft: i === 0 ? 0 : -u(5) }} />
              ))}
            </span>
            {tr('dashboard.nHome', '{count} home', { count: people.home.length })}
          </Chip>
        )}
        {locks.kind === 'allLocked' && (
          <Chip color={t.accent.green.loud} dot={t.ok}>
            {tr('dashboard.allLocked', 'All doors locked')}
          </Chip>
        )}
        {locks.kind === 'unlocked' && (
          <Chip color={t.accent.red.loud} dot={t.danger}>
            {locks.names.length === 1
              ? tr('dashboard.unlocked', '{name} unlocked', { name: locks.names[0] })
              : tr('dashboard.manyUnlocked', '{count} doors unlocked', { count: locks.names.length })}
          </Chip>
        )}
      </div>
    </div>
  );
}

/** A person's face, or their initials when Home Assistant has no picture. */
function Avatar({ state, size, haUrl, ring, dim, style }: {
  state: HAStateObject; size: number; haUrl: string; ring?: string; dim?: boolean;
  style?: React.CSSProperties;
}) {
  const t = useTheme();
  const picture = safeEntityPicture(state.attributes.entity_picture, haUrl);
  return (
    <span style={{
      width: size, height: size, borderRadius: 99, flexShrink: 0, boxSizing: 'border-box',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.4, fontWeight: 600, color: t.fg(0.8),
      background: picture ? undefined : `linear-gradient(135deg, ${withAlpha(t.accent.amber.base, 0.5)}, ${withAlpha(t.accent.red.base, 0.5)})`,
      ...(picture ? pictureBackground(picture, { position: 'center 30%' }) : {}),
      border: ring ? `2px solid ${ring}` : undefined,
      opacity: dim ? 0.55 : 1,
      filter: dim ? 'grayscale(0.7)' : undefined,
      ...style,
    }}>{!picture && initials(friendlyName(state))}</span>
  );
}

// ── Sections ────────────────────────────────────────────────────────────────

function Section({ section, ...props }: ViewProps & { section: DashboardSection }) {
  const u = useScale();
  const t = useTheme();
  const stats = sectionStats(section.entities);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: u(8), minWidth: 0 }}>
      {section.title != null && (
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          gap: u(8), padding: `0 ${u(2)}px`,
        }}>
          <span style={{
            fontSize: u(15), fontWeight: 600, letterSpacing: '-0.01em', color: t.fg(),
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{section.title}</span>
          <span style={{
            display: 'flex', gap: u(9), fontSize: u(11), color: t.fg(0.75),
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0,
          }}>
            {stats.temperature && <span>{formatDegrees(Number(stats.temperature.state), stats.temperature)}°</span>}
            {stats.humidity && <span>{Math.round(Number(stats.humidity.state))}%</span>}
            {stats.presence && <span style={{ color: t.accent.green.base }}>{tr('dashboard.presence', 'Motion')}</span>}
          </span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: u(8), alignContent: 'start' }}>
        {section.entities.map((s) => <Tile key={s.entity_id} state={s} {...props} />)}
      </div>
    </div>
  );
}

// ── Tiles ───────────────────────────────────────────────────────────────────

function Tile({ state, config, onCommand, onOpenDetail, history, lookFor }: ViewProps & { state: HAStateObject }) {
  const look = lookFor?.(state);
  const series = history?.[state.entity_id];
  if (entityDomain(state.entity_id) === 'climate' && state.state !== 'unavailable') {
    return <ClimateTile state={state} look={look} onCommand={onCommand} onOpenDetail={onOpenDetail} />;
  }
  if (series && isHistoryEligible(state)) {
    return <HeroTile state={state} series={series} look={look} />;
  }
  return (
    <EntityTile state={state} look={look} onCommand={onCommand} onOpenDetail={onOpenDetail}
      controls={onCommand != null} haUrl={config.haUrl} />
  );
}

/** The tile's surface, from the same palette the cards use, so a light
 *  that is on looks the same here as on the card grid. */
function toneSurface(t: Theme, tone: TileTone, look?: ResolvedLook) {
  return look?.tone ? t.ruleTone[look.tone] : t.cardTone[tone];
}

function TileShell({ state, tone, look, wide, stacked, onClick, pressProps, children, after, shellRef }: {
  state: HAStateObject; tone: TileTone; look?: ResolvedLook; wide?: boolean;
  /** Icon and text on the first row, `after` on its own row below (the
   *  climate stepper). Otherwise everything sits on one row. */
  stacked?: boolean;
  onClick?: () => void; pressProps?: React.DOMAttributes<HTMLDivElement>;
  children: React.ReactNode; after?: React.ReactNode;
  shellRef?: React.Ref<HTMLDivElement>;
}) {
  const u = useScale();
  const t = useTheme();
  const surface = toneSurface(t, tone, look);
  const accent = lookAccent(look, t);
  const iconColor = accent ?? (
    tone === 'on' ? t.accent.amber.base
      : tone === 'active' ? t.accent.blue.base
        : tone === 'alert' ? t.accent.red.base
          : t.fg(0.75));
  const icon = (
    <span style={{
      width: u(30), height: u(30), borderRadius: 99, flexShrink: 0,
      background: accent ? withAlpha(accent, 0.2)
        : tone === 'on' ? withAlpha(t.accent.amber.base, 0.22) : t.fg(0.07),
      display: 'flex', alignItems: 'center', justifyContent: 'center', color: iconColor,
    }}>
      <Icon name={look?.icon ?? iconFor(state)} size={u(16)} />
    </span>
  );
  return (
    <div
      ref={shellRef}
      onClick={onClick}
      {...pressProps}
      style={{
        ...surface,
        border: `1px solid ${surface.borderColor}`,
        borderRadius: u(12), padding: `${u(9)}px ${u(10)}px`,
        minHeight: u(52), boxSizing: 'border-box',
        position: 'relative', overflow: 'hidden', isolation: 'isolate',
        display: 'flex', gap: u(9),
        flexDirection: stacked ? 'column' : 'row',
        alignItems: stacked ? 'stretch' : 'center',
        gridColumn: wide ? '1 / -1' : undefined,
        cursor: onClick || pressProps ? 'pointer' : 'default',
        // Vertical pans stay with the page so a finger can still scroll a
        // long board; a still finger holds, a sideways one drags.
        touchAction: pressProps ? 'pan-y' : undefined,
      }}
    >
      {stacked ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: u(9) }}>{icon}{children}</div>
      ) : (<>{icon}{children}</>)}
      {after}
    </div>
  );
}

function TileText({ name, line, color }: { name: string; line: string; color?: string }) {
  const u = useScale();
  const t = useTheme();
  return (
    <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: u(2) }}>
      <span style={{
        fontSize: u(12), fontWeight: 500, color: t.fg(),
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{name}</span>
      <span style={{
        fontSize: u(10.5), color: color ?? t.fg(0.55),
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{line}</span>
    </span>
  );
}

/** Sideways drag across a lit light sets its brightness. Runs beside the
 *  tap/hold handlers: the hold cancels itself once the finger travels past
 *  the slop, so the two never fire for the same gesture. Only a mostly
 *  horizontal move becomes a drag; a vertical one is the page scrolling.
 *  The drag itself rides useReleaseCommit, so a release the tile never sees
 *  still lands through the window fallback, and the bar holds the committed
 *  value until live state catches up instead of snapping back. */
function useBrightnessDrag(enabled: boolean, live: number, onCommit: (fraction: number) => void) {
  const ref = React.useRef<HTMLDivElement>(null);
  // The finger being watched for the slop gate; cleared on every release
  // path, including ones that never reach the element.
  const origin = React.useRef<{ x: number; y: number; id: number } | null>(null);
  const windowEnd = React.useRef<(() => void) | null>(null);
  const drag = useReleaseCommit({ live, onCommit });
  const dragRef = React.useRef(drag);
  dragRef.current = drag;

  const detach = React.useCallback(() => {
    if (!windowEnd.current) return;
    window.removeEventListener('pointerup', windowEnd.current);
    window.removeEventListener('pointercancel', windowEnd.current);
    windowEnd.current = null;
  }, []);
  const reset = React.useCallback(() => {
    detach();
    origin.current = null;
  }, [detach]);
  React.useEffect(() => reset, [reset]);
  // A poll can turn the light off mid-gesture: the handlers go away with
  // `enabled`, so the refs must not keep waiting for a release.
  React.useEffect(() => {
    if (enabled) return;
    reset();
    dragRef.current.cancel();
  }, [enabled, reset]);

  // The tile's box, read once when the finger lands: measuring on every
  // move forces a synchronous layout, and the tile does not move mid-drag.
  const rect = React.useRef<DOMRect | null>(null);
  const fractionAt = (clientX: number) => {
    const r = rect.current;
    return r ? fractionFromX(clientX, r.left, r.width, live) : live;
  };

  if (!enabled) return { ref, fraction: live, handlers: {} as React.DOMAttributes<HTMLDivElement> };
  return {
    ref,
    fraction: drag.shown,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        if (origin.current) return;
        origin.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        rect.current = ref.current?.getBoundingClientRect() ?? null;
        detach();
        // The element's own handlers run first; this only fires for a
        // release that never reached the tile (mouse let go outside it).
        windowEnd.current = reset;
        window.addEventListener('pointerup', windowEnd.current);
        window.addEventListener('pointercancel', windowEnd.current);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (!origin.current || e.pointerId !== origin.current.id) return;
        if (drag.isDragging()) { drag.move(fractionAt(e.clientX)); return; }
        const dx = e.clientX - origin.current.x;
        const dy = e.clientY - origin.current.y;
        if (!exceedsSlop(dx, dy) || Math.abs(dx) < Math.abs(dy)) return;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
        drag.begin(fractionAt(e.clientX));
      },
      onPointerUp: (e: React.PointerEvent) => {
        if (!origin.current || e.pointerId !== origin.current.id) return;
        reset();
        drag.end();
      },
      onPointerCancel: (e: React.PointerEvent) => {
        if (!origin.current || e.pointerId !== origin.current.id) return;
        reset();
        drag.cancel();
      },
    } as React.DOMAttributes<HTMLDivElement>,
  };
}

/** Merge two sets of pointer handlers so both see every event. */
function chain(
  a: React.DOMAttributes<HTMLDivElement> | undefined, b: React.DOMAttributes<HTMLDivElement>,
): React.DOMAttributes<HTMLDivElement> {
  const out: Record<string, unknown> = { ...(a ?? {}) };
  for (const [key, fn] of Object.entries(b)) {
    const prev = out[key] as ((e: unknown) => void) | undefined;
    out[key] = prev ? (e: unknown) => { prev(e); (fn as (e: unknown) => void)(e); } : fn;
  }
  return out as React.DOMAttributes<HTMLDivElement>;
}

function EntityTile({ state, look, onCommand, onOpenDetail, controls, haUrl }: {
  state: HAStateObject; look?: ResolvedLook; onCommand?: CardCommand;
  onOpenDetail?: (s: HAStateObject) => void; controls: boolean; haUrl: string;
}) {
  const u = useScale();
  const t = useTheme();
  const gestures = onCommand ? entityInteraction(state) : NO_INTERACTION;
  const press = useEntityPress({
    tap: onCommand && gestures.tapService ? () => onCommand(state, gestures.tapService!) : undefined,
    hold: onCommand && onOpenDetail && gestures.opensSheet ? () => onOpenDetail(state) : undefined,
    guarded: onCommand && gestures.guardedService ? () => onCommand(state, gestures.guardedService!) : undefined,
  });
  const isLight = entityDomain(state.entity_id) === 'light';
  const pct = isLight ? brightnessPct(state) : null;
  const dragEnabled = isLight && pct != null && onCommand != null;
  const drag = useBrightnessDrag(
    dragEnabled, (pct ?? 0) / 100,
    (f) => onCommand!(state, 'turn_on', { brightness_pct: brightnessFromFraction(f) }),
  );
  const tone = tileTone(state);
  const surface = toneSurface(t, tone, look);
  const accent = lookAccent(look, t);
  const lineColor = accent ?? (tone === 'default' ? undefined : surface.color);
  // While a drag is in flight or settling, the bar and the line follow the
  // finger rather than the last poll.
  const shownPct = dragEnabled ? Math.round(drag.fraction * 100) : pct;
  const line = look?.label
    ?? (dragEnabled && shownPct !== pct ? `${tr('common.on', 'On')} · ${shownPct}%` : tileStateLine(state, controls));
  const isPerson = entityDomain(state.entity_id) === 'person';
  const pressProps = press.pressProps || dragEnabled
    ? chain(press.pressProps, dragEnabled ? drag.handlers : {}) : undefined;
  return (
    <TileShell state={state} tone={tone} look={look} shellRef={drag.ref}
        onClick={press.onClick} pressProps={pressProps}
        wide={entityDomain(state.entity_id) === 'media_player'}
        after={<>
          {isPerson && (
            <Avatar state={state} size={u(26)} haUrl={haUrl} dim={state.state !== 'home'} />
          )}
          {gestures.guardedService && (
            <span style={{
              position: 'absolute', top: 0, bottom: 0, left: 0, zIndex: -1,
              width: press.holding ? '100%' : '0%',
              transition: press.holding ? `width ${HOLD_TO_RUN_MS}ms linear` : 'none',
              background: `linear-gradient(90deg, ${withAlpha(t.accent.amber.base, 0.12)}, ${withAlpha(t.accent.amber.base, 0.32)})`,
              pointerEvents: 'none',
            }} />
          )}
          {shownPct != null && state.state === 'on' && (
            <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: u(4), background: t.fg(0.06) }}>
              <span style={{
                display: 'block', height: '100%', width: `${shownPct}%`,
                background: accent ?? t.accent.amber.base, borderRadius: `0 ${u(2)}px ${u(2)}px 0`,
              }} />
            </span>
          )}
        </>}>
        <TileText name={friendlyName(state)} color={lineColor}
          line={press.holding ? tr('buttons.keepHolding', 'Keep holding…') : line} />
    </TileShell>
  );
}

/** Thermostat: name and what it is doing, with a −/+ stepper for the
 *  setpoint. Taps accumulate and land as one service call, the way the
 *  climate sheet does it. The body opens the sheet. */
function ClimateTile({ state, look, onCommand, onOpenDetail }: {
  state: HAStateObject; look?: ResolvedLook; onCommand?: CardCommand;
  onOpenDetail?: (s: HAStateObject) => void;
}) {
  const u = useScale();
  const t = useTheme();
  const model = setpointModel(state);
  const step = tempStep(state);
  const bounds = tempBounds(state);
  const live = model?.kind === 'single' ? model.target : 0;
  const commit = React.useCallback((v: number) => {
    onCommand?.(state, 'set_temperature', setTemperaturePayload({ kind: 'single', target: v }));
  }, [onCommand, state]);
  const pending = usePendingSteps(live, commit);
  const tone = tileTone(state);
  const canStep = onCommand != null && model?.kind === 'single';
  const open = onOpenDetail ? () => onOpenDetail(state) : undefined;

  const button = (dir: 1 | -1) => (
    <button
      aria-label={dir > 0 ? tr('dashboard.raise', 'Raise') : tr('dashboard.lower', 'Lower')}
      onClick={(e) => { e.stopPropagation(); pending.bump(stepValue(pending.shown, dir, step, bounds)); }}
      style={{
        width: u.touch(44), height: u.touch(34), border: 0, borderRadius: u(8),
        background: t.fg(0.07), color: t.fg(), fontSize: u(18), lineHeight: 1,
        cursor: 'pointer', padding: 0, flexShrink: 0,
      }}
    >{dir > 0 ? '+' : '−'}</button>
  );

  return (
    <TileShell state={state} tone={tone} look={look} wide stacked onClick={open} after={<>
      {model?.kind === 'single' && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: t.fg(0.05), borderRadius: u(10), padding: u(3),
        }}>
          {canStep ? button(-1) : <span />}
          <span style={{ fontSize: u(16), fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: t.fg() }}>
            {formatTemp(pending.shown)}
            <span style={{ fontSize: u(10.5), fontWeight: 400, color: t.fg(0.5), marginLeft: u(2) }}>°</span>
          </span>
          {canStep ? button(1) : <span />}
        </div>
      )}
      {model?.kind === 'range' && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: t.fg(0.05), borderRadius: u(10), padding: `${u(6)}px`,
          fontSize: u(14), fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: t.fg(),
        }}>
          {formatTemp(model.low)}° – {formatTemp(model.high)}°
        </div>
      )}
    </>}>
      <TileText name={friendlyName(state)} line={look?.label ?? tileStateLine(state, onCommand != null)}
        color={lookAccent(look, t) ?? (tone === 'active' ? t.accent.blue.text : undefined)} />
    </TileShell>
  );
}

/** The 24h curve along the bottom of a panel, under its text: a soft fill
 *  and a line in the panel's accent. The parent provides the positioned,
 *  isolated box. */
function SparkBackdrop({ series, color }: { series: HistorySeries; color: string }) {
  const gradientId = React.useId();
  const { line, area } = sparkPaths(series, 100, 30, 2);
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" style={{
      position: 'absolute', left: 0, right: 0, bottom: 0, width: '100%', height: '55%', zIndex: -1,
    }}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.25" />
          <stop offset="1" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeOpacity={0.8} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A measurement with its day behind it: label, big number, the 24h curve
 *  along the bottom, and the day's range. */
function HeroTile({ state, series, look }: { state: HAStateObject; series: HistorySeries; look?: ResolvedLook }) {
  const u = useScale();
  const t = useTheme();
  const color = lookAccent(look, t) ?? t.accent.orange.base;
  return (
    <div style={{
      ...t.cardTone.default, border: `1px solid ${t.cardTone.default.borderColor}`,
      borderRadius: u(12), padding: `${u(10)}px ${u(11)}px ${u(8)}px`,
      gridColumn: '1 / -1', minHeight: u(96), boxSizing: 'border-box',
      position: 'relative', overflow: 'hidden', isolation: 'isolate',
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: u(4),
    }}>
      <SparkBackdrop series={series} color={color} />
      <span style={{ display: 'flex', alignItems: 'center', gap: u(6), fontSize: u(11), color: t.fg(0.6), minWidth: 0 }}>
        <Icon name={look?.icon ?? iconFor(state)} size={u(14)} style={{ color, flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{friendlyName(state)}</span>
      </span>
      <span style={{
        fontSize: u(30), fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1.05,
        color: t.fg(), fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{look?.label ?? formatValue(state)}</span>
      <span style={{ fontSize: u(10), color: t.fg(0.55), fontVariantNumeric: 'tabular-nums' }}>
        {tr('dashboard.todayRange', 'Today {range}', { range: formatHistoryRange(state, series.min, series.max) })}
      </span>
    </div>
  );
}

// ── At-a-glance column ──────────────────────────────────────────────────────

function Panel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  const u = useScale();
  const t = useTheme();
  return (
    <div style={{
      ...t.cardTone.default, border: `1px solid ${t.cardTone.default.borderColor}`,
      borderRadius: u(16), padding: `${u(14)}px ${u(16)}px`,
      position: 'relative', overflow: 'hidden', isolation: 'isolate', boxSizing: 'border-box',
      ...style,
    }}>{children}</div>
  );
}

const WEATHER_ICON: Record<string, IconName> = {
  'sunny': 'sun', 'clear-night': 'moon', 'windy': 'wind', 'windy-variant': 'wind',
};

/** The daily forecast for a weather entity, asked of the
 *  weather.get_forecasts service on mount and every FORECAST_POLL_MS.
 *  Older Home Assistant still sets a `forecast` attribute; that is the
 *  starting value and the fallback when the service has nothing to say. */
function useForecast(state: HAStateObject, haUrl: string, preview?: boolean): unknown[] | null {
  const attribute = Array.isArray(state.attributes.forecast) ? state.attributes.forecast : null;
  const [fetched, setFetched] = React.useState<unknown[] | null>(null);
  const entityId = state.entity_id;
  React.useEffect(() => {
    // The preview pane already shows whatever the attribute holds; one
    // more service call per keystroke in the editor buys nothing.
    if (!haUrl || (preview && attribute)) return;
    let cancelled = false;
    const load = async () => {
      try {
        const list = await fetchForecast(haUrl, entityId);
        if (!cancelled && list) setFetched(list);
      } catch (e) {
        window.__HS_SDK__?.emit({
          type: 'log', level: 'warn',
          message: `HA forecast fetch failed: ${e instanceof Error ? e.message : 'unknown'}`,
        });
      }
    };
    void load();
    const id = window.setInterval(load, FORECAST_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [haUrl, entityId, preview, attribute != null]);
  return fetched ?? attribute;
}

function WeatherPanel({ state, haUrl, preview }: { state: HAStateObject; haUrl: string; preview?: boolean }) {
  const u = useScale();
  const t = useTheme();
  const temp = state.attributes.temperature;
  const humidity = state.attributes.humidity;
  const forecast = useForecast(state, haUrl, preview);
  const days = React.useMemo(() => dailyForecast(forecast, hostTimezone()), [forecast]);
  const sunny = state.state === 'sunny' || state.state === 'clear-night';
  const line = [weatherLabel(state.state), typeof humidity === 'number' ? `${Math.round(humidity)}%` : null]
    .filter(Boolean).join(' · ');
  return (
    <Panel>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: u(12) }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: u(42), fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1, color: t.fg(), fontVariantNumeric: 'tabular-nums' }}>
            {typeof temp === 'number' ? formatDegrees(temp) : formatValue(state)}
            {typeof temp === 'number' && <span style={{ fontSize: u(16), fontWeight: 400, color: t.fg(0.5) }}>°</span>}
          </div>
          <div style={{ fontSize: u(12), color: t.fg(0.6), marginTop: u(5), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line}</div>
        </div>
        <span style={{
          width: u(56), height: u(56), borderRadius: 99, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: sunny ? t.accent.amber.base : t.fg(0.6),
          background: sunny
            ? `radial-gradient(circle at 40% 40%, ${withAlpha(t.accent.amber.base, 0.35)}, ${withAlpha(t.accent.amber.base, 0.08)} 70%)`
            : t.fg(0.06),
          boxShadow: sunny ? `0 0 ${u(24)}px ${withAlpha(t.accent.amber.base, 0.3)}` : undefined,
        }}>
          <Icon name={WEATHER_ICON[state.state] ?? 'cloud'} size={u(28)} />
        </span>
      </div>
      {days.length > 0 && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', marginTop: u(12), paddingTop: u(10),
          borderTop: `1px solid ${t.fg(0.08)}`,
        }}>
          {days.map((d) => (
            <div key={d.label} style={{ textAlign: 'center', fontSize: u(10.5), color: t.fg(0.5) }}>
              {d.label}
              <div style={{ color: t.fg(), fontSize: u(13), fontWeight: 500, marginTop: u(2), fontVariantNumeric: 'tabular-nums' }}>{d.high}</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function PeoplePanel({ people, haUrl }: { people: HAStateObject[]; haUrl: string }) {
  const u = useScale();
  const t = useTheme();
  return (
    <Panel>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${u(56)}px, 1fr))`, gap: u(6) }}>
        {people.map((p) => {
          const home = p.state === 'home';
          return (
            <div key={p.entity_id} style={{ textAlign: 'center', fontSize: u(10.5), color: t.fg(0.55), minWidth: 0 }}>
              <Avatar state={p} size={u(40)} haUrl={haUrl} dim={!home}
                ring={home ? t.ok : t.fg(0.15)} style={{ margin: `0 auto ${u(5)}px` }} />
              <div style={{ color: t.fg(), fontWeight: 500, fontSize: u(12), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {friendlyName(p)}
              </div>
              <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{formatValue(p)}</div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function PowerPanel({ state, series }: { state: HAStateObject; series?: HistorySeries }) {
  const u = useScale();
  const t = useTheme();
  const color = t.accent.green.base;
  return (
    <Panel style={{ minHeight: u(96), display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: u(10) }}>
      {series && <SparkBackdrop series={series} color={color} />}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: u(11), color: t.fg(0.55), marginBottom: u(5), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {friendlyName(state)}
        </div>
        <div style={{ fontSize: u(32), fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1, color: t.fg(), fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {formatValue(state)}
        </div>
      </div>
      {series && (
        <div style={{ fontSize: u(10.5), color: t.fg(0.5), textAlign: 'right', lineHeight: 1.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          <div>{tr('power.low', 'Low')} {formatMeasurement(state, series.min, series.max)}</div>
          <div>{tr('power.average', 'Average')} {formatMeasurement(state, powerAverage(series), series.max)}</div>
          <div>{tr('power.high', 'High')} {formatMeasurement(state, series.max, series.max)}</div>
        </div>
      )}
    </Panel>
  );
}

function SceneRow({ scenes, onCommand, lookFor }: {
  scenes: HAStateObject[]; onCommand?: CardCommand; lookFor?: ViewProps['lookFor'];
}) {
  const u = useScale();
  const t = useTheme();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${u(68)}px, 1fr))`, gap: u(8) }}>
      {scenes.map((s) => {
        const look = lookFor?.(s);
        const accent = lookAccent(look, t) ?? t.accent.purple.base;
        return (
          <button key={s.entity_id}
            onClick={onCommand ? () => onCommand(s, 'turn_on') : undefined}
            disabled={!onCommand}
            style={{
              height: u.touch(56), borderRadius: u(12), padding: `0 ${u(6)}px`,
              background: t.fg(0.05), border: `1px solid ${t.fg(0.08)}`,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: u(3), fontSize: u(10.5), color: t.fg(0.75), cursor: onCommand ? 'pointer' : 'default',
              minWidth: 0,
            }}>
            <Icon name={look?.icon ?? iconFor(s)} size={u(18)} style={{ color: accent }} />
            <span style={{ maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {look?.label ?? friendlyName(s)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
