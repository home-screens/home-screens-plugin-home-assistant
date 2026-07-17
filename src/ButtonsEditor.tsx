// Editor panel for the `buttons` view — replaces the entity browser inside
// the Configure Home Assistant modal. Rows collapse to a summary and reorder
// by drag; the "What it should do" picker is searchable, grouped by friendly
// domain labels, and fed live from HA's /api/services through the proxy.
// Extra service data stays behind an Advanced JSON field.

import React from 'react';
import type { HAStateObject, HAButtonRow } from './types';
import { entityDomain } from './types';
import { fetchServices } from './api';
import { friendlyName } from './utils';
import { isIconName } from './icons';
import {
  INPUT, HINT, SectionTitle, Field, GreenToggle,
  PickerShell, PopupNote, POPUP_ITEM, POPUP_MONO, POPUP_DIM,
  IconOption, ToneOption,
  mintId, useRowList, RowShell, AddButton,
} from './config-ui';
import {
  TONE_ORDER, BUTTON_ICON_CHOICES,
  parseServicesResponse, groupServicesForPicker, findServiceDef,
  defaultIconForDomain, parseServiceDataJson,
  type HAServiceDef,
} from './buttons';

interface ButtonsEditorProps {
  buttons: HAButtonRow[];
  onChange: (buttons: HAButtonRow[]) => void;
  states: HAStateObject[] | null;
  connected: boolean;
  haUrl: string;
}

export function ButtonsEditor({ buttons, onChange, states, connected, haUrl }: ButtonsEditorProps) {
  const [catalog, setCatalog] = React.useState<HAServiceDef[] | null>(null);
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  const list = useRowList(buttons, onChange);

  React.useEffect(() => {
    if (!connected || !haUrl) { setCatalog(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const parsed = parseServicesResponse(await fetchServices(haUrl));
        if (!cancelled) { setCatalog(parsed); setCatalogError(null); }
      } catch (e) {
        if (!cancelled) {
          setCatalogError(e instanceof Error ? e.message : 'Failed to load actions');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [connected, haUrl]);

  function addRow() {
    const id = mintId('btn');
    onChange([...buttons, {
      id, label: 'New button', icon: 'power', tone: 'default',
      domain: '', service: '',
    }]);
    list.setExpandedId(id);
  }

  return (
    <section>
      <SectionTitle>
        Buttons <span style={{ color: 'rgba(255,255,255,0.4)' }}>· {buttons.length}</span>
      </SectionTitle>
      <div style={{ ...HINT, marginTop: 0, marginBottom: 12 }}>
        Each button runs one Home Assistant action when tapped on the display.
        Drag the handle to reorder.
      </div>

      {catalogError && (
        <div style={{ ...HINT, color: '#fca5a5', marginBottom: 10 }}>
          Couldn&apos;t load the action list: {catalogError}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {buttons.map((row, i) => {
          const complete = Boolean(row.domain && row.service);
          return (
            <RowShell
              key={row.id}
              list={list} index={i} id={row.id}
              chipIcon={isIconName(row.icon) ? row.icon : 'bolt'}
              chipTone={row.tone}
              title={row.label || 'New button'}
              subtitle={complete
                ? `${row.domain}.${row.service}${row.entityId ? ` · ${row.entityId}` : ''}`
                : 'Pick what it should do'}
              monoSubtitle={complete}
              incomplete={!complete}
              badge={row.holdToRun && (
                <span style={{
                  fontSize: 10, padding: '3px 8px', borderRadius: 99, flexShrink: 0,
                  background: 'rgba(248,113,113,0.1)',
                  border: '1px solid rgba(248,113,113,0.25)', color: '#fca5a5',
                }}>hold to run</span>
              )}
              removeLabel="Remove button"
            >
              <RowForm row={row} onUpdate={(u) => list.update(row.id, u)}
                catalog={catalog} connected={connected} states={states} />
            </RowShell>
          );
        })}
      </div>

      <AddButton onClick={addRow}>+ Add a button</AddButton>

      <div style={HINT}>
        The display shows buttons in this order. A button without an action
        picked yet stays hidden on the display until it&apos;s finished.
      </div>
    </section>
  );
}

// ── Expanded form ───────────────────────────────────────────────────────────

function RowForm({ row, onUpdate, catalog, connected, states }: {
  row: HAButtonRow;
  onUpdate: (u: Partial<HAButtonRow>) => void;
  catalog: HAServiceDef[] | null;
  connected: boolean;
  states: HAStateObject[] | null;
}) {
  const def = catalog ? findServiceDef(catalog, row.domain, row.service) : undefined;

  // JSON draft commits on blur; invalid text shows an error and doesn't save.
  const [jsonText, setJsonText] = React.useState<string>(() =>
    row.serviceData ? JSON.stringify(row.serviceData) : '');
  const [jsonError, setJsonError] = React.useState<string | null>(null);

  function commitJson() {
    const parsed = parseServiceDataJson(jsonText);
    if (parsed.ok) {
      setJsonError(null);
      onUpdate({ serviceData: parsed.value });
    } else {
      setJsonError(parsed.error);
    }
  }

  function pickService(s: HAServiceDef) {
    const updates: Partial<HAButtonRow> = { domain: s.domain, service: s.service };
    // Auto-swap the icon while the user hasn't customized it (it still
    // matches the old domain's default). A hand-picked icon is kept.
    if (!row.domain || row.icon === defaultIconForDomain(row.domain)) {
      updates.icon = defaultIconForDomain(s.domain);
    }
    // A target from the old service rarely fits the new one.
    if (row.domain && (row.domain !== s.domain || row.service !== s.service)) {
      updates.entityId = undefined;
    }
    onUpdate(updates);
  }

  // Device options: entities from the service's own domain when any exist
  // (lock.lock → locks, scene.turn_on → scenes); otherwise every entity
  // (homeassistant.turn_on can target anything).
  const deviceOptions = React.useMemo(() => {
    if (!states) return [];
    const sameDomain = row.domain
      ? states.filter((s) => entityDomain(s.entity_id) === row.domain)
      : [];
    const pool = sameDomain.length > 0 ? sameDomain : states;
    return [...pool].sort((a, b) => friendlyName(a).localeCompare(friendlyName(b)));
  }, [states, row.domain]);

  const needsEntity = def?.needsEntity ?? false;

  return (
    <>
      <Field label="Button name">
        <input
          style={INPUT}
          value={row.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          placeholder="Good Night"
        />
      </Field>

      <Field label="Icon & color">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {BUTTON_ICON_CHOICES.map((name) => (
              <IconOption key={name} name={name} selected={row.icon === name}
                onPick={() => onUpdate({ icon: name })} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            {TONE_ORDER.map((t) => (
              <ToneOption key={t} tone={t} selected={row.tone === t}
                onPick={() => onUpdate({ tone: t })} />
            ))}
          </div>
        </div>
      </Field>

      <ServicePicker
        row={row} catalog={catalog} connected={connected} def={def}
        onPick={pickService}
      />

      <DevicePicker
        row={row} options={deviceOptions} needsEntity={needsEntity}
        ready={Boolean(states) && deviceOptions.length > 0}
        onPick={(entityId) => onUpdate({ entityId })}
      />

      <div style={{ gridColumn: '1 / -1' }}>
        <GreenToggle
          label="Hold for one second to run"
          checked={row.holdToRun === true}
          onChange={(v) => onUpdate({ holdToRun: v || undefined })}
        />
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 4, marginLeft: 50 }}>
          Good for locks, garage doors, anything you don&apos;t want bumped by accident.
        </div>
      </div>

      <div style={{ gridColumn: '1 / -1' }}>
        <Field label={
          <>Advanced: extra settings sent with the action
            <span style={{ color: 'rgba(255,255,255,0.35)', fontWeight: 400 }}> — optional JSON</span>
          </>
        }>
          <textarea
            rows={2}
            style={{
              ...INPUT, resize: 'none', lineHeight: 1.5,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5,
            }}
            value={jsonText}
            placeholder='{ "code": "1234" }'
            onChange={(e) => setJsonText(e.target.value)}
            onBlur={commitJson}
          />
          {jsonError && (
            <div style={{ fontSize: 10.5, color: '#f87171', marginTop: 4 }}>{jsonError}</div>
          )}
        </Field>
      </div>
    </>
  );
}

// ── Service picker ──────────────────────────────────────────────────────────
//
// The shared PickerShell / popup chrome lives in config-ui.tsx (also used by
// the rule-entity picker in RulesEditor).

function ServicePicker({ row, catalog, connected, def, onPick }: {
  row: HAButtonRow;
  catalog: HAServiceDef[] | null;
  connected: boolean;
  def: HAServiceDef | undefined;
  onPick: (s: HAServiceDef) => void;
}) {
  const current = row.domain && row.service
    ? `${row.domain}.${row.service}` : '';

  return (
    <Field label="What it should do">
      <PickerShell
        current={current} mono
        placeholder={connected ? 'Search actions… e.g. lock, script, scene' : 'Connect to Home Assistant first'}
        disabled={!connected}
      >
        {(query, close) => {
          if (catalog == null) return <PopupNote>Loading actions…</PopupNote>;
          const { groups, truncated } = groupServicesForPicker(catalog, query);
          if (groups.length === 0) return <PopupNote>Nothing matches.</PopupNote>;
          return (
            <>
              {groups.map((g) => (
                <React.Fragment key={g.domain}>
                  <div style={{
                    fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.1em',
                    color: 'rgba(255,255,255,0.35)', padding: '8px 12px 4px',
                  }}>{g.label}</div>
                  {g.services.map((s) => {
                    const selected = def?.domain === s.domain && def?.service === s.service;
                    return (
                      <div
                        key={`${s.domain}.${s.service}`}
                        onMouseDown={(e) => { e.preventDefault(); onPick(s); close(); }}
                        style={{
                          ...POPUP_ITEM,
                          background: selected ? 'rgba(59,130,246,0.16)' : 'transparent',
                        }}
                      >
                        <span style={POPUP_MONO}>{s.domain}.{s.service}</span>
                        {s.name && s.name !== s.service.replace(/_/g, ' ') && (
                          <span style={POPUP_DIM}>{s.name}</span>
                        )}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
              {truncated && <PopupNote divider>Keep typing to narrow the list.</PopupNote>}
            </>
          );
        }}
      </PickerShell>
      {def?.description && (
        <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.35)', marginTop: 4, lineHeight: 1.45 }}>
          {def.description}
        </div>
      )}
    </Field>
  );
}

// ── Device picker ───────────────────────────────────────────────────────────

const DEVICE_PICKER_CAP = 100;

function DevicePicker({ row, options, needsEntity, ready, onPick }: {
  row: HAButtonRow;
  options: HAStateObject[];
  needsEntity: boolean;
  ready: boolean;
  onPick: (entityId: string | undefined) => void;
}) {
  const selected = row.entityId
    ? options.find((s) => s.entity_id === row.entityId) : undefined;
  const current = row.entityId
    ? (selected ? `${friendlyName(selected)} (${row.entityId})` : row.entityId)
    : '';

  return (
    <Field label={
      <>Which device{needsEntity && (
        <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>
          {' '}— this action needs one
        </span>
      )}</>
    }>
      <PickerShell
        current={current}
        placeholder={ready ? 'Search devices…' : 'Connect to Home Assistant first'}
        disabled={!ready}
      >
        {(query, close) => {
          const q = query.trim().toLowerCase();
          const matched = q
            ? options.filter((s) =>
                s.entity_id.toLowerCase().includes(q)
                || friendlyName(s).toLowerCase().includes(q))
            : options;
          const capped = matched.slice(0, DEVICE_PICKER_CAP);
          return (
            <>
              <div
                onMouseDown={(e) => { e.preventDefault(); onPick(undefined); close(); }}
                style={{
                  ...POPUP_ITEM,
                  background: !row.entityId ? 'rgba(59,130,246,0.16)' : 'transparent',
                }}
              >
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>No device</span>
              </div>
              {capped.map((s) => (
                <div
                  key={s.entity_id}
                  onMouseDown={(e) => { e.preventDefault(); onPick(s.entity_id); close(); }}
                  style={{
                    ...POPUP_ITEM,
                    background: s.entity_id === row.entityId
                      ? 'rgba(59,130,246,0.16)' : 'transparent',
                  }}
                >
                  <span style={{
                    display: 'block', fontSize: 12, color: '#fff',
                    overflowWrap: 'anywhere', lineHeight: 1.35,
                  }}>
                    {friendlyName(s)}
                  </span>
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
      {needsEntity && !row.entityId && (
        <div style={{ fontSize: 10.5, color: '#fbbf24', marginTop: 4 }}>
          Pick a device or this button won&apos;t do anything.
        </div>
      )}
    </Field>
  );
}

// IconOption / ToneOption moved to config-ui.tsx (shared with RulesEditor).
