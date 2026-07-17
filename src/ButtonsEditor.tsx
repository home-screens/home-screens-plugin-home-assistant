// Editor panel for the `buttons` view — replaces the entity browser inside
// the Configure Home Assistant modal. Rows collapse to a summary and reorder
// by drag; the "What it should do" picker is searchable, grouped by friendly
// domain labels, and fed live from HA's /api/services through the proxy.
// Extra service data stays behind an Advanced JSON field.

import React from 'react';
import type { HAStateObject, HAButtonRow, HAButtonTone } from './types';
import { entityDomain } from './types';
import { fetchServices } from './api';
import { friendlyName } from './utils';
import { Icon, isIconName, type IconName } from './icons';
import { INPUT, HINT, secondaryBtn, SectionTitle, Field, GreenToggle } from './config-ui';
import {
  BUTTON_TONES, TONE_ORDER, BUTTON_ICON_CHOICES,
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
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  // Drag-to-reorder (HTML5 DnD — the editor is desktop Chromium).
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [dropIndex, setDropIndex] = React.useState<number | null>(null);

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

  function updateRow(id: string, updates: Partial<HAButtonRow>) {
    onChange(buttons.map((b) => (b.id === id ? { ...b, ...updates } : b)));
  }

  function removeRow(id: string) {
    onChange(buttons.filter((b) => b.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  function addRow() {
    const id = `btn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    onChange([...buttons, {
      id, label: 'New button', icon: 'power', tone: 'default',
      domain: '', service: '',
    }]);
    setExpandedId(id);
  }

  function moveRow(from: number, to: number) {
    if (from === to) return;
    const next = [...buttons];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
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
        {buttons.map((row, i) => (
          <ButtonRowItem
            key={row.id}
            row={row}
            expanded={expandedId === row.id}
            onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
            onUpdate={(u) => updateRow(row.id, u)}
            onRemove={() => removeRow(row.id)}
            catalog={catalog}
            connected={connected}
            states={states}
            dragProps={{
              draggable: true,
              onDragStart: (e: React.DragEvent) => {
                e.dataTransfer.effectAllowed = 'move';
                setDragIndex(i);
              },
              onDragOver: (e: React.DragEvent) => {
                e.preventDefault();
                if (dragIndex != null && dropIndex !== i) setDropIndex(i);
              },
              onDrop: (e: React.DragEvent) => {
                e.preventDefault();
                if (dragIndex != null) moveRow(dragIndex, i);
                setDragIndex(null); setDropIndex(null);
              },
              onDragEnd: () => { setDragIndex(null); setDropIndex(null); },
            }}
            dropTarget={dropIndex === i && dragIndex !== i}
          />
        ))}
      </div>

      <button onClick={addRow} style={{
        marginTop: 10, padding: '9px 16px', borderRadius: 7,
        background: 'rgba(59,130,246,0.14)', border: '1px solid rgba(59,130,246,0.4)',
        color: '#93c5fd', fontSize: 12, fontWeight: 600,
        cursor: 'pointer', fontFamily: 'inherit',
      }}>+ Add a button</button>

      <div style={HINT}>
        The display shows buttons in this order. A button without an action
        picked yet stays hidden on the display until it&apos;s finished.
      </div>
    </section>
  );
}

// ── One row ─────────────────────────────────────────────────────────────────

interface RowProps {
  row: HAButtonRow;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (u: Partial<HAButtonRow>) => void;
  onRemove: () => void;
  catalog: HAServiceDef[] | null;
  connected: boolean;
  states: HAStateObject[] | null;
  dragProps: React.HTMLAttributes<HTMLDivElement> & { draggable: boolean };
  dropTarget: boolean;
}

function ButtonRowItem(props: RowProps) {
  const { row, expanded, onToggle, onRemove, dragProps, dropTarget } = props;
  const tone = BUTTON_TONES[row.tone] ?? BUTTON_TONES.default;
  const serviceLine = row.domain && row.service
    ? `${row.domain}.${row.service}${row.entityId ? ` · ${row.entityId}` : ''}`
    : 'Pick what it should do';

  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: `1px solid ${expanded ? 'rgba(59,130,246,0.4)'
        : dropTarget ? 'rgba(59,130,246,0.6)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 10,
    }}>
      <div
        {...dragProps}
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '11px 14px', cursor: 'pointer',
        }}
      >
        <span title="Drag to reorder" style={{
          color: 'rgba(255,255,255,0.25)', fontSize: 14, letterSpacing: -2,
          cursor: 'grab', flexShrink: 0,
        }}>⠿</span>
        <span style={{
          width: 30, height: 30, borderRadius: 8, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: tone.chipBg, color: tone.accent,
        }}>
          <Icon name={isIconName(row.icon) ? row.icon : 'bolt'} size={15} />
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{
            display: 'block', fontSize: 13, fontWeight: 600, color: '#fff',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{row.label || 'New button'}</span>
          <span style={{
            display: 'block', fontSize: 11, marginTop: 1,
            color: row.domain ? 'rgba(255,255,255,0.45)' : '#fbbf24',
            fontFamily: row.domain
              ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{serviceLine}</span>
        </span>
        {row.holdToRun && (
          <span style={{
            fontSize: 10, padding: '3px 8px', borderRadius: 99, flexShrink: 0,
            background: 'rgba(248,113,113,0.1)',
            border: '1px solid rgba(248,113,113,0.25)', color: '#fca5a5',
          }}>hold to run</span>
        )}
        <button
          aria-label="Remove button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.3)', padding: 4, flexShrink: 0,
            display: 'flex',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{
            color: 'rgba(255,255,255,0.35)', flexShrink: 0,
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s ease',
          }} aria-hidden="true">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </div>
      {/* Key by row id so per-row local state (JSON draft, search query)
          never leaks between rows. */}
      {expanded && <RowForm key={row.id} {...props} />}
    </div>
  );
}

// ── Expanded form ───────────────────────────────────────────────────────────

function RowForm({ row, onUpdate, catalog, connected, states }: RowProps) {
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
    <div style={{
      borderTop: '1px solid rgba(255,255,255,0.07)',
      padding: '16px 14px',
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
      gap: '14px 16px',
    }}>
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
    </div>
  );
}

// ── Picker shell ────────────────────────────────────────────────────────────
//
// Shared search-popup chrome for the service and device pickers, matching
// the host editor's custom suggestion dropdowns (a native <select> opens the
// OS-styled list, which clashes with the dark modal). The input shows the
// current value when closed and becomes a search box while open; item picks
// use onMouseDown (fires before blur), so plain blur just closes the popup.

function PickerShell({ current, mono, placeholder, disabled, children }: {
  /** Closed-state display value ('' shows the placeholder). */
  current: string;
  /** Render the closed value in the mono font (service ids). */
  mono?: boolean;
  placeholder: string;
  disabled?: boolean;
  /** Popup body for a given query; return items wired to onMouseDown. */
  children: (query: string, close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const close = React.useCallback(() => { setOpen(false); setQuery(''); }, []);

  return (
    <div style={{ position: 'relative' }}>
      <input
        style={{
          ...INPUT,
          fontFamily: mono && current && !open
            ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
        }}
        value={open ? query : current}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onBlur={close}
        onChange={(e) => setQuery(e.target.value)}
      />
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        style={{
          position: 'absolute', right: 12, top: '50%',
          transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`,
          color: 'rgba(255,255,255,0.4)', pointerEvents: 'none',
          transition: 'transform 0.15s ease',
        }} aria-hidden="true">
        <polyline points="6 9 12 15 18 9" />
      </svg>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 30,
          background: '#171c2a',
          border: '1px solid rgba(255,255,255,0.14)',
          borderRadius: 9, overflow: 'hidden',
          boxShadow: '0 18px 44px rgba(0,0,0,0.55)',
          maxHeight: 280, overflowY: 'auto', overscrollBehavior: 'contain',
        }}>
          {children(query, close)}
        </div>
      )}
    </div>
  );
}

function PopupNote({ children, divider }: { children: React.ReactNode; divider?: boolean }) {
  return (
    <div style={{
      padding: divider ? '8px 12px' : '10px 12px',
      fontSize: divider ? 11 : 12, color: 'rgba(255,255,255,0.45)',
      borderTop: divider ? '1px solid rgba(255,255,255,0.08)' : 'none',
      textAlign: divider ? 'center' : 'left',
    }}>{children}</div>
  );
}

// Items stack their two lines and wrap long values — the form columns are
// narrow (~250px) and a single flex line would force names or entity ids to
// truncate, which made real installs' long names unreadable.
const POPUP_ITEM: React.CSSProperties = {
  padding: '7px 12px', cursor: 'pointer',
};

const POPUP_MONO: React.CSSProperties = {
  display: 'block', fontSize: 12, color: '#fff',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  overflowWrap: 'anywhere', lineHeight: 1.35,
};

const POPUP_DIM: React.CSSProperties = {
  display: 'block', fontSize: 10.5, color: 'rgba(255,255,255,0.4)',
  overflowWrap: 'anywhere', lineHeight: 1.35, marginTop: 1,
};

// ── Service picker ──────────────────────────────────────────────────────────

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

// ── Small pickers ───────────────────────────────────────────────────────────

function IconOption({ name, selected, onPick }: {
  name: IconName; selected: boolean; onPick: () => void;
}) {
  return (
    <button
      aria-label={name}
      onClick={onPick}
      style={{
        width: 32, height: 32, borderRadius: 8, padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: selected ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.05)',
        border: `1px solid ${selected ? '#3b82f6' : 'rgba(255,255,255,0.1)'}`,
        color: selected ? '#93c5fd' : 'rgba(255,255,255,0.65)',
        cursor: 'pointer',
      }}
    >
      <Icon name={name} size={15} />
    </button>
  );
}

function ToneOption({ tone, selected, onPick }: {
  tone: HAButtonTone; selected: boolean; onPick: () => void;
}) {
  const dot = tone === 'default' ? 'rgba(255,255,255,0.25)' : BUTTON_TONES[tone].accent;
  return (
    <button
      aria-label={`${tone} color`}
      onClick={onPick}
      style={{
        width: 26, height: 26, borderRadius: 99, padding: 0,
        background: dot, cursor: 'pointer',
        border: `2px solid ${selected ? '#fff' : 'transparent'}`,
      }}
    />
  );
}
