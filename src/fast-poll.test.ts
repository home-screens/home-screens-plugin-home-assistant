import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAST_POLL_MS, resetFastPollBaseline, subscribeFastPoll, __resetFastPollForTests,
} from './fast-poll';
import * as api from './api';

vi.mock('./api', () => ({
  fetchEntityRefs: vi.fn(),
}));

const fetchEntityRefs = vi.mocked(api.fetchEntityRefs);

async function flushTicks(): Promise<void> {
  // The tick's fetch promise resolves on the microtask queue; advancing the
  // fake timer alone doesn't run it.
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchEntityRefs.mockReset();
});

afterEach(() => {
  __resetFastPollForTests();
  vi.useRealTimers();
});

describe('subscribeFastPoll', () => {
  it('ticks immediately, then every FAST_POLL_MS, notifying changed refs only', async () => {
    fetchEntityRefs.mockResolvedValue([{ ref: 'light.a', value: 'off' }]);
    const listener = vi.fn();
    subscribeFastPoll('http://ha:8123', ['light.a'], listener);
    await flushTicks();

    expect(fetchEntityRefs).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([{ ref: 'light.a', value: 'off' }]);

    // Same value on the next tick — no notification.
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(fetchEntityRefs).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);

    // Value flips — notified with just the changed entry.
    fetchEntityRefs.mockResolvedValue([{ ref: 'light.a', value: 'on' }]);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith([{ ref: 'light.a', value: 'on' }]);
  });

  it('tracks attribute refs alongside state refs, change-detected per ref', async () => {
    fetchEntityRefs.mockResolvedValue([
      { ref: 'sensor.phone', value: 'home' },
      { ref: 'sensor.phone:battery_level', value: '84' },
    ]);
    const listener = vi.fn();
    subscribeFastPoll('http://ha:8123', ['sensor.phone', 'sensor.phone:battery_level'], listener);
    await flushTicks();
    expect(listener).toHaveBeenLastCalledWith([
      { ref: 'sensor.phone', value: 'home' },
      { ref: 'sensor.phone:battery_level', value: '84' },
    ]);

    // Only the attribute changes — the state ref stays silent.
    fetchEntityRefs.mockResolvedValue([
      { ref: 'sensor.phone', value: 'home' },
      { ref: 'sensor.phone:battery_level', value: '83' },
    ]);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(listener).toHaveBeenLastCalledWith([{ ref: 'sensor.phone:battery_level', value: '83' }]);
  });

  it('skips null values without disturbing the change baseline', async () => {
    fetchEntityRefs.mockResolvedValue([{ ref: 'sensor.phone:battery_level', value: '84' }]);
    const listener = vi.fn();
    subscribeFastPoll('http://ha:8123', ['sensor.phone:battery_level'], listener);
    await flushTicks();
    expect(listener).toHaveBeenCalledTimes(1);

    // Attribute vanishes (null) — no notification, baseline untouched.
    fetchEntityRefs.mockResolvedValue([{ ref: 'sensor.phone:battery_level', value: null }]);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(listener).toHaveBeenCalledTimes(1);

    // It returns with the same value — still silent against the held
    // baseline (the StateProvider resets the baseline when it clears a
    // vanished key, tested below); a different value notifies.
    fetchEntityRefs.mockResolvedValue([{ ref: 'sensor.phone:battery_level', value: '84' }]);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(listener).toHaveBeenCalledTimes(1);
    fetchEntityRefs.mockResolvedValue([{ ref: 'sensor.phone:battery_level', value: '70' }]);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('skips a null-emitted ref while other refs in the same batch still update', async () => {
    // Fix 3: the template guard nulls a non-primitive attribute (e.g. a
    // datetime) rather than 400ing the batch, so fetchEntityRefs returns null
    // for it. That one ref must be skipped while its batch siblings notify.
    fetchEntityRefs.mockResolvedValue([
      { ref: 'automation.dishwasher:last_triggered', value: null },
      { ref: 'sensor.phone:battery_level', value: '84' },
    ]);
    const listener = vi.fn();
    subscribeFastPoll('http://ha:8123', [
      'automation.dishwasher:last_triggered', 'sensor.phone:battery_level',
    ], listener);
    await flushTicks();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith([{ ref: 'sensor.phone:battery_level', value: '84' }]);
  });

  it('re-notifies an unchanged value after resetFastPollBaseline', async () => {
    fetchEntityRefs.mockResolvedValue([{ ref: 'sensor.phone:battery_level', value: '84' }]);
    const listener = vi.fn();
    subscribeFastPoll('http://ha:8123', ['sensor.phone:battery_level'], listener);
    await flushTicks();
    expect(listener).toHaveBeenCalledTimes(1);

    // The attribute vanishes; the full poll clears the key and resets the
    // baseline. When it returns at its pre-vanish value, the next tick must
    // re-notify — otherwise the cleared key stays unknown on the bus until
    // the next full poll.
    fetchEntityRefs.mockResolvedValue([{ ref: 'sensor.phone:battery_level', value: null }]);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    resetFastPollBaseline('http://ha:8123', 'sensor.phone:battery_level');

    fetchEntityRefs.mockResolvedValue([{ ref: 'sensor.phone:battery_level', value: '84' }]);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith([{ ref: 'sensor.phone:battery_level', value: '84' }]);
  });

  it('resetFastPollBaseline is a no-op for unknown urls and refs', () => {
    expect(() => resetFastPollBaseline('http://nowhere:1', 'light.a')).not.toThrow();
  });

  it('a clear during an inflight tick keeps the baseline cleared so the return re-notifies', async () => {
    // Fix 12(b): the reset races the tick's own lastValues.set. Hang the
    // immediate tick's fetch, call resetFastPollBaseline mid-await, then let
    // the pre-clear value land. Without the guard the completing tick would
    // re-establish that value as the baseline, silently swallowing the ref's
    // eventual return at the same value.
    let resolveFetch!: (v: Array<{ ref: string; value: string | null }>) => void;
    fetchEntityRefs.mockImplementationOnce(
      () => new Promise((res) => { resolveFetch = res; }),
    );
    const listener = vi.fn();
    subscribeFastPoll('http://ha:8123', ['sensor.co2:x'], listener);
    // The immediate tick is now awaiting its fetch; clear the baseline.
    resetFastPollBaseline('http://ha:8123', 'sensor.co2:x');
    resolveFetch([{ ref: 'sensor.co2:x', value: '900' }]);
    await flushTicks();

    // The baseline must be cleared, not re-set to '900': the same value on the
    // next tick has to re-notify.
    const callsBefore = listener.mock.calls.length;
    fetchEntityRefs.mockResolvedValue([{ ref: 'sensor.co2:x', value: '900' }]);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(listener.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(listener).toHaveBeenLastCalledWith([{ ref: 'sensor.co2:x', value: '900' }]);
  });

  it('shares one loop across subscribers of the same haUrl, polling the ref union', async () => {
    fetchEntityRefs.mockResolvedValue([]);
    const a = vi.fn();
    const b = vi.fn();
    subscribeFastPoll('http://ha:8123', ['light.a'], a);
    subscribeFastPoll('http://ha:8123', ['light.a', 'sensor.b:battery_level'], b);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);

    // One shared loop: the second subscribe does not start its own interval
    // (only the first subscriber's immediate tick plus interval ticks fire).
    const perTickCalls = fetchEntityRefs.mock.calls;
    expect(perTickCalls.length).toBe(2); // immediate + 1 interval
    expect(perTickCalls[perTickCalls.length - 1][1]).toEqual(['light.a', 'sensor.b:battery_level']);
  });

  it('stops polling when the last subscriber releases, and release is idempotent', async () => {
    fetchEntityRefs.mockResolvedValue([]);
    const release1 = subscribeFastPoll('http://ha:8123', ['light.a'], vi.fn());
    const release2 = subscribeFastPoll('http://ha:8123', ['light.a'], vi.fn());
    await flushTicks();
    const callsBefore = fetchEntityRefs.mock.calls.length;

    release1();
    release1(); // idempotent — must not double-decrement the refcount
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(fetchEntityRefs.mock.calls.length).toBeGreaterThan(callsBefore);

    release2();
    const callsAfter = fetchEntityRefs.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
    expect(fetchEntityRefs.mock.calls.length).toBe(callsAfter);
  });

  it('re-notifies a ref after full release and re-subscribe (baseline cleared)', async () => {
    fetchEntityRefs.mockResolvedValue([{ ref: 'light.a', value: 'off' }]);
    const first = vi.fn();
    const release = subscribeFastPoll('http://ha:8123', ['light.a'], first);
    await flushTicks();
    expect(first).toHaveBeenCalledTimes(1);
    release();

    const second = vi.fn();
    subscribeFastPoll('http://ha:8123', ['light.a'], second);
    await flushTicks();
    // Unchanged upstream value, but the baseline was dropped on release —
    // the new subscriber still gets an initial notification.
    expect(second).toHaveBeenCalledWith([{ ref: 'light.a', value: 'off' }]);
  });

  it('swallows fetch errors and keeps polling', async () => {
    fetchEntityRefs.mockRejectedValueOnce(new Error('boom'));
    fetchEntityRefs.mockResolvedValue([{ ref: 'light.a', value: 'on' }]);
    const listener = vi.fn();
    subscribeFastPoll('http://ha:8123', ['light.a'], listener);
    await flushTicks();
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(listener).toHaveBeenCalledWith([{ ref: 'light.a', value: 'on' }]);
  });

  it('does not let one throwing listener starve its siblings', async () => {
    fetchEntityRefs.mockResolvedValue([{ ref: 'light.a', value: 'on' }]);
    const bad = vi.fn(() => { throw new Error('listener bug'); });
    const good = vi.fn();
    subscribeFastPoll('http://ha:8123', ['light.a'], bad);
    subscribeFastPoll('http://ha:8123', ['light.a'], good);
    await flushTicks();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
