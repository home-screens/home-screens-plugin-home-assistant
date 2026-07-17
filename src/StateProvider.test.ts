import { afterEach, describe, expect, it } from 'vitest';
import type { HAStateObject } from './types';
import {
  selectPublishableRefs, planFullPublish, planShrinkClears,
  planVanishedClears, planFastPublish, planFastBuffer, planReadopt,
  planHealthReport, emitProviderHealth,
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
  it('holds a first miss, then clears on the second consecutive miss', () => {
    const published = new Set(['light.kitchen', 'sensor.renamed_away']);
    const demanded = ['light.kitchen', 'sensor.renamed_away'];
    const resolved = new Set(['light.kitchen']);
    // First miss: nothing cleared, the ref is recorded as pending.
    const first = planVanishedClears(published, demanded, resolved, new Set());
    expect(first.clears).toEqual([]);
    expect([...first.nextMisses]).toEqual(['sensor.renamed_away']);
    // Second consecutive miss: now it clears.
    const second = planVanishedClears(published, demanded, resolved, first.nextMisses);
    expect(second.clears).toEqual(['sensor.renamed_away']);
    expect([...second.nextMisses]).toEqual([]);
  });

  it('clears an attribute ref whose attribute vanished for two consecutive polls', () => {
    // media_title disappears when playback stops: the entity still resolves,
    // the attribute ref does not.
    const published = new Set(['media_player.tv', 'media_player.tv:media_title']);
    const demanded = ['media_player.tv', 'media_player.tv:media_title'];
    const resolved = new Set(['media_player.tv']);
    const first = planVanishedClears(published, demanded, resolved, new Set());
    expect(first.clears).toEqual([]);
    expect(planVanishedClears(published, demanded, resolved, first.nextMisses).clears)
      .toEqual(['media_player.tv:media_title']);
  });

  it('resets the miss state as soon as a ref resolves again (one miss then back)', () => {
    const published = new Set(['sensor.flaky']);
    const demanded = ['sensor.flaky'];
    // Miss once (partial startup snapshot), then it resolves on the next poll.
    const first = planVanishedClears(published, demanded, new Set(), new Set());
    expect(first.clears).toEqual([]);
    expect([...first.nextMisses]).toEqual(['sensor.flaky']);
    const recovered = planVanishedClears(published, demanded, new Set(['sensor.flaky']), first.nextMisses);
    expect(recovered.clears).toEqual([]);
    expect([...recovered.nextMisses]).toEqual([]);
  });

  it('leaves keys that dropped out of demand to the shrink path', () => {
    const published = new Set(['sensor.no_longer_demanded']);
    const out = planVanishedClears(published, ['light.kitchen'], new Set(['light.kitchen']), new Set(['sensor.no_longer_demanded']));
    expect(out.clears).toEqual([]);
    expect([...out.nextMisses]).toEqual([]);
  });

  it('clears nothing when every published ref still resolves', () => {
    const published = new Set(['light.kitchen']);
    const out = planVanishedClears(published, ['light.kitchen'], new Set(['light.kitchen']), new Set());
    expect(out.clears).toEqual([]);
    expect([...out.nextMisses]).toEqual([]);
  });
});

describe('planReadopt', () => {
  const updates = [
    { ref: 'media_player.tv:media_title', value: 'Song' },
    { ref: 'light.kitchen', value: 'on' },
    { ref: 'sensor.widget_only', value: '5' },
  ];

  it('re-adopts recently-cleared refs that are still demanded', () => {
    const cleared = new Set(['media_player.tv:media_title']);
    const demanded = new Set(['media_player.tv:media_title', 'light.kitchen']);
    expect(planReadopt(cleared, demanded, updates))
      .toEqual([{ ref: 'media_player.tv:media_title', value: 'Song' }]);
  });

  it('never re-adopts a ref that left the demand set (stale in the cleared window)', () => {
    const cleared = new Set(['sensor.widget_only']);
    const demanded = new Set(['light.kitchen']);
    expect(planReadopt(cleared, demanded, updates)).toEqual([]);
  });

  it('re-adopts nothing when the cleared set is empty', () => {
    expect(planReadopt(new Set(), new Set(['light.kitchen']), updates)).toEqual([]);
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

describe('planHealthReport', () => {
  // Only the full poll feeds outcomes into this function; the fast lane never
  // does (it has no failure→report path at all), so "fast-lane never reports"
  // is a property of the wiring, and every case below is a full-poll outcome.

  it('opens an outage on the first failure, reporting not-ok with since = failure time', () => {
    const out = planHealthReport(null, { ok: false, message: "Can't reach", at: 1000 });
    expect(out.report).toEqual({ ok: false, message: "Can't reach", since: 1000 });
    expect(out.outage).toEqual({ since: 1000 });
  });

  it('keeps the same since across consecutive failures and re-reports each time', () => {
    let outage = null as { since: number } | null;
    const times = [1000, 1060_000, 1120_000];
    for (const at of times) {
      const out = planHealthReport(outage, { ok: false, message: "Can't reach", at });
      // since is pinned to the FIRST failure (1000), never the later poll time.
      expect(out.report).toEqual({ ok: false, message: "Can't reach", since: 1000 });
      outage = out.outage;
    }
    expect(outage).toEqual({ since: 1000 });
  });

  it('reports ok exactly once on recovery, then stays silent while healthy', () => {
    const recovered = planHealthReport({ since: 1000 }, { ok: true });
    expect(recovered.report).toEqual({ ok: true });
    expect(recovered.outage).toBeNull();
    // A subsequent healthy poll reports nothing.
    const stillHealthy = planHealthReport(recovered.outage, { ok: true });
    expect(stillHealthy.report).toBeNull();
    expect(stillHealthy.outage).toBeNull();
  });

  it('reports nothing on a success that was never preceded by an outage', () => {
    const out = planHealthReport(null, { ok: true });
    expect(out.report).toBeNull();
    expect(out.outage).toBeNull();
  });
});

describe('emitProviderHealth', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else delete (globalThis as { window?: unknown }).window;
  });
  function setWindow(value: unknown) {
    Object.defineProperty(globalThis, 'window', { value, configurable: true, writable: true });
  }

  it('never throws when the host SDK is absent', () => {
    setWindow({});
    expect(() => emitProviderHealth({ ok: true })).not.toThrow();
  });

  it('never throws when an older host lacks reportProviderHealth', () => {
    setWindow({ __HS_SDK__: {} });
    expect(() => emitProviderHealth({ ok: false, message: 'Down', since: 1 })).not.toThrow();
  });

  it('forwards the plugin id and status to the host method', () => {
    const calls: unknown[][] = [];
    setWindow({ __HS_SDK__: { reportProviderHealth: (...args: unknown[]) => calls.push(args) } });
    emitProviderHealth({ ok: false, message: 'Down', since: 42 });
    expect(calls).toEqual([['home-assistant', { ok: false, message: 'Down', since: 42 }]]);
  });
});
