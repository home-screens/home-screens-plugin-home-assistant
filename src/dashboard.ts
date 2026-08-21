// Pure model for the `dashboard` view: how the selected entities split into
// area sections, what each section's title row says, which entities the
// at-a-glance column claims, and the house-wide summaries along the top.
// No React, no fetch — the view is a render of the regular states poll plus
// the 24h history the sparklines already load.

import type { HAStateObject, HAArea } from './types';
import { entityDomain } from './types';
import {
  friendlyName, formatValue, isAlertState, precisionFor, pickDefaultPrecision, formatClock,
} from './utils';
import { isPowerSensor } from './power';
import { brightnessPct } from './light';
import { climateStateLine } from './climate';
import { mediaStateLabel } from './media';
import { isRunning } from './vacuum';
import { tr } from './i18n';

// ── Sections ────────────────────────────────────────────────────────────────

export interface DashboardSection {
  /** Area name, or null when Home Assistant has no areas to name — the one
   *  section then has no title row at all. */
  title: string | null;
  entities: HAStateObject[];
}

/**
 * Group the selected entities by area, the way the By area view does: one
 * section per area that holds at least one selected entity, in registry
 * order, then an "Other" section for anything no area claims. `areaId`
 * narrows the board to a single area and hides everything outside it.
 */
/** Domains a whole-house dashboard should not pull in on its own: they are
 *  plumbing (updates, helpers, TTS) or have no state worth a tile. Picking
 *  one explicitly still works; this only shapes the automatic selection. */
const AUTO_SKIP_DOMAINS: ReadonlySet<string> = new Set([
  'update', 'button', 'event', 'number', 'select', 'text', 'tts', 'stt',
  'conversation', 'input_text', 'input_number', 'input_select', 'input_datetime',
  'datetime', 'date', 'time', 'tag', 'zone', 'sun', 'script', 'automation',
  'device_tracker', 'image', 'notify', 'remote', 'siren', 'todo', 'calendar',
  'assist_satellite', 'wake_word', 'ai_task', 'lawn_mower_zone',
  // Hue alone ships a dozen scene presets per room; a house-wide fill would
  // be mostly scene tiles. Pick the scenes you want on the wall.
  'scene',
]);

/**
 * What the dashboard draws when nobody has picked entities: everything that
 * lives in an area (or in the one chosen area), in area order, minus the
 * plumbing domains. A wall display set to "All areas" should light up with
 * the house, not ask for a checklist first. Picking entities turns this off
 * and becomes the filter, the way the other views work.
 */
export function autoDashboardEntities(
  states: HAStateObject[], areas: HAArea[] | undefined | null, areaId?: string | null,
): HAStateObject[] {
  if (!areas) return [];
  const byId = new Map(states.map((s) => [s.entity_id, s]));
  const scope = areaId ? areas.filter((a) => a.area_id === areaId) : areas;
  const out: HAStateObject[] = [];
  const seen = new Set<string>();
  for (const area of scope) {
    for (const id of area.entities) {
      if (seen.has(id)) continue;
      const s = byId.get(id);
      if (!s || AUTO_SKIP_DOMAINS.has(entityDomain(id))) continue;
      seen.add(id);
      out.push(s);
    }
  }
  return out;
}

export function groupByArea(
  states: HAStateObject[], areas: HAArea[] | undefined, areaId?: string | null,
): DashboardSection[] {
  const byEntityId = new Map(states.map((s) => [s.entity_id, s]));
  const sections: DashboardSection[] = [];
  const claimed = new Set<string>();

  const scope = areaId && areas ? areas.filter((a) => a.area_id === areaId) : areas;
  if (scope) {
    for (const area of scope) {
      const members: HAStateObject[] = [];
      for (const eid of area.entities) {
        const s = byEntityId.get(eid);
        if (s && !claimed.has(eid)) { members.push(s); claimed.add(eid); }
      }
      if (members.length > 0) sections.push({ title: area.name, entities: members });
    }
  }
  if (!areaId) {
    const other = states.filter((s) => !claimed.has(s.entity_id));
    if (other.length > 0) {
      // With no areas at all there is nothing to tell "Other" apart from, so
      // the lone section goes untitled rather than labelling the whole house
      // "Other".
      const hasAreas = scope != null && scope.length > 0;
      sections.push({ title: hasAreas ? tr('room.other', 'Other') : null, entities: other });
    }
  }
  return sections;
}

// ── Section title stats ─────────────────────────────────────────────────────

export interface SectionStats {
  temperature: HAStateObject | null;
  humidity: HAStateObject | null;
  /** A motion / occupancy / presence sensor in the room is reporting on. */
  presence: boolean;
}

export function isTemperatureSensor(s: HAStateObject): boolean {
  if (entityDomain(s.entity_id) !== 'sensor') return false;
  if (s.attributes.device_class === 'temperature') return true;
  const unit = s.attributes.unit_of_measurement;
  return typeof unit === 'string' && unit.trim().startsWith('°');
}

export function isHumiditySensor(s: HAStateObject): boolean {
  return entityDomain(s.entity_id) === 'sensor' && s.attributes.device_class === 'humidity';
}

const PRESENCE_CLASSES = new Set(['motion', 'occupancy', 'presence']);

export function isPresenceSensor(s: HAStateObject): boolean {
  return entityDomain(s.entity_id) === 'binary_sensor'
    && PRESENCE_CLASSES.has(s.attributes.device_class ?? '');
}

function hasReading(s: HAStateObject): boolean {
  return Number.isFinite(Number(s.state)) && s.state.trim() !== '';
}

/** The room's own numbers for its title row: first temperature sensor,
 *  first humidity sensor, and whether anyone is moving around in it. */
export function sectionStats(entities: HAStateObject[]): SectionStats {
  return {
    temperature: entities.find((s) => isTemperatureSensor(s) && hasReading(s)) ?? null,
    humidity: entities.find((s) => isHumiditySensor(s) && hasReading(s)) ?? null,
    presence: entities.some((s) => isPresenceSensor(s) && s.state === 'on'),
  };
}

// ── At-a-glance column ──────────────────────────────────────────────────────

export interface HeroPartition {
  weather: HAStateObject | null;
  people: HAStateObject[];
  power: HAStateObject | null;
  scenes: HAStateObject[];
  /** Everything the column did not claim — what the rooms draw. */
  rest: HAStateObject[];
}

/** Split the selection into the column's panels and the rest. An entity the
 *  column shows never also appears as a room tile. */
export function partitionHero(states: HAStateObject[]): HeroPartition {
  const weather = states.find((s) => entityDomain(s.entity_id) === 'weather') ?? null;
  const power = states.find(isPowerSensor) ?? null;
  const people = states.filter((s) => entityDomain(s.entity_id) === 'person');
  const scenes = states.filter((s) => entityDomain(s.entity_id) === 'scene');
  const taken = new Set<string>([
    ...people.map((s) => s.entity_id), ...scenes.map((s) => s.entity_id),
  ]);
  if (weather) taken.add(weather.entity_id);
  if (power) taken.add(power.entity_id);
  return {
    weather, people, power, scenes,
    rest: states.filter((s) => !taken.has(s.entity_id)),
  };
}

// ── Top strip summaries ─────────────────────────────────────────────────────

export type LockSummary =
  | { kind: 'none' }
  | { kind: 'allLocked'; count: number }
  | { kind: 'unlocked'; names: string[] };

/** The lock chip: green when every lock is locked, red naming what isn't.
 *  Only real lock entities count; a door contact is a different question
 *  (open, not unlocked) and it already draws as a red tile. */
export function lockSummary(states: HAStateObject[]): LockSummary {
  const locks = states.filter((s) => entityDomain(s.entity_id) === 'lock'
    && s.state !== 'unavailable' && s.state !== 'unknown');
  if (locks.length === 0) return { kind: 'none' };
  const open = locks.filter((s) => s.state !== 'locked' && s.state !== 'locking');
  if (open.length === 0) return { kind: 'allLocked', count: locks.length };
  return { kind: 'unlocked', names: open.map(friendlyName) };
}

export interface PeopleSummary {
  people: HAStateObject[];
  home: HAStateObject[];
}

export function peopleSummary(states: HAStateObject[]): PeopleSummary {
  const people = states.filter((s) => entityDomain(s.entity_id) === 'person');
  return { people, home: people.filter((s) => s.state === 'home') };
}

export interface HouseClimate {
  /** Formatted temperature ("72.4°") or null. */
  temperature: string | null;
  /** Formatted humidity ("48%") or null. */
  humidity: string | null;
}

const OUTDOOR = /outdoor|outside|exterior|backyard|garden|patio/i;

function isOutdoor(s: HAStateObject): boolean {
  return OUTDOOR.test(s.entity_id) || OUTDOOR.test(friendlyName(s));
}

/** The house-wide temperature and humidity chips: the weather entity when
 *  one is selected, else the first outdoor temperature / humidity sensor,
 *  else the first of each at all (a single indoor probe still answers "how
 *  warm is it" better than nothing). */
export function houseClimate(states: HAStateObject[]): HouseClimate {
  const weather = states.find((s) => entityDomain(s.entity_id) === 'weather');
  if (weather) {
    const temp = weather.attributes.temperature;
    const hum = weather.attributes.humidity;
    return {
      temperature: typeof temp === 'number' ? `${formatDegrees(temp)}°` : null,
      humidity: typeof hum === 'number' ? `${Math.round(hum)}%` : null,
    };
  }
  const temps = states.filter((s) => isTemperatureSensor(s) && hasReading(s));
  const hums = states.filter((s) => isHumiditySensor(s) && hasReading(s));
  const temp = temps.find(isOutdoor) ?? temps[0];
  const hum = hums.find(isOutdoor) ?? hums[0];
  return {
    temperature: temp ? `${formatDegrees(Number(temp.state), temp)}°` : null,
    humidity: hum ? `${Math.round(Number(hum.state))}%` : null,
  };
}

/** "72.4" / "81", no unit letter, with the decimals formatValue would use:
 *  the sensor's suggested_display_precision when one is given, else one
 *  decimal under 100° and none above. So the chip and the tile beside it
 *  never disagree about the same reading. */
export function formatDegrees(value: number, sensor?: HAStateObject | null): string {
  const precision = sensor ? precisionFor(sensor, value) : pickDefaultPrecision(value, '°');
  return value.toFixed(precision);
}

// ── Tiles ───────────────────────────────────────────────────────────────────

export type TileTone = 'default' | 'on' | 'active' | 'alert';

/** The surface a tile earns from its state: amber for things that are on,
 *  blue for things that are busy, red for things that need a look. */
export function tileTone(s: HAStateObject): TileTone {
  const state = s.state;
  if (state === 'unavailable' || state === 'unknown') return 'default';
  switch (entityDomain(s.entity_id)) {
    case 'light': case 'switch': case 'fan': case 'input_boolean': case 'automation':
      return state === 'on' ? 'on' : 'default';
    case 'cover':
      return state === 'open' || state === 'opening' ? 'on' : 'default';
    case 'binary_sensor':
      if (isAlertState(s)) return 'alert';
      if (s.attributes.device_class === 'battery_charging') return state === 'on' ? 'active' : 'default';
      return state === 'on' ? 'on' : 'default';
    case 'lock':
      return state === 'unlocked' || state === 'jammed' ? 'alert' : 'default';
    case 'media_player':
      return state === 'playing' || state === 'buffering' ? 'active' : 'default';
    case 'climate': {
      const action = s.attributes.hvac_action;
      if (typeof action === 'string' && action !== '') {
        return action === 'heating' || action === 'cooling' || action === 'drying' ? 'active' : 'default';
      }
      return state !== 'off' ? 'active' : 'default';
    }
    case 'vacuum': case 'lawn_mower':
      if (state === 'error') return 'alert';
      return isRunning(s) ? 'active' : 'default';
    case 'person':
      return state === 'home' ? 'on' : 'default';
    default:
      return 'default';
  }
}

/** The small line under a tile's name: the state word, plus the one number
 *  worth adding (a light's brightness, a blind's position, what's playing). */
export function tileStateLine(s: HAStateObject, controls: boolean): string {
  if (s.state === 'unavailable') return tr('common.unavailable', 'Unavailable');
  const domain = entityDomain(s.entity_id);
  const label = formatValue(s);
  switch (domain) {
    case 'light': {
      const pct = brightnessPct(s);
      return pct != null ? `${label} · ${pct}%` : label;
    }
    case 'fan': {
      const pct = s.attributes.percentage;
      return s.state === 'on' && typeof pct === 'number' ? `${label} · ${pct}%` : label;
    }
    case 'cover': {
      const pos = s.attributes.current_position;
      return typeof pos === 'number' && s.state === 'open' && pos < 100 ? `${label} · ${pos}%` : label;
    }
    case 'climate':
      return climateStateLine(s);
    case 'media_player': {
      const title = s.attributes.media_title;
      const word = mediaStateLabel(s.state);
      return title && (s.state === 'playing' || s.state === 'paused') ? `${word} · ${title}` : word;
    }
    case 'scene':
      return controls ? tr('dashboard.tapToRun', 'Tap to run') : tr('card.scene', 'Scene');
    case 'vacuum': case 'lawn_mower': {
      const battery = s.attributes.battery_level;
      return typeof battery === 'number' ? `${label} · ${Math.round(battery)}%` : label;
    }
    default:
      return label;
  }
}

// ── Forecast ────────────────────────────────────────────────────────────────

/** Short weekday for a forecast entry ("Fri"), or null for an unreadable
 *  timestamp. */
export function forecastDay(datetime: unknown, timeZone?: string, locale?: string): string | null {
  if (typeof datetime !== 'string') return null;
  const t = Date.parse(datetime);
  if (Number.isNaN(t)) return null;
  return formatClock(t, timeZone, { shape: 'weekday', locale });
}

export interface ForecastDay {
  label: string;
  high: string;
}

/**
 * The forecast list out of a `weather.get_forecasts` response
 * (`POST /api/services/weather/get_forecasts?return_response`), which HA
 * shapes as `{ service_response: { [entity_id]: { forecast: [...] } } }`.
 * Null when the response holds nothing usable for this entity, so the
 * caller can keep whatever it already had.
 */
export function parseForecastResponse(raw: unknown, entityId: string): unknown[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const response = (raw as { service_response?: unknown }).service_response;
  if (typeof response !== 'object' || response === null) return null;
  const entry = (response as Record<string, unknown>)[entityId];
  if (typeof entry !== 'object' || entry === null) return null;
  const forecast = (entry as { forecast?: unknown }).forecast;
  return Array.isArray(forecast) ? forecast : null;
}

/** Up to five daily entries off a forecast list (the service response, or
 *  the `forecast` attribute older Home Assistant still sets). Hourly
 *  forecasts share the shape, so entries on the same calendar day collapse
 *  to the first one. */
export function dailyForecast(raw: unknown, timeZone?: string, locale?: string): ForecastDay[] {
  if (!Array.isArray(raw)) return [];
  const out: ForecastDay[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { datetime, temperature } = entry as { datetime?: unknown; temperature?: unknown };
    const label = forecastDay(datetime, timeZone, locale);
    if (!label || typeof temperature !== 'number' || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, high: `${Math.round(temperature)}°` });
    if (out.length === 5) break;
  }
  return out;
}

// ── People ──────────────────────────────────────────────────────────────────

/** "Bryan Smith" → "BS", "Emma" → "E". For the avatar when HA has no
 *  picture for someone. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}
