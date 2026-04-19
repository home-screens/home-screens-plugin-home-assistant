// Formatters + entity helpers. Zero template strings for the user to learn —
// this is the file that turns raw HA state into glanceable text.

import type { HAStateObject } from './types';
import { entityDomain } from './types';

export { entityDomain };

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
  if (domain === 'light' || domain === 'switch' || domain === 'input_boolean' || domain === 'fan') {
    return state === 'on' ? 'On' : state === 'off' ? 'Off' : state;
  }
  if (domain === 'climate') {
    return capitalize(state);
  }
  if (domain === 'cover') {
    return capitalize(state); // open / closed / opening / closing
  }
  if (domain === 'lock') {
    return capitalize(state); // locked / unlocked / jammed
  }
  if (domain === 'person') {
    return state === 'home' ? 'Home' : state === 'not_home' ? 'Away' : prettifyId(state);
  }

  return capitalize(state);
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

function formatBinarySensor(state: string, deviceClass?: string): string {
  const on = state === 'on';
  switch (deviceClass) {
    case 'door': case 'garage_door': case 'window': case 'opening':
      return on ? 'Open' : 'Closed';
    case 'lock': return on ? 'Unlocked' : 'Locked';
    case 'moisture': return on ? 'Wet' : 'Dry';
    case 'motion': case 'occupancy': case 'presence': case 'moving': case 'vibration':
      return on ? 'Detected' : 'Clear';
    case 'smoke': case 'gas': case 'co': case 'safety': case 'tamper':
      return on ? 'Alert' : 'Clear';
    case 'battery': return on ? 'Low' : 'Normal';
    case 'connectivity': return on ? 'Online' : 'Offline';
    case 'plug': return on ? 'Plugged' : 'Unplugged';
    case 'power': return on ? 'On' : 'Off';
    case 'problem': return on ? 'Problem' : 'OK';
    case 'update': return on ? 'Available' : 'Up to date';
    case 'running': return on ? 'Running' : 'Idle';
    default: return on ? 'On' : 'Off';
  }
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const delta = Math.max(0, now - t);
  const sec = Math.floor(delta / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
 * Richer one-line state description for the entity browser / status board.
 * Pulls in domain-specific context the raw state alone doesn't convey
 * ("heat · 70°→72°" rather than just "heat").
 */
export function entityStateSummary(s: HAStateObject): string {
  if (s.state === 'unavailable' || s.state === 'unknown') return '—';
  const d = entityDomain(s.entity_id);

  if (d === 'light' && s.state === 'on' && typeof s.attributes.brightness === 'number') {
    return `on · ${Math.round((s.attributes.brightness / 255) * 100)}%`;
  }
  if (d === 'climate') {
    const cur = s.attributes.current_temperature;
    const target = s.attributes.temperature;
    if (cur != null && target != null) return `${s.state} · ${target}°→${cur}°`;
    if (target != null) return `${s.state} · target ${target}°`;
    return s.state;
  }
  if (d === 'media_player') {
    const title = s.attributes.media_title;
    if (title && (s.state === 'playing' || s.state === 'paused')) {
      return `${s.state} · ${title}`;
    }
    return s.state;
  }
  if (d === 'cover') {
    const pos = s.attributes.current_position;
    if (typeof pos === 'number' && s.state === 'open') return `${pos}% open`;
    return s.state;
  }
  if (d === 'fan' && s.state === 'on' && typeof s.attributes.percentage === 'number') {
    return `on · ${s.attributes.percentage}%`;
  }
  // Fall back to the display-formatted value for sensors / switches / etc.
  return formatValue(s);
}

/** Battery sensor values that should render in red. */
export function batteryAlert(s: HAStateObject): boolean {
  if (s.attributes.device_class !== 'battery') return false;
  const n = Number(s.state);
  return !Number.isNaN(n) && n <= 20;
}
