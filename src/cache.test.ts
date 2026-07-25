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

  // A no-change poll must not produce a new array: `states` is compared by
  // reference before it re-renders the module (applyStates), so a fresh array
  // of identical entries costs a full card-tree render for nothing.
  describe('array identity', () => {
    it('returns the held array itself when nothing changed', () => {
      const prev = [stateObj('light.desk', 'on', T1), stateObj('sensor.temp', '21', T1)];
      const next = [stateObj('light.desk', 'on', T1), stateObj('sensor.temp', '21', T1)];
      expect(reconcileStates(prev, next, null)).toBe(prev);
    });

    it('returns a new array when any entity actually changed', () => {
      const prev = [stateObj('light.desk', 'on', T1), stateObj('sensor.temp', '21', T1)];
      const next = [stateObj('light.desk', 'on', T1), stateObj('sensor.temp', '22', T2)];
      const out = reconcileStates(prev, next, null);
      expect(out).not.toBe(prev);
      expect(out[0]).toBe(prev[0]);
      expect(out[1]).toBe(next[1]);
    });

    it('returns a new array when a fast-lane value overlays', () => {
      const prev = [stateObj('light.desk', 'on', T1)];
      const next = [stateObj('light.desk', 'on', T1)];
      const out = reconcileStates(prev, next, new Map([['light.desk', 'off']]));
      expect(out).not.toBe(prev);
      expect(out[0].state).toBe('off');
    });

    it('returns a new array when an entity appears or disappears', () => {
      const prev = [stateObj('light.desk', 'on', T1)];
      const grown = [stateObj('light.desk', 'on', T1), stateObj('light.new', 'off', T1)];
      expect(reconcileStates(prev, grown, null)).not.toBe(prev);
      expect(reconcileStates(grown, [grown[0]], null)).not.toBe(grown);
    });

    it('does not reuse the held array when the snapshot reorders it', () => {
      const a = stateObj('light.a', 'on', T1);
      const b = stateObj('light.b', 'on', T1);
      const prev = [a, b];
      const out = reconcileStates(prev, [stateObj('light.b', 'on', T1), stateObj('light.a', 'on', T1)], null);
      expect(out).not.toBe(prev);
      expect(out[0]).toBe(b);
      expect(out[1]).toBe(a);
    });
  });
});
