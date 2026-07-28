// Pure lock helpers backing the hold-to-run card action (cards.tsx).
// Kept free of React so they can be unit-tested in the node environment
// (`tr` is a plain function that returns its English fallback with no window).

import { tr } from './i18n';
import type { HAStateObject } from './types';

/** True when HA expects a code with lock/unlock. We have no keypad yet, so
 *  a coded lock gets no card action at all — offering one would fire a
 *  service call HA rejects, which on a kiosk reads as "the tile is broken". */
export function lockNeedsCode(s: HAStateObject): boolean {
  return typeof s.attributes.code_format === 'string'
    && s.attributes.code_format.trim() !== '';
}

/**
 * The service a hold on this lock should fire, or null when there isn't an
 * unambiguous one. `locking`/`unlocking` are mid-motion and `jammed` means
 * the bolt didn't move — guessing a direction there is worse than leaving
 * the card inert until it settles.
 */
export function lockService(s: HAStateObject): 'lock' | 'unlock' | null {
  if (lockNeedsCode(s)) return null;
  if (s.state === 'locked') return 'unlock';
  if (s.state === 'unlocked') return 'lock';
  return null;
}

/** What the bolt is doing, in plain words. The one place lock states become
 *  text, so a card, a hero, and the status board can't disagree. */
export function lockStateLabel(s: HAStateObject): string {
  switch (s.state) {
    case 'locked': return tr('lock.locked', 'Locked');
    case 'unlocked': return tr('lock.unlocked', 'Unlocked');
    case 'jammed': return tr('lock.jammed', 'Jammed');
    case 'locking': return tr('lock.locking', 'Locking…');
    case 'unlocking': return tr('lock.unlocking', 'Unlocking…');
    case 'unavailable': case 'unknown': case '':
      return tr('common.unavailable', 'Unavailable');
    default:
      return s.state.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
}

/** Card hint for the action a hold would run; null when there is none. */
export function lockActionLabel(s: HAStateObject): string | null {
  const service = lockService(s);
  if (!service) return null;
  return service === 'lock'
    ? tr('lock.holdToLock', 'Hold to lock')
    : tr('lock.holdToUnlock', 'Hold to unlock');
}
