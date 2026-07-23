import { describe, expect, it } from 'vitest';
import { reconcileStates } from './cache';
import type { HAStateObject } from './types';

function stateObj(
  entityId: string, state: string, lastUpdated: string,
  attributes: Record<string, unknown> = {},
): HAStateObject {
  return {
    entity_id: entityId,
    state,
    attributes: attributes as HAStateObject['attributes'],
    last_changed: lastUpdated,
    last_updated: lastUpdated,
  };
}

const T1 = '2026-07-22T10:00:00+00:00';
const T2 = '2026-07-22T10:00:30+00:00';

describe('reconcileStates', () => {
  it('keeps the held entity — state and attributes — over an older snapshot', () => {
    const held = stateObj('climate.living', 'off', T2, { temperature: 72 });
    const snapshot = stateObj('climate.living', 'heat', T1, { temperature: 70 });
    const out = reconcileStates([held], [snapshot], null);
    expect(out).toEqual([held]);
    expect(out[0]).toBe(held);
  });

  it('takes the snapshot when it is strictly newer than the held entity', () => {
    const held = stateObj('climate.living', 'heat', T1);
    const snapshot = stateObj('climate.living', 'off', T2);
    expect(reconcileStates([held], [snapshot], null)).toEqual([snapshot]);
  });

  it('keeps the held object on a timestamp tie (same server event, possibly fast-merged)', () => {
    const held = { ...stateObj('light.desk', 'on', T1), last_changed: T2 };
    const snapshot = stateObj('light.desk', 'off', T1);
    const out = reconcileStates([held], [snapshot], null);
    expect(out[0]).toBe(held);
  });

  it('trusts the snapshot when a timestamp does not parse', () => {
    const held = stateObj('light.desk', 'on', 'not-a-date');
    const snapshot = stateObj('light.desk', 'off', T1);
    expect(reconcileStates([held], [snapshot], null)).toEqual([snapshot]);
  });

  it('overlays the fast lane value onto the snapshot state, stamping last_changed', () => {
    const snapshot = stateObj('light.desk', 'on', T1);
    const out = reconcileStates(null, [snapshot], new Map([['light.desk', 'off']]));
    expect(out[0].state).toBe('off');
    expect(out[0].last_updated).toBe(T1);
    expect(out[0].last_changed).not.toBe(T1);
    expect(out[0].attributes).toBe(snapshot.attributes);
  });

  it('leaves the snapshot object untouched when the fast value matches', () => {
    const snapshot = stateObj('light.desk', 'on', T1);
    const out = reconcileStates(null, [snapshot], new Map([['light.desk', 'on']]));
    expect(out[0]).toBe(snapshot);
  });

  it('ignores fast-lane attribute refs — entity ids never contain a colon', () => {
    const snapshot = stateObj('sensor.phone', 'home', T1);
    const fast = new Map([['sensor.phone:battery_level', '12']]);
    expect(reconcileStates(null, [snapshot], fast)[0]).toBe(snapshot);
  });

  it('applies the fast overlay on top of a kept-newer held entity', () => {
    const held = stateObj('climate.living', 'off', T2);
    const snapshot = stateObj('climate.living', 'heat', T1);
    const out = reconcileStates([held], [snapshot], new Map([['climate.living', 'cool']]));
    expect(out[0].state).toBe('cool');
    expect(out[0].last_updated).toBe(T2);
  });

  it('drops held entities absent from the snapshot', () => {
    const held = stateObj('light.gone', 'on', T2);
    const snapshot = stateObj('light.desk', 'off', T1);
    expect(reconcileStates([held], [snapshot], null)).toEqual([snapshot]);
  });
});
