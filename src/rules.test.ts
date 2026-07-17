import { describe, it, expect } from 'vitest';
import type { HAStateObject, HAAlertRule } from './types';
import {
  ruleMatches, normalizeAlerts, normalizeLookRules, resolveLook,
  evaluateAlerts, acknowledgeAlert, readAcks, writeAcks,
  isNumericOperator, OPERATOR_LABELS, RULE_OPERATORS,
} from './rules';

function state(entityId: string, s: string, lastChanged = '2026-07-16T10:00:00Z'): HAStateObject {
  return {
    entity_id: entityId,
    state: s,
    attributes: {},
    last_changed: lastChanged,
    last_updated: lastChanged,
  };
}

function alertRule(overrides: Partial<HAAlertRule> = {}): HAAlertRule {
  return {
    id: 'r1', entityId: 'cover.garage', operator: 'is', value: 'open',
    title: 'Garage open', icon: 'garage', tone: 'red',
    ...overrides,
  };
}

// ── ruleMatches ─────────────────────────────────────────────────────────────

describe('ruleMatches', () => {
  it('matches "is" case-insensitively and trimmed', () => {
    expect(ruleMatches({ operator: 'is', value: 'Open' }, state('cover.g', 'open'))).toBe(true);
    expect(ruleMatches({ operator: 'is', value: ' open ' }, state('cover.g', 'open'))).toBe(true);
    expect(ruleMatches({ operator: 'is', value: 'closed' }, state('cover.g', 'open'))).toBe(false);
  });

  it('matches "is_not" as negation', () => {
    expect(ruleMatches({ operator: 'is_not', value: 'closed' }, state('cover.g', 'open'))).toBe(true);
    expect(ruleMatches({ operator: 'is_not', value: 'open' }, state('cover.g', 'open'))).toBe(false);
  });

  it('never matches unavailable/unknown/empty states, even for is_not', () => {
    for (const s of ['unavailable', 'unknown', '']) {
      expect(ruleMatches({ operator: 'is', value: s }, state('sensor.x', s))).toBe(false);
      expect(ruleMatches({ operator: 'is_not', value: 'on' }, state('sensor.x', s))).toBe(false);
      expect(ruleMatches({ operator: 'above', value: '0' }, state('sensor.x', s))).toBe(false);
    }
  });

  it('compares above/below numerically', () => {
    expect(ruleMatches({ operator: 'above', value: '1000' }, state('sensor.co2', '1240'))).toBe(true);
    expect(ruleMatches({ operator: 'above', value: '1000' }, state('sensor.co2', '1000'))).toBe(false);
    expect(ruleMatches({ operator: 'below', value: '20' }, state('sensor.batt', '12.5'))).toBe(true);
    expect(ruleMatches({ operator: 'below', value: '20' }, state('sensor.batt', '20'))).toBe(false);
  });

  it('never matches above/below on non-numeric states or bounds', () => {
    expect(ruleMatches({ operator: 'above', value: '10' }, state('sensor.x', 'on'))).toBe(false);
    expect(ruleMatches({ operator: 'above', value: 'high' }, state('sensor.x', '50'))).toBe(false);
  });
});

// ── Normalization ───────────────────────────────────────────────────────────

describe('normalizeAlerts', () => {
  it('drops rows without an entity or value and non-objects', () => {
    expect(normalizeAlerts([
      null, 'x', { entityId: '', operator: 'is', value: 'on' },
      { entityId: 'a.b', operator: 'is', value: '' },
      { entityId: 'a.b', operator: 'is', value: 'on' },
    ])).toHaveLength(1);
    expect(normalizeAlerts(undefined)).toEqual([]);
    expect(normalizeAlerts('nope')).toEqual([]);
  });

  it('applies defaults: title from entity, bolt icon, red tone, is operator', () => {
    const [r] = normalizeAlerts([{ entityId: 'cover.garage', value: 'open', operator: 'bogus', icon: 'nope', tone: 'nope' }]);
    expect(r).toMatchObject({
      entityId: 'cover.garage', operator: 'is', value: 'open',
      title: 'cover.garage', icon: 'bolt', tone: 'red',
    });
  });

  it('keeps valid fields and mints positional ids when missing', () => {
    const rules = normalizeAlerts([
      { id: 'mine', entityId: 'a.b', value: 'on', operator: 'is_not', title: ' Hi ', icon: 'garage', tone: 'amber' },
      { entityId: 'c.d', value: '5', operator: 'above' },
    ]);
    expect(rules[0]).toMatchObject({ id: 'mine', title: 'Hi', icon: 'garage', tone: 'amber', operator: 'is_not' });
    expect(rules[1].id).toBe('alert-1');
  });
});

describe('normalizeLookRules', () => {
  it('drops rules that change nothing', () => {
    expect(normalizeLookRules([
      { entityId: 'a.b', value: 'on' },
      { entityId: 'a.b', value: 'on', tone: 'default' },
      { entityId: 'a.b', value: 'on', icon: 'not-an-icon', label: '  ' },
    ])).toEqual([]);
  });

  it('keeps tone/icon/label overrides, treating default tone as unset', () => {
    const rules = normalizeLookRules([
      { entityId: 'a.b', value: 'on', tone: 'red' },
      { entityId: 'a.b', value: 'on', icon: 'garage' },
      { entityId: 'a.b', value: 'on', label: 'Close me!' },
    ]);
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatchObject({ tone: 'red', icon: undefined, label: undefined });
    expect(rules[1].icon).toBe('garage');
    expect(rules[2].label).toBe('Close me!');
  });
});

// ── resolveLook ─────────────────────────────────────────────────────────────

describe('resolveLook', () => {
  const rules = normalizeLookRules([
    { id: 'severe', entityId: 'sensor.co2', operator: 'above', value: '1500', tone: 'red', label: 'Open a window!' },
    { id: 'mild', entityId: 'sensor.co2', operator: 'above', value: '1000', tone: 'amber' },
    { id: 'other', entityId: 'cover.garage', operator: 'is', value: 'open', tone: 'red', icon: 'garage' },
  ]);

  it('returns the first matching rule (order = priority)', () => {
    expect(resolveLook(rules, state('sensor.co2', '1800'))).toMatchObject({ tone: 'red', label: 'Open a window!' });
    expect(resolveLook(rules, state('sensor.co2', '1200'))).toMatchObject({ tone: 'amber' });
  });

  it('returns undefined when nothing matches or entity has no rules', () => {
    expect(resolveLook(rules, state('sensor.co2', '600'))).toBeUndefined();
    expect(resolveLook(rules, state('sensor.temp', '72'))).toBeUndefined();
  });

  it('only considers rules for the same entity', () => {
    expect(resolveLook(rules, state('cover.garage', 'open'))).toMatchObject({ tone: 'red', icon: 'garage' });
  });
});

// ── Alert acknowledge lifecycle ─────────────────────────────────────────────

describe('evaluateAlerts', () => {
  const T1 = '2026-07-16T10:00:00Z';
  const T2 = '2026-07-16T11:00:00Z';

  it('shows a matching, unacknowledged rule', () => {
    const rule = alertRule();
    const { visible, acks } = evaluateAlerts([rule], [state('cover.garage', 'open', T1)], {});
    expect(visible).toHaveLength(1);
    expect(visible[0].rule.id).toBe('r1');
    expect(acks).toEqual({});
  });

  it('hides a rule that does not match, and one whose entity is absent', () => {
    const rule = alertRule();
    expect(evaluateAlerts([rule], [state('cover.garage', 'closed', T1)], {}).visible).toHaveLength(0);
    expect(evaluateAlerts([rule], [], {}).visible).toHaveLength(0);
  });

  it('enum ack hides the tile while last_changed is unchanged (across refreshes)', () => {
    const rule = alertRule();
    const s = state('cover.garage', 'open', T1);
    const acks = acknowledgeAlert({}, rule, s);
    const result = evaluateAlerts([rule], [s], acks);
    expect(result.visible).toHaveLength(0);
    expect(result.acks).toBe(acks); // unchanged → same reference, no write
  });

  it('enum ack recorded against a fast-lane stamp still covers the earlier real transition', () => {
    const rule = alertRule();
    // Fast lane stamped last_changed = T2; user tapped then.
    const acks = acknowledgeAlert({}, rule, state('cover.garage', 'open', T2));
    // Full poll replaces it with the true (earlier) transition time T1.
    const result = evaluateAlerts([rule], [state('cover.garage', 'open', T1)], acks);
    expect(result.visible).toHaveLength(0);
    expect(result.acks).toBe(acks);
  });

  it('falls back to exact string equality when timestamps cannot be parsed', () => {
    const rule = alertRule();
    const garbage = state('cover.garage', 'open', 'not-a-timestamp');
    const acks = acknowledgeAlert({}, rule, garbage);
    // Same unparseable stamp → the ack still covers it, tile stays hidden.
    const same = evaluateAlerts([rule], [garbage], acks);
    expect(same.visible).toHaveLength(0);
    expect(same.acks).toBe(acks);
    // A different unparseable stamp reads as a new transition → tile is back.
    const changed = evaluateAlerts([rule], [state('cover.garage', 'open', 'also-garbage')], acks);
    expect(changed.visible).toHaveLength(1);
    expect(changed.acks).toEqual({});
  });

  it('enum ack is spent by a NEW transition into the matching state', () => {
    const rule = alertRule();
    const acks = acknowledgeAlert({}, rule, state('cover.garage', 'open', T1));
    const result = evaluateAlerts([rule], [state('cover.garage', 'open', T2)], acks);
    expect(result.visible).toHaveLength(1);
    expect(result.acks).toEqual({});
  });

  it('leaving the matching state prunes the ack; re-entering shows the tile', () => {
    const rule = alertRule();
    let acks = acknowledgeAlert({}, rule, state('cover.garage', 'open', T1));
    // Door closes → hidden, ack pruned.
    const closed = evaluateAlerts([rule], [state('cover.garage', 'closed', T1)], acks);
    expect(closed.visible).toHaveLength(0);
    expect(closed.acks).toEqual({});
    acks = closed.acks;
    // Door reopens → visible again.
    expect(evaluateAlerts([rule], [state('cover.garage', 'open', T2)], acks).visible).toHaveLength(1);
  });

  it('numeric ack hides the tile even as last_changed churns with new readings', () => {
    const rule = alertRule({ id: 'co2', entityId: 'sensor.co2', operator: 'above', value: '1000' });
    let acks = acknowledgeAlert({}, rule, state('sensor.co2', '1240', T1));
    // New reading, still above 1000 → stays hidden.
    const still = evaluateAlerts([rule], [state('sensor.co2', '1300', T2)], acks);
    expect(still.visible).toHaveLength(0);
    expect(still.acks).toBe(acks);
    // Drops below → pruned; climbs back above → visible.
    acks = evaluateAlerts([rule], [state('sensor.co2', '800', T2)], still.acks).acks;
    expect(acks).toEqual({});
    expect(evaluateAlerts([rule], [state('sensor.co2', '1100', T2)], acks).visible).toHaveLength(1);
  });

  it('keeps an ack when the entity is temporarily missing from the poll', () => {
    const rule = alertRule({ id: 'co2', entityId: 'sensor.co2', operator: 'above', value: '1000' });
    const acks = acknowledgeAlert({}, rule, state('sensor.co2', '1240', T1));
    const gap = evaluateAlerts([rule], [], acks);
    expect(gap.acks).toBe(acks);
    // Entity returns, still matching → still hidden.
    expect(evaluateAlerts([rule], [state('sensor.co2', '1250', T2)], gap.acks).visible).toHaveLength(0);
  });

  it('drops acks for rules no longer configured', () => {
    const result = evaluateAlerts([], [], { gone: T1 });
    expect(result.acks).toEqual({});
  });

  it('does not match a rule against a different entity that shares no id', () => {
    const rule = alertRule({ entityId: 'cover.garage' });
    const { visible } = evaluateAlerts([rule], [state('cover.shed', 'open', T1)], {});
    expect(visible).toHaveLength(0);
  });
});

// ── Storage round-trip ──────────────────────────────────────────────────────

describe('readAcks / writeAcks', () => {
  function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v); },
    };
  }

  it('round-trips acks', () => {
    const storage = memoryStorage();
    writeAcks({ r1: '2026-07-16T10:00:00Z' }, storage);
    expect(readAcks(storage)).toEqual({ r1: '2026-07-16T10:00:00Z' });
  });

  it('tolerates missing, corrupt, and non-object payloads', () => {
    const storage = memoryStorage();
    expect(readAcks(storage)).toEqual({});
    storage.data.set('hs-plugin-home-assistant:alert-acks', 'not json');
    expect(readAcks(storage)).toEqual({});
    storage.data.set('hs-plugin-home-assistant:alert-acks', '[1,2]');
    expect(readAcks(storage)).toEqual({});
    storage.data.set('hs-plugin-home-assistant:alert-acks', '{"a":"t","b":5}');
    expect(readAcks(storage)).toEqual({ a: 't' });
  });

  it('survives a null storage (blocked localStorage)', () => {
    expect(readAcks(null)).toEqual({});
    expect(() => writeAcks({ a: 'b' }, null)).not.toThrow();
  });
});

// ── Vocabulary sanity ───────────────────────────────────────────────────────

describe('operator vocabulary', () => {
  it('labels every operator', () => {
    for (const op of RULE_OPERATORS) expect(OPERATOR_LABELS[op]).toBeTruthy();
  });
  it('classifies numeric operators', () => {
    expect(isNumericOperator('above')).toBe(true);
    expect(isNumericOperator('below')).toBe(true);
    expect(isNumericOperator('is')).toBe(false);
    expect(isNumericOperator('is_not')).toBe(false);
  });
});
