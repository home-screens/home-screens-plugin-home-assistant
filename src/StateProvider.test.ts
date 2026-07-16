import { describe, expect, it } from 'vitest';
import {
  selectPublishableIds, planFullPublish, planShrinkClears,
  planVanishedClears, planFastPublish,
} from './StateProvider';

describe('selectPublishableIds', () => {
  it('keeps valid entity ids and drops keys the host would reject', () => {
    const overlong = `sensor.${'x'.repeat(120)}`;
    expect(selectPublishableIds([
      'binary_sensor.back_door',
      'Light.Kitchen',      // uppercase — host key charset is lowercase-only
      'has space.oops',
      overlong,
      'sun.sun',
    ])).toEqual(['binary_sensor.back_door', 'sun.sun']);
  });
});

describe('planFullPublish', () => {
  const states = [
    { entity_id: 'binary_sensor.back_door', state: 'on' },
    { entity_id: 'sun.sun', state: 'below_horizon' },
    { entity_id: 'light.kitchen', state: 'off' },
  ];

  it('publishes only demanded ids, with their snapshot state', () => {
    expect(planFullPublish(['binary_sensor.back_door', 'sun.sun'], states)).toEqual([
      { id: 'binary_sensor.back_door', state: 'on' },
      { id: 'sun.sun', state: 'below_horizon' },
    ]);
  });

  it('never publishes unresolvable ids (typo / deleted entity)', () => {
    const plan = planFullPublish(['binary_sensor.back_door', 'sensor.typo_never_existed'], states);
    expect(plan).toEqual([{ id: 'binary_sensor.back_door', state: 'on' }]);
  });

  it('passes raw values through verbatim, including unavailable', () => {
    const plan = planFullPublish(
      ['sensor.flaky'],
      [{ entity_id: 'sensor.flaky', state: 'unavailable' }],
    );
    expect(plan).toEqual([{ id: 'sensor.flaky', state: 'unavailable' }]);
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
    const snapshot = new Set(['light.kitchen']);
    expect(planVanishedClears(published, demanded, snapshot)).toEqual(['sensor.renamed_away']);
  });

  it('leaves keys that dropped out of demand to the shrink path', () => {
    const published = new Set(['sensor.no_longer_demanded']);
    expect(planVanishedClears(published, ['light.kitchen'], new Set(['light.kitchen'])))
      .toEqual([]);
  });

  it('clears nothing when every published entity is still in the snapshot', () => {
    const published = new Set(['light.kitchen']);
    expect(planVanishedClears(published, ['light.kitchen'], new Set(['light.kitchen'])))
      .toEqual([]);
  });
});

describe('planFastPublish', () => {
  const updates = [
    { entity_id: 'light.kitchen', state: 'on' },
    { entity_id: 'sensor.not_yet_confirmed', state: 'unknown' },
  ];

  it('publishes only entities the full poll confirmed to exist', () => {
    expect(planFastPublish(new Set(['light.kitchen']), updates)).toEqual([
      { id: 'light.kitchen', state: 'on' },
    ]);
  });

  it('publishes nothing before the first full poll resolves', () => {
    expect(planFastPublish(new Set(), updates)).toEqual([]);
  });
});
