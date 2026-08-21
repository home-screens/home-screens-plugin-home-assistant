// Energy Flow view: where the power is going right now, as a live diagram.
// Solar, grid, battery, and the house are nodes; the wires between them
// carry moving particles whose speed follows the watts and whose direction
// flips when the house exports or the battery discharges. The roles come
// from the sensors' names (energy.ts), so there is nothing to set up beyond
// picking the power sensors.
//
// Two layers. The nodes, glows, and wires are one static SVG with a viewBox
// so they scale with the module and the wires never drift off the circles
// they connect. The particles are HTML dots on top, moved by a CSS
// transform keyframe: Chromium composites those off the main thread, where
// an SVG animation would repaint the whole diagram (glows, text, and all)
// sixty times a second for as long as the view is on screen, which a
// Raspberry Pi feels. The "Right now" list beside it is ordinary HTML sized
// with u().

import React from 'react';
import { EmptyState, type ViewProps } from './views';
import { Chip } from './cards';
import { useElementSize } from './hooks';
import {
  classifyEnergy, findBatteryLevel, flows, energyStatus, selfPowered, formatWatts,
  wattsLabel, particleDuration, hasAnyNode, homeOnly, roleDetail, rightNowRows,
  IDLE_WATTS, PARTICLES_PER_WIRE,
  type EnergyModel, type EnergyRole, type EnergyStatus, type Flow, type RoleDetail,
} from './energy';
import type { HAStateObject } from './types';
import { Icon, type IconName } from './icons';
import { tr } from './i18n';
import { useScale } from './scale';
import { useTheme, withAlpha, type Theme } from './theme';

// ── Geometry (viewBox units) ────────────────────────────────────────────────

const HUB = { x: 500, y: 500 };
const NODE_R = 140;
const HOME_R = 170;
const GLOW_PAD = 60;
const WIRE_W = 6;
const PARTICLE_R = 9;

const NODE_POS: Record<EnergyRole, { x: number; y: number; r: number }> = {
  solar: { x: 500, y: 170, r: NODE_R },
  grid: { x: 170, y: 500, r: NODE_R },
  home: { x: 840, y: 500, r: HOME_R },
  battery: { x: 500, y: 830, r: NODE_R },
};

const NODE_ICON: Record<EnergyRole, IconName> = {
  solar: 'sun', grid: 'bolt', home: 'house', battery: 'battery',
};

function nodeColor(role: EnergyRole, t: Theme): string {
  switch (role) {
    case 'solar': return t.accent.amber.base;
    case 'grid': return t.accent.blue.base;
    case 'battery': return t.accent.green.base;
    default: return t.fg();
  }
}

function wireRole(flow: Flow): EnergyRole {
  return (flow.from === 'hub' ? flow.to : flow.from) as EnergyRole;
}

interface Point { x: number; y: number }

/** The wire's two ends: on the node's rim (so particles are never hidden
 *  under the circle) and at the hub. `a` to `b` follows the flow. */
function wireEnds(flow: Flow): { a: Point; b: Point } {
  const n = NODE_POS[wireRole(flow)];
  const dx = HUB.x - n.x;
  const dy = HUB.y - n.y;
  const len = Math.hypot(dx, dy);
  const rim = { x: n.x + (dx / len) * n.r, y: n.y + (dy / len) * n.r };
  return flow.from === 'hub' ? { a: HUB, b: rim } : { a: rim, b: HUB };
}

interface ViewBox { x: number; y: number; w: number; h: number }

/** The viewBox that fits the nodes actually drawn, with room for their
 *  glow, so a solar-and-home pair fills the module instead of sitting in
 *  the top right corner of an empty square. */
function viewBoxFor(roles: EnergyRole[]): ViewBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (x: number, y: number, r: number) => {
    minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
    minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
  };
  for (const role of roles) {
    const n = NODE_POS[role];
    include(n.x, n.y, n.r + GLOW_PAD);
  }
  if (roles.length > 1) include(HUB.x, HUB.y, 20);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ── Hooks ───────────────────────────────────────────────────────────────────

function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(() => (
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  ));
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Which battery level sensor goes with the selected battery, resolved
 *  only when the entity lists change. findBatteryLevel is a name match
 *  over the whole poll, so running it on every tick would regex-split
 *  every entity's name every few seconds for an answer that cannot have
 *  changed. */
function useBatteryLevelSensor(
  states: HAStateObject[], allStates: HAStateObject[],
): HAStateObject | null {
  const idsKey = `${states.map((s) => s.entity_id).join('|')}#${allStates.map((s) => s.entity_id).join('|')}`;
  const levelId = React.useMemo(
    () => findBatteryLevel(states, allStates)?.entity_id ?? null,
    // The lists' identities change every poll; their contents are the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idsKey],
  );
  if (!levelId) return null;
  return allStates.find((s) => s.entity_id === levelId) ?? null;
}

// ── View ────────────────────────────────────────────────────────────────────

export function EnergyFlowView({ states, allStates }: ViewProps) {
  const u = useScale();
  const t = useTheme();
  const [ref, box] = useElementSize<HTMLDivElement>();
  const levelSensor = useBatteryLevelSensor(states, allStates ?? states);
  const model = React.useMemo(() => classifyEnergy(states, levelSensor), [states, levelSensor]);

  if (!hasAnyNode(model)) {
    return <EmptyState message={tr('empty.pickPowerSensor', 'Pick a power sensor in the module config.')} />;
  }

  const justHome = homeOnly(model);
  // Side-by-side needs the list to fit beside a square diagram; below that
  // ratio the list goes underneath instead.
  const wide = box.width > 0 && box.width >= box.height * 1.35;
  const pad = u(16);

  return (
    <div ref={ref} style={{
      position: 'relative', height: '100%', boxSizing: 'border-box',
      padding: `${u(6)}px ${pad}px ${pad}px`,
      display: 'flex', flexDirection: wide ? 'row' : 'column',
      gap: u(wide ? 20 : 10), minHeight: 0, overflow: 'hidden',
    }}>
      <div style={{
        // The diagram is the point of the view: stacked, it keeps at least
        // the top 44% of the height and the list below gives way, not the
        // other way round.
        flex: '1 1 0', minWidth: 0, minHeight: wide ? 0 : '44%', position: 'relative',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Diagram model={model} />
        {justHome && (
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            textAlign: 'center', fontSize: u(12), lineHeight: 1.4,
            color: t.fg(0.5), padding: `0 ${u(12)}px`,
          }}>
            {tr('energy.pickSensors', 'Pick your solar, grid, and battery power sensors to see the flow')}
          </div>
        )}
      </div>
      {!justHome && (
        <SidePanel model={model} wide={wide} />
      )}
    </div>
  );
}

// ── Diagram ─────────────────────────────────────────────────────────────────

/** One keyframe per axis. A particle is a box as long as its wire with the
 *  dot at the far end, so translating the box by its own length walks the
 *  dot from one end of the wire to the other; `animation-direction:
 *  reverse` sends it the other way. Percent transforms are of the element
 *  itself, which is why the box, not the dot, is what moves. */
const KEYFRAMES = `
@keyframes ha-energy-x { from { transform: translateX(-100%); } to { transform: translateX(0); } }
@keyframes ha-energy-y { from { transform: translateY(-100%); } to { transform: translateY(0); } }
`;

function Diagram({ model }: { model: EnergyModel }) {
  const t = useTheme();
  const reduced = useReducedMotion();
  const [frameRef, frame] = useElementSize<HTMLDivElement>();
  const wires = flows(model);
  const roles = wires.map(wireRole);
  const vb = viewBoxFor(roles);
  const gradientId = React.useId();

  // Fit the viewBox into the frame ourselves (what preserveAspectRatio
  // "meet" would do) so the particle layer can share the exact same box.
  const scale = frame.width > 0 && frame.height > 0
    ? Math.min(frame.width / vb.w, frame.height / vb.h)
    : 0;
  const fitW = vb.w * scale;
  const fitH = vb.h * scale;

  return (
    <div ref={frameRef} style={{
      width: '100%', height: '100%', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ position: 'relative', width: fitW, height: fitH }}>
        <svg
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} preserveAspectRatio="xMidYMid meet"
          style={{ display: 'block', width: '100%', height: '100%', overflow: 'visible' }}
          aria-hidden="true"
        >
          <defs>
            {roles.map((role) => (
              <radialGradient key={role} id={`${gradientId}-${role}`}>
                <stop offset="0.55" stopColor={nodeColor(role, t)} stopOpacity={0.16} />
                <stop offset="1" stopColor={nodeColor(role, t)} stopOpacity={0} />
              </radialGradient>
            ))}
          </defs>
          {roles.length > 1 && wires.map((flow) => (
            <WireLine key={wireRole(flow)} flow={flow} reduced={reduced} />
          ))}
          {roles.length > 1 && (
            <circle cx={HUB.x} cy={HUB.y} r={10} fill={t.fg(0.35)} />
          )}
          {roles.map((role) => (
            <Node key={role} role={role} model={model} glowId={`${gradientId}-${role}`} />
          ))}
        </svg>
        {!reduced && roles.length > 1 && scale > 0 && (
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden="true">
            <style>{KEYFRAMES}</style>
            {wires.map((flow) => (
              <Particles key={wireRole(flow)} flow={flow} vb={vb} scale={scale} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The wire itself, and its particles when motion is off: a still frame
 *  of the moving version, dots spaced evenly along the line. */
function WireLine({ flow, reduced }: { flow: Flow; reduced: boolean }) {
  const t = useTheme();
  const color = nodeColor(wireRole(flow), t);
  const { a, b } = wireEnds(flow);
  const live = flow.watts >= IDLE_WATTS;
  return (
    <g>
      <path d={`M${a.x} ${a.y} L${b.x} ${b.y}`} stroke={withAlpha(color, live ? 0.35 : 0.12)}
        strokeWidth={WIRE_W} strokeLinecap="round" fill="none" />
      {live && reduced && Array.from({ length: PARTICLES_PER_WIRE }, (_, i) => {
        const f = (i + 0.5) / PARTICLES_PER_WIRE;
        return (
          <circle key={i} cx={a.x + (b.x - a.x) * f} cy={a.y + (b.y - a.y) * f}
            r={PARTICLE_R} fill={color} />
        );
      })}
    </g>
  );
}

/** The moving dots for one wire, in the HTML layer. Every wire is axis
 *  aligned, so each particle is a box along the wire's axis with the dot
 *  at its far end, and the keyframe slides the box by its own length. */
function Particles({ flow, vb, scale }: { flow: Flow; vb: ViewBox; scale: number }) {
  const t = useTheme();
  if (flow.watts < IDLE_WATTS) return null;
  const color = nodeColor(wireRole(flow), t);
  const { a, b } = wireEnds(flow);
  const d = PARTICLE_R * 2 * scale;
  const horizontal = a.y === b.y;
  // The box always runs from the lower coordinate to the higher one; the
  // flow direction only decides which way the keyframe plays.
  const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
  const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
  const forward = horizontal ? b.x > a.x : b.y > a.y;
  const len = (hi - lo) * scale;
  const left = horizontal ? (lo - vb.x) * scale : (a.x - vb.x) * scale - d / 2;
  const top = horizontal ? (a.y - vb.y) * scale - d / 2 : (lo - vb.y) * scale;
  // Tenths of a second: a poll that nudges 1842 W to 1851 W must not
  // restart the animation by changing the property.
  const dur = Math.round(particleDuration(flow.watts) * 10) / 10;

  return (
    <>
      {Array.from({ length: PARTICLES_PER_WIRE }, (_, i) => (
        <div key={i} style={{
          position: 'absolute', left, top,
          width: horizontal ? len : d, height: horizontal ? d : len,
          willChange: 'transform',
          animation: `ha-energy-${horizontal ? 'x' : 'y'} ${dur}s linear infinite`,
          animationDirection: forward ? 'normal' : 'reverse',
          animationDelay: `${(-(i / PARTICLES_PER_WIRE) * dur).toFixed(2)}s`,
        }}>
          <div style={{
            position: 'absolute', width: d, height: d, borderRadius: '50%', background: color,
            // The dot sits at the far end of the box: the box starts slid
            // fully back, so at t=0 the dot is at the wire's start.
            right: horizontal ? 0 : undefined, bottom: horizontal ? undefined : 0,
          }} />
        </div>
      ))}
    </>
  );
}

function Node({ role, model, glowId }: { role: EnergyRole; model: EnergyModel; glowId: string }) {
  const t = useTheme();
  const { x, y, r } = NODE_POS[role];
  const color = nodeColor(role, t);
  const isHome = role === 'home';
  const watts = model[role] ?? 0;
  const { value, unit } = formatWatts(watts);
  const label = nodeLabel(role, model);
  const iconSize = isHome ? 54 : 46;
  const valueSize = isHome ? 80 : 66;
  // Long labels ("Grid · exporting") have to fit inside the circle, so they
  // give up most of their tracking rather than running past the rim.
  const labelSize = isHome ? 27 : 24;
  const tracking = label.length > 11 ? '0.04em' : '0.1em';
  const iconScale = iconSize / 24;

  return (
    <g>
      <circle cx={x} cy={y} r={r + GLOW_PAD} fill={`url(#${glowId})`} />
      <circle cx={x} cy={y} r={r} fill={t.fg(0.04)}
        stroke={isHome ? t.fg(0.25) : withAlpha(color, 0.6)} strokeWidth={3} />
      <g transform={`translate(${x - iconSize / 2} ${y - r * 0.62 - iconSize / 2}) scale(${iconScale})`}
        style={{ color }}>
        <Icon name={NODE_ICON[role]} size={24} style={{ strokeWidth: 1.8 }} />
      </g>
      <text x={x} y={y + r * 0.16} textAnchor="middle" fill={t.fg()}
        fontSize={valueSize} fontWeight={600} letterSpacing="-0.03em"
        style={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
        <tspan fontSize={valueSize * 0.44} fontWeight={400} fill={t.fg(0.5)} dx={6}>{unit}</tspan>
      </text>
      <text x={x} y={y + r * 0.58} textAnchor="middle" fill={t.fg(0.55)}
        fontSize={labelSize} letterSpacing={tracking} style={{ textTransform: 'uppercase' }}>
        {label}
      </text>
    </g>
  );
}

// ── Labels ──────────────────────────────────────────────────────────────────

function roleName(role: EnergyRole): string {
  switch (role) {
    case 'solar': return tr('energy.solar', 'Solar');
    case 'grid': return tr('energy.grid', 'Grid');
    case 'battery': return tr('energy.battery', 'Battery');
    default: return tr('energy.home', 'Home');
  }
}

function detailWord(detail: RoleDetail): string {
  switch (detail) {
    case 'exporting': return tr('energy.exportingWord', 'exporting');
    case 'importing': return tr('energy.importingWord', 'importing');
    case 'charging': return tr('energy.chargingWord', 'charging');
    case 'discharging': return tr('energy.dischargingWord', 'discharging');
    default: return tr('energy.estimatedWord', 'estimated');
  }
}

/** "Grid · exporting", "Battery · 78%", "Home · estimated". */
function nodeLabel(role: EnergyRole, m: EnergyModel): string {
  const name = roleName(role);
  if (role === 'battery' && m.batteryLevel !== null) return `${name} · ${m.batteryLevel}%`;
  const detail = roleDetail(role, m);
  return detail ? `${name} · ${detailWord(detail)}` : name;
}

function statusText(s: EnergyStatus): string {
  switch (s.kind) {
    case 'exporting': return tr('energy.exporting', 'Exporting {watts}', { watts: wattsLabel(s.watts) });
    case 'importing': return tr('energy.importing', 'Importing {watts}', { watts: wattsLabel(s.watts) });
    case 'solar': return tr('energy.onSolar', 'Running on solar');
    case 'battery': return tr('energy.onBattery', 'Running on battery');
    case 'using': return tr('energy.using', 'Using {watts}', { watts: wattsLabel(s.watts) });
    default: return tr('energy.quiet', 'Not much going on');
  }
}

function statusColor(s: EnergyStatus, t: Theme): string {
  switch (s.kind) {
    case 'exporting': return t.ok;
    case 'importing': return t.accent.blue.base;
    case 'solar': return t.accent.amber.base;
    case 'battery': return t.accent.green.base;
    default: return t.fg(0.45);
  }
}

// ── Side panel ──────────────────────────────────────────────────────────────

function SidePanel({ model, wide }: { model: EnergyModel; wide: boolean }) {
  const u = useScale();
  const t = useTheme();
  const status = energyStatus(model);
  const self = selfPowered(model);
  const rows = rightNowRows(model);

  return (
    <div style={{
      flex: '0 1 auto', display: 'flex', flexDirection: 'column', gap: u(8),
      width: wide ? u(220) : undefined, minWidth: 0, minHeight: 0, overflow: 'hidden',
      justifyContent: wide ? 'center' : undefined,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: u(10), flexWrap: 'wrap',
      }}>
        <span style={{
          fontSize: u(10), textTransform: 'uppercase', letterSpacing: '0.14em',
          color: t.fg(0.45), fontWeight: 600,
        }}>
          {tr('energy.rightNow', 'Right now')}
        </span>
        <Chip dot={statusColor(status, t)}>{statusText(status)}</Chip>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((row) => (
          <Row key={row.key}
            label={row.detail ? `${roleName(row.role)} · ${detailWord(row.detail)}` : roleName(row.role)}
            value={row.value}
            color={nodeColor(row.role, t)}
            compact={!wide} />
        ))}
        {self !== null && (
          <Row label={tr('energy.selfPowered', 'Self-powered right now')} value={`${self}%`}
            color={`linear-gradient(90deg, ${t.accent.amber.base}, ${t.accent.green.base})`}
            compact={!wide} last />
        )}
      </div>
      {self !== null && (
        <div style={{
          height: u(6), borderRadius: u(3), background: t.fg(0.08),
          overflow: 'hidden', flexShrink: 0,
        }}>
          <div style={{
            height: '100%', width: `${self}%`,
            background: `linear-gradient(90deg, ${t.accent.amber.base}, ${t.accent.green.base})`,
          }} />
        </div>
      )}
    </div>
  );
}

function Row({ label, value, color, compact, last }: {
  label: string; value: string; color: string; compact: boolean; last?: boolean;
}) {
  const u = useScale();
  const t = useTheme();
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      gap: u(10), padding: `${u(compact ? 3 : 5)}px 0`, fontSize: u(12), color: t.fg(0.6),
      borderBottom: last ? undefined : `1px solid ${t.fg(0.06)}`, minWidth: 0,
    }}>
      <span style={{
        display: 'flex', alignItems: 'center', gap: u(7), minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        <span style={{
          width: u(7), height: u(7), borderRadius: 99, flexShrink: 0,
          background: color,
        }} />
        {label}
      </span>
      <b style={{
        color: t.fg(), fontWeight: 600, fontSize: u(14),
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
      }}>
        {value}
      </b>
    </div>
  );
}
