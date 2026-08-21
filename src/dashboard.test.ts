import { autoDashboardEntities } from './dashboard';
import { describe, expect, it } from 'vitest';
import type { HAStateObject, HAArea } from './types';
import {
  groupByArea, sectionStats, partitionHero, lockSummary, peopleSummary,
  houseClimate, tileTone, tileStateLine, dailyForecast, parseForecastResponse,
  initials, formatDegrees,
} from './dashboard';

const state = (entity_id: string, s: string, attributes: Record<string, unknown> = {}): HAStateObject => ({
  entity_id, state: s, attributes, last_changed: '2026-07-26T10:00:00Z', last_updated: '2026-07-26T10:00:00Z',
});

const lamp = state('light.lamp', 'on', { friendly_name: 'Floor lamp', brightness: 178 });
const kitchenLight = state('light.kitchen', 'off', { friendly_name: 'Ceiling' });
const temp = state('sensor.living_temp', '71.8', { device_class: 'temperature', unit_of_measurement: '°F', state_class: 'measurement' });
const hum = state('sensor.living_hum', '46', { device_class: 'humidity', unit_of_measurement: '%' });
const motion = state('binary_sensor.kitchen_motion', 'on', { device_class: 'motion' });
const door = state('binary_sensor.front_door', 'on', { device_class: 'door', friendly_name: 'Front door' });
const frontLock = state('lock.front', 'locked', { friendly_name: 'Front door' });
const backLock = state('lock.back', 'unlocked', { friendly_name: 'Back door' });
const jamie = state('person.jamie', 'home', { friendly_name: 'Jamie Lee' });
const emma = state('person.emma', 'school', { friendly_name: 'Emma' });
const weather = state('weather.home', 'sunny', { temperature: 81.4, humidity: 48 });
const FORECAST = [
    { datetime: '2026-07-27T06:00:00Z', temperature: 84.2 },
    { datetime: '2026-07-27T18:00:00Z', temperature: 80 },
    { datetime: '2026-07-28T06:00:00Z', temperature: 79 },
    { datetime: '2026-07-29T06:00:00Z', temperature: 75 },
    { datetime: '2026-07-30T06:00:00Z', temperature: 77 },
    { datetime: '2026-07-31T06:00:00Z', temperature: 80 },
    { datetime: '2026-08-01T06:00:00Z', temperature: 82 },
];
const power = state('sensor.house_power', '1840', { device_class: 'power', unit_of_measurement: 'W', state_class: 'measurement' });
const movie = state('scene.movie', 'unknown', { friendly_name: 'Movie Night' });

const AREAS: HAArea[] = [
  { area_id: 'living', name: 'Living room', entities: ['light.lamp', 'sensor.living_temp', 'sensor.living_hum', 'person.jamie'] },
  { area_id: 'kitchen', name: 'Kitchen', entities: ['light.kitchen', 'binary_sensor.kitchen_motion'] },
  { area_id: 'empty', name: 'Attic', entities: ['light.attic'] },
];

describe('groupByArea', () => {
  it('makes one section per area with members, then Other for the rest', () => {
    const sections = groupByArea([lamp, kitchenLight, temp, door, frontLock], AREAS);
    expect(sections.map((s) => s.title)).toEqual(['Living room', 'Kitchen', 'Other']);
    expect(sections[0].entities.map((s) => s.entity_id)).toEqual(['light.lamp', 'sensor.living_temp']);
    expect(sections[2].entities.map((s) => s.entity_id)).toEqual(['binary_sensor.front_door', 'lock.front']);
  });

  it('narrows to one area and hides everything outside it', () => {
    const sections = groupByArea([lamp, kitchenLight, door], AREAS, 'kitchen');
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe('Kitchen');
    expect(sections[0].entities).toEqual([kitchenLight]);
  });

  it('leaves the lone section untitled when there are no areas at all', () => {
    expect(groupByArea([lamp, door], undefined)).toEqual([{ title: null, entities: [lamp, door] }]);
    expect(groupByArea([lamp, door], [])).toEqual([{ title: null, entities: [lamp, door] }]);
  });

  it('is empty when the chosen area matches nothing', () => {
    expect(groupByArea([lamp, door], AREAS, 'nope')).toEqual([]);
    expect(groupByArea([lamp, door], undefined, 'kitchen')).toEqual([]);
    expect(groupByArea([door], AREAS, 'kitchen')).toEqual([]);
  });

  it('never lists an entity twice when two areas claim it', () => {
    const areas: HAArea[] = [
      { area_id: 'a', name: 'A', entities: ['light.lamp'] },
      { area_id: 'b', name: 'B', entities: ['light.lamp'] },
    ];
    const sections = groupByArea([lamp], areas);
    expect(sections).toEqual([{ title: 'A', entities: [lamp] }]);
  });
});

describe('sectionStats', () => {
  it('finds the first temperature and humidity sensor and any presence', () => {
    const stats = sectionStats([lamp, temp, hum, motion]);
    expect(stats.temperature).toBe(temp);
    expect(stats.humidity).toBe(hum);
    expect(stats.presence).toBe(true);
  });

  it('ignores sensors without a numeric reading', () => {
    const broken = state('sensor.t', 'unavailable', { device_class: 'temperature' });
    expect(sectionStats([broken]).temperature).toBeNull();
  });

  it('treats a °C unit as temperature even without a device class', () => {
    const probe = state('sensor.probe', '21.5', { unit_of_measurement: '°C' });
    expect(sectionStats([probe]).temperature).toBe(probe);
  });

  it('does not count a motion sensor that is clear', () => {
    expect(sectionStats([{ ...motion, state: 'off' }]).presence).toBe(false);
  });
});

describe('partitionHero', () => {
  it('claims weather, people, the first power sensor, and scenes', () => {
    const p = partitionHero([lamp, weather, jamie, emma, power, movie, door]);
    expect(p.weather).toBe(weather);
    expect(p.people).toEqual([jamie, emma]);
    expect(p.power).toBe(power);
    expect(p.scenes).toEqual([movie]);
    expect(p.rest).toEqual([lamp, door]);
  });

  it('claims only the first power sensor; the second stays a room tile', () => {
    const solar = state('sensor.solar', '900', { device_class: 'power', unit_of_measurement: 'W' });
    const p = partitionHero([lamp, power, solar]);
    expect(p.power).toBe(power);
    expect(p.rest).toEqual([lamp, solar]);
  });

  it('leaves everything in the rooms when nothing qualifies', () => {
    const p = partitionHero([lamp, door]);
    expect(p.weather).toBeNull();
    expect(p.power).toBeNull();
    expect(p.rest).toEqual([lamp, door]);
  });
});

describe('lockSummary', () => {
  it('is none without locks', () => {
    expect(lockSummary([lamp])).toEqual({ kind: 'none' });
  });
  it('counts all locked', () => {
    expect(lockSummary([frontLock, { ...backLock, state: 'locked' }])).toEqual({ kind: 'allLocked', count: 2 });
  });
  it('names the ones that are not locked', () => {
    expect(lockSummary([frontLock, backLock])).toEqual({ kind: 'unlocked', names: ['Back door'] });
  });
  it('skips unavailable locks rather than calling them unlocked', () => {
    expect(lockSummary([{ ...frontLock, state: 'unavailable' }])).toEqual({ kind: 'none' });
  });
});

describe('peopleSummary', () => {
  it('separates who is home', () => {
    const s = peopleSummary([jamie, emma, lamp]);
    expect(s.people).toEqual([jamie, emma]);
    expect(s.home).toEqual([jamie]);
  });
});

describe('houseClimate', () => {
  it('reads the weather entity first', () => {
    expect(houseClimate([temp, weather])).toEqual({ temperature: '81.4°', humidity: '48%' });
  });
  it('gives null for a weather entity missing or misreporting a reading', () => {
    expect(houseClimate([state('weather.x', 'sunny', { humidity: 40 })])).toEqual({ temperature: null, humidity: '40%' });
    expect(houseClimate([state('weather.x', 'sunny', { temperature: '81', humidity: '48' })])).toEqual({ temperature: null, humidity: null });
  });
  it('matches outdoor by friendly name too', () => {
    const patio = state('sensor.t2', '64', { friendly_name: 'Patio Temperature', device_class: 'temperature' });
    expect(houseClimate([temp, patio]).temperature).toBe('64°');
  });
  it('prefers an outdoor sensor over an indoor one', () => {
    const outdoor = state('sensor.outdoor_temp', '64', { device_class: 'temperature', unit_of_measurement: '°F' });
    expect(houseClimate([temp, outdoor, hum])).toEqual({ temperature: '64.0°', humidity: '46%' });
  });
  it('falls back to the first sensors, and to nothing', () => {
    expect(houseClimate([temp])).toEqual({ temperature: '71.8°', humidity: null });
    expect(houseClimate([lamp])).toEqual({ temperature: null, humidity: null });
  });
});

describe('formatDegrees', () => {
  it('uses the same decimals formatValue gives a temperature', () => {
    expect(formatDegrees(71.84)).toBe('71.8');
    expect(formatDegrees(72)).toBe('72.0');
    expect(formatDegrees(101.6)).toBe('102');
  });

  it('honours the sensor\'s suggested_display_precision', () => {
    const whole = state('sensor.t', '72.4', { unit_of_measurement: '°F', suggested_display_precision: 0 });
    expect(formatDegrees(72.4, whole)).toBe('72');
    expect(formatDegrees(72.4, temp)).toBe('72.4');
  });
});

describe('tileTone', () => {
  it('follows the plugin tones', () => {
    expect(tileTone(lamp)).toBe('on');
    expect(tileTone(kitchenLight)).toBe('default');
    expect(tileTone(door)).toBe('alert');
    expect(tileTone(backLock)).toBe('alert');
    expect(tileTone(frontLock)).toBe('default');
    expect(tileTone(state('media_player.tv', 'playing'))).toBe('active');
    expect(tileTone(state('media_player.tv', 'paused'))).toBe('default');
    expect(tileTone(state('climate.h', 'heat', { hvac_action: 'heating' }))).toBe('active');
    expect(tileTone(state('climate.h', 'heat', { hvac_action: 'idle' }))).toBe('default');
    expect(tileTone(state('climate.h', 'heat'))).toBe('active');
    expect(tileTone(state('binary_sensor.ev', 'on', { device_class: 'battery_charging' }))).toBe('active');
    expect(tileTone(state('cover.blinds', 'open'))).toBe('on');
    expect(tileTone(state('light.x', 'unavailable'))).toBe('default');
    expect(tileTone(state('lock.x', 'jammed'))).toBe('alert');
    expect(tileTone(state('climate.h', 'off'))).toBe('default');
    expect(tileTone(state('binary_sensor.m', 'on', { device_class: 'motion' }))).toBe('on');
    expect(tileTone(state('binary_sensor.m', 'off', { device_class: 'motion' }))).toBe('default');
    expect(tileTone(state('vacuum.v', 'error'))).toBe('alert');
    expect(tileTone(state('vacuum.v', 'cleaning'))).toBe('active');
    expect(tileTone(state('vacuum.v', 'docked'))).toBe('default');
    expect(tileTone(jamie)).toBe('on');
    expect(tileTone(emma)).toBe('default');
    expect(tileTone(state('sensor.s', '5'))).toBe('default');
  });
});

describe('tileStateLine', () => {
  it('adds the one useful number to the state word', () => {
    expect(tileStateLine(lamp, true)).toBe('On · 70%');
    expect(tileStateLine(kitchenLight, true)).toBe('Off');
    expect(tileStateLine(state('cover.b', 'open', { current_position: 40 }), true)).toBe('Open · 40%');
    expect(tileStateLine(state('cover.b', 'open', { current_position: 100 }), true)).toBe('Open');
    expect(tileStateLine(state('media_player.tv', 'playing', { media_title: 'Bluey' }), true)).toBe('Playing · Bluey');
    expect(tileStateLine(state('media_player.tv', 'idle', { media_title: 'Bluey' }), true)).toBe('Idle');
    expect(tileStateLine(state('climate.h', 'heat', { hvac_action: 'heating', current_temperature: 70.8 }), true)).toBe('Heating · 70.8° now');
    expect(tileStateLine(movie, true)).toBe('Tap to run');
    expect(tileStateLine(movie, false)).toBe('Scene');
    expect(tileStateLine(temp, true)).toBe('71.8°F');
    expect(tileStateLine(state('light.x', 'unavailable'), true)).toBe('Unavailable');
    expect(tileStateLine(state('fan.f', 'on', { percentage: 66 }), true)).toBe('On · 66%');
    expect(tileStateLine(state('fan.f', 'off', { percentage: 66 }), true)).toBe('Off');
    expect(tileStateLine(state('vacuum.v', 'docked', { battery_level: 84.4 }), true)).toBe('Docked · 84%');
    expect(tileStateLine(state('vacuum.v', 'cleaning'), true)).toBe('Cleaning');
  });
});

describe('dailyForecast', () => {
  it('collapses to one entry per day and caps at five', () => {
    const days = dailyForecast(FORECAST, 'UTC', 'en-US');
    expect(days).toEqual([
      { label: 'Mon', high: '84°' }, { label: 'Tue', high: '79°' }, { label: 'Wed', high: '75°' },
      { label: 'Thu', high: '77°' }, { label: 'Fri', high: '80°' },
    ]);
  });
  it('is empty without a list', () => {
    expect(dailyForecast(undefined)).toEqual([]);
    expect(dailyForecast('nope')).toEqual([]);
  });
  it('skips entries with a bad datetime or non-numeric temperature', () => {
    expect(dailyForecast([
      { datetime: 'yesterday-ish', temperature: 70 },
      { datetime: '2026-07-27T06:00:00Z', temperature: '84' },
      { datetime: '2026-07-28T06:00:00Z', temperature: 79 },
      null,
    ], 'UTC', 'en-US')).toEqual([{ label: 'Tue', high: '79°' }]);
  });
});

describe('parseForecastResponse', () => {
  it('reads the list out of the service response for the entity', () => {
    const raw = { changed_states: [], service_response: { 'weather.home': { forecast: FORECAST } } };
    expect(parseForecastResponse(raw, 'weather.home')).toBe(FORECAST);
  });
  it('is null for another entity, a missing list, or junk', () => {
    const raw = { service_response: { 'weather.home': { forecast: FORECAST } } };
    expect(parseForecastResponse(raw, 'weather.other')).toBeNull();
    expect(parseForecastResponse({ service_response: { 'weather.home': {} } }, 'weather.home')).toBeNull();
    expect(parseForecastResponse({ service_response: { 'weather.home': { forecast: 'no' } } }, 'weather.home')).toBeNull();
    expect(parseForecastResponse([], 'weather.home')).toBeNull();
    expect(parseForecastResponse(null, 'weather.home')).toBeNull();
    expect(parseForecastResponse('', 'weather.home')).toBeNull();
  });
});

describe('initials', () => {
  it('takes the first letter of up to two words', () => {
    expect(initials('Jamie Lee')).toBe('JL');
    expect(initials('Emma')).toBe('E');
    expect(initials('  ')).toBe('?');
  });
});

describe('autoDashboardEntities', () => {
  const st = (id: string) => ({ entity_id: id, state: 'on', attributes: {}, last_changed: '', last_updated: '' });
  const states = [st('light.a'), st('update.core'), st('sensor.b'), st('switch.c'), st('light.unplaced')];
  const areas = [
    { area_id: 'k', name: 'Kitchen', entities: ['light.a', 'update.core', 'light.missing'] },
    { area_id: 'l', name: 'Living', entities: ['sensor.b', 'switch.c', 'light.a'] },
  ];
  it('draws every placed entity in area order, skipping plumbing domains and duplicates', () => {
    expect(autoDashboardEntities(states, areas).map((s) => s.entity_id))
      .toEqual(['light.a', 'sensor.b', 'switch.c']);
  });
  it('narrows to one area', () => {
    expect(autoDashboardEntities(states, areas, 'l').map((s) => s.entity_id))
      .toEqual(['sensor.b', 'switch.c', 'light.a']);
  });
  it('draws nothing until the areas arrive', () => {
    expect(autoDashboardEntities(states, null)).toEqual([]);
    expect(autoDashboardEntities(states, [])).toEqual([]);
  });
});
