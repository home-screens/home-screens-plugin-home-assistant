import { describe, expect, it } from 'vitest';
import {
  VACUUM_FEATURES, MOWER_FEATURES, isMower, isRunning, supportsAction,
  vacuumService, vacuumActions, vacuumTapAction, vacuumBattery,
  fanSpeedList, currentFanSpeed, fanSpeedLabel,
  vacuumStateLabel, vacuumStateLine,
} from './vacuum';
import type { HAStateObject } from './types';

const FULL = VACUUM_FEATURES.START | VACUUM_FEATURES.PAUSE | VACUUM_FEATURES.STOP
  | VACUUM_FEATURES.RETURN_HOME | VACUUM_FEATURES.FAN_SPEED | VACUUM_FEATURES.LOCATE;

function vac(attributes: Record<string, unknown> = {}, state = 'docked'): HAStateObject {
  return {
    entity_id: 'vacuum.robby', state,
    attributes: { friendly_name: 'Robby', supported_features: FULL, ...attributes },
    last_changed: '2026-07-01T00:00:00Z', last_updated: '2026-07-01T00:00:00Z',
  };
}

function mower(attributes: Record<string, unknown> = {}, state = 'docked'): HAStateObject {
  return {
    entity_id: 'lawn_mower.yard', state,
    attributes: {
      friendly_name: 'Yard Mower',
      supported_features: MOWER_FEATURES.START_MOWING | MOWER_FEATURES.PAUSE | MOWER_FEATURES.DOCK,
      ...attributes,
    },
    last_changed: '2026-07-01T00:00:00Z', last_updated: '2026-07-01T00:00:00Z',
  };
}

describe('isMower / isRunning', () => {
  it('separates the two domains', () => {
    expect(isMower(mower())).toBe(true);
    expect(isMower(vac())).toBe(false);
  });

  it('counts a robot on its way home as still out', () => {
    expect(isRunning(vac({}, 'cleaning'))).toBe(true);
    expect(isRunning(mower({}, 'mowing'))).toBe(true);
    expect(isRunning(vac({}, 'returning'))).toBe(true);
    expect(isRunning(vac({}, 'paused'))).toBe(false);
    expect(isRunning(vac({}, 'docked'))).toBe(false);
  });
});

describe('supportsAction', () => {
  it('reads the vacuum bits', () => {
    expect(supportsAction(vac({ supported_features: VACUUM_FEATURES.LOCATE }), 'locate')).toBe(true);
    expect(supportsAction(vac({ supported_features: VACUUM_FEATURES.LOCATE }), 'stop')).toBe(false);
  });

  it('reads the mower bits, which reuse the same low numbers', () => {
    // 4 is DOCK on a mower and STOP on a vacuum.
    const parked = mower({ supported_features: MOWER_FEATURES.DOCK });
    expect(supportsAction(parked, 'dock')).toBe(true);
    expect(supportsAction(parked, 'start')).toBe(false);
    expect(supportsAction(vac({ supported_features: VACUUM_FEATURES.STOP }), 'stop')).toBe(true);
  });

  it('gives a mower no stop or locate at all', () => {
    expect(supportsAction(mower({ supported_features: 0xffff }), 'stop')).toBe(false);
    expect(supportsAction(mower({ supported_features: 0xffff }), 'locate')).toBe(false);
  });

  it('falls back to start/pause/dock when the mask is missing or zero', () => {
    for (const s of [vac({ supported_features: undefined }), vac({ supported_features: 0 })]) {
      expect(supportsAction(s, 'start')).toBe(true);
      expect(supportsAction(s, 'pause')).toBe(true);
      expect(supportsAction(s, 'dock')).toBe(true);
      expect(supportsAction(s, 'stop')).toBe(false);
      expect(supportsAction(s, 'locate')).toBe(false);
    }
    expect(supportsAction(mower({ supported_features: undefined }), 'start')).toBe(true);
  });
});

describe('vacuumService', () => {
  it('maps each action to its vacuum service', () => {
    expect(vacuumService(vac(), 'start')).toBe('start');
    expect(vacuumService(vac(), 'pause')).toBe('pause');
    expect(vacuumService(vac(), 'stop')).toBe('stop');
    expect(vacuumService(vac(), 'dock')).toBe('return_to_base');
    expect(vacuumService(vac(), 'locate')).toBe('locate');
  });

  it('maps a mower to its own services', () => {
    expect(vacuumService(mower(), 'start')).toBe('start_mowing');
    expect(vacuumService(mower(), 'pause')).toBe('pause');
    expect(vacuumService(mower(), 'dock')).toBe('dock');
    expect(vacuumService(mower(), 'stop')).toBeNull();
    expect(vacuumService(mower(), 'locate')).toBeNull();
  });

  it('returns null for an action the entity does not advertise', () => {
    expect(vacuumService(vac({ supported_features: VACUUM_FEATURES.START }), 'locate')).toBeNull();
  });
});

describe('vacuumActions', () => {
  it('keeps a fixed order and drops the unsupported', () => {
    expect(vacuumActions(vac())).toEqual(['start', 'pause', 'stop', 'dock', 'locate']);
    expect(vacuumActions(mower())).toEqual(['start', 'pause', 'dock']);
    expect(vacuumActions(vac({
      supported_features: VACUUM_FEATURES.START | VACUUM_FEATURES.RETURN_HOME,
    }))).toEqual(['start', 'dock']);
  });
});

describe('vacuumTapAction', () => {
  it('pauses a robot that is out and starts one that is parked', () => {
    expect(vacuumTapAction(vac({}, 'cleaning'))).toBe('pause');
    expect(vacuumTapAction(vac({}, 'returning'))).toBe('pause');
    expect(vacuumTapAction(mower({}, 'mowing'))).toBe('pause');
    expect(vacuumTapAction(vac({}, 'docked'))).toBe('start');
    expect(vacuumTapAction(vac({}, 'idle'))).toBe('start');
    expect(vacuumTapAction(vac({}, 'paused'))).toBe('start');
  });

  it('leaves a stuck or offline robot alone', () => {
    expect(vacuumTapAction(vac({}, 'error'))).toBeNull();
    expect(vacuumTapAction(vac({}, 'unavailable'))).toBeNull();
    expect(vacuumTapAction(vac({}, 'unknown'))).toBeNull();
  });

  it('offers nothing when the matching action is unsupported', () => {
    const noPause = vac({ supported_features: VACUUM_FEATURES.START }, 'cleaning');
    expect(vacuumTapAction(noPause)).toBeNull();
    const noStart = vac({ supported_features: VACUUM_FEATURES.PAUSE }, 'docked');
    expect(vacuumTapAction(noStart)).toBeNull();
  });
});

describe('vacuumBattery', () => {
  it('rounds and clamps, and reports nothing when absent', () => {
    expect(vacuumBattery(vac({ battery_level: 72.4 }))).toBe(72);
    expect(vacuumBattery(vac({ battery_level: 140 }))).toBe(100);
    expect(vacuumBattery(vac({ battery_level: -3 }))).toBe(0);
    expect(vacuumBattery(vac())).toBeNull();
    expect(vacuumBattery(vac({ battery_level: '72' }))).toBeNull();
  });
});

describe('fan speeds', () => {
  it('lists named speeds only with the feature bit', () => {
    expect(fanSpeedList(vac({ fan_speed_list: ['quiet', 'balanced', 'max'] })))
      .toEqual(['quiet', 'balanced', 'max']);
    expect(fanSpeedList(vac({
      supported_features: VACUUM_FEATURES.START, fan_speed_list: ['quiet', 'max'],
    }))).toEqual([]);
    expect(fanSpeedList(vac())).toEqual([]);
    expect(fanSpeedList(mower({ fan_speed_list: ['quiet'] }))).toEqual([]);
  });

  it('drops junk entries from the list', () => {
    expect(fanSpeedList(vac({ fan_speed_list: ['quiet', '', 3, null, 'max'] })))
      .toEqual(['quiet', 'max']);
  });

  it('reads the live speed and prettifies names', () => {
    expect(currentFanSpeed(vac({ fan_speed: 'balanced' }))).toBe('balanced');
    expect(currentFanSpeed(vac({ fan_speed: '' }))).toBeNull();
    expect(currentFanSpeed(vac())).toBeNull();
    expect(fanSpeedLabel('max+')).toBe('Max+');
    expect(fanSpeedLabel('quiet_mode')).toBe('Quiet mode');
  });
});

describe('vacuumStateLabel / vacuumStateLine', () => {
  it('says what the robot is doing in plain words', () => {
    expect(vacuumStateLabel(vac({}, 'cleaning'))).toBe('Cleaning');
    expect(vacuumStateLabel(mower({}, 'mowing'))).toBe('Mowing');
    expect(vacuumStateLabel(vac({}, 'returning'))).toBe('Heading back');
    expect(vacuumStateLabel(vac({}, 'error'))).toBe('Needs help');
    expect(vacuumStateLabel(vac({}, 'unavailable'))).toBe('Unavailable');
  });

  it('prettifies a state no domain enumerates', () => {
    expect(vacuumStateLabel(vac({}, 'returning_to_base'))).toBe('Returning to base');
  });

  it('appends the battery when there is one', () => {
    expect(vacuumStateLine(vac({ battery_level: 72 }, 'cleaning'))).toBe('Cleaning · 72%');
    expect(vacuumStateLine(vac({}, 'docked'))).toBe('Docked');
  });
});
