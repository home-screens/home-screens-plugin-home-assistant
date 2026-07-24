// Pure model for the `batteries` view: which entities count as batteries,
// what a level means, and the sorted list the view renders. No React, no
// fetch — the view is a render of whatever the regular states poll already
// returned, so this whole feature costs no extra API calls.

import type { HAStateObject } from './types';
import { entityDomain } from './types';
import { friendlyName } from './utils';

/** At or below this, the device needs charging now (red). */
export const BATTERY_LOW_PCT = 20;
/** At or below this, it's worth knowing about on the next pass (amber). */
export const BATTERY_WARN_PCT = 40;

export type BatteryTone = 'low' | 'warn' | 'ok';

export interface BatteryEntry {
  state: HAStateObject;
  /** 0–100, clamped. */
  level: number;
}

/**
 * Percent level for a battery sensor, or null when this isn't one. HA marks
 * every battery reading with `device_class: battery` on a `sensor` entity;
 * the `binary_sensor` flavor (on = low) carries no level and stays with the
 * normal cards, where it already renders in the alert tone.
 */
export function batteryLevel(s: HAStateObject): number | null {
  if (s.attributes.device_class !== 'battery') return null;
  if (entityDomain(s.entity_id) !== 'sensor') return null;
  const n = Number(s.state);
  // Covers unavailable/unknown/'' too — none of them parse.
  if (s.state.trim() === '' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

export function batteryTone(level: number): BatteryTone {
  if (level <= BATTERY_LOW_PCT) return 'low';
  if (level <= BATTERY_WARN_PCT) return 'warn';
  return 'ok';
}

/**
 * Every battery sensor in the poll, emptiest first — the whole point of the
 * view is that the one about to die is at the top. Ties break by name so the
 * list doesn't reshuffle between polls when several sit at 100%.
 */
export function collectBatteries(states: HAStateObject[]): BatteryEntry[] {
  const entries: BatteryEntry[] = [];
  for (const state of states) {
    const level = batteryLevel(state);
    if (level !== null) entries.push({ state, level });
  }
  entries.sort((a, b) => (
    a.level - b.level || friendlyName(a.state).localeCompare(friendlyName(b.state))
  ));
  return entries;
}

/** How many need charging now — the summary line's number. */
export function countNeedingCharge(entries: BatteryEntry[]): number {
  return entries.filter((e) => e.level <= BATTERY_LOW_PCT).length;
}
