// Pure vacuum helpers backing the vacuum card (cards.tsx) and its detail
// sheet (controls.tsx). Kept free of React so they can be unit-tested in the
// node environment (`tr` is a plain function that returns its English
// fallback with no window).
//
// Covers `lawn_mower` too: a mower is the same object on screen — a robot
// that is out working, paused, or parked — but HA gives it its own services
// and its own much smaller feature bitmask, so every lookup here takes the
// entity and branches, never a bare number.

import { tr } from './i18n';
import { entityDomain } from './types';
import type { HAStateObject } from './types';

// vacuum supported_features bits (HA VacuumEntityFeature). The deprecated
// TURN_ON / TURN_OFF / BATTERY bits are deliberately not read.
export const VACUUM_FEATURES = {
  PAUSE: 4,
  STOP: 8,
  RETURN_HOME: 16,
  FAN_SPEED: 32,
  LOCATE: 512,
  START: 8192,
} as const;

// lawn_mower supported_features bits (HA LawnMowerEntityFeature) — a
// separate, much smaller mask that reuses the same low bits for other
// things, which is why nothing here reads a bitmask without its domain.
export const MOWER_FEATURES = {
  START_MOWING: 1,
  PAUSE: 2,
  DOCK: 4,
} as const;

/** The actions a card or sheet can offer. `dock` is HA's return_to_base. */
export type VacuumAction = 'start' | 'pause' | 'stop' | 'dock' | 'locate';

export function isMower(s: HAStateObject): boolean {
  return entityDomain(s.entity_id) === 'lawn_mower';
}

/** A robot that is out doing its job. `returning` counts: it is still on the
 *  floor and still worth pausing. */
export function isRunning(s: HAStateObject): boolean {
  return s.state === 'cleaning' || s.state === 'mowing' || s.state === 'returning';
}

/** A missing or zero bitmask (older integrations, HA's own demo mower)
 *  defaults to the three every robot has. Falling back to nothing instead
 *  would leave a card with no action at all, which on a kiosk reads as a
 *  broken tile rather than as a limited one. */
function featureBits(s: HAStateObject): number {
  const f = s.attributes.supported_features;
  if (typeof f === 'number' && f > 0) return f;
  return isMower(s)
    ? MOWER_FEATURES.START_MOWING | MOWER_FEATURES.PAUSE | MOWER_FEATURES.DOCK
    : VACUUM_FEATURES.START | VACUUM_FEATURES.PAUSE | VACUUM_FEATURES.RETURN_HOME;
}

/** The feature bit an action needs, or 0 when the domain has no such action
 *  at all (a mower neither stops-in-place nor beeps to be found). */
function bitFor(s: HAStateObject, action: VacuumAction): number {
  if (isMower(s)) {
    switch (action) {
      case 'start': return MOWER_FEATURES.START_MOWING;
      case 'pause': return MOWER_FEATURES.PAUSE;
      case 'dock': return MOWER_FEATURES.DOCK;
      default: return 0;
    }
  }
  switch (action) {
    case 'start': return VACUUM_FEATURES.START;
    case 'pause': return VACUUM_FEATURES.PAUSE;
    case 'stop': return VACUUM_FEATURES.STOP;
    case 'dock': return VACUUM_FEATURES.RETURN_HOME;
    case 'locate': return VACUUM_FEATURES.LOCATE;
  }
}

export function supportsAction(s: HAStateObject, action: VacuumAction): boolean {
  const bit = bitFor(s, action);
  return bit !== 0 && (featureBits(s) & bit) !== 0;
}

/** The HA service an action maps to in this entity's domain, or null when
 *  the entity doesn't support it. The caller pairs it with the entity's own
 *  domain — `vacuum.start` vs `lawn_mower.start_mowing`. */
export function vacuumService(s: HAStateObject, action: VacuumAction): string | null {
  if (!supportsAction(s, action)) return null;
  if (isMower(s)) {
    switch (action) {
      case 'start': return 'start_mowing';
      case 'pause': return 'pause';
      case 'dock': return 'dock';
      default: return null;
    }
  }
  switch (action) {
    case 'start': return 'start';
    case 'pause': return 'pause';
    case 'stop': return 'stop';
    case 'dock': return 'return_to_base';
    case 'locate': return 'locate';
  }
}

/** Sheet button order, filtered to what the entity supports. Fixed order —
 *  the row must not reshuffle as the robot changes state, or the button
 *  under a finger becomes a different button mid-tap. */
export function vacuumActions(s: HAStateObject): VacuumAction[] {
  const all: VacuumAction[] = ['start', 'pause', 'stop', 'dock', 'locate'];
  return all.filter((a) => supportsAction(s, a));
}

/**
 * What a quick tap on the card should do. Running robots pause, parked ones
 * start. `error` (and anything indefinite) gets nothing: a robot that is
 * stuck under the couch needs a person, and guessing a direction there is
 * the same mistake as guessing at a jammed lock.
 */
export function vacuumTapAction(s: HAStateObject): VacuumAction | null {
  if (s.state === 'unavailable' || s.state === 'unknown' || s.state === 'error') return null;
  const wanted: VacuumAction = isRunning(s) ? 'pause' : 'start';
  return supportsAction(s, wanted) ? wanted : null;
}

/** 0–100 battery, or null when the integration publishes none. Newer HA
 *  moves this to a separate battery sensor — which the batteries view
 *  already finds — so its absence is normal, not an error. */
export function vacuumBattery(s: HAStateObject): number | null {
  const level = s.attributes.battery_level;
  if (typeof level !== 'number' || Number.isNaN(level)) return null;
  return Math.max(0, Math.min(100, Math.round(level)));
}

/** The named suction levels this robot offers, gated on the feature bit so a
 *  stale `fan_speed_list` on an entity that dropped the capability can't
 *  render pills whose service call HA would reject. */
export function fanSpeedList(s: HAStateObject): string[] {
  if (isMower(s)) return [];
  if ((featureBits(s) & VACUUM_FEATURES.FAN_SPEED) === 0) return [];
  const list = s.attributes.fan_speed_list;
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is string => typeof v === 'string' && v !== '');
}

export function currentFanSpeed(s: HAStateObject): string | null {
  const speed = s.attributes.fan_speed;
  return typeof speed === 'string' && speed !== '' ? speed : null;
}

/** Integration-authored speed names ("max+", "Silent", "quiet_mode") shown
 *  as words. Untranslatable by nature — they come from the robot. */
export function fanSpeedLabel(speed: string): string {
  const words = speed.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The card's big value: what the robot is doing, in plain words. */
export function vacuumStateLabel(s: HAStateObject): string {
  switch (s.state) {
    case 'cleaning': return tr('vacuum.cleaning', 'Cleaning');
    case 'mowing': return tr('vacuum.mowing', 'Mowing');
    case 'docked': return tr('vacuum.docked', 'Docked');
    case 'idle': return tr('vacuum.idle', 'Idle');
    case 'paused': return tr('vacuum.paused', 'Paused');
    case 'returning': return tr('vacuum.returning', 'Heading back');
    case 'error': return tr('vacuum.error', 'Needs help');
    case 'unavailable': case 'unknown': case '':
      return tr('common.unavailable', 'Unavailable');
    default:
      return s.state.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
}

/** "Cleaning · 72%" header line for the detail sheet. */
export function vacuumStateLine(s: HAStateObject): string {
  const label = vacuumStateLabel(s);
  const battery = vacuumBattery(s);
  if (battery == null) return label;
  return `${label} · ${battery}%`;
}
