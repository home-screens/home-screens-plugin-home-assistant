// Pure model for wave 3: the shared "when [entity] [operator] [value]"
// condition row that powers both the `alerts` view (item #1) and per-entity
// look rules (item #4). Config normalization, rule matching, first-match
// look resolution, and the alert acknowledge store. No React, no fetch —
// everything here is unit-testable.

import type { HAStateObject, HAButtonTone, HARuleOperator, HAAlertRule, HALookRule } from './types';
import { entityDomain } from './types';
import { isIconName, type IconName } from './icons';
import { TONE_ORDER } from './buttons';
import { DEFAULT_THEME, type Theme } from './theme';

// ── Operators ───────────────────────────────────────────────────────────────

export const RULE_OPERATORS: HARuleOperator[] = ['is', 'is_not', 'above', 'below'];

/** Plain-language operator labels for editor selects and row summaries. */
export const OPERATOR_LABELS: Record<HARuleOperator, string> = {
  is: 'is',
  is_not: 'is not',
  above: 'goes above',
  below: 'goes below',
};

export function isNumericOperator(op: HARuleOperator): boolean {
  return op === 'above' || op === 'below';
}

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * Does this entity's current state satisfy the rule? Unavailable/unknown
 * states never match ANY operator — `is_not on` firing every time a sensor
 * drops offline would turn alerts into noise. String comparison is EXACT,
 * matching the host's visibility-condition semantics, so "when it is on"
 * means the same thing in an alert rule and in a host condition. The select
 * path stores raw vocabulary values that always match; hand-typed values are
 * trimmed at normalization and get a case-mismatch hint in the editor.
 */
export function ruleMatches(
  rule: Pick<HAAlertRule, 'operator' | 'value'>,
  state: HAStateObject,
): boolean {
  const s = state.state;
  if (isIndefiniteState(s)) return false;
  switch (rule.operator) {
    case 'is': return eq(s, rule.value);
    case 'is_not': return !eq(s, rule.value);
    case 'above': {
      const { n, bound } = nums(s, rule.value);
      return n !== null && bound !== null && n > bound;
    }
    case 'below': {
      const { n, bound } = nums(s, rule.value);
      return n !== null && bound !== null && n < bound;
    }
  }
}

/** HA reports these when an entity is offline or hasn't produced a reading,
 *  an indefinite value, not a real observation. Never a rule match, and (for
 *  acks) treated as a transient gap rather than "left the matching state". */
function isIndefiniteState(s: string): boolean {
  return s === 'unavailable' || s === 'unknown' || s === '';
}

function eq(a: string, b: string): boolean {
  return a === b;
}

function nums(state: string, value: string): { n: number | null; bound: number | null } {
  const n = Number(state);
  const bound = Number(value);
  return {
    n: state.trim() !== '' && Number.isFinite(n) ? n : null,
    bound: value.trim() !== '' && Number.isFinite(bound) ? bound : null,
  };
}

// ── Normalization ───────────────────────────────────────────────────────────

const VALID_TONES = new Set<string>(TONE_ORDER);
const VALID_OPERATORS = new Set<string>(RULE_OPERATORS);

/** Filter persisted alert rules down to usable ones. A rule without an
 *  entity or a value can't match anything, so it is dropped (the editor
 *  keeps incomplete drafts in raw config; only the display path normalizes).
 */
export function normalizeAlerts(raw: unknown): HAAlertRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: HAAlertRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const base = normalizeRuleBase(raw[i], i, 'alert');
    if (!base) continue;
    const o = raw[i] as Record<string, unknown>;
    const title = typeof o.title === 'string' && o.title.trim()
      ? o.title.trim()
      : base.entityId;
    const icon = typeof o.icon === 'string' && isIconName(o.icon) ? o.icon : 'bolt';
    const tone: HAButtonTone = typeof o.tone === 'string' && VALID_TONES.has(o.tone)
      ? (o.tone as HAButtonTone)
      : 'red';
    rules.push({ ...base, title, icon, tone });
  }
  return rules;
}

/** Filter persisted look rules. Besides a complete condition, a rule must
 *  change SOMETHING (tone, icon, or label) — a full no-op is dropped so it
 *  can't shadow a later rule on the same entity. */
export function normalizeLookRules(raw: unknown): HALookRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: HALookRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const base = normalizeRuleBase(raw[i], i, 'look');
    if (!base) continue;
    const o = raw[i] as Record<string, unknown>;
    const tone = typeof o.tone === 'string' && VALID_TONES.has(o.tone) && o.tone !== 'default'
      ? (o.tone as Exclude<HAButtonTone, 'default'>)
      : undefined;
    const icon = typeof o.icon === 'string' && isIconName(o.icon) ? o.icon : undefined;
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : undefined;
    if (!tone && !icon && !label) continue;
    rules.push({ ...base, tone, icon, label });
  }
  return rules;
}

function normalizeRuleBase(
  r: unknown, index: number, kind: string,
): { id: string; entityId: string; operator: HARuleOperator; value: string } | null {
  if (r == null || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const entityId = typeof o.entityId === 'string' ? o.entityId.trim() : '';
  const value = typeof o.value === 'string' ? o.value.trim() : '';
  if (!entityId || !value) return null;
  const operator: HARuleOperator = typeof o.operator === 'string' && VALID_OPERATORS.has(o.operator)
    ? (o.operator as HARuleOperator)
    : 'is';
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `${kind}-${index}`,
    entityId, operator, value,
  };
}

// ── Look resolution ─────────────────────────────────────────────────────────

/** What a matched look rule changes, ready for the render layer. Tone is
 *  never 'default' — "keep the normal tone" is expressed as absent. */
export interface ResolvedLook {
  tone?: Exclude<HAButtonTone, 'default'>;
  icon?: IconName;
  label?: string;
}

/** Accent color (icons, status dots, big values) for a matched look's tone;
 *  undefined when there is no match or the rule doesn't change tone.
 *
 *  Takes the theme rather than reading a module-level palette: the same tone
 *  resolves to a different color on a light module than a dark one. Callers
 *  on the display path pass `useTheme()`; the default covers the editor's
 *  own dark chrome. */
export function lookAccent(
  look: ResolvedLook | undefined, theme: Theme = DEFAULT_THEME,
): string | undefined {
  return look?.tone ? theme.buttonTone[look.tone].accent : undefined;
}

/**
 * First matching rule for this entity wins — rules are ordered (the editor
 * reorders by drag), so "above 1500 → red" placed above "above 1000 → amber"
 * behaves the way it reads. Returns undefined when nothing matches, meaning
 * "keep the normal look".
 */
export function resolveLook(
  rules: HALookRule[], state: HAStateObject,
): ResolvedLook | undefined {
  for (const rule of rules) {
    if (rule.entityId !== state.entity_id) continue;
    if (!ruleMatches(rule, state)) continue;
    return {
      tone: rule.tone,
      icon: rule.icon && isIconName(rule.icon) ? rule.icon : undefined,
      label: rule.label,
    };
  }
  return undefined;
}

// ── Built-in state tones ────────────────────────────────────────────────────

/**
 * The tone an entity earns from its own state, with no rule configured.
 * Only states that genuinely mean something at a glance get one — a running
 * furnace, an unlocked door, an open blind, somebody home, an armed alarm.
 * Everything else returns undefined and keeps its normal card look, because
 * a wall of colored cards says as little as a wall of grey ones.
 *
 * These are the implicit last rule: `makeLookResolver` only reaches for them
 * when no configured rule claimed the tone.
 */
export function defaultTone(
  state: HAStateObject,
): Exclude<HAButtonTone, 'default'> | undefined {
  const s = state.state;
  if (isIndefiniteState(s)) return undefined;
  switch (entityDomain(state.entity_id)) {
    case 'climate': {
      // hvac_action is what the equipment is DOING right now, so when it is
      // reported it decides on its own — `heat` while idle has reached its
      // setpoint and should look calm. Only integrations that omit the
      // action fall back to the mode.
      const action = state.attributes.hvac_action;
      if (typeof action === 'string' && action !== '') {
        if (action === 'heating') return 'amber';
        if (action === 'cooling') return 'blue';
        return undefined;
      }
      if (s === 'heat') return 'amber';
      if (s === 'cool') return 'blue';
      return undefined;
    }
    case 'lock':
      // Jammed is the loudest thing a lock can say, and it is not "unlocked".
      return s === 'unlocked' || s === 'jammed' ? 'red' : undefined;
    case 'cover':
      return s === 'open' || s === 'opening' ? 'amber' : undefined;
    case 'person':
    case 'device_tracker':
      return s === 'home' ? 'green' : undefined;
    case 'vacuum':
    case 'lawn_mower':
      // A robot that needs rescuing is the whole reason to glance at its
      // tile; one that is out working reads as busy, and a docked one is at
      // rest like a locked door — no color earned.
      if (s === 'error') return 'red';
      return s === 'cleaning' || s === 'mowing' || s === 'returning' ? 'blue' : undefined;
    case 'alarm_control_panel':
      if (s === 'triggered') return 'red';
      if (s === 'arming' || s === 'pending') return 'amber';
      if (s.startsWith('armed')) return 'blue';
      if (s === 'disarmed') return 'green';
      return undefined;
    default:
      return undefined;
  }
}

/**
 * The look resolver a view uses, or undefined when nothing can change any
 * entity's look (the hot path then skips the lookup entirely). Configured
 * rules win: the built-in tone only fills a gap the rules left, so a rule
 * that swaps just the icon keeps its entity's automatic color.
 */
export function makeLookResolver(
  rules: HALookRule[], autoTones: boolean,
): ((s: HAStateObject) => ResolvedLook | undefined) | undefined {
  if (rules.length === 0 && !autoTones) return undefined;
  if (!autoTones) return (s) => resolveLook(rules, s);
  return (s) => {
    const look = resolveLook(rules, s);
    if (look?.tone) return look;
    const auto = defaultTone(s);
    if (!auto) return look;
    return look ? { ...look, tone: auto } : { tone: auto };
  };
}

// ── Alert acknowledge store ─────────────────────────────────────────────────
//
// Tapping an alert stores the entity's `last_changed` under the rule id.
// The store lives in localStorage, so it is naturally per-device (each kiosk
// has its own Chromium profile) and survives refreshes and reboots.
//
// Hidden-vs-visible semantics differ by operator kind:
//   - Enum rules (`is` / `is_not`): `last_changed` IS the transition into
//     the matching state, so the ack is valid exactly while it equals the
//     live value. A door that closes and reopens gets a new `last_changed`
//     even if the kiosk was offline for the whole cycle.
//   - Numeric rules (`above` / `below`): sensors bump `last_changed` on
//     every reading, so equality would resurface the alert constantly.
//     Instead an ack hides the alert for as long as the rule keeps matching
//     (the "episode"); the moment a poll observes it NOT matching, the ack
//     is pruned, and the next time it matches the tile is back.

export type AlertAcks = Record<string, string>;

const ACK_STORAGE_KEY = 'hs-plugin-home-assistant:alert-acks';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readAcks(storage: StorageLike | null = defaultStorage()): AlertAcks {
  if (!storage) return {};
  try {
    const raw = storage.getItem(ACK_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const acks: AlertAcks = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') acks[k] = v;
    }
    return acks;
  } catch {
    return {};
  }
}

export function writeAcks(acks: AlertAcks, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(ACK_STORAGE_KEY, JSON.stringify(acks));
  } catch {
    // Full/blocked storage just means acks won't survive a refresh.
  }
}

export interface AlertEvaluation {
  /** Rules currently matching AND not acknowledged, with their live state. */
  visible: Array<{ rule: HAAlertRule; state: HAStateObject }>;
  /** Acks after pruning stale entries. Reference-equal to the input when
   *  nothing changed, so callers can skip the write. */
  acks: AlertAcks;
}

/**
 * One pass over the rules: decide which tiles show and prune acks that no
 * longer hold (rule gone from config, entity left the matching state, or —
 * for enum rules — a fresh transition superseded the acknowledged one).
 */
export function evaluateAlerts(
  rules: HAAlertRule[], states: HAStateObject[], acks: AlertAcks,
): AlertEvaluation {
  const byId = new Map(states.map((s) => [s.entity_id, s]));
  const visible: AlertEvaluation['visible'] = [];
  const nextAcks: AlertAcks = {};

  for (const rule of rules) {
    const ack = acks[rule.id];
    const state = byId.get(rule.entityId);
    if (!state) {
      // Entity missing from this poll: tile hidden, but KEEP the ack — a
      // transient gap shouldn't reset a numeric episode.
      if (ack !== undefined) nextAcks[rule.id] = ack;
      continue;
    }
    if (isIndefiniteState(state.state)) {
      // Entity present but unavailable/unknown/'': a device or integration
      // blip, not a real observation. Treat it exactly like the missing-entity
      // transient gap: tile hidden, ack preserved, NOT counted as leaving the
      // matching state (so a one-poll radio dropout can't spend a numeric ack).
      if (ack !== undefined) nextAcks[rule.id] = ack;
      continue;
    }
    if (!ruleMatches(rule, state)) {
      // A definite value that fails the rule: the ack is spent (dropped).
      continue;
    }
    if (ack === undefined) {
      visible.push({ rule, state });
    } else if (isNumericOperator(rule.operator) || ackCovers(ack, state.last_changed)) {
      // Acknowledged episode continues — stay hidden, keep the ack.
      nextAcks[rule.id] = ack;
    } else {
      // A new transition into the matching state — the ack is spent.
      visible.push({ rule, state });
    }
  }

  // nextAcks only ever copies entries from acks (acknowledgeAlert is the
  // sole writer of new ones), so "changed" reduces to a key-count check.
  // Acks for rules no longer configured fall away here too.
  const changed = Object.keys(acks).length !== Object.keys(nextAcks).length;
  return { visible, acks: changed ? nextAcks : acks };
}

/**
 * True when the ack was recorded at-or-after this transition. The fast-poll
 * lane approximates last_changed with its merge time (an upper bound on the
 * real transition), so an ack stored against the stamp must still cover the
 * earlier true timestamp once the full poll replaces it — exact string
 * equality would resurrect the tile. Unparseable timestamps fall back to
 * string equality.
 */
function ackCovers(ack: string, lastChanged: string): boolean {
  const a = Date.parse(ack);
  const t = Date.parse(lastChanged);
  if (Number.isNaN(a) || Number.isNaN(t)) return ack === lastChanged;
  return a >= t;
}

/** Record a tap: the rule stays hidden until this transition is superseded
 *  (enum) or the entity leaves the matching state (numeric). */
export function acknowledgeAlert(
  acks: AlertAcks, rule: HAAlertRule, state: HAStateObject,
): AlertAcks {
  return { ...acks, [rule.id]: state.last_changed };
}
