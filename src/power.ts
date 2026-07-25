// Pure model for the `power` view: which of the selected entities is the
// power reading, and the day's numbers underneath it. No React, no fetch —
// the chart data is the same 24h history the sparklines already load
// (history.ts), so this view costs no API call the plugin didn't make.
//
// Deliberately NOT the full HA energy dashboard: that one needs long-term
// statistics and the energy preferences flow, both WebSocket-only. What a
// kiosk actually wants is "how much is the house pulling right now, and is
// that a lot for today" — one number, one day of context.

import type { HAStateObject } from './types';
import { entityDomain } from './types';
import type { HistorySeries } from './history';

/** Units that make an unclassified sensor a rate-of-flow reading. HA sets
 *  device_class on most of them, but DIY template sensors often don't. */
const POWER_UNITS = new Set(['W', 'kW', 'MW', 'VA', 'kVA']);

export function isPowerSensor(s: HAStateObject): boolean {
  if (entityDomain(s.entity_id) !== 'sensor') return false;
  if (s.attributes.device_class === 'power') return true;
  const unit = s.attributes.unit_of_measurement;
  return typeof unit === 'string' && POWER_UNITS.has(unit.trim());
}

/**
 * The entity the view renders. A real power sensor wins; failing that the
 * first selected sensor of any kind, because the view — big number, day
 * chart, day's low/average/high — reads correctly for any measurement, and
 * showing the water-flow sensor somebody picked beats an empty state
 * lecturing them about device classes.
 */
export function pickPowerEntity(states: HAStateObject[]): HAStateObject | null {
  return states.find(isPowerSensor)
    ?? states.find((s) => entityDomain(s.entity_id) === 'sensor')
    ?? null;
}

export interface PowerStats {
  /** Extremes of the bucketed series — the same numbers the chart is scaled
   *  to, so Low and High name points the curve actually reaches. The raw
   *  window's extremes (series.min/max) are higher whenever a spike is
   *  shorter than a bucket, and printing those beside the chart labels a peak
   *  that isn't drawn anywhere on it. */
  min: number;
  max: number;
  /** Mean of the bucketed series. Buckets are equal slices of the window and
   *  empty ones carry the previous value forward, so this is an even
   *  time-weighted average of the day — near enough for "is right now a lot",
   *  not an energy total. Buckets before the sensor's first sample are
   *  back-filled for the chart's sake and excluded here: a sensor added three
   *  hours ago has no opinion about the other twenty-one. */
  avg: number;
}

export function powerStats(series: HistorySeries): PowerStats {
  const { points, firstSampleIndex } = series;
  const measured = points.slice(firstSampleIndex);
  const sum = measured.reduce((acc, v) => acc + v, 0);
  return {
    min: Math.min(...points),
    max: Math.max(...points),
    avg: sum / measured.length,
  };
}
