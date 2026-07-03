import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAST_POLL_MS, subscribeFastPoll, __resetFastPollForTests } from './fast-poll';
import * as api from './api';

vi.mock('./api', () => ({
  fetchEntityStates: vi.fn(),
}));

const fetchEntityStates = vi.mocked(api.fetchEntityStates);

async function flushTicks(): Promise<void> {
  // The tick's fetch promise resolves on the microtask queue; advancing the
  // fake timer alone doesn't run it.
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchEntityStates.mockReset();
});

afterEach(() => {
  __resetFastPollForTests();
  vi.useRealTimers();
});

describe('subscribeFastPoll', () => {
  it('ticks immediately, then every FAST_POLL_MS, notifying changed entities only', async () => {
    fetchEntityStates.mockResolvedValue([{ entity_id: 'light.a', state: 'off' }]);
    const listener = vi.fn();
    subscribeFastPoll('http://ha:8123', ['light.a'], listener);
    await flushTicks();

    expect(fetchEntityStates).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([{ entity_id: 'light.a', state: 'off' }]);

    // Same value on the next tick — no notification.
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(fetchEntityStates).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);

    // Value flips — notified with just the changed entry.
    fetchEntityStates.mockResolvedValue([{ entity_id: 'light.a', state: 'on' }]);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith([{ entity_id: 'light.a', state: 'on' }]);
  });

  it('shares one loop across subscribers of the same haUrl, polling the entity union', async () => {
    fetchEntityStates.mockResolvedValue([]);
    const a = vi.fn();
    const b = vi.fn();
    subscribeFastPoll('http://ha:8123', ['light.a'], a);
    subscribeFastPoll('http://ha:8123', ['light.a', 'sensor.b'], b);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);

    // One shared loop: the second subscribe does not start its own interval
    // (only the first subscriber's immediate tick plus interval ticks fire).
    const perTickCalls = fetchEntityStates.mock.calls;
    expect(perTickCalls.length).toBe(2); // immediate + 1 interval
    expect(perTickCalls[perTickCalls.length - 1][1]).toEqual(['light.a', 'sensor.b']);
  });

  it('stops polling when the last subscriber releases, and release is idempotent', async () => {
    fetchEntityStates.mockResolvedValue([]);
    const release1 = subscribeFastPoll('http://ha:8123', ['light.a'], vi.fn());
    const release2 = subscribeFastPoll('http://ha:8123', ['light.a'], vi.fn());
    await flushTicks();
    const callsBefore = fetchEntityStates.mock.calls.length;

    release1();
    release1(); // idempotent — must not double-decrement the refcount
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(fetchEntityStates.mock.calls.length).toBeGreaterThan(callsBefore);

    release2();
    const callsAfter = fetchEntityStates.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
    expect(fetchEntityStates.mock.calls.length).toBe(callsAfter);
  });

  it('re-notifies an entity after full release and re-subscribe (baseline cleared)', async () => {
    fetchEntityStates.mockResolvedValue([{ entity_id: 'light.a', state: 'off' }]);
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
    expect(second).toHaveBeenCalledWith([{ entity_id: 'light.a', state: 'off' }]);
  });

  it('swallows fetch errors and keeps polling', async () => {
    fetchEntityStates.mockRejectedValueOnce(new Error('boom'));
    fetchEntityStates.mockResolvedValue([{ entity_id: 'light.a', state: 'on' }]);
    const listener = vi.fn();
    subscribeFastPoll('http://ha:8123', ['light.a'], listener);
    await flushTicks();
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(listener).toHaveBeenCalledWith([{ entity_id: 'light.a', state: 'on' }]);
  });

  it('does not let one throwing listener starve its siblings', async () => {
    fetchEntityStates.mockResolvedValue([{ entity_id: 'light.a', state: 'on' }]);
    const bad = vi.fn(() => { throw new Error('listener bug'); });
    const good = vi.fn();
    subscribeFastPoll('http://ha:8123', ['light.a'], bad);
    subscribeFastPoll('http://ha:8123', ['light.a'], good);
    await flushTicks();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
