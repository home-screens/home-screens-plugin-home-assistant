import { describe, expect, it } from 'vitest';
import { entityStateSummary, formatValue, possibleRawStates } from './utils';
import type { HAStateObject } from './types';

function stub(entityId: string, state = 'on', attributes: Record<string, unknown> = {}): HAStateObject {
  return {
    entity_id: entityId,
    state,
    attributes,
    last_changed: '2026-07-04T00:00:00Z',
    last_updated: '2026-07-04T00:00:00Z',
  };
}

describe('possibleRawStates', () => {
  it('enumerates on/off domains via the shared domain map', () => {
    expect(possibleRawStates(stub('binary_sensor.back_door', 'off', { device_class: 'safety' })))
      .toEqual(['on', 'off']);
    expect(possibleRawStates(stub('switch.fan'))).toEqual(['on', 'off']);
  });

  it('uses per-entity attributes where HA enumerates states', () => {
    expect(possibleRawStates(stub('climate.house', 'heat', { hvac_modes: ['off', 'heat', 'cool'] })))
      .toEqual(['off', 'heat', 'cool']);
    expect(possibleRawStates(stub('input_select.mode', 'day', { options: ['day', 'night', 'away'] })))
      .toEqual(['day', 'night', 'away']);
  });

  it('returns null when attributes are missing or malformed instead of guessing', () => {
    expect(possibleRawStates(stub('climate.house', 'heat'))).toBeNull();
    expect(possibleRawStates(stub('climate.house', 'heat', { hvac_modes: 'heat' }))).toBeNull();
    expect(possibleRawStates(stub('select.mode', 'a', { options: [1, 2] }))).toBeNull();
  });

  it('lists full lifecycle states for locks and covers', () => {
    expect(possibleRawStates(stub('lock.front', 'locked')))
      .toEqual(['locked', 'unlocked', 'locking', 'unlocking', 'jammed']);
    expect(possibleRawStates(stub('cover.garage', 'open')))
      .toEqual(['open', 'closed', 'opening', 'closing']);
  });

  it('returns null for numeric and free-form domains', () => {
    expect(possibleRawStates(stub('sensor.outdoor_temp', '72.5', { unit_of_measurement: '°F' }))).toBeNull();
    expect(possibleRawStates(stub('weather.home', 'partlycloudy'))).toBeNull();
  });
});

describe('formatValue', () => {
  // The hero views and the status board format through here while the card
  // calls vacuumStateLabel directly, so the same robot used to read "Error"
  // on one surface and "Needs help" on the other.
  it('gives robots the same plain words the card uses', () => {
    expect(formatValue(stub('vacuum.robot', 'error'))).toBe('Needs help');
    expect(formatValue(stub('vacuum.robot', 'returning'))).toBe('Heading back');
    expect(formatValue(stub('lawn_mower.yard', 'mowing'))).toBe('Mowing');
    expect(formatValue(stub('lawn_mower.yard', 'docked'))).toBe('Docked');
  });

  it('still shows unavailable robots as the shared em dash', () => {
    expect(formatValue(stub('vacuum.robot', 'unavailable'))).toBe('—');
  });

  // Same story for every other domain that turns a state into words: each
  // one owns its labels, and formatValue reads them rather than restating
  // the English a card would have shown.
  it('defers to each domain for its own words', () => {
    expect(formatValue(stub('light.kitchen', 'on'))).toBe('On');
    expect(formatValue(stub('switch.porch', 'off'))).toBe('Off');
    expect(formatValue(stub('cover.garage', 'open'))).toBe('Open');
    expect(formatValue(stub('cover.garage', 'opening'))).toBe('Opening…');
    expect(formatValue(stub('lock.front', 'jammed'))).toBe('Jammed');
    expect(formatValue(stub('climate.hall', 'heat_cool'))).toBe('Heat/Cool');
    expect(formatValue(stub('media_player.den', 'buffering'))).toBe('Buffering');
    expect(formatValue(stub('weather.home', 'partlycloudy'))).toBe('Partly cloudy');
    expect(formatValue(stub('alarm_control_panel.house', 'armed_away'))).toBe('Armed away');
  });

  it('names a person by where they are, and a zone by its own name', () => {
    expect(formatValue(stub('person.jamie', 'home'))).toBe('Home');
    expect(formatValue(stub('device_tracker.phone', 'not_home'))).toBe('Away');
    expect(formatValue(stub('person.jamie', 'grandmas_house'))).toBe('Grandmas House');
  });

  it('keeps the raw value recognizable for editor dropdowns', () => {
    // search.ts and RulesEditor render "<label> (<raw>)", so a label that
    // equals the raw value is dropped rather than doubled.
    expect(formatValue(stub('sensor.pressure', '1013', { unit_of_measurement: 'hPa' })))
      .toBe('1013 hPa');
    expect(formatValue(stub('vacuum.robot', 'shampooing'))).toBe('Shampooing');
  });

  it('gives a binary sensor the words its device class calls for', () => {
    const bs = (dc: string, state: string) =>
      formatValue(stub('binary_sensor.thing', state, { device_class: dc }));
    expect(bs('door', 'on')).toBe('Open');
    expect(bs('moisture', 'on')).toBe('Wet');
    expect(bs('motion', 'off')).toBe('Clear');
    expect(bs('battery', 'on')).toBe('Low');
    expect(bs('problem', 'off')).toBe('OK');
    expect(bs('update', 'off')).toBe('Up to date');
  });
});

describe('entityStateSummary', () => {
  // The editor's entity browser: same words as the card, plus the context
  // that makes one thermostat distinguishable from another in a long list.
  it('names an entity the way its card will, with the extra context', () => {
    expect(entityStateSummary(stub('climate.hall', 'heat', { temperature: 70, current_temperature: 72 })))
      .toBe('Heat · 70°→72°');
    expect(entityStateSummary(stub('climate.hall', 'heat', { temperature: 70 })))
      .toBe('Heat · target 70°');
    expect(entityStateSummary(stub('light.kitchen', 'on', { brightness: 128 })))
      .toBe('On · 50%');
    expect(entityStateSummary(stub('cover.garage', 'open', { current_position: 40 })))
      .toBe('40% open');
    expect(entityStateSummary(stub('media_player.den', 'playing', { media_title: 'Harvest Moon' })))
      .toBe('Playing · Harvest Moon');
    expect(entityStateSummary(stub('vacuum.robot', 'error', { battery_level: 30 })))
      .toBe('Needs help · 30%');
  });

  it('still shows unreachable entities as the em dash', () => {
    expect(entityStateSummary(stub('light.kitchen', 'unavailable'))).toBe('—');
  });
});
