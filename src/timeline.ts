// Pure helpers for the timeline view: the 24-hour history window, response
// parsing, which states count as "active" per domain, the active spans a
// lane draws, the lane tone, the sentences in the feed, the lane summaries,
// and hour-tick positions. The fetch lives in api.ts (fetchTimeline); React
// rendering in TimelineView.tsx.

import type { HAStateObject } from './types';
import { entityDomain } from './types';
import { isActiveState, capitalize, clockFormatter } from './utils';
import type { AccentName } from './theme';
import { tr } from './i18n';

export interface TimelineTransition {
  state: string;
  /** Epoch ms of the change. */
  at: number;
}

/** Chronological transitions per entity id. */
export type TimelineData = Record<string, TimelineTransition[]>;

export interface TimelineSegment {
  startMs: number;
  endMs: number;
}

export interface TimelineEvent {
  entityId: string;
  at: number;
  state: string;
}

export const TIMELINE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Window edges snap to 5-minute marks so the URL stays byte-identical for
 *  five minutes and the host proxy's GET cache dedupes across displays. */
export const TIMELINE_QUANTUM_MS = 5 * 60 * 1000;
export const TIMELINE_POLL_MS = 60_000;
/** Below the poll interval, so a tick never re-serves the snapshot the
 *  previous tick already painted. */
export const TIMELINE_TTL_MS = 45_000;
/** The feed stops here; the rest is counted as "and N more earlier". */
export const TIMELINE_FEED_CAP = 60;
/** A door blip shorter than this still draws at the minimum bar width. */
export const TIMELINE_MIN_SPAN_MS = 90 * 1000;

/** Start floored and end ceiled to the quantum, so the window always covers
 *  the last 24 hours and a little more. */
export function timelineWindow(now = Date.now()): { startMs: number; endMs: number } {
  const startMs = Math.floor((now - TIMELINE_WINDOW_MS) / TIMELINE_QUANTUM_MS) * TIMELINE_QUANTUM_MS;
  const endMs = Math.ceil(now / TIMELINE_QUANTUM_MS) * TIMELINE_QUANTUM_MS;
  return { startMs, endMs };
}

/** Parse an /api/history/period response (minimal_response + no_attributes:
 *  one array per entity, entity_id on the first entry only) into every
 *  transition, numeric or not, in chronological order. */
export function parseTimelineResponse(raw: unknown): TimelineData {
  const out: TimelineData = {};
  if (!Array.isArray(raw)) return out;
  for (const series of raw) {
    if (!Array.isArray(series) || series.length === 0) continue;
    const first = series[0] as { entity_id?: unknown } | null;
    const entityId = first && typeof first.entity_id === 'string' ? first.entity_id : null;
    if (!entityId) continue;
    const list: TimelineTransition[] = [];
    for (const e of series) {
      if (typeof e !== 'object' || e === null) continue;
      const { state, last_changed: lastChanged } = e as { state?: unknown; last_changed?: unknown };
      if (typeof state !== 'string' || typeof lastChanged !== 'string') continue;
      const at = Date.parse(lastChanged);
      if (Number.isNaN(at)) continue;
      list.push({ state, at });
    }
    list.sort((a, b) => a.at - b.at);
    out[entityId] = list;
  }
  return out;
}

/** Whether a raw state counts as "on" for a lane: on, home, open, unlocked,
 *  playing, heating, cleaning... People are the one domain the card rules
 *  never cover, so they get their own check; everything else reuses the
 *  card tone rule through a throwaway state object. */
export function isActiveTimelineState(entityId: string, state: string): boolean {
  if (state === 'unavailable' || state === 'unknown' || state === '') return false;
  const domain = entityDomain(entityId);
  if (domain === 'person' || domain === 'device_tracker') return state === 'home';
  if (domain === 'media_player') return state === 'playing';
  if (domain === 'script' || domain === 'scene') return false;
  return isActiveState({
    entity_id: entityId, state, attributes: {}, last_changed: '', last_updated: '',
  });
}

/** The history list with the live state folded in: when the poll already
 *  knows a change history has not reported yet, it lands as the last
 *  transition. A live reading older than the last history entry is the
 *  stale one (a cache-aged poll) and history wins. */
export function withLiveState(
  transitions: readonly TimelineTransition[], live: TimelineTransition | null | undefined,
): TimelineTransition[] {
  if (!live) return [...transitions];
  const last = transitions[transitions.length - 1];
  if (last && (last.state === live.state || live.at <= last.at)) return [...transitions];
  return [...transitions, { state: live.state, at: live.at }];
}

/** Spans where the entity was active, clipped to the window. The last span
 *  runs to endMs when the entity is still active. */
export function segments(
  entityId: string,
  transitions: readonly TimelineTransition[],
  startMs: number,
  endMs: number,
  live?: TimelineTransition | null,
): TimelineSegment[] {
  const list = withLiveState(transitions, live);
  const out: TimelineSegment[] = [];
  let openAt: number | null = null;
  for (const t of list) {
    const at = Math.max(startMs, Math.min(endMs, t.at));
    const active = isActiveTimelineState(entityId, t.state);
    if (active && openAt === null) openAt = at;
    if (!active && openAt !== null) {
      if (at > openAt) out.push({ startMs: openAt, endMs: at });
      openAt = null;
    }
  }
  if (openAt !== null && endMs > openAt) out.push({ startMs: openAt, endMs });
  return out;
}

export type LaneTone = Extract<AccentName, 'amber' | 'blue' | 'red' | 'green' | 'purple' | 'orange'>;

const OPENING_CLASSES = new Set(['door', 'garage_door', 'window', 'opening', 'garage']);

function isOpening(entityId: string, deviceClass?: string): boolean {
  const domain = entityDomain(entityId);
  if (domain === 'cover') return true;
  return domain === 'binary_sensor' && deviceClass != null && OPENING_CLASSES.has(deviceClass);
}

/** Hue for a lane and its feed chips: amber for things that switch on, blue
 *  for people, red for doors and windows, green for locks, purple for
 *  media, orange for climate. */
export function laneTone(entityId: string, deviceClass?: string): LaneTone {
  const domain = entityDomain(entityId);
  if (domain === 'person' || domain === 'device_tracker') return 'blue';
  if (domain === 'media_player') return 'purple';
  if (domain === 'lock') return 'green';
  if (domain === 'climate' || domain === 'water_heater') return 'orange';
  if (isOpening(entityId, deviceClass)) return 'red';
  if (domain === 'binary_sensor' && deviceClass === 'lock') return 'green';
  if (domain === 'binary_sensor') return 'blue';
  if (domain === 'vacuum' || domain === 'lawn_mower') return 'purple';
  return 'amber';
}

/** Every change in the window, newest first, with the live state folded in.
 *  The first entry of each series is Home Assistant's "state at the start of
 *  the window", not a change, so it is skipped. Drops to and from
 *  unavailable/unknown are noise rather than news and are left out. */
export function timelineEvents(
  data: TimelineData,
  liveById: ReadonlyMap<string, TimelineTransition>,
  startMs: number,
  endMs: number,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const ids = new Set<string>([...Object.keys(data), ...liveById.keys()]);
  for (const entityId of ids) {
    const history = data[entityId] ?? [];
    const list = withLiveState(history, liveById.get(entityId));
    for (let i = 1; i < list.length; i++) {
      const { state, at } = list[i];
      const prev = list[i - 1].state;
      if (at < startMs || at > endMs) continue;
      if (isNoise(state) || isNoise(prev)) continue;
      if (state === prev) continue;
      out.push({ entityId, at, state });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

function isNoise(state: string): boolean {
  return state === 'unavailable' || state === 'unknown' || state === '';
}

/** A person's state outside home/not_home is the zone's friendly name as
 *  Home Assistant stores it ("School", "Grandma's house"); this only tidies
 *  an underscored one. */
function zoneName(state: string): string {
  return capitalize(state.replace(/_/g, ' '));
}

/** One sentence for a change: "{name} turned on", "{name} came home". The
 *  whole sentence goes through tr() so word order can change per language;
 *  the view finds the name inside it to set it bold. */
export function eventSentence(
  entityId: string, state: string, name: string, deviceClass?: string,
): string {
  const domain = entityDomain(entityId);
  const vars = { name };
  if (domain === 'person' || domain === 'device_tracker') {
    if (state === 'home') return tr('timeline.cameHome', '{name} came home', vars);
    if (state === 'not_home') return tr('timeline.leftHome', '{name} left home', vars);
    return tr('timeline.arrivedAt', '{name} arrived at {zone}', { ...vars, zone: zoneName(state) });
  }
  if (domain === 'lock' || (domain === 'binary_sensor' && deviceClass === 'lock')) {
    const s = domain === 'binary_sensor' ? (state === 'on' ? 'unlocked' : 'locked') : state;
    if (s === 'locked') return tr('timeline.locked', '{name} locked', vars);
    if (s === 'unlocked') return tr('timeline.unlocked', '{name} unlocked', vars);
  }
  if (isOpening(entityId, deviceClass)) {
    if (state === 'on' || state === 'open' || state === 'opening') {
      return tr('timeline.opened', '{name} opened', vars);
    }
    if (state === 'off' || state === 'closed' || state === 'closing') {
      return tr('timeline.closed', '{name} closed', vars);
    }
  }
  if (domain === 'binary_sensor') {
    switch (deviceClass) {
      case 'motion': case 'occupancy': case 'presence': case 'moving': case 'vibration':
        return state === 'on'
          ? tr('timeline.sawMovement', '{name} saw movement', vars)
          : tr('timeline.wentQuiet', '{name} went quiet', vars);
      case 'moisture':
        return state === 'on'
          ? tr('timeline.gotWet', '{name} got wet', vars)
          : tr('timeline.driedOut', '{name} dried out', vars);
      default:
        break;
    }
  }
  if (domain === 'media_player') {
    if (state === 'playing') return tr('timeline.startedPlaying', '{name} started playing', vars);
    if (state === 'paused') return tr('timeline.paused', '{name} paused', vars);
    if (state === 'idle' || state === 'standby') return tr('timeline.stopped', '{name} stopped', vars);
  }
  if (domain === 'climate') {
    if (state === 'heat' || state === 'heating') return tr('timeline.startedHeating', '{name} started heating', vars);
    if (state === 'cool' || state === 'cooling') return tr('timeline.startedCooling', '{name} started cooling', vars);
    if (state === 'idle') return tr('timeline.wentIdle', '{name} went idle', vars);
  }
  if (domain === 'vacuum' || domain === 'lawn_mower') {
    if (state === 'cleaning' || state === 'mowing') return tr('timeline.startedCleaning', '{name} started cleaning', vars);
    if (state === 'docked') return tr('timeline.docked', '{name} went back to its dock', vars);
  }
  if (state === 'on') return tr('timeline.turnedOn', '{name} turned on', vars);
  if (state === 'off') return tr('timeline.turnedOff', '{name} turned off', vars);
  return tr('timeline.isNow', '{name} is now {state}', { ...vars, state: capitalize(state) });
}

/** Split a sentence around the entity name so the view can set the name in
 *  a heavier weight. Falls back to the whole sentence when a translation
 *  did not keep the name verbatim. */
export function splitAroundName(
  sentence: string, name: string,
): { before: string; name: string; after: string } | null {
  const idx = name ? sentence.indexOf(name) : -1;
  if (idx < 0) return null;
  return { before: sentence.slice(0, idx), name, after: sentence.slice(idx + name.length) };
}

/** "6 h" or "45 min": a span of time in words, short enough to sit beside
 *  a lane name. Whole hours past the first one; a glance summary does not
 *  need the minutes. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return tr('timeline.minutes', '{count} min', { count: Math.max(1, minutes) });
  const hours = Math.max(1, Math.round(minutes / 60));
  return tr('timeline.hours', '{count} h', { count: hours });
}

/** The words under a lane name: how long a light was on, how many times a
 *  door opened, or that it is open right now. */
export function summarizeLane(
  entityId: string,
  segs: readonly TimelineSegment[],
  liveState: string | null | undefined,
  deviceClass?: string,
): string {
  const domain = entityDomain(entityId);
  const live = liveState ?? null;
  const activeNow = live != null && isActiveTimelineState(entityId, live);
  const total = segs.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  const count = segs.length;

  if (isOpening(entityId, deviceClass)) {
    if (activeNow) return tr('timeline.openNow', 'open now');
    if (count === 0) return tr('timeline.closedAllDay', 'closed all day');
    if (count === 1) return tr('timeline.openedOnce', 'opened once');
    return tr('timeline.openedTimes', 'opened {count} times', { count });
  }
  if (domain === 'binary_sensor' && deviceClass !== 'lock') {
    if (activeNow) return tr('timeline.activeNow', 'active now');
    if (count === 0) return tr('timeline.quietAllDay', 'quiet all day');
    if (count === 1) return tr('timeline.activeOnce', 'active once');
    return tr('timeline.activeTimes', 'active {count} times', { count });
  }
  if (domain === 'person' || domain === 'device_tracker') {
    if (live != null && !activeNow && live !== 'not_home' && !isNoise(live)) {
      return tr('timeline.atZone', 'at {zone}', { zone: zoneName(live) });
    }
    if (total === 0) return tr('timeline.awayAllDay', 'away all day');
    return tr('timeline.homeFor', 'home {duration}', { duration: formatDuration(total) });
  }
  if (domain === 'lock' || (domain === 'binary_sensor' && deviceClass === 'lock')) {
    if (total === 0) return tr('timeline.lockedAllDay', 'locked all day');
    return tr('timeline.unlockedFor', 'unlocked {duration}', { duration: formatDuration(total) });
  }
  if (domain === 'media_player') {
    if (total === 0) return tr('timeline.nothingPlayed', 'nothing played');
    return tr('timeline.playingFor', 'playing {duration}', { duration: formatDuration(total) });
  }
  if (domain === 'climate' || domain === 'vacuum' || domain === 'lawn_mower' || domain === 'water_heater') {
    if (total === 0) return tr('timeline.offAllDay', 'off all day');
    return tr('timeline.runningFor', 'running {duration}', { duration: formatDuration(total) });
  }
  if (total === 0) return tr('timeline.offAllDay', 'off all day');
  return tr('timeline.onFor', 'on {duration}', { duration: formatDuration(total) });
}

export interface HourTick {
  ms: number;
  /** 0..1 across the window. */
  fraction: number;
  label: string;
}

/** Tick marks at every third whole hour of the host's day (12 AM, 3 AM...),
 *  placed as fractions of the window. Walks the window in 15-minute steps
 *  and reads the clock in the host timezone, which handles half-hour zones
 *  and DST without any offset math. */
export function hourTicks(
  startMs: number, endMs: number, timeZone: string | undefined, stepHours = 3,
): HourTick[] {
  const span = endMs - startMs;
  if (span <= 0) return [];
  const probe = clockFormatter('hourMinute24', timeZone, 'en-US');
  const label = clockFormatter('hour', timeZone);
  const step = 15 * 60 * 1000;
  const first = Math.ceil(startMs / step) * step;
  const out: HourTick[] = [];
  for (let ms = first; ms <= endMs; ms += step) {
    const parts = probe.formatToParts(new Date(ms));
    const hour = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    if (minute !== 0 || hour % stepHours !== 0) continue;
    out.push({ ms, fraction: (ms - startMs) / span, label: label.format(new Date(ms)) });
  }
  return out;
}

/** Left and width of a span as fractions of the lane, with the minimum
 *  width applied so a door blip stays visible. */
export function spanBox(
  seg: TimelineSegment, startMs: number, endMs: number, minFraction: number,
): { left: number; width: number } {
  const span = endMs - startMs;
  if (span <= 0) return { left: 0, width: 0 };
  const left = (seg.startMs - startMs) / span;
  const width = Math.max(minFraction, (seg.endMs - seg.startMs) / span);
  return { left: Math.min(left, 1 - width), width };
}

/** Round down to the minute: the chart's "now". A memo keyed on a raw
 *  Date.now() never hits, and nothing on screen moves within a minute. */
export function quantizeNow(now = Date.now()): number {
  return Math.floor(now / 60_000) * 60_000;
}

/** The live state of an entity as a transition, for merging into history. */
export function liveTransition(s: HAStateObject): TimelineTransition {
  const at = Date.parse(s.last_changed);
  return { state: s.state, at: Number.isNaN(at) ? Date.now() : at };
}

/** Hour-tick spacing that leaves room for every label: 3 h where the lane
 *  is wide, 6 h or 12 h where it is not. */
export function tickStepFor(laneWidth: number, labelRoom: number): number {
  for (const step of [3, 6, 12]) {
    if ((laneWidth * step) / 24 >= labelRoom) return step;
  }
  return 24;
}

/** Feed columns that keep a sentence readable: the slider's value, capped
 *  by what fits in the width. */
export function feedColumnsFor(configured: number, width: number, minColumn: number): number {
  const fit = Math.max(1, Math.floor(width / minColumn));
  return Math.max(1, Math.min(Math.round(configured || 2), fit));
}

export function countHome(states: readonly HAStateObject[]): number {
  return states.filter((s) => {
    const d = entityDomain(s.entity_id);
    return (d === 'person' || d === 'device_tracker') && s.state === 'home';
  }).length;
}
