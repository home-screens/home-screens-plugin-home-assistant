import { describe, expect, it } from 'vitest';
import { entityInteraction, NO_INTERACTION } from './interaction';
import { FAN_FEATURES } from './fan';
import { VACUUM_FEATURES, MOWER_FEATURES } from './vacuum';
import type { HAStateObject } from './types';

function ent(
  entity_id: string, state = 'on', attributes: Record<string, unknown> = {},
): HAStateObject {
  return {
    entity_id, state, attributes,
    last_changed: '2026-07-01T00:00:00Z', last_updated: '2026-07-01T00:00:00Z',
  };
}

describe('entityInteraction', () => {
  it('gives toggling domains a tap', () => {
    expect(entityInteraction(ent('light.kitchen'))).toEqual({
      tapService: 'toggle', opensSheet: true, guardedService: null,
    });
    expect(entityInteraction(ent('switch.desk')).tapService).toBe('toggle');
    expect(entityInteraction(ent('switch.desk')).opensSheet).toBe(false);
    expect(entityInteraction(ent('scene.movie')).tapService).toBe('turn_on');
    expect(entityInteraction(ent('media_player.kitchen')).tapService).toBe('media_play_pause');
    expect(entityInteraction(ent('cover.blinds', 'open')).tapService).toBe('toggle');
  });

  it('opens the climate sheet on the plain tap', () => {
    expect(entityInteraction(ent('climate.hall', 'heat'))).toEqual({
      tapService: null, opensSheet: true, guardedService: null,
    });
  });

  it('gates the fan sheet on speed support', () => {
    expect(entityInteraction(ent('fan.attic', 'on')).opensSheet).toBe(false);
    expect(entityInteraction(
      ent('fan.bedroom', 'on', { supported_features: FAN_FEATURES.SET_SPEED }),
    ).opensSheet).toBe(true);
  });

  it('makes a lock guarded and nothing else', () => {
    expect(entityInteraction(ent('lock.front', 'locked'))).toEqual({
      tapService: null, opensSheet: false, guardedService: 'unlock',
    });
    // A lock wanting a PIN we have no keypad for stays inert.
    expect(entityInteraction(ent('lock.gate', 'locked', { code_format: '\\d{4}' })))
      .toEqual(NO_INTERACTION);
    expect(entityInteraction(ent('lock.side', 'jammed')).guardedService).toBeNull();
  });

  it('picks the vacuum action from what the robot is doing', () => {
    const full = { supported_features: VACUUM_FEATURES.START | VACUUM_FEATURES.PAUSE };
    expect(entityInteraction(ent('vacuum.robby', 'docked', full)).tapService).toBe('start');
    expect(entityInteraction(ent('vacuum.robby', 'cleaning', full)).tapService).toBe('pause');
    // The mower's mask is its own — the vacuum's START bit means nothing here.
    expect(entityInteraction(ent('lawn_mower.yard', 'docked', full)).tapService).toBeNull();
    expect(entityInteraction(ent('lawn_mower.yard', 'docked', {
      supported_features: MOWER_FEATURES.START_MOWING | MOWER_FEATURES.PAUSE,
    })).tapService).toBe('start_mowing');
    // Stuck: no tap, but the sheet is still reachable to send it home.
    const stuck = entityInteraction(ent('vacuum.robby', 'error', full));
    expect(stuck.tapService).toBeNull();
    expect(stuck.opensSheet).toBe(true);
  });

  it('leaves read-only domains and unavailable entities inert', () => {
    for (const id of ['sensor.temp', 'binary_sensor.door', 'weather.home', 'person.dad']) {
      expect(entityInteraction(ent(id))).toEqual(NO_INTERACTION);
    }
    expect(entityInteraction(ent('light.kitchen', 'unavailable'))).toEqual(NO_INTERACTION);
  });
});
