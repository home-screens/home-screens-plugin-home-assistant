// Shared editor-modal UI atoms, extracted from ConfigSection.tsx so sibling
// editor panels (ButtonsEditor, RulesEditor) can reuse them without importing
// the whole modal (which would be a require cycle: ConfigSection renders the
// editors). The picker/popup family lives here too — the service, device,
// and rule-entity pickers all share the same search-popup chrome.

import React from 'react';
import { Icon, type IconName } from './icons';
import { BUTTON_TONES } from './buttons';
import type { HAButtonTone } from './types';

export const INPUT: React.CSSProperties = {
  width: '100%', padding: '9px 12px', fontSize: 13,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  color: '#fff', borderRadius: 6, fontFamily: 'inherit',
  boxSizing: 'border-box', outline: 'none',
};

export const HINT: React.CSSProperties = {
  fontSize: 12, color: 'rgba(255,255,255,0.45)', lineHeight: 1.5, marginTop: 10,
};

export function secondaryBtn(disabled: boolean): React.CSSProperties {
  return {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    color: disabled ? 'rgba(255,255,255,0.3)' : '#f5f5f7',
    fontSize: 12, padding: '7px 14px', borderRadius: 6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit', fontWeight: 500,
    whiteSpace: 'nowrap', flexShrink: 0,
  };
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em',
      color: 'rgba(255,255,255,0.45)', marginBottom: 12,
    }}>{children}</div>
  );
}

export function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>{label}</span>
      {children}
    </label>
  );
}

export function GreenToggle({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  // <label> forwards clicks only to a contained <input>; since we render a
  // role="switch" <span>, clicks on the label text were previously dead. The
  // onClick on <label> handles text clicks; the span has its own handler
  // with stopPropagation so a click on the knob doesn't both fire on the
  // span AND bubble up to re-toggle via the label handler.
  return (
    <label
      onClick={() => onChange(!checked)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 10,
        cursor: 'pointer', userSelect: 'none',
        fontSize: 13, color: 'rgba(255,255,255,0.8)',
      }}>
      <span
        role="switch" aria-checked={checked} tabIndex={0}
        onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(!checked); } }}
        style={{
          width: 40, height: 22, borderRadius: 99,
          background: checked ? '#22c55e' : 'rgba(255,255,255,0.1)',
          border: `1px solid ${checked ? '#22c55e' : 'rgba(255,255,255,0.15)'}`,
          position: 'relative', flexShrink: 0,
          transition: 'background 0.15s ease, border-color 0.15s ease',
        }}
      >
        <span style={{
          position: 'absolute', top: 1, left: checked ? 19 : 1,
          width: 18, height: 18, borderRadius: 99, background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          transition: 'left 0.15s ease',
        }} />
      </span>
      {label}
    </label>
  );
}

/**
 * One switch with its own description, laid out for SettingsGrid.
 *
 * The description is what lets the shared explanatory paragraph go away. A
 * sentence sitting next to its switch no longer has to name itself, which is
 * why these read "Tap and hold to operate this widget" rather than the old
 * "Show controls lets you tap this widget...".
 *
 * Keep every description to one line at this column width (roughly 45
 * characters). Two-line descriptions are what made the old block tall; if a
 * setting genuinely needs more words, the words are wrong, not the layout.
 */
export function SettingRow({ label, desc, checked, onChange, last }: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Row sits in the grid's last line; drops the divider so the block ends on
   *  content rather than on a rule hanging under the shorter column. */
  last?: boolean;
}) {
  return (
    <label
      onClick={() => onChange(!checked)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12, padding: '8px 0',
        borderBottom: last ? 'none' : '1px solid rgba(255,255,255,0.06)',
        cursor: 'pointer', userSelect: 'none',
      }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12.5, color: 'rgba(255,255,255,0.88)' }}>
          {label}
        </span>
        <span style={{
          display: 'block', fontSize: 11, lineHeight: 1.4, marginTop: 2,
          color: 'rgba(255,255,255,0.45)',
        }}>{desc}</span>
      </span>
      {/* Same switch as GreenToggle, minus its own label and click target:
          the whole row is the target here. */}
      <span
        role="switch" aria-checked={checked} tabIndex={0}
        onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(!checked); } }}
        style={{
          width: 34, height: 19, borderRadius: 99, marginTop: 1,
          background: checked ? '#22c55e' : 'rgba(255,255,255,0.1)',
          border: `1px solid ${checked ? '#22c55e' : 'rgba(255,255,255,0.15)'}`,
          position: 'relative', flexShrink: 0,
          transition: 'background 0.15s ease, border-color 0.15s ease',
        }}
      >
        <span style={{
          position: 'absolute', top: 1, left: checked ? 16 : 1,
          width: 15, height: 15, borderRadius: 99, background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          transition: 'left 0.15s ease',
        }} />
      </span>
    </label>
  );
}

/**
 * Two-column holder for SettingRow. Six settings become three rows, which is
 * what keeps the block shorter than the single row of switches plus paragraph
 * it replaced.
 *
 * An odd number of children leaves the last cell empty rather than stretching
 * anything, and every view hides a different subset, so the count really does
 * vary from two to six.
 */
export function SettingsGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 22,
      marginTop: 14, paddingTop: 10,
      borderTop: '1px solid rgba(255,255,255,0.06)',
    }}>{children}</div>
  );
}

// ── Picker shell ────────────────────────────────────────────────────────────
//
// Shared search-popup chrome for the service, device, and rule-entity
// pickers, matching the host editor's custom suggestion dropdowns (a native
// <select> opens the OS-styled list, which clashes with the dark modal). The
// input shows the current value when closed and becomes a search box while
// open; item picks use onMouseDown (fires before blur), so plain blur just
// closes the popup.

export function PickerShell({ current, mono, placeholder, disabled, children }: {
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

export function PopupNote({ children, divider }: { children: React.ReactNode; divider?: boolean }) {
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
export const POPUP_ITEM: React.CSSProperties = {
  padding: '7px 12px', cursor: 'pointer',
};

export const POPUP_MONO: React.CSSProperties = {
  display: 'block', fontSize: 12, color: '#fff',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  overflowWrap: 'anywhere', lineHeight: 1.35,
};

export const POPUP_DIM: React.CSSProperties = {
  display: 'block', fontSize: 10.5, color: 'rgba(255,255,255,0.4)',
  overflowWrap: 'anywhere', lineHeight: 1.35, marginTop: 1,
};

// ── Icon & tone swatch pickers ──────────────────────────────────────────────

export function IconOption({ name, selected, onPick }: {
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

export function ToneOption({ tone, selected, onPick }: {
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

// ── Row-list scaffolding ────────────────────────────────────────────────────
//
// Collapse/expand + HTML5 drag reorder (the editor is desktop Chromium) for
// the row editors: ButtonsEditor, AlertsEditor, LookRulesEditor. Each row
// renders through RowShell — drag handle, tone chip, title/subtitle summary,
// trash button, chevron — with the expanded form laid out in a responsive
// grid underneath.

export function mintId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface RowListState<T extends { id: string }> {
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  update: (id: string, u: Partial<T>) => void;
  remove: (id: string) => void;
  dragProps: (index: number) => React.HTMLAttributes<HTMLDivElement> & { draggable: boolean };
  isDropTarget: (index: number) => boolean;
}

export function useRowList<T extends { id: string }>(
  rows: T[], onChange: (rows: T[]) => void,
): RowListState<T> {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [dropIndex, setDropIndex] = React.useState<number | null>(null);

  function moveRow(from: number, to: number) {
    if (from === to) return;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  }

  return {
    expandedId,
    setExpandedId,
    update: (id, u) => onChange(rows.map((r) => (r.id === id ? { ...r, ...u } : r))),
    remove: (id) => {
      onChange(rows.filter((r) => r.id !== id));
      if (expandedId === id) setExpandedId(null);
    },
    dragProps: (i) => ({
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
    }),
    isDropTarget: (i) => dropIndex === i && dragIndex !== i,
  };
}

export function RowShell<T extends { id: string }>({
  list, index, id, chipIcon, chipTone, title, subtitle, incomplete,
  monoSubtitle, badge, removeLabel, children,
}: {
  list: RowListState<T>;
  index: number;
  id: string;
  chipIcon: IconName;
  chipTone: HAButtonTone;
  title: string;
  subtitle: string;
  incomplete: boolean;
  /** Render the subtitle in the mono font (service ids). */
  monoSubtitle?: boolean;
  /** Extra pill between the summary text and the trash icon. */
  badge?: React.ReactNode;
  removeLabel: string;
  children: React.ReactNode;
}) {
  const expanded = list.expandedId === id;
  const tone = BUTTON_TONES[chipTone] ?? BUTTON_TONES.default;
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: `1px solid ${expanded ? 'rgba(59,130,246,0.4)'
        : list.isDropTarget(index) ? 'rgba(59,130,246,0.6)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 10,
    }}>
      <div
        {...list.dragProps(index)}
        onClick={() => list.setExpandedId(expanded ? null : id)}
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
          <Icon name={chipIcon} size={15} />
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{
            display: 'block', fontSize: 13, fontWeight: 600, color: '#fff',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{title}</span>
          <span style={{
            display: 'block', fontSize: 11, marginTop: 1,
            color: incomplete ? '#fbbf24' : 'rgba(255,255,255,0.45)',
            fontFamily: monoSubtitle
              ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{subtitle}</span>
        </span>
        {badge}
        <button
          aria-label={removeLabel}
          onClick={(e) => { e.stopPropagation(); list.remove(id); }}
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
      {/* Key by row id so per-row local state (JSON drafts, search queries)
          never leaks between rows. */}
      {expanded && (
        <div key={id} style={{
          borderTop: '1px solid rgba(255,255,255,0.07)',
          padding: '16px 14px',
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '14px 16px',
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      marginTop: 10, padding: '9px 16px', borderRadius: 7,
      background: 'rgba(59,130,246,0.14)', border: '1px solid rgba(59,130,246,0.4)',
      color: '#93c5fd', fontSize: 12, fontWeight: 600,
      cursor: 'pointer', fontFamily: 'inherit',
    }}>{children}</button>
  );
}
