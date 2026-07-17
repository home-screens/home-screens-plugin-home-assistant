import { describe, expect, it } from 'vitest';
import {
  isHistoryEligible, historyWindow, parseHistoryResponse, buildSeries, sparkPaths,
  HISTORY_WINDOW_MS, HISTORY_QUANTUM_MS, HISTORY_BUCKETS,
} from './history';
import { formatHistoryRange } from './utils';
import type { HAStateObject } from './types';

function sensor(attributes: Record<string, unknown> = {}, entityId = 'sensor.temp'): HAStateObject {
  return {
    entity_id: entityId,
    state: '72.4',
    attributes,
    last_changed: '2026-07-16T00:00:00Z',
    last_updated: '2026-07-16T00:00:00Z',
  };
}

const START = Date.parse('2026-07-15T00:00:00Z');
const END = START + HISTORY_WINDOW_MS;

function entry(offsetMs: number, state: string, entityId?: string) {
  return {
    ...(entityId ? { entity_id: entityId } : {}),
    state,
    last_changed: new Date(START + offsetMs).toISOString(),
  };
}

describe('isHistoryEligible', () => {
  it('accepts only measurement-class sensors', () => {
    expect(isHistoryEligible(sensor({ state_class: 'measurement' }))).toBe(true);
    expect(isHistoryEligible(sensor({ state_class: 'total_increasing' }))).toBe(false);
    expect(isHistoryEligible(sensor({}))).toBe(false);
    expect(isHistoryEligible(sensor({ state_class: 'measurement' }, 'binary_sensor.door'))).toBe(false);
  });
});

describe('historyWindow', () => {
  it('quantizes edges so URLs stay stable within the window', () => {
    const now = Date.parse('2026-07-16T12:07:33Z');
    const w = historyWindow(now);
    expect(w.endMs % HISTORY_QUANTUM_MS).toBe(0);
    expect(w.endMs).toBe(Date.parse('2026-07-16T12:00:00Z'));
    expect(w.endMs - w.startMs).toBe(HISTORY_WINDOW_MS);
    // Two calls 3 minutes apart inside the same quantum agree.
    expect(historyWindow(now + 3 * 60_000)).toEqual(w);
  });
});

describe('buildSeries', () => {
  it('bucket-means values and reports true raw extremes', () => {
    const hour = 60 * 60 * 1000;
    const entries = Array.from({ length: 24 }, (_, i) => entry(i * hour, String(60 + i)));
    const s = buildSeries(entries, START, END)!;
    expect(s.points).toHaveLength(HISTORY_BUCKETS);
    expect(s.min).toBe(60);
    expect(s.max).toBe(83);
    // Chronological: later buckets carry larger means.
    expect(s.points[0]).toBeLessThan(s.points[HISTORY_BUCKETS - 1]);
  });

  it('forward-fills gaps and backfills leading empties', () => {
    const s = buildSeries([
      entry(HISTORY_WINDOW_MS * 0.5, '10'),
      entry(HISTORY_WINDOW_MS * 0.9, '20'),
    ], START, END)!;
    expect(s.points[0]).toBe(10);           // leading empties take first value
    expect(s.points[HISTORY_BUCKETS - 1]).toBe(20);
    expect(s.points.every((p) => !Number.isNaN(p))).toBe(true);
  });

  it('skips non-numeric states and needs at least two numeric points', () => {
    expect(buildSeries([entry(0, 'unavailable'), entry(1000, '5')], START, END)).toBeNull();
    const s = buildSeries([
      entry(0, '5'), entry(1000, 'unavailable'), entry(HISTORY_WINDOW_MS - 1, '7'),
    ], START, END)!;
    expect(s.min).toBe(5);
    expect(s.max).toBe(7);
  });

  it('rejects a degenerate window or bucket count', () => {
    const entries = [entry(0, '1'), entry(1000, '2')];
    expect(buildSeries(entries, END, START)).toBeNull();  // reversed window
    expect(buildSeries(entries, START, START)).toBeNull(); // zero span
    expect(buildSeries(entries, START, END, 1)).toBeNull();
  });

  it('skips entries whose timestamp does not parse', () => {
    // The unparseable entry must not count toward the two-point minimum…
    expect(buildSeries([
      { state: '5', last_changed: 'garbage' },
      entry(1000, '6'),
    ], START, END)).toBeNull();
    // …nor contribute to the extremes when enough valid points remain.
    const s = buildSeries([
      { state: '5', last_changed: 'garbage' },
      entry(0, '6'), entry(1000, '7'),
    ], START, END)!;
    expect(s.min).toBe(6);
    expect(s.max).toBe(7);
  });

  it('clamps out-of-window timestamps into the edge buckets', () => {
    const s = buildSeries([
      entry(-5000, '1'), entry(HISTORY_WINDOW_MS + 5000, '3'),
    ], START, END)!;
    expect(s.points[0]).toBe(1);
    expect(s.points[HISTORY_BUCKETS - 1]).toBe(3);
  });
});

describe('parseHistoryResponse', () => {
  it('keys series by the first entry entity_id (minimal_response shape)', () => {
    const raw = [
      [entry(0, '1', 'sensor.a'), entry(1000, '2')],
      [entry(0, '5', 'sensor.b'), entry(1000, '6')],
    ];
    const out = parseHistoryResponse(raw, START, END);
    expect(Object.keys(out).sort()).toEqual(['sensor.a', 'sensor.b']);
    expect(out['sensor.a'].max).toBe(2);
  });

  it('drops malformed series and non-array payloads without throwing', () => {
    expect(parseHistoryResponse(null, START, END)).toEqual({});
    expect(parseHistoryResponse([[], 'nope', [entry(0, '1')]], START, END)).toEqual({});
    // Single numeric point → dropped (a one-sample line is fiction).
    expect(parseHistoryResponse([[entry(0, '1', 'sensor.a')]], START, END)).toEqual({});
  });
});

describe('sparkPaths', () => {
  it('spans the full width and scales to the point extremes', () => {
    const paths = sparkPaths({ points: [0, 10, 5], min: 0, max: 10 }, 100, 30, 3);
    expect(paths.line.startsWith('M0.00,27.00')).toBe(true);  // min → bottom pad
    expect(paths.line).toContain('50.00,3.00');               // max → top pad
    expect(paths.endX).toBe(100);
    expect(paths.area.endsWith('L100.00,30.00 L0,30.00 Z')).toBe(true);
  });

  it('renders flat series as a midline instead of dividing by zero', () => {
    const paths = sparkPaths({ points: [4, 4, 4], min: 4, max: 4 }, 100, 30, 3);
    expect(paths.line).toBe('M0.00,15.00 L50.00,15.00 L100.00,15.00');
    expect(paths.endY).toBe(15);
  });
});

describe('formatHistoryRange', () => {
  it('shares formatValue unit/precision rules with one precision for both bounds', () => {
    expect(formatHistoryRange(sensor({ unit_of_measurement: '°F' }), 68.93, 73.12))
      .toBe('68.9 – 73.1°F');
    // kW under 10 gets 2 decimals, matching the card's own "1.24 kW".
    expect(formatHistoryRange(sensor({ unit_of_measurement: 'kW' }), 0.42, 4.81))
      .toBe('0.42 – 4.81 kW');
    expect(formatHistoryRange(sensor({ unit_of_measurement: '%' }), 41.2, 52.8))
      .toBe('41 – 53 %');
    expect(formatHistoryRange(sensor({}), 1.5, 2.5)).toBe('1.5 – 2.5');
  });

  it('respects suggested_display_precision', () => {
    expect(formatHistoryRange(
      sensor({ unit_of_measurement: 'ppm', suggested_display_precision: 0 }), 512.4, 1240.2,
    )).toBe('512 – 1240 ppm');
  });
});
