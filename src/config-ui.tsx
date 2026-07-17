// Shared editor-modal UI atoms, extracted from ConfigSection.tsx so sibling
// editor panels (ButtonsEditor) can reuse them without importing the whole
// modal (which would be a require cycle: ConfigSection renders ButtonsEditor).

import React from 'react';

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
