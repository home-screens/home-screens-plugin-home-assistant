// What touching an entity does — one answer for every surface that shows it.
//
// This used to live inside cards.tsx's router, which meant the hero views
// (entity card, entity row) had no way to offer the same gestures without
// restating the rules. Keeping the decision here and the rendering in the
// views means a domain gains its behavior everywhere at once, and "what does
// tapping a vacuum do" has exactly one answer to read.
//
// The gesture contract every consumer implements:
//   tapService + opensSheet → quick tap runs the service, hold opens the sheet
//   opensSheet alone        → plain tap opens the sheet (nothing to protect)
//   tapService alone        → plain tap runs the service
//   guardedService          → 1s deliberate hold, with a sweep; no tap at all

import { entityDomain } from './types';
import type { HAStateObject } from './types';
import { supportsSpeed } from './fan';
import { lockService } from './lock';
import { vacuumActions, vacuumService, vacuumTapAction } from './vacuum';

export interface EntityInteraction {
  /** Service a quick tap fires, relative to the entity's own domain. */
  tapService: string | null;
  /** Whether a detail sheet exists and is worth opening for this entity. */
  opensSheet: boolean;
  /** A service that must not fire by accident (locks): 1s hold-to-run. */
  guardedService: string | null;
}

/** Reacts to nothing. Also the value a view uses when controls are off, so
 *  its gesture wiring is one shape instead of a pile of optional checks. */
export const NO_INTERACTION: EntityInteraction = {
  tapService: null, opensSheet: false, guardedService: null,
};

/**
 * The gestures this entity offers. Read-only domains (sensors, weather,
 * people) return NO_INTERACTION — tapping them should do nothing at all, which is
 * itself a promise: a card that never reacts is a card nobody keeps poking.
 */
export function entityInteraction(state: HAStateObject): EntityInteraction {
  if (state.state === 'unavailable') return NO_INTERACTION;
  switch (entityDomain(state.entity_id)) {
    case 'light':
      return { tapService: 'toggle', opensSheet: true, guardedService: null };
    case 'cover':
      return { tapService: 'toggle', opensSheet: true, guardedService: null };
    case 'fan':
      // A fan with no speed to set has an empty sheet, and wiring the hold
      // would cost the tap-toggle the gesture that opens it.
      return { tapService: 'toggle', opensSheet: supportsSpeed(state), guardedService: null };
    case 'switch': case 'input_boolean': case 'automation':
      return { tapService: 'toggle', opensSheet: false, guardedService: null };
    case 'scene':
      return { tapService: 'turn_on', opensSheet: false, guardedService: null };
    case 'media_player':
      return { tapService: 'media_play_pause', opensSheet: false, guardedService: null };
    case 'climate':
      // No tap action to protect, so the sheet takes the plain tap.
      return { tapService: null, opensSheet: true, guardedService: null };
    case 'lock':
      return { tapService: null, opensSheet: false, guardedService: lockService(state) };
    case 'vacuum': case 'lawn_mower': {
      const action = vacuumTapAction(state);
      return {
        tapService: action ? vacuumService(state, action) : null,
        opensSheet: vacuumActions(state).length > 0,
        guardedService: null,
      };
    }
    default:
      return NO_INTERACTION;
  }
}
