// Which entities each view can draw, and how many of them it draws.
//
// The views have always known this, but only implicitly: ClimateView calls
// find(domain === 'climate'), EntityCardView renders states[0] and drops the
// rest, PowerView asks pickPowerEntity. None of that reaches the editor, so
// the entity browser offers all 500 entities for every view and then throws
// most of the answer away without saying so.
//
// This is that knowledge as one table. Two separate facts live here:
//
//   accepts — what the view can render at all. A media player on the climate
//             view is not a weak choice, it is invisible.
//   max     — how many accepted entities it actually draws. The single-widget
//             views take one, and the editor turns that into a radio rather
//             than letting somebody tick eight and see one.
//
// Predicates are imported from the modules that own them (isPowerSensor,
// batteryLevel) rather than restated, so the browser and the renderer cannot
// disagree about what qualifies. view-entities.test.ts pins the rest by
// checking this table's pick against what each view really does.

import type { HAStateObject, HAView } from './types';
import { entityDomain } from './types';
import { isPowerSensor } from './power';
import { batteryLevel } from './batteries';

export interface ViewEntitySpec {
  /** Entities this view can render. */
  accepts: (s: HAStateObject) => boolean;
  /** Among accepted entities, the ones it reaches for first. Only meaningful
   *  where `max` is 1 — it is the difference between "a sensor" and "the
   *  power sensor". */
  prefers?: (s: HAStateObject) => boolean;
  /** How many accepted entities the view draws. */
  max: 1 | 'many';
  /**
   * What to call the accepted set in the editor, e.g. "Media players". Absent
   * means the view accepts anything, which is also how the editor decides
   * whether to offer the "Show everything" escape at all.
   */
  label?: string;
}

const ANYTHING = () => true;
const inDomain = (domain: string) => (s: HAStateObject) =>
  entityDomain(s.entity_id) === domain;

export const VIEW_ENTITIES: Record<HAView, ViewEntitySpec> = {
  // The general-purpose views: whatever you pick, in the order you picked it.
  'card-grid': { accepts: ANYTHING, max: 'many' },
  'status-board': { accepts: ANYTHING, max: 'many' },
  room: { accepts: ANYTHING, max: 'many' },
  // One widget, one entity. views.tsx reads states[0] and ignores the rest.
  'entity-card': { accepts: ANYTHING, max: 1 },
  'entity-row': { accepts: ANYTHING, max: 1 },
  climate: { accepts: inDomain('climate'), label: 'Thermostats', max: 1 },
  media: { accepts: inDomain('media_player'), label: 'Media players', max: 1 },
  cameras: { accepts: inDomain('camera'), label: 'Cameras', max: 'many' },
  // Any sensor is drawable — the big number, the day chart, and the low /
  // average / high read correctly for water flow or CO2 as well. A real power
  // sensor just wins when both are picked (power.ts).
  power: {
    accepts: inDomain('sensor'), prefers: isPowerSensor,
    label: 'Sensors', max: 1,
  },
  // The three self-sourced views. Nothing in the editor browses entities for
  // them (batteries scans every state for a battery level; buttons and alerts
  // have their own row editors), but the table answers for all twelve views
  // so adding one cannot skip the question.
  batteries: {
    accepts: (s) => batteryLevel(s) !== null,
    label: 'Battery sensors', max: 'many',
  },
  buttons: { accepts: ANYTHING, max: 'many' },
  alerts: { accepts: ANYTHING, max: 'many' },
};

/** True when the view draws anything you give it, so the editor has no reason
 *  to filter the browser or offer a way back to the full list. */
export function acceptsAnything(view: HAView): boolean {
  return VIEW_ENTITIES[view].accepts === ANYTHING;
}

/**
 * The entities a view will actually draw, given a selection in config order.
 *
 * `states` is expected in the order the user picked them, which is what
 * index.tsx hands the views — so "the first accepted one" here is the same
 * entity the view itself lands on.
 */
export function entitiesForView(
  view: HAView, states: HAStateObject[],
): HAStateObject[] {
  const spec = VIEW_ENTITIES[view];
  const eligible = states.filter(spec.accepts);
  if (spec.max !== 1) return eligible;
  const first = (spec.prefers && eligible.find(spec.prefers)) ?? eligible[0];
  return first ? [first] : [];
}

/** The picked entity ids this view has no use for — wrong kind, or past the
 *  one it draws. Ids Home Assistant no longer reports count as unused, which
 *  is true: nothing renders for them either. */
export function unusedEntityIds(
  view: HAView, picked: string[], states: HAStateObject[],
): string[] {
  const byId = new Map(states.map((s) => [s.entity_id, s]));
  const present = picked
    .map((id) => byId.get(id))
    .filter((s): s is HAStateObject => Boolean(s));
  const used = new Set(entitiesForView(view, present).map((s) => s.entity_id));
  return picked.filter((id) => !used.has(id));
}
