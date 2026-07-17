// Editor panels for wave 3, both built on ONE shared condition row
// (mockup section 4): "when [device] [is / is not / goes above / goes below]
// [value]". AlertsEditor attaches a message (title/icon/tone) to the
// condition; LookRulesEditor attaches an appearance override (tone/icon/
// label). Rows collapse to a summary, expand to edit, and drag to reorder —
// the same interaction contract as ButtonsEditor.
//
// The value input speaks the same friendly vocabulary as the host's
// visibility-condition builder: enumerable entities offer their possible raw
// states labeled the way cards format them ("Open (open)"), numeric sensors
// get a number field with the unit, everything else free text.

import React from 'react';
import type { HAStateObject, HAAlertRule, HALookRule, HARuleOperator, HAButtonTone } from './types';
import { iconFor, isIconName, type IconName } from './icons';
import { friendlyName, formatValue, possibleRawStates } from './utils';
import { TONE_ORDER } from './buttons';
import { RULE_OPERATORS, OPERATOR_LABELS, isNumericOperator } from './rules';
import {
  INPUT, HINT, SectionTitle, Field,
  PickerShell, PopupNote, POPUP_ITEM, POPUP_DIM,
  IconOption, ToneOption,
  mintId, useRowList, RowShell, AddButton,
} from './config-ui';

/** Sensor-flavored additions ahead of the button set — alert rules mostly
 *  watch doors, leaks, batteries, and machines, not services. */
const RULE_ICON_CHOICES: IconName[] = [
  'garage', 'door', 'window', 'lock', 'unlock', 'motion', 'smoke', 'leak',
  'droplet', 'battery', 'thermometer', 'bolt', 'plug', 'user', 'house',
  'camera', 'shield', 'robot', 'wind', 'megaphone',
];

// ═══════════════════════════════════════════════════════════════════════════
// Alerts editor
// ═══════════════════════════════════════════════════════════════════════════

export function AlertsEditor({ alerts, onChange, states, connected }: {
  alerts: HAAlertRule[];
  onChange: (alerts: HAAlertRule[]) => void;
  states: HAStateObject[] | null;
  connected: boolean;
}) {
  const list = useRowList(alerts, onChange);

  function addRow() {
    const id = mintId('alert');
    onChange([...alerts, {
      id, entityId: '', operator: 'is', value: '',
      title: '', icon: 'bolt', tone: 'red',
    }]);
    list.setExpandedId(id);
  }

  return (
    <section>
      <SectionTitle>
        Alerts <span style={{ color: 'rgba(255,255,255,0.4)' }}>· {alerts.length}</span>
      </SectionTitle>
      <div style={{ ...HINT, marginTop: 0, marginBottom: 12 }}>
        Each alert pops up on the display when its rule matches, and goes away
        when someone taps it. It stays away until the same thing happens again.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {alerts.map((rule, i) => {
          const entityState = states?.find((s) => s.entity_id === rule.entityId);
          return (
            <RowShell
              key={rule.id}
              list={list} index={i} id={rule.id}
              chipIcon={isIconName(rule.icon) ? rule.icon : 'bolt'}
              chipTone={rule.tone}
              title={rule.title || 'New alert'}
              subtitle={whenSummary(rule, entityState)}
              incomplete={!rule.entityId || !rule.value}
              removeLabel="Remove alert"
            >
              <ConditionRow
                rule={rule} states={states} connected={connected}
                operatorLabel="Show when it"
                onChange={(u) => list.update(rule.id, applyEntitySideEffects(rule, u, states))}
              />
              <Field label="What it should say">
                <input
                  style={INPUT}
                  value={rule.title}
                  onChange={(e) => list.update(rule.id, { title: e.target.value })}
                  placeholder={titlePlaceholder(rule, entityState)}
                />
              </Field>
              <Field label="Icon & color">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {RULE_ICON_CHOICES.map((name) => (
                      <IconOption key={name} name={name} selected={rule.icon === name}
                        onPick={() => list.update(rule.id, { icon: name })} />
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 7 }}>
                    {TONE_ORDER.map((t) => (
                      <ToneOption key={t} tone={t} selected={rule.tone === t}
                        onPick={() => list.update(rule.id, { tone: t })} />
                    ))}
                  </div>
                </div>
              </Field>
            </RowShell>
          );
        })}
      </div>

      <AddButton onClick={addRow}>+ Add an alert</AddButton>

      <div style={HINT}>
        The display shows nothing at all while no alert is going off — this
        widget is invisible until something needs attention. An alert without
        a device and value picked stays off until it&apos;s finished.
      </div>
    </section>
  );
}

/** Best-guess tile text from what's picked so far, shown as the placeholder
 *  so an empty title still previews sensibly. */
function titlePlaceholder(rule: HAAlertRule, state?: HAStateObject): string {
  if (!rule.entityId) return 'The garage door is open';
  const name = state ? friendlyName(state) : rule.entityId;
  if (!rule.value) return `${name} needs attention`;
  if (isNumericOperator(rule.operator)) {
    return `${name} is ${rule.operator === 'above' ? 'too high' : 'too low'}`;
  }
  return `${name} ${rule.operator === 'is_not' ? 'is not' : 'is'} ${rule.value}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Look-rules editor ("Change how things look")
// ═══════════════════════════════════════════════════════════════════════════

export function LookRulesEditor({ rules, onChange, states, connected }: {
  rules: HALookRule[];
  onChange: (rules: HALookRule[]) => void;
  states: HAStateObject[] | null;
  connected: boolean;
}) {
  const list = useRowList(rules, onChange);

  function addRow() {
    const id = mintId('look');
    onChange([...rules, { id, entityId: '', operator: 'is', value: '', tone: 'red' }]);
    list.setExpandedId(id);
  }

  return (
    <section>
      <SectionTitle>
        Change how things look
        <span style={{ color: 'rgba(255,255,255,0.4)' }}> · optional</span>
      </SectionTitle>
      <div style={{ ...HINT, marginTop: 0, marginBottom: 12 }}>
        Give a device a different color, icon, or wording when something is
        true — like turning the garage door red while it&apos;s open. Devices
        keep their normal look until a rule matches. Rules are checked top to
        bottom; the first match wins, so put the most serious one first.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rules.map((rule, i) => {
          const entityState = states?.find((s) => s.entity_id === rule.entityId);
          const tone: HAButtonTone = rule.tone ?? 'default';
          return (
            <RowShell
              key={rule.id}
              list={list} index={i} id={rule.id}
              chipIcon={rule.icon && isIconName(rule.icon) ? rule.icon
                : entityState ? iconFor(entityState) : 'palette'}
              chipTone={tone}
              title={entityState ? friendlyName(entityState) : rule.entityId || 'New rule'}
              subtitle={lookSummary(rule, entityState)}
              incomplete={!rule.entityId || !rule.value}
              removeLabel="Remove rule"
            >
              <ConditionRow
                rule={rule} states={states} connected={connected}
                operatorLabel="Change it when it"
                onChange={(u) => list.update(rule.id, u)}
              />
              <Field label={
                <>Color & icon <span style={{ color: 'rgba(255,255,255,0.4)' }}>
                  — leave unpicked to keep the normal one</span></>
              }>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 7 }}>
                    {TONE_ORDER.map((t) => (
                      <ToneOption key={t} tone={t} selected={tone === t}
                        onPick={() => list.update(rule.id, { tone: t === 'default' ? undefined : t })} />
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <KeepIconOption selected={!rule.icon}
                      onPick={() => list.update(rule.id, { icon: undefined })} />
                    {RULE_ICON_CHOICES.map((name) => (
                      <IconOption key={name} name={name} selected={rule.icon === name}
                        onPick={() => list.update(rule.id, { icon: name })} />
                    ))}
                  </div>
                </div>
              </Field>
              <Field label={
                <>Say this instead <span style={{ color: 'rgba(255,255,255,0.4)' }}>— optional</span></>
              }>
                <input
                  style={INPUT}
                  value={rule.label ?? ''}
                  onChange={(e) => list.update(rule.id, { label: e.target.value || undefined })}
                  placeholder="Close me!"
                />
              </Field>
            </RowShell>
          );
        })}
      </div>

      <AddButton onClick={addRow}>+ Add a look rule</AddButton>
    </section>
  );
}

/** Dashed "keep the normal icon" swatch at the head of the icon strip. */
function KeepIconOption({ selected, onPick }: { selected: boolean; onPick: () => void }) {
  return (
    <button
      aria-label="Keep the normal icon"
      title="Keep the normal icon"
      onClick={onPick}
      style={{
        width: 32, height: 32, borderRadius: 8, padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: selected ? 'rgba(59,130,246,0.15)' : 'transparent',
        border: `1px dashed ${selected ? '#3b82f6' : 'rgba(255,255,255,0.25)'}`,
        color: selected ? '#93c5fd' : 'rgba(255,255,255,0.45)',
        cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
      }}
    >
      —
    </button>
  );
}

function whenSummary(
  rule: Pick<HAAlertRule, 'entityId' | 'operator' | 'value'>,
  state?: HAStateObject,
): string {
  if (!rule.entityId) return 'Pick a device';
  const name = state ? friendlyName(state) : rule.entityId;
  if (!rule.value) return `when ${name} ${OPERATOR_LABELS[rule.operator]} …`;
  return `when ${name} ${OPERATOR_LABELS[rule.operator]} ${rule.value}`;
}

function lookSummary(rule: HALookRule, state?: HAStateObject): string {
  const base = rule.entityId
    ? (rule.value ? `when it ${OPERATOR_LABELS[rule.operator]} ${rule.value}` : `when it ${OPERATOR_LABELS[rule.operator]} …`)
    : 'Pick a device';
  const parts: string[] = [];
  if (rule.tone) parts.push(rule.tone);
  if (rule.icon && isIconName(rule.icon)) parts.push(`${rule.icon} icon`);
  if (rule.label) parts.push(`say "${rule.label}"`);
  return parts.length > 0 ? `${base} → ${parts.join(' · ')}` : base;
}

/** When the user picks a device for an alert, follow with the entity's own
 *  icon while they haven't customized it, and reset a value that belonged to
 *  the previous device. */
function applyEntitySideEffects(
  rule: HAAlertRule, updates: Partial<HAAlertRule>, states: HAStateObject[] | null,
): Partial<HAAlertRule> {
  if (updates.entityId === undefined || updates.entityId === rule.entityId) return updates;
  const next = { ...updates };
  const prevState = states?.find((s) => s.entity_id === rule.entityId);
  const prevDefault: IconName = prevState ? iconFor(prevState) : 'bolt';
  if (rule.icon === 'bolt' || rule.icon === prevDefault) {
    const picked = states?.find((s) => s.entity_id === updates.entityId);
    if (picked) next.icon = iconFor(picked);
  }
  return next;
}

// ═══════════════════════════════════════════════════════════════════════════
// The shared condition row
// ═══════════════════════════════════════════════════════════════════════════

const ENTITY_PICKER_CAP = 100;

function ConditionRow({ rule, states, connected, operatorLabel, onChange }: {
  rule: Pick<HAAlertRule, 'entityId' | 'operator' | 'value'>;
  states: HAStateObject[] | null;
  connected: boolean;
  /** "Show when it" (alerts) / "Change it when it" (look rules). */
  operatorLabel: string;
  onChange: (u: { entityId?: string; operator?: HARuleOperator; value?: string }) => void;
}) {
  const entityState = states?.find((s) => s.entity_id === rule.entityId);
  const options = React.useMemo(() => {
    if (!states) return [];
    return [...states].sort((a, b) => friendlyName(a).localeCompare(friendlyName(b)));
  }, [states]);

  return (
    <div style={{
      gridColumn: '1 / -1',
      display: 'grid',
      gridTemplateColumns: 'minmax(220px, 1.6fr) minmax(130px, 0.9fr) minmax(150px, 1fr)',
      gap: '12px 12px',
    }}>
      <Field label="Which device">
        <PickerShell
          current={rule.entityId
            ? (entityState ? `${friendlyName(entityState)} (${rule.entityId})` : rule.entityId)
            : ''}
          placeholder={connected ? 'Search devices…' : 'Connect to Home Assistant first'}
          disabled={!connected}
        >
          {(query, close) => {
            const q = query.trim().toLowerCase();
            const matched = q
              ? options.filter((s) =>
                  s.entity_id.toLowerCase().includes(q)
                  || friendlyName(s).toLowerCase().includes(q))
              : options;
            const capped = matched.slice(0, ENTITY_PICKER_CAP);
            return (
              <>
                {capped.map((s) => (
                  <div
                    key={s.entity_id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      // A value picked for the old device rarely fits the new
                      // one; clear it so the value input re-derives choices.
                      onChange({ entityId: s.entity_id, value: '' });
                      close();
                    }}
                    style={{
                      ...POPUP_ITEM,
                      background: s.entity_id === rule.entityId
                        ? 'rgba(59,130,246,0.16)' : 'transparent',
                    }}
                  >
                    <span style={{
                      display: 'block', fontSize: 12, color: '#fff',
                      overflowWrap: 'anywhere', lineHeight: 1.35,
                    }}>{friendlyName(s)}</span>
                    <span style={{ ...POPUP_DIM, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                      {s.entity_id}
                    </span>
                  </div>
                ))}
                {matched.length === 0 && <PopupNote>Nothing matches.</PopupNote>}
                {matched.length > capped.length && (
                  <PopupNote divider>Keep typing to narrow the list.</PopupNote>
                )}
              </>
            );
          }}
        </PickerShell>
      </Field>

      <Field label={operatorLabel}>
        <select
          style={INPUT}
          value={rule.operator}
          onChange={(e) => {
            const operator = e.target.value as HARuleOperator;
            // Enum values don't survive an enum↔numeric operator flip.
            const crossed = isNumericOperator(operator) !== isNumericOperator(rule.operator);
            onChange(crossed ? { operator, value: '' } : { operator });
          }}
        >
          {RULE_OPERATORS.map((op) => (
            <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>
          ))}
        </select>
      </Field>

      <ValueField rule={rule} entityState={entityState} onChange={onChange} />
    </div>
  );
}

/** The adaptive value input: number field (with unit) for above/below,
 *  friendly dropdown for enumerable states, free text otherwise. */
function ValueField({ rule, entityState, onChange }: {
  rule: Pick<HAAlertRule, 'entityId' | 'operator' | 'value'>;
  entityState?: HAStateObject;
  onChange: (u: { value?: string }) => void;
}) {
  if (isNumericOperator(rule.operator)) {
    const unit = entityState?.attributes.unit_of_measurement;
    return (
      <Field label={unit ? `This number (${unit})` : 'This number'}>
        <input
          type="number"
          style={INPUT}
          value={rule.value}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder="1000"
        />
      </Field>
    );
  }

  const rawStates = entityState ? possibleRawStates(entityState) : null;
  if (rawStates && rawStates.length > 0) {
    // Fold in the live state when the static list misses it (zone names,
    // transient states) — same folding the condition search does.
    const values = rawStates.includes(entityState!.state)
      || entityState!.state === 'unavailable' || entityState!.state === 'unknown'
      || entityState!.state === ''
      ? rawStates
      : [entityState!.state, ...rawStates];
    return (
      <Field label="This value">
        <select
          style={INPUT}
          value={rule.value}
          onChange={(e) => onChange({ value: e.target.value })}
        >
          {rule.value === '' && <option value="">Pick one…</option>}
          {values.map((v) => (
            <option key={v} value={v}>{friendlyValueLabel(entityState!, v)}</option>
          ))}
        </select>
      </Field>
    );
  }

  return (
    <Field label="This value">
      <input
        style={INPUT}
        value={rule.value}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder={entityState ? entityState.state : 'open'}
      />
    </Field>
  );
}

/** "Open (open)" — the same friendly text the cards render, with the raw
 *  value alongside when it differs. */
function friendlyValueLabel(state: HAStateObject, raw: string): string {
  const label = formatValue({ ...state, state: raw });
  return label && label !== raw && label !== '—' ? `${label} (${raw})` : raw;
}
