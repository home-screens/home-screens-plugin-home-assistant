import { describe, expect, it } from 'vitest';
import {
  parseTimelineResponse, timelineWindow, isActiveTimelineState, withLiveState,
  segments, laneTone, timelineEvents, eventSentence, splitAroundName,
  formatDuration, summarizeLane, hourTicks, spanBox, countHome,
  tickStepFor, feedColumnsFor, liveTransition, quantizeNow,
  TIMELINE_WINDOW_MS, TIMELINE_QUANTUM_MS,
} from './timeline';
import type { HAStateObject } from './types';

const H = 3600_000;
const T0 = Date.parse('2026-07-25T10:00:00Z');
const T1 = T0 + 24 * H;

function entity(entityId: string, state: string): HAStateObject {
  return {
    entity_id: entityId, state, attributes: {},
    last_changed: '2026-07-26T09:00:00Z', last_updated: '2026-07-26T09:00:00Z',
  };
}

describe('timelineWindow', () => {
  it('floors the start and ceils the end to five minutes', () => {
    const now = Date.parse('2026-07-26T10:32:10Z');
    const { startMs, endMs } = timelineWindow(now);
    expect(new Date(endMs).toISOString()).toBe('2026-07-26T10:35:00.000Z');
    expect(new Date(startMs).toISOString()).toBe('2026-07-25T10:30:00.000Z');
    expect(endMs - startMs).toBe(TIMELINE_WINDOW_MS + TIMELINE_QUANTUM_MS);
  });

  it('is stable inside one quantum', () => {
    const a = timelineWindow(Date.parse('2026-07-26T10:30:01Z'));
    const b = timelineWindow(Date.parse('2026-07-26T10:34:59Z'));
    expect(a).toEqual(b);
  });
});

describe('parseTimelineResponse', () => {
  it('keeps every entry, numeric or not, in time order', () => {
    const raw = [[
      { entity_id: 'light.a', state: 'off', last_changed: '2026-07-25T10:00:00Z' },
      { state: 'on', last_changed: '2026-07-25T14:00:00Z' },
      { state: '42', last_changed: '2026-07-25T12:00:00Z' },
    ]];
    expect(parseTimelineResponse(raw)).toEqual({
      'light.a': [
        { state: 'off', at: Date.parse('2026-07-25T10:00:00Z') },
        { state: '42', at: Date.parse('2026-07-25T12:00:00Z') },
        { state: 'on', at: Date.parse('2026-07-25T14:00:00Z') },
      ],
    });
  });

  it('ignores junk', () => {
    expect(parseTimelineResponse(null)).toEqual({});
    expect(parseTimelineResponse([[], [null], [{ state: 'on' }]])).toEqual({});
    expect(parseTimelineResponse([[
      { entity_id: 'light.a', state: 'on', last_changed: 'nope' },
      { state: 5, last_changed: '2026-07-25T10:00:00Z' },
    ]])).toEqual({ 'light.a': [] });
  });
});

describe('isActiveTimelineState', () => {
  it('knows what on means per domain', () => {
    expect(isActiveTimelineState('light.a', 'on')).toBe(true);
    expect(isActiveTimelineState('light.a', 'off')).toBe(false);
    expect(isActiveTimelineState('person.a', 'home')).toBe(true);
    expect(isActiveTimelineState('person.a', 'school')).toBe(false);
    expect(isActiveTimelineState('device_tracker.a', 'home')).toBe(true);
    expect(isActiveTimelineState('cover.a', 'open')).toBe(true);
    expect(isActiveTimelineState('cover.a', 'opening')).toBe(true);
    expect(isActiveTimelineState('cover.a', 'closed')).toBe(false);
    expect(isActiveTimelineState('lock.a', 'unlocked')).toBe(true);
    expect(isActiveTimelineState('lock.a', 'locked')).toBe(false);
    expect(isActiveTimelineState('media_player.a', 'playing')).toBe(true);
    expect(isActiveTimelineState('media_player.a', 'paused')).toBe(false);
    expect(isActiveTimelineState('climate.a', 'heat')).toBe(true);
    expect(isActiveTimelineState('climate.a', 'off')).toBe(false);
    expect(isActiveTimelineState('vacuum.a', 'cleaning')).toBe(true);
    expect(isActiveTimelineState('vacuum.a', 'docked')).toBe(false);
    expect(isActiveTimelineState('binary_sensor.a', 'on')).toBe(true);
  });

  it('never treats unavailable as on', () => {
    expect(isActiveTimelineState('light.a', 'unavailable')).toBe(false);
    expect(isActiveTimelineState('climate.a', 'unknown')).toBe(false);
  });
});

describe('withLiveState', () => {
  it('appends the live state when history has not caught up', () => {
    const hist = [{ state: 'off', at: T0 }, { state: 'on', at: T0 + H }];
    expect(withLiveState(hist, { state: 'off', at: T0 + 2 * H })).toEqual([
      ...hist, { state: 'off', at: T0 + 2 * H },
    ]);
  });

  it('does nothing when history already ends in the live state', () => {
    const hist = [{ state: 'on', at: T0 }];
    expect(withLiveState(hist, { state: 'on', at: T0 + H })).toEqual(hist);
  });

  it('lets history win over a live reading that is older than it', () => {
    const hist = [{ state: 'on', at: T0 + 5 * H }];
    expect(withLiveState(hist, { state: 'off', at: T0 })).toEqual(hist);
    expect(withLiveState(hist, { state: 'off', at: T0 + 5 * H })).toEqual(hist);
  });

  it('starts from the live state when history is empty', () => {
    expect(withLiveState([], { state: 'on', at: T0 })).toEqual([{ state: 'on', at: T0 }]);
    expect(withLiveState([], null)).toEqual([]);
  });
});

describe('segments', () => {
  it('draws a span from on to off and extends an open span to now', () => {
    const hist = [
      { state: 'off', at: T0 }, { state: 'on', at: T0 + 2 * H },
      { state: 'off', at: T0 + 5 * H }, { state: 'on', at: T0 + 20 * H },
    ];
    expect(segments('light.a', hist, T0, T1)).toEqual([
      { startMs: T0 + 2 * H, endMs: T0 + 5 * H },
      { startMs: T0 + 20 * H, endMs: T1 },
    ]);
  });

  it('clips a span that began before the window', () => {
    const hist = [{ state: 'on', at: T0 - 3 * H }, { state: 'off', at: T0 + H }];
    expect(segments('light.a', hist, T0, T1)).toEqual([{ startMs: T0, endMs: T0 + H }]);
  });

  it('lets the live state close or open the last span', () => {
    const hist = [{ state: 'on', at: T0 }];
    expect(segments('light.a', hist, T0, T1, { state: 'off', at: T0 + 10 * H }))
      .toEqual([{ startMs: T0, endMs: T0 + 10 * H }]);
    const off = [{ state: 'off', at: T0 }];
    expect(segments('light.a', off, T0, T1, { state: 'on', at: T0 + 23 * H }))
      .toEqual([{ startMs: T0 + 23 * H, endMs: T1 }]);
  });

  it('treats unavailable as off without duplicating spans', () => {
    const hist = [
      { state: 'on', at: T0 }, { state: 'unavailable', at: T0 + H },
      { state: 'on', at: T0 + 2 * H }, { state: 'off', at: T0 + 3 * H },
    ];
    expect(segments('light.a', hist, T0, T1)).toEqual([
      { startMs: T0, endMs: T0 + H }, { startMs: T0 + 2 * H, endMs: T0 + 3 * H },
    ]);
  });

  it('clips a span that runs past the window end', () => {
    const hist = [{ state: 'on', at: T0 + 20 * H }, { state: 'off', at: T1 + 2 * H }];
    expect(segments('light.a', hist, T0, T1)).toEqual([{ startMs: T0 + 20 * H, endMs: T1 }]);
    // A change entirely after the window draws nothing.
    expect(segments('light.a', [{ state: 'off', at: T0 }, { state: 'on', at: T1 + H }], T0, T1))
      .toEqual([]);
  });

  it('returns nothing for an entity that stayed off', () => {
    expect(segments('light.a', [{ state: 'off', at: T0 }], T0, T1)).toEqual([]);
    expect(segments('light.a', [], T0, T1)).toEqual([]);
  });
});

describe('laneTone', () => {
  it('picks the hue per kind of thing', () => {
    expect(laneTone('light.a')).toBe('amber');
    expect(laneTone('switch.a')).toBe('amber');
    expect(laneTone('fan.a')).toBe('amber');
    expect(laneTone('person.a')).toBe('blue');
    expect(laneTone('device_tracker.a')).toBe('blue');
    expect(laneTone('media_player.a')).toBe('purple');
    expect(laneTone('lock.a')).toBe('green');
    expect(laneTone('cover.a')).toBe('red');
    expect(laneTone('binary_sensor.a', 'door')).toBe('red');
    expect(laneTone('binary_sensor.a', 'window')).toBe('red');
    expect(laneTone('binary_sensor.a', 'garage_door')).toBe('red');
    expect(laneTone('binary_sensor.a', 'lock')).toBe('green');
    expect(laneTone('binary_sensor.a', 'motion')).toBe('blue');
    expect(laneTone('climate.a')).toBe('orange');
    expect(laneTone('vacuum.a')).toBe('purple');
  });
});

describe('timelineEvents', () => {
  it('lists changes newest first and skips the state at window start', () => {
    const data = {
      'light.a': [{ state: 'off', at: T0 }, { state: 'on', at: T0 + 2 * H }],
      'person.b': [{ state: 'home', at: T0 }, { state: 'not_home', at: T0 + 5 * H }],
    };
    expect(timelineEvents(data, new Map(), T0, T1)).toEqual([
      { entityId: 'person.b', at: T0 + 5 * H, state: 'not_home' },
      { entityId: 'light.a', at: T0 + 2 * H, state: 'on' },
    ]);
  });

  it('folds in a live change history has not reported', () => {
    const data = { 'light.a': [{ state: 'off', at: T0 }] };
    const live = new Map([['light.a', { state: 'on', at: T0 + 23 * H }]]);
    expect(timelineEvents(data, live, T0, T1)).toEqual([
      { entityId: 'light.a', at: T0 + 23 * H, state: 'on' },
    ]);
  });

  it('drops unavailable blips and repeated states', () => {
    const data = {
      'light.a': [
        { state: 'on', at: T0 }, { state: 'unavailable', at: T0 + H },
        { state: 'on', at: T0 + 2 * H }, { state: 'on', at: T0 + 3 * H },
        { state: 'off', at: T0 + 4 * H },
      ],
    };
    expect(timelineEvents(data, new Map(), T0, T1)).toEqual([
      { entityId: 'light.a', at: T0 + 4 * H, state: 'off' },
    ]);
  });

  it('ignores changes outside the window', () => {
    const data = { 'light.a': [{ state: 'off', at: T0 - 2 * H }, { state: 'on', at: T0 - H }] };
    expect(timelineEvents(data, new Map(), T0, T1)).toEqual([]);
  });
});

describe('eventSentence', () => {
  it('reads naturally per domain', () => {
    expect(eventSentence('light.a', 'on', 'Lamp')).toBe('Lamp turned on');
    expect(eventSentence('switch.a', 'off', 'Porch')).toBe('Porch turned off');
    expect(eventSentence('person.a', 'home', 'Jamie')).toBe('Jamie came home');
    expect(eventSentence('person.a', 'not_home', 'Jamie')).toBe('Jamie left home');
    expect(eventSentence('person.a', 'school', 'Emma')).toBe('Emma arrived at School');
    expect(eventSentence('person.a', 'grandmas_house', 'Emma')).toBe('Emma arrived at Grandmas house');
    expect(eventSentence('binary_sensor.a', 'on', 'Front door', 'door')).toBe('Front door opened');
    expect(eventSentence('binary_sensor.a', 'off', 'Front door', 'door')).toBe('Front door closed');
    expect(eventSentence('cover.a', 'open', 'Garage')).toBe('Garage opened');
    expect(eventSentence('cover.a', 'closing', 'Garage')).toBe('Garage closed');
    expect(eventSentence('lock.a', 'locked', 'Back door')).toBe('Back door locked');
    expect(eventSentence('lock.a', 'unlocked', 'Back door')).toBe('Back door unlocked');
    expect(eventSentence('media_player.a', 'playing', 'TV')).toBe('TV started playing');
    expect(eventSentence('media_player.a', 'paused', 'TV')).toBe('TV paused');
    expect(eventSentence('media_player.a', 'idle', 'TV')).toBe('TV stopped');
    expect(eventSentence('media_player.a', 'off', 'TV')).toBe('TV turned off');
    expect(eventSentence('climate.a', 'heat', 'Hallway')).toBe('Hallway started heating');
    expect(eventSentence('climate.a', 'cool', 'Hallway')).toBe('Hallway started cooling');
    expect(eventSentence('climate.a', 'off', 'Hallway')).toBe('Hallway turned off');
    expect(eventSentence('binary_sensor.a', 'on', 'Hall', 'motion')).toBe('Hall saw movement');
    expect(eventSentence('vacuum.a', 'cleaning', 'Robot')).toBe('Robot started cleaning');
  });

  it('handles binary lock sensors, leaks, and the quieter climate and vacuum words', () => {
    expect(eventSentence('binary_sensor.a', 'on', 'Back door', 'lock')).toBe('Back door unlocked');
    expect(eventSentence('binary_sensor.a', 'off', 'Back door', 'lock')).toBe('Back door locked');
    expect(eventSentence('binary_sensor.a', 'on', 'Sink', 'moisture')).toBe('Sink got wet');
    expect(eventSentence('binary_sensor.a', 'off', 'Sink', 'moisture')).toBe('Sink dried out');
    expect(eventSentence('binary_sensor.a', 'off', 'Hall', 'occupancy')).toBe('Hall went quiet');
    expect(eventSentence('binary_sensor.a', 'on', 'Plug', 'plug')).toBe('Plug turned on');
    expect(eventSentence('climate.a', 'idle', 'Hallway')).toBe('Hallway went idle');
    expect(eventSentence('vacuum.a', 'docked', 'Robot')).toBe('Robot went back to its dock');
    expect(eventSentence('lawn_mower.a', 'mowing', 'Mower')).toBe('Mower started cleaning');
    expect(eventSentence('media_player.a', 'standby', 'TV')).toBe('TV stopped');
    expect(eventSentence('media_player.a', 'on', 'TV')).toBe('TV turned on');
    expect(eventSentence('cover.a', 'opening', 'Garage')).toBe('Garage opened');
    expect(eventSentence('binary_sensor.a', 'off', 'Window', 'window')).toBe('Window closed');
  });

  it('falls back to the raw state in words', () => {
    expect(eventSentence('lock.a', 'jammed', 'Back door')).toBe('Back door is now Jammed');
    expect(eventSentence('climate.a', 'heat_cool', 'Hallway')).toBe('Hallway is now Heat cool');
  });
});

describe('splitAroundName', () => {
  it('finds the name so the view can bold it', () => {
    expect(splitAroundName('Lamp turned on', 'Lamp')).toEqual({ before: '', name: 'Lamp', after: ' turned on' });
    expect(splitAroundName('Es wurde Lampe eingeschaltet', 'Lampe'))
      .toEqual({ before: 'Es wurde ', name: 'Lampe', after: ' eingeschaltet' });
    expect(splitAroundName('Something else', 'Lamp')).toBeNull();
    expect(splitAroundName('Something', '')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('rounds to minutes and hours the way a person would say it', () => {
    expect(formatDuration(20 * 1000)).toBe('1 min');
    expect(formatDuration(45 * 60_000)).toBe('45 min');
    expect(formatDuration(6 * H)).toBe('6 h');
    expect(formatDuration(H + 20 * 60_000)).toBe('1 h');
    expect(formatDuration(H + 40 * 60_000)).toBe('2 h');
    expect(formatDuration(14 * H + 30 * 60_000)).toBe('15 h');
  });
});

describe('summarizeLane', () => {
  const span = (a: number, b: number) => ({ startMs: T0 + a * H, endMs: T0 + b * H });

  it('totals time for things that stay on', () => {
    expect(summarizeLane('light.a', [span(0, 4), span(10, 12)], 'off')).toBe('on 6 h');
    expect(summarizeLane('light.a', [], 'off')).toBe('off all day');
    expect(summarizeLane('person.a', [span(0, 14)], 'home')).toBe('home 14 h');
    expect(summarizeLane('person.a', [], 'not_home')).toBe('away all day');
    expect(summarizeLane('person.a', [span(0, 2)], 'school')).toBe('at School');
    expect(summarizeLane('lock.a', [span(0, 2)], 'locked')).toBe('unlocked 2 h');
    expect(summarizeLane('lock.a', [], 'locked')).toBe('locked all day');
    expect(summarizeLane('media_player.a', [span(0, 3)], 'off')).toBe('playing 3 h');
    expect(summarizeLane('media_player.a', [], 'off')).toBe('nothing played');
    expect(summarizeLane('climate.a', [span(0, 24)], 'heat')).toBe('running 24 h');
  });

  it('counts openings for doors and says when one is open now', () => {
    const blips = [span(1, 1.01), span(2, 2.01), span(3, 3.01)];
    expect(summarizeLane('binary_sensor.a', blips, 'off', 'door')).toBe('opened 3 times');
    expect(summarizeLane('binary_sensor.a', blips.slice(0, 1), 'off', 'door')).toBe('opened once');
    expect(summarizeLane('binary_sensor.a', [], 'off', 'door')).toBe('closed all day');
    expect(summarizeLane('cover.a', [span(23, 24)], 'open')).toBe('open now');
    expect(summarizeLane('binary_sensor.a', blips, 'off', 'motion')).toBe('active 3 times');
  });

  it('covers the rest of the branches', () => {
    expect(summarizeLane('light.a', [span(0, 0.5)], 'off')).toBe('on 30 min');
    expect(summarizeLane('person.a', [span(0, 2)], 'unknown')).toBe('home 2 h');
    expect(summarizeLane('person.a', [span(0, 2)], null)).toBe('home 2 h');
    expect(summarizeLane('binary_sensor.a', [span(0, 1)], 'on', 'lock')).toBe('unlocked 1 h');
    expect(summarizeLane('binary_sensor.a', [], 'off', 'lock')).toBe('locked all day');
    expect(summarizeLane('binary_sensor.a', [span(0, 1)], 'on', 'motion')).toBe('active now');
    expect(summarizeLane('binary_sensor.a', [span(0, 0.01)], 'off', 'motion')).toBe('active once');
    expect(summarizeLane('binary_sensor.a', [], 'off', 'motion')).toBe('quiet all day');
    expect(summarizeLane('cover.a', [span(1, 1.1)], 'closed')).toBe('opened once');
    expect(summarizeLane('climate.a', [], 'off')).toBe('off all day');
    expect(summarizeLane('vacuum.a', [span(0, 1)], 'docked')).toBe('running 1 h');
    expect(summarizeLane('switch.a', [], 'off')).toBe('off all day');
  });
});

describe('hourTicks', () => {
  it('marks every third hour in the given timezone', () => {
    const start = Date.parse('2026-07-25T10:30:00Z');
    const end = Date.parse('2026-07-26T10:35:00Z');
    const ticks = hourTicks(start, end, 'UTC');
    expect(ticks.map((t) => new Date(t.ms).toISOString().slice(11, 16)))
      .toEqual(['12:00', '15:00', '18:00', '21:00', '00:00', '03:00', '06:00', '09:00']);
    expect(ticks[0].fraction).toBeCloseTo(1.5 / 24.083, 3);
    expect(ticks.every((t) => t.fraction >= 0 && t.fraction <= 1)).toBe(true);
    expect(ticks[0].label).toMatch(/12/);
  });

  it('reads the clock in the host timezone, half-hour zones included', () => {
    const start = Date.parse('2026-07-25T10:30:00Z');
    const end = Date.parse('2026-07-26T10:35:00Z');
    const chicago = hourTicks(start, end, 'America/Chicago');
    // 10:30Z is 5:30 AM in Chicago (CDT); the first 3-hourly mark is 6 AM = 11:00Z.
    expect(new Date(chicago[0].ms).toISOString()).toBe('2026-07-25T11:00:00.000Z');
    const kolkata = hourTicks(start, end, 'Asia/Kolkata');
    // 10:30Z is 4:00 PM in Kolkata; the next mark is 6 PM = 12:30Z.
    expect(new Date(kolkata[0].ms).toISOString()).toBe('2026-07-25T12:30:00.000Z');
  });

  it('spaces ticks by the step it is given', () => {
    const start = Date.parse('2026-07-25T10:30:00Z');
    const end = Date.parse('2026-07-26T10:35:00Z');
    expect(hourTicks(start, end, 'UTC', 6).map((t) => new Date(t.ms).toISOString().slice(11, 16)))
      .toEqual(['12:00', '18:00', '00:00', '06:00']);
    expect(hourTicks(start, end, 'UTC', 12).map((t) => new Date(t.ms).toISOString().slice(11, 16)))
      .toEqual(['12:00', '00:00']);
  });

  it('follows the wall clock across a DST change', () => {
    // Chicago springs forward at 2 AM on 2026-03-08: the day has 23 hours
    // and 3 AM local lands one UTC hour after 12 AM local did.
    const start = Date.parse('2026-03-07T18:00:00Z'); // 12 PM CST
    const end = Date.parse('2026-03-08T17:00:00Z');   // 12 PM CDT
    const ticks = hourTicks(start, end, 'America/Chicago');
    expect(ticks.map((t) => new Date(t.ms).toISOString().slice(11, 16)))
      .toEqual(['18:00', '21:00', '00:00', '03:00', '06:00', '08:00', '11:00', '14:00', '17:00']);
    expect(ticks.map((t) => t.label)).toEqual(
      ['12 PM', '3 PM', '6 PM', '9 PM', '12 AM', '3 AM', '6 AM', '9 AM', '12 PM'],
    );
  });

  it('returns nothing for an empty window', () => {
    expect(hourTicks(T0, T0, 'UTC')).toEqual([]);
  });
});

describe('spanBox', () => {
  it('places a span and enforces the minimum width', () => {
    expect(spanBox({ startMs: T0 + 6 * H, endMs: T0 + 12 * H }, T0, T1, 0.005))
      .toEqual({ left: 0.25, width: 0.25 });
    const blip = spanBox({ startMs: T0 + 12 * H, endMs: T0 + 12 * H + 10_000 }, T0, T1, 0.01);
    expect(blip.width).toBe(0.01);
    expect(blip.left).toBe(0.5);
  });

  it('keeps a blip at the right edge inside the lane', () => {
    const edge = spanBox({ startMs: T1 - 1000, endMs: T1 }, T0, T1, 0.01);
    expect(edge.left + edge.width).toBeCloseTo(1, 9);
  });
});

describe('liveTransition', () => {
  it('reads the entity\'s last change, and falls back to now when it is unreadable', () => {
    expect(liveTransition(entity('light.a', 'on')))
      .toEqual({ state: 'on', at: Date.parse('2026-07-26T09:00:00Z') });
    const broken = { ...entity('light.a', 'on'), last_changed: 'nope' };
    const before = Date.now();
    const out = liveTransition(broken);
    expect(out.state).toBe('on');
    expect(out.at).toBeGreaterThanOrEqual(before);
  });
});

describe('quantizeNow', () => {
  it('rounds down to the minute', () => {
    expect(quantizeNow(Date.parse('2026-07-26T10:32:59.900Z'))).toBe(Date.parse('2026-07-26T10:32:00Z'));
  });
});

describe('countHome', () => {
  it('counts people at home', () => {
    expect(countHome([
      entity('person.a', 'home'), entity('person.b', 'school'),
      entity('device_tracker.c', 'home'), entity('light.d', 'on'),
    ])).toBe(2);
  });
});

describe('tickStepFor', () => {
  it('spreads the labels out as the lane narrows', () => {
    expect(tickStepFor(800, 48)).toBe(3);
    expect(tickStepFor(300, 48)).toBe(6);
    expect(tickStepFor(150, 48)).toBe(12);
    expect(tickStepFor(40, 48)).toBe(24);
  });
});

describe('feedColumnsFor', () => {
  it('honors the slider until the width runs out', () => {
    expect(feedColumnsFor(3, 1200, 230)).toBe(3);
    expect(feedColumnsFor(3, 500, 230)).toBe(2);
    expect(feedColumnsFor(2, 390, 230)).toBe(1);
    expect(feedColumnsFor(0, 1200, 230)).toBe(2);
    expect(feedColumnsFor(2, 0, 230)).toBe(1);
  });
});
