// Pure model for the `energy-flow` view: which power sensor plays which part
// (solar, grid, battery, home), every reading normalized to watts with one
// sign convention, and the wires between them. No React, no fetch: the view
// is a redraw of the regular states poll, so it costs no extra API calls.
//
// Deliberately NOT the HA energy dashboard. Daily totals (kWh produced,
// sent to the grid) live in long-term statistics the REST API does not
// expose, so this view only ever shows what is flowing right now.

import type { HAStateObject } from './types';
import { entityDomain } from './types';
import { isPowerSensor } from './power';
import { batteryLevel } from './batteries';
import { friendlyName, pickDefaultPrecision } from './utils';

export type EnergyRole = 'solar' | 'grid' | 'battery' | 'home';

/** The junction the wires meet at. Every wire runs between a node and the
 *  hub, so a flow is "this much, toward or away from the middle". */
export type FlowEnd = EnergyRole | 'hub';

export interface Flow {
  from: FlowEnd;
  to: FlowEnd;
  /** Always >= 0; direction is carried by from/to. */
  watts: number;
}

export interface EnergyModel {
  /** Watts per role, null when no sensor plays that part. Signs after
   *  normalization: grid positive = importing, negative = exporting;
   *  battery positive = charging, negative = discharging; solar and home
   *  are magnitudes. */
  solar: number | null;
  grid: number | null;
  battery: number | null;
  home: number | null;
  /** True when `home` was computed from the others rather than read. */
  homeDerived: boolean;
  /** 0–100 from the matching battery level sensor, or null. */
  batteryLevel: number | null;
}

/** Below this many watts a wire is "not really flowing": drawn dim, no
 *  particles, and it never decides the status chip. Inverters idle at a
 *  few watts either way all night. */
export const IDLE_WATTS = 50;

const ROLE_WORDS: Array<[EnergyRole, RegExp]> = [
  ['solar', /\b(solar|pv|inverter)\b/],
  ['grid', /\b(grid|utility|mains|import|export|meter)\b/],
  ['battery', /\b(battery|powerwall|storage)\b/],
];

/** Entity id plus name as one lowercase word list. Underscores and dots
 *  become spaces so `sensor.solar_power` matches the same way "Solar Power"
 *  does. */
function words(s: HAStateObject): string {
  return `${s.entity_id} ${friendlyName(s)}`.toLowerCase().replace(/[._\-/]+/g, ' ');
}

/** Which part a power sensor plays. Anything that is not recognisably
 *  solar, grid, or battery is the house: "house", "home", "consumption",
 *  "load", "total", and whatever a DIY template sensor was called. */
export function roleFor(s: HAStateObject): EnergyRole {
  const text = words(s);
  for (const [role, re] of ROLE_WORDS) {
    if (re.test(text)) return role;
  }
  return 'home';
}

/** The reading in watts, whatever unit the sensor reports in. Null for
 *  unavailable/unknown/blank states and anything that does not parse. */
export function toWatts(s: HAStateObject): number | null {
  const raw = s.state.trim();
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const unit = (s.attributes.unit_of_measurement ?? 'W').trim();
  switch (unit) {
    case 'kW': case 'kVA': return n * 1000;
    case 'MW': return n * 1_000_000;
    default: return n;
  }
}

/** Grid, made positive-when-importing. A sensor called "export" reports
 *  power leaving the house as a positive number, so it is flipped. */
export function gridSign(s: HAStateObject, watts: number): number {
  return /\bexport/.test(words(s)) ? -watts : watts;
}

/** Battery, made positive-when-charging.
 *
 *  Checked against the Home Assistant Powerwall integration docs
 *  (home-assistant.io/integrations/powerwall, 2026-08-21): both "Battery
 *  Now" (the gateway meter, kW) and "Battery Power" (per battery, W) are
 *  documented as "negative for charging", so a Powerwall reports discharge
 *  as positive and is flipped here by the "powerwall" in its name. A sensor
 *  that calls itself "discharge" is flipped by its own name. Every other
 *  integration keeps its sign as read (positive = charging); that default
 *  is unverified, and the name is the only signal the REST API gives. */
export function batterySign(s: HAStateObject, watts: number): number {
  return /\b(discharg\w*|powerwall)\b/.test(words(s)) ? -watts : watts;
}

/** True when this sensor reports a battery's charge level (the % one, not
 *  the watts one). */
function isBatteryLevelSensor(s: HAStateObject): boolean {
  return entityDomain(s.entity_id) === 'sensor' && batteryLevel(s) !== null;
}

/** Words worth matching between a battery power sensor and a level sensor.
 *  "battery", "power", "level", and "sensor" are in almost every name, so
 *  they say nothing about whether two sensors belong to the same device. */
const COMMON_WORDS = new Set(['battery', 'power', 'level', 'sensor', 'state', 'of', 'charge', 'soc']);

function nameWords(s: HAStateObject): Set<string> {
  return new Set(words(s).split(/\s+/).filter((w) => w && !COMMON_WORDS.has(w)));
}

/**
 * The level sensor that belongs to the battery power sensor: one the user
 * selected wins (they pointed at it on purpose), else the first level sensor
 * in the whole poll that shares a distinctive word with the power sensor
 * ("powerwall", "garage", "lg"), else one whose entity id starts the same
 * way. Never "any battery sensor": a house with a Powerwall also has forty
 * door sensors with batteries, and that guess would pick the kitchen remote.
 *
 * This is a name match, so the answer only changes when the entity list
 * does. The view resolves it once per list and passes the live state of the
 * winner into classifyEnergy on every poll.
 */
export function findBatteryLevel(
  selected: HAStateObject[],
  all: HAStateObject[],
): HAStateObject | null {
  const picked = selected.find(isBatteryLevelSensor);
  if (picked) return picked;
  const batteryPower = rolesOf(selected).battery;
  if (!batteryPower) return null;
  const mine = nameWords(batteryPower);
  for (const s of all) {
    if (!isBatteryLevelSensor(s)) continue;
    const theirs = nameWords(s);
    for (const w of theirs) {
      if (mine.has(w)) return s;
    }
  }
  // Two sensors that are only ever called "Battery Power" and "Battery
  // Level" share no distinctive word, but they do share their whole prefix.
  for (const s of all) {
    if (!isBatteryLevelSensor(s)) continue;
    if (sameObjectPrefix(batteryPower.entity_id, s.entity_id)) return s;
  }
  return null;
}

/** `sensor.battery_power` and `sensor.battery_level` → both start with
 *  "battery". */
function sameObjectPrefix(a: string, b: string): boolean {
  const pa = a.split('.')[1]?.split('_') ?? [];
  const pb = b.split('.')[1]?.split('_') ?? [];
  if (pa.length < 2 || pb.length < 2) return false;
  return pa[0] === pb[0];
}

/** The first power sensor per role. Extra home candidates are ignored
 *  rather than summed, because "House Power" and "Total Load" are usually
 *  the same number twice. */
function rolesOf(states: HAStateObject[]): Partial<Record<EnergyRole, HAStateObject>> {
  const sensors: Partial<Record<EnergyRole, HAStateObject>> = {};
  for (const s of states) {
    if (!isPowerSensor(s)) continue;
    const role = roleFor(s);
    if (!sensors[role]) sensors[role] = s;
  }
  return sensors;
}

/**
 * Sort the selected sensors into roles and read them. The first sensor per
 * role wins, so a user with two solar arrays gets the one they listed first.
 * `levelSensor` is the battery level sensor findBatteryLevel picked, with
 * its current state; a role whose sensor is unavailable reads as 0 so the
 * node stays put instead of the diagram reshuffling.
 */
export function classifyEnergy(
  states: HAStateObject[], levelSensor: HAStateObject | null = null,
): EnergyModel {
  const sensors = rolesOf(states);

  const read = (role: EnergyRole): number | null => {
    const s = sensors[role];
    return s ? toWatts(s) : null;
  };

  const solar = sensors.solar ? Math.abs(read('solar') ?? 0) : null;
  const gridRaw = read('grid');
  const grid = sensors.grid && gridRaw !== null ? gridSign(sensors.grid, gridRaw) : sensors.grid ? 0 : null;
  const batteryRaw = read('battery');
  const battery = sensors.battery && batteryRaw !== null
    ? batterySign(sensors.battery, batteryRaw)
    : sensors.battery ? 0 : null;

  let home: number | null = sensors.home ? Math.abs(read('home') ?? 0) : null;
  let homeDerived = false;
  // Home = everything coming in minus everything going out. Solar and grid
  // are enough to derive it; the battery just adjusts: charging takes
  // some, discharging adds some. Clamped at zero for the moment a meter
  // lags the inverter and the sum goes negative.
  if (home === null && solar !== null && grid !== null) {
    home = Math.max(0, solar + grid - (battery ?? 0));
    homeDerived = true;
  }

  return {
    solar, grid, battery, home, homeDerived,
    batteryLevel: levelSensor ? batteryLevel(levelSensor) : null,
  };
}

/** True when there is at least one node to draw. */
export function hasAnyNode(m: EnergyModel): boolean {
  return m.solar !== null || m.grid !== null || m.battery !== null || m.home !== null;
}

/** True when the diagram is just the house: nothing for it to flow to. */
export function homeOnly(m: EnergyModel): boolean {
  return m.home !== null && m.solar === null && m.grid === null && m.battery === null;
}

/**
 * One wire per node that exists, each between that node and the hub. The
 * grid wire carries |grid| toward the hub when importing and away when
 * exporting; the battery wire carries |battery| away from the hub when
 * charging and toward it when discharging; solar always feeds in; the home
 * wire always draws out. Tiny readings still produce a wire (the view draws
 * it dim) so the diagram does not flicker as an inverter idles around zero.
 */
export function flows(m: EnergyModel): Flow[] {
  const out: Flow[] = [];
  if (m.solar !== null) out.push({ from: 'solar', to: 'hub', watts: m.solar });
  if (m.grid !== null) {
    out.push(m.grid >= 0
      ? { from: 'grid', to: 'hub', watts: m.grid }
      : { from: 'hub', to: 'grid', watts: -m.grid });
  }
  if (m.battery !== null) {
    out.push(m.battery >= 0
      ? { from: 'hub', to: 'battery', watts: m.battery }
      : { from: 'battery', to: 'hub', watts: -m.battery });
  }
  if (m.home !== null) out.push({ from: 'hub', to: 'home', watts: m.home });
  return out;
}

/** Solar as a share of what the house is using right now, 0–100. Null
 *  unless both numbers exist and the house is using something. */
export function selfPowered(m: EnergyModel): number | null {
  if (m.solar === null || m.home === null || m.home < IDLE_WATTS) return null;
  return Math.round(Math.max(0, Math.min(100, (m.solar / m.home) * 100)));
}

export type EnergyStatusKind = 'exporting' | 'importing' | 'solar' | 'battery' | 'using' | 'quiet';

export interface EnergyStatus {
  kind: EnergyStatusKind;
  /** The number the chip shows, always >= 0. */
  watts: number;
}

/**
 * The one-line summary: what the house is mostly doing. Grid movement is
 * the most interesting fact when there is any, then "on solar" when the sun
 * covers the house, then "on battery" when the battery is carrying it.
 */
export function energyStatus(m: EnergyModel): EnergyStatus {
  if (m.grid !== null && m.grid <= -IDLE_WATTS) return { kind: 'exporting', watts: -m.grid };
  if (m.grid !== null && m.grid >= IDLE_WATTS) return { kind: 'importing', watts: m.grid };
  const home = m.home ?? 0;
  if (m.solar !== null && m.solar >= IDLE_WATTS && m.solar >= home) {
    return { kind: 'solar', watts: m.solar };
  }
  if (m.battery !== null && m.battery <= -IDLE_WATTS) return { kind: 'battery', watts: -m.battery };
  if (m.solar !== null && m.solar >= IDLE_WATTS) return { kind: 'solar', watts: m.solar };
  if (home >= IDLE_WATTS) return { kind: 'using', watts: home };
  return { kind: 'quiet', watts: 0 };
}

export interface WattsText {
  /** "5.2" or "430" (no sign). */
  value: string;
  /** "kW" or "W". */
  unit: string;
}

/** W below 1000, kW above, with the decimals formatValue gives those units
 *  (whole watts; two decimals under 10 kW, one above), so a sensor reads
 *  the same here as it does on the Power and Dashboard views. */
export function formatWatts(watts: number): WattsText {
  const abs = Math.abs(watts);
  if (abs < 1000) return { value: abs.toFixed(pickDefaultPrecision(abs, 'W')), unit: 'W' };
  const kw = abs / 1000;
  return { value: kw.toFixed(pickDefaultPrecision(kw, 'kW')), unit: 'kW' };
}

export function wattsLabel(watts: number): string {
  const { value, unit } = formatWatts(watts);
  return `${value} ${unit}`;
}

/** Particle loop time for a wire: faster with more watts, clamped so a
 *  trickle still visibly moves and a 10 kW surge is not a blur. */
export function particleDuration(watts: number): number {
  if (watts <= 0) return 6;
  return Math.max(0.8, Math.min(6, 3000 / watts));
}

/** Particles on every live wire. Fixed rather than scaled with watts: a
 *  count that changes at a threshold remounts the particles and restarts
 *  the animation each time a reading jitters across it. Speed carries the
 *  magnitude instead (particleDuration). */
export const PARTICLES_PER_WIRE = 4;

export type RoleDetail = 'exporting' | 'importing' | 'charging' | 'discharging' | 'estimated';

/** The word after a node's name: which way the grid or battery is going,
 *  or that the house number was worked out rather than read. */
export function roleDetail(role: EnergyRole, m: EnergyModel): RoleDetail | null {
  if (role === 'grid' && m.grid !== null) {
    if (m.grid <= -IDLE_WATTS) return 'exporting';
    if (m.grid >= IDLE_WATTS) return 'importing';
  }
  if (role === 'battery' && m.battery !== null) {
    if (m.battery >= IDLE_WATTS) return 'charging';
    if (m.battery <= -IDLE_WATTS) return 'discharging';
  }
  if (role === 'home' && m.homeDerived) return 'estimated';
  return null;
}

export interface RightNowRow {
  key: string;
  role: EnergyRole;
  detail: RoleDetail | null;
  /** Formatted: "5.2 kW", or for the battery "900 W · 78%" (the level
   *  alone when only a level sensor was picked). */
  value: string;
}

/** The "Right now" list: one row per node in solar, grid, battery, home
 *  order. The battery's level shares its row rather than taking a second
 *  one, so the list stays one line per thing. */
export function rightNowRows(m: EnergyModel): RightNowRow[] {
  const rows: RightNowRow[] = [];
  const order: EnergyRole[] = ['solar', 'grid', 'battery', 'home'];
  for (const role of order) {
    const watts = m[role];
    if (role === 'battery') {
      const parts: string[] = [];
      if (watts !== null) parts.push(wattsLabel(watts));
      if (m.batteryLevel !== null) parts.push(`${m.batteryLevel}%`);
      if (parts.length === 0) continue;
      rows.push({ key: role, role, detail: roleDetail(role, m), value: parts.join(' · ') });
      continue;
    }
    if (watts === null) continue;
    rows.push({ key: role, role, detail: roleDetail(role, m), value: wattsLabel(watts) });
  }
  return rows;
}
