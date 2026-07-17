// Pure helpers for 24-hour sensor history sparklines: eligibility, window
// quantization, response parsing/downsampling, and SVG path math. The fetch
// itself lives in api.ts (fetchHistory); React rendering in cards.tsx.

import type { HAStateObject } from './types';
import { entityDomain } from './types';

export interface HistorySeries {
  /** Downsampled chronological bucket means, gaps forward-filled. */
  points: number[];
  /** True extremes of the raw window (footer label), not the bucket means. */
  min: number;
  max: number;
}

export const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HISTORY_BUCKETS = 64;
/** Window edges snap to 15-minute boundaries so repeated fetches inside the
 *  TTL produce byte-identical URLs — that is what lets the host proxy's GET
 *  cache (keyed by full URL) actually hit across displays and tabs. */
export const HISTORY_QUANTUM_MS = 15 * 60 * 1000;
export const HISTORY_TTL_MS = HISTORY_QUANTUM_MS;

/** Sparklines only make sense for numeric time series. HA's own marker for
 *  that is state_class 'measurement' (temperature, power, CO₂...); totals
 *  and counters would draw misleading ramps. */
export function isHistoryEligible(s: HAStateObject): boolean {
  return entityDomain(s.entity_id) === 'sensor'
    && s.attributes.state_class === 'measurement';
}

export function historyWindow(now = Date.now()): { startMs: number; endMs: number } {
  const endMs = Math.floor(now / HISTORY_QUANTUM_MS) * HISTORY_QUANTUM_MS;
  return { startMs: endMs - HISTORY_WINDOW_MS, endMs };
}

/** Parse an /api/history/period response (minimal_response + no_attributes:
 *  one array per entity, entity_id present only on the first entry). Series
 *  that yield fewer than two numeric points are dropped — a flat line drawn
 *  from one sample would be fiction. */
export function parseHistoryResponse(
  raw: unknown, startMs: number, endMs: number,
): Record<string, HistorySeries> {
  const out: Record<string, HistorySeries> = {};
  if (!Array.isArray(raw)) return out;
  for (const series of raw) {
    if (!Array.isArray(series) || series.length === 0) continue;
    const first = series[0] as { entity_id?: unknown } | null;
    const entityId = first && typeof first.entity_id === 'string' ? first.entity_id : null;
    if (!entityId) continue;
    const built = buildSeries(series, startMs, endMs);
    if (built) out[entityId] = built;
  }
  return out;
}

/** Bucket-mean a raw entry list into HISTORY_BUCKETS points across the
 *  window. Non-numeric states ('unavailable', 'unknown') are gaps; empty
 *  buckets carry the previous bucket's value forward, and leading empties
 *  take the first known value so the line always spans the full width. */
export function buildSeries(
  entries: unknown[], startMs: number, endMs: number, buckets = HISTORY_BUCKETS,
): HistorySeries | null {
  const span = endMs - startMs;
  if (span <= 0 || buckets < 2) return null;
  const sums = new Array<number>(buckets).fill(0);
  const counts = new Array<number>(buckets).fill(0);
  let min = Infinity;
  let max = -Infinity;
  let numericCount = 0;
  for (const e of entries) {
    if (typeof e !== 'object' || e === null) continue;
    const { state, last_changed: lastChanged } = e as { state?: unknown; last_changed?: unknown };
    if (typeof state !== 'string' || state === '' || typeof lastChanged !== 'string') continue;
    const v = Number(state);
    if (Number.isNaN(v)) continue;
    const t = Date.parse(lastChanged);
    if (Number.isNaN(t)) continue;
    numericCount += 1;
    if (v < min) min = v;
    if (v > max) max = v;
    const idx = Math.max(0, Math.min(buckets - 1, Math.floor(((t - startMs) / span) * buckets)));
    sums[idx] += v;
    counts[idx] += 1;
  }
  if (numericCount < 2) return null;
  const points = new Array<number>(buckets);
  let prev: number | null = null;
  for (let i = 0; i < buckets; i++) {
    if (counts[i] > 0) prev = sums[i] / counts[i];
    points[i] = prev ?? Number.NaN;
  }
  const firstKnown = points.find((p) => !Number.isNaN(p));
  if (firstKnown === undefined) return null;
  for (let i = 0; i < buckets && Number.isNaN(points[i]); i++) points[i] = firstKnown;
  return { points, min, max };
}

export interface SparkPaths {
  line: string;
  area: string;
  endX: number;
  endY: number;
}

/** SVG path strings for a w×h viewBox with vertical padding. Scaling uses
 *  the bucketed points' own extremes (so the line fills the strip); a flat
 *  series renders as a midline rather than dividing by zero. */
export function sparkPaths(series: HistorySeries, w = 100, h = 30, pad = 3): SparkPaths {
  const { points } = series;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = hi - lo;
  const n = points.length;
  const yOf = (v: number) => (span <= 0 ? h / 2 : pad + (1 - (v - lo) / span) * (h - pad * 2));
  const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * w);
  const coords = points.map((v, i) => `${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`);
  const line = `M${coords.join(' L')}`;
  const area = `${line} L${w.toFixed(2)},${h.toFixed(2)} L0,${h.toFixed(2)} Z`;
  return {
    line,
    area,
    endX: Number(xOf(n - 1).toFixed(2)),
    endY: Number(yOf(points[n - 1]).toFixed(2)),
  };
}
