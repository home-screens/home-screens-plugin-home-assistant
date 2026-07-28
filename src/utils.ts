// Formatters + entity helpers. Zero template strings for the user to learn —
// this is the file that turns raw HA state into glanceable text.

import type { HAStateObject } from './types';
import { entityDomain } from './types';
import { sampleRawStates } from './shared-state';
import { hostTimezone } from './settings';
import { vacuumStateLabel } from './vacuum';
import { coverStateLabel } from './cover';
import { lockStateLabel } from './lock';
import { hvacModeLabel } from './climate';
import { mediaStateLabel } from './media';
import { tr } from './i18n';

export { entityDomain };

/**
 * Raw states this entity can report, for the visibility-conditions panel.
 * Attribute-driven where HA enumerates them per entity (climate hvac modes,
 * select options) and lifecycle-complete per domain otherwise; falls back to
 * the domain samples shared with the editor key picker. Null = not
 * enumerable (numeric sensors, free-form states).
 *
 * Person/device_tracker lists are common values, not exhaustive — zone names
 * are also valid states, which is why the panel labels this row "values"
 * rather than claiming completeness.
 */
export function possibleRawStates(s: HAStateObject): string[] | null {
  const domain = entityDomain(s.entity_id);
  if (domain === 'climate') {
    const modes = s.attributes.hvac_modes;
    return Array.isArray(modes) && modes.length > 0
      && modes.every((m) => typeof m === 'string')
      ? [...modes] : null;
  }
  if (domain === 'select' || domain === 'input_select') {
    const opts = s.attributes.options;
    return Array.isArray(opts) && opts.length > 0
      && opts.every((o) => typeof o === 'string')
      ? [...(opts as string[])] : null;
  }
  if (domain === 'lock') return ['locked', 'unlocked', 'locking', 'unlocking', 'jammed'];
  if (domain === 'cover') return ['open', 'closed', 'opening', 'closing'];
  if (domain === 'media_player') {
    return ['playing', 'paused', 'idle', 'off', 'on', 'standby', 'buffering'];
  }
  if (domain === 'vacuum') return ['cleaning', 'docked', 'paused', 'idle', 'returning', 'error'];
  if (domain === 'lawn_mower') return ['mowing', 'docked', 'paused', 'returning', 'error'];
  if (domain === 'alarm_control_panel') {
    return ['disarmed', 'armed_home', 'armed_away', 'armed_night', 'arming', 'pending', 'triggered'];
  }
  return sampleRawStates(s.entity_id);
}

export function friendlyName(s: HAStateObject): string {
  return s.attributes.friendly_name || prettifyId(s.entity_id);
}

function prettifyId(entityId: string): string {
  const obj = entityId.split('.')[1] ?? entityId;
  return obj.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatValue(s: HAStateObject): string {
  const { state, attributes } = s;
  // Unavailable / unknown — show as em dash
  if (state === 'unavailable' || state === 'unknown' || state === '') return '—';

  const domain = entityDomain(s.entity_id);
  const unit = attributes.unit_of_measurement;

  // Numeric states with units: respect suggested_display_precision if present.
  const num = Number(state);
  if (!Number.isNaN(num) && unit) {
    const precision = typeof attributes.suggested_display_precision === 'number'
      ? attributes.suggested_display_precision
      : pickDefaultPrecision(num, unit);
    return `${num.toFixed(precision)}${unit.startsWith('°') ? '' : ' '}${unit}`;
  }

  // Domain-specific friendly states
  if (domain === 'binary_sensor') {
    return formatBinarySensor(state, attributes.device_class as string | undefined);
  }
  // Where a key already exists, this reads it rather than restating the
  // English: the cards and sheets translate, and a hero tile beside them
  // saying "On" while the card says "An" is the same word twice in two
  // languages on one screen.
  if (domain === 'light' || domain === 'switch' || domain === 'input_boolean' || domain === 'fan') {
    if (state === 'on') return tr('common.on', 'On');
    if (state === 'off') return tr('common.off', 'Off');
    return state;
  }
  // Every domain that turns a raw state into words does it in its own module,
  // so a card, a hero, the status board, and the detail sheet cannot drift
  // apart — that drift is exactly how a robot read "Error" here and "Needs
  // help" on the tile beside it.
  if (domain === 'climate') return hvacModeLabel(state);
  if (domain === 'cover') return coverStateLabel(s);
  if (domain === 'lock') return lockStateLabel(s);
  if (domain === 'vacuum' || domain === 'lawn_mower') return vacuumStateLabel(s);
  if (domain === 'media_player') return mediaStateLabel(state);
  if (domain === 'weather') return weatherLabel(state);
  if (domain === 'alarm_control_panel') return alarmStateLabel(state);
  if (domain === 'person' || domain === 'device_tracker') {
    if (state === 'home') return tr('person.home', 'Home');
    if (state === 'not_home') return tr('person.away', 'Away');
    return prettifyId(state); // a zone name, which is the family's own word
  }

  return capitalize(state);
}

/** "68.9 – 73.1 °F" footer for sparkline min/max, sharing formatValue's
 *  unit and precision rules. One precision for both bounds (derived from
 *  the max) so the pair always reads aligned. */
export function formatHistoryRange(s: HAStateObject, min: number, max: number): string {
  const unit = s.attributes.unit_of_measurement;
  const precision = precisionFor(s, max);
  const lo = min.toFixed(precision);
  const hi = max.toFixed(precision);
  if (!unit) return `${lo} – ${hi}`;
  return `${lo} – ${hi}${unit.startsWith('°') ? '' : ' '}${unit}`;
}

/**
 * A computed number in the entity's own units — the day's average, a bucket
 * extreme — with the same precision rules formatValue applies to the live
 * state. `scaleFrom` picks the precision off a different number so a row of
 * stats (low / average / high) shares one, and 0.4 doesn't sit next to 3.
 */
export function formatMeasurement(
  s: HAStateObject, value: number, scaleFrom = value,
): string {
  const unit = s.attributes.unit_of_measurement;
  const text = value.toFixed(precisionFor(s, scaleFrom));
  if (!unit) return text;
  return `${text}${unit.startsWith('°') ? '' : ' '}${unit}`;
}

function precisionFor(s: HAStateObject, sample: number): number {
  return typeof s.attributes.suggested_display_precision === 'number'
    ? s.attributes.suggested_display_precision
    : pickDefaultPrecision(sample, s.attributes.unit_of_measurement ?? '');
}

function pickDefaultPrecision(n: number, unit: string): number {
  // Whole-number units get 0 decimals; temperatures and percents can have 1.
  if (unit === '%') return 0;
  if (unit.startsWith('°')) return Math.abs(n) >= 100 ? 0 : 1;
  if (unit === 'kW' || unit === 'kWh') return Math.abs(n) >= 10 ? 1 : 2;
  if (unit === 'W' || unit === 'Wh') return 0;
  if (Number.isInteger(n)) return 0;
  return 1;
}

// A binary sensor's two words depend entirely on its device class: "on" is
// Open for a door, Wet for a leak probe, and Low for a battery. Their own
// keys rather than the cover/lock ones — a door and a blind share the English
// word and part ways in languages that inflect it.
function formatBinarySensor(state: string, deviceClass?: string): string {
  const on = state === 'on';
  switch (deviceClass) {
    case 'door': case 'garage_door': case 'window': case 'opening':
      return on ? tr('binary.open', 'Open') : tr('binary.closed', 'Closed');
    case 'lock':
      return on ? tr('binary.unlocked', 'Unlocked') : tr('binary.locked', 'Locked');
    case 'moisture':
      return on ? tr('binary.wet', 'Wet') : tr('binary.dry', 'Dry');
    case 'motion': case 'occupancy': case 'presence': case 'moving': case 'vibration':
      return on ? tr('binary.motion', 'Detected') : tr('binary.noMotion', 'Clear');
    case 'smoke': case 'gas': case 'co': case 'safety': case 'tamper':
      return on ? tr('binary.alert', 'Alert') : tr('binary.clear', 'Clear');
    case 'battery':
      return on ? tr('binary.batteryLow', 'Low') : tr('binary.batteryNormal', 'Normal');
    case 'connectivity':
      return on ? tr('binary.online', 'Online') : tr('binary.offline', 'Offline');
    case 'plug':
      return on ? tr('binary.plugged', 'Plugged') : tr('binary.unplugged', 'Unplugged');
    case 'power':
      return on ? tr('common.on', 'On') : tr('common.off', 'Off');
    case 'problem':
      return on ? tr('binary.problem', 'Problem') : tr('binary.ok', 'OK');
    case 'update':
      return on ? tr('binary.updateAvailable', 'Available') : tr('binary.upToDate', 'Up to date');
    case 'running':
      return on ? tr('binary.running', 'Running') : tr('binary.stopped', 'Idle');
    default:
      return on ? tr('common.on', 'On') : tr('common.off', 'Off');
  }
}

/** HA's weather conditions as words. The card used to print the raw
 *  condition, so a partly cloudy day read "Partlycloudy". */
export function weatherLabel(condition: string): string {
  switch (condition) {
    case 'clear-night': return tr('weather.clearNight', 'Clear');
    case 'cloudy': return tr('weather.cloudy', 'Cloudy');
    case 'exceptional': return tr('weather.exceptional', 'Exceptional');
    case 'fog': return tr('weather.fog', 'Fog');
    case 'hail': return tr('weather.hail', 'Hail');
    case 'lightning': return tr('weather.lightning', 'Lightning');
    case 'lightning-rainy': return tr('weather.lightningRainy', 'Storms');
    case 'partlycloudy': return tr('weather.partlycloudy', 'Partly cloudy');
    case 'pouring': return tr('weather.pouring', 'Pouring');
    case 'rainy': return tr('weather.rainy', 'Rainy');
    case 'snowy': return tr('weather.snowy', 'Snowy');
    case 'snowy-rainy': return tr('weather.snowyRainy', 'Sleet');
    case 'sunny': return tr('weather.sunny', 'Sunny');
    // HA reports two windy conditions that mean the same thing to a family.
    case 'windy': case 'windy-variant': return tr('weather.windy', 'Windy');
    default: return capitalize(condition.replace(/-/g, ' '));
  }
}

/** Alarm panel states. No card of its own — these land on the generic tile. */
export function alarmStateLabel(state: string): string {
  switch (state) {
    case 'disarmed': return tr('alarm.disarmed', 'Disarmed');
    case 'armed_home': return tr('alarm.armedHome', 'Armed home');
    case 'armed_away': return tr('alarm.armedAway', 'Armed away');
    case 'armed_night': return tr('alarm.armedNight', 'Armed night');
    case 'armed_vacation': return tr('alarm.armedVacation', 'Armed vacation');
    case 'arming': return tr('alarm.arming', 'Arming…');
    case 'pending': return tr('alarm.pending', 'Pending…');
    case 'triggered': return tr('alarm.triggered', 'Triggered');
    default: return capitalize(state);
  }
}

export function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const delta = Math.max(0, now - t);
  const sec = Math.floor(delta / 1000);
  if (sec < 5) return tr('time.justNow', 'just now');
  if (sec < 60) return tr('time.secondsAgo', '{count}s ago', { count: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return tr('time.minutesAgo', '{count}m ago', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return tr('time.hoursAgo', '{count}h ago', { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return tr('time.daysAgo', '{count}d ago', { count: day });
  return new Date(t).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', timeZone: hostTimezone(),
  });
}

export function isActiveState(s: HAStateObject): boolean {
  if (s.state === 'unavailable' || s.state === 'unknown') return false;
  const domain = entityDomain(s.entity_id);
  if (domain === 'light' || domain === 'switch' || domain === 'fan'
    || domain === 'input_boolean' || domain === 'binary_sensor' || domain === 'automation') {
    return s.state === 'on';
  }
  if (domain === 'climate') return s.state !== 'off';
  if (domain === 'media_player') return s.state === 'playing' || s.state === 'paused' || s.state === 'buffering';
  if (domain === 'cover') return s.state === 'open' || s.state === 'opening';
  if (domain === 'lock') return s.state === 'unlocked';
  if (domain === 'vacuum' || domain === 'lawn_mower') {
    return s.state === 'cleaning' || s.state === 'mowing' || s.state === 'returning';
  }
  return false;
}

/** True if this binary sensor's current state warrants user attention. */
export function isAlertState(s: HAStateObject): boolean {
  if (entityDomain(s.entity_id) !== 'binary_sensor') return false;
  if (s.state !== 'on') return false;
  const dc = s.attributes.device_class;
  if (!dc) return false;
  return (
    dc === 'door' || dc === 'garage_door' || dc === 'window' || dc === 'opening'
    || dc === 'smoke' || dc === 'gas' || dc === 'co' || dc === 'safety'
    || dc === 'tamper' || dc === 'moisture' || dc === 'problem'
  );
}

/**
 * Richer one-line state description for the entity browser. Pulls in
 * domain-specific context the state word alone doesn't convey ("Heat ·
 * 70°→72°" rather than just "Heat"), and takes that word from formatValue
 * so the picker names an entity the way the card will.
 */
export function entityStateSummary(s: HAStateObject): string {
  if (s.state === 'unavailable' || s.state === 'unknown') return '—';
  const d = entityDomain(s.entity_id);
  const label = formatValue(s);

  if (d === 'light' && s.state === 'on' && typeof s.attributes.brightness === 'number') {
    return `${label} · ${Math.round((s.attributes.brightness / 255) * 100)}%`;
  }
  if (d === 'climate') {
    const cur = s.attributes.current_temperature;
    const target = s.attributes.temperature;
    if (cur != null && target != null) return `${label} · ${target}°→${cur}°`;
    if (target != null) {
      return `${label} · ${tr('card.target', 'target {temp}°', { temp: String(target) })}`;
    }
    return label;
  }
  if (d === 'media_player') {
    const title = s.attributes.media_title;
    if (title && (s.state === 'playing' || s.state === 'paused')) {
      return `${label} · ${title}`;
    }
    return label;
  }
  if (d === 'cover') {
    const pos = s.attributes.current_position;
    if (typeof pos === 'number' && s.state === 'open') {
      return tr('card.percentOpen', '{percent}% open', { percent: pos });
    }
    return label;
  }
  if (d === 'vacuum' || d === 'lawn_mower') {
    const battery = s.attributes.battery_level;
    if (typeof battery === 'number') return `${label} · ${Math.round(battery)}%`;
    return label;
  }
  if (d === 'fan' && s.state === 'on' && typeof s.attributes.percentage === 'number') {
    return `${label} · ${s.attributes.percentage}%`;
  }
  // Sensors / switches / everything else are just their formatted value.
  return label;
}

/** Battery sensor values that should render in red. */
export function batteryAlert(s: HAStateObject): boolean {
  if (s.attributes.device_class !== 'battery') return false;
  const n = Number(s.state);
  return !Number.isNaN(n) && n <= 20;
}
