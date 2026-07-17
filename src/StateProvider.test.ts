import { describe, expect, it } from 'vitest';
import type { HAStateObject } from './types';
import {
  selectPublishableRefs, planFullPublish, planShrinkClears,
  planVanishedClears, planFastPublish, planFastBuffer,
} from './StateProvider';

function stateObj(entityId: string, state: string, attributes: Record<string, unknown> = {}): HAStateObject {
  return {
    entity_id: entityId,
    state,
    attributes: attributes as HAStateObject['attributes'],
    last_changed: '',
    last_updated: '',
  };
}

describe('selectPublishableRefs', () => {
  it('keeps valid entity ids and drops keys the host would reject', () => {
    const overlong = `sensor.${'x'.repeat(120)}`;
    expect(selectPublishableRefs([
      'binary_sensor.back_door',
      'Light.Kitchen',      // uppercase — host key charset is lowercase-only
      'has space.oops',
      overlong,
      'sun.sun',
    ])).toEqual(['binary_sensor.back_door', 'sun.sun']);
  });

  it('keeps attribute refs and drops malformed ones', () => {
    expect(selectPublishableRefs([
      'sensor.phone:battery_level',
      'sensor.phone:',
      'a:b:c',
    ])).toEqual(['sensor.phone:battery_level']);
  });
});

describe('planFullPublish', () => {
  const states = [
    stateObj('binary_sensor.back_door', 'on'),
    stateObj('sun.sun', 'below_horizon'),
    stateObj('light.kitchen', 'off', { brightness: 128 }),
    stateObj('sensor.phone', 'home', { battery_level: 84, forecast: [] }),
  ];

  it('publishes only demanded refs, with their snapshot value', () => {
    expect(planFullPublish(['binary_sensor.back_door', 'sun.sun'], states)).toEqual([
      { ref: 'binary_sensor.back_door', value: 'on' },
      { ref: 'sun.sun', value: 'below_horizon' },
    ]);
  });

  it('resolves attribute refs to stringified scalar attributes', () => {
    expect(planFullPublish(
      ['sensor.phone:battery_level', 'light.kitchen:brightness'], states,
    )).toEqual([
      { ref: 'sensor.phone:battery_level', value: '84' },
      { ref: 'light.kitchen:brightness', value: '128' },
    ]);
  });

  it('never publishes unresolvable refs (typo, deleted entity, missing or non-scalar attribute)', () => {
    const plan = planFullPublish([
      'binary_sensor.back_door',
      'sensor.typo_never_existed',
      'sensor.phone:no_such_attribute',
      'sensor.phone:forecast',
      'a:b:c',
    ], states);
    expect(plan).toEqual([{ ref: 'binary_sensor.back_door', value: 'on' }]);
  });

  it('passes raw values through verbatim, including unavailable', () => {
    const plan = planFullPublish(['sensor.flaky'], [stateObj('sensor.flaky', 'unavailable')]);
    expect(plan).toEqual([{ ref: 'sensor.flaky', value: 'unavailable' }]);
  });
});

describe('planShrinkClears', () => {
  it('clears previously published keys that dropped out of the demand set', () => {
    const published = new Set(['binary_sensor.back_door', 'sun.sun']);
    expect(planShrinkClears(published, ['sun.sun'])).toEqual(['binary_sensor.back_door']);
  });

  it('clears everything when demand empties', () => {
    const published = new Set(['a.b', 'c.d']);
    expect(planShrinkClears(published, []).sort()).toEqual(['a.b', 'c.d']);
  });

  it('never clears keys still demanded, and ignores never-published demand', () => {
    const published = new Set(['a.b']);
    expect(planShrinkClears(published, ['a.b', 'e.f'])).toEqual([]);
  });
});

describe('planVanishedClears', () => {
  it('clears published keys whose entity vanished from a successful snapshot', () => {
    const published = new Set(['light.kitchen', 'sensor.renamed_away']);
    const demanded = ['light.kitchen', 'sensor.renamed_away'];
    const resolved = new Set(['light.kitchen']);
    expect(planVanishedClears(published, demanded, resolved)).toEqual(['sensor.renamed_away']);
  });

  it('clears an attribute ref whose attribute vanished while the entity stayed', () => {
    // media_title disappears when playback stops: the entity still resolves,
    // the attribute ref does not.
    const published = new Set(['media_player.tv', 'media_player.tv:media_title']);
    const demanded = ['media_player.tv', 'media_player.tv:media_title'];
    const resolved = new Set(['media_player.tv']);
    expect(planVanishedClears(published, demanded, resolved))
      .toEqual(['media_player.tv:media_title']);
  });

  it('leaves keys that dropped out of demand to the shrink path', () => {
    const published = new Set(['sensor.no_longer_demanded']);
    expect(planVanishedClears(published, ['light.kitchen'], new Set(['light.kitchen'])))
      .toEqual([]);
  });

  it('clears nothing when every published ref still resolves', () => {
    const published = new Set(['light.kitchen']);
    expect(planVanishedClears(published, ['light.kitchen'], new Set(['light.kitchen'])))
      .toEqual([]);
  });
});

describe('planFastPublish', () => {
  const updates = [
    { ref: 'light.kitchen', value: 'on' },
    { ref: 'sensor.phone:battery_level', value: '83' },
    { ref: 'sensor.not_yet_confirmed', value: 'unknown' },
  ];

  it('publishes only refs the full poll confirmed to resolve', () => {
    expect(planFastPublish(new Set(['light.kitchen', 'sensor.phone:battery_level']), updates))
      .toEqual([
        { ref: 'light.kitchen', value: 'on' },
        { ref: 'sensor.phone:battery_level', value: '83' },
      ]);
  });

  it('publishes nothing before the first full poll resolves', () => {
    expect(planFastPublish(new Set(), updates)).toEqual([]);
  });
});

describe('planFastBuffer', () => {
  const updates = [
    { ref: 'light.kitchen', value: 'on' },
    { ref: 'sensor.new_condition', value: '12' },
    { ref: 'light.widget_only', value: 'off' },
  ];

  it('buffers demanded refs the full poll has not yet confirmed', () => {
    const demanded = new Set(['light.kitchen', 'sensor.new_condition']);
    const known = new Set(['light.kitchen']);
    expect(planFastBuffer(demanded, known, updates))
      .toEqual([{ ref: 'sensor.new_condition', value: '12' }]);
  });

  it('never buffers refs outside the demand set (widget-only hub traffic)', () => {
    // The shared hub broadcasts every changed ref on the loop; buffering a
    // foreign ref leaks it forever and replays a stale value over the full
    // poll's fresh one the moment the ref later becomes demanded.
    const demanded = new Set(['light.kitchen']);
    expect(planFastBuffer(demanded, new Set(), updates))
      .toEqual([{ ref: 'light.kitchen', value: 'on' }]);
  });

  it('buffers nothing when everything demanded is already known', () => {
    const demanded = new Set(['light.kitchen']);
    const known = new Set(['light.kitchen']);
    expect(planFastBuffer(demanded, known, updates)).toEqual([]);
  });
});
