// Entity cards — domain-aware visual representations of an HA state.
// Each card exports its own component; `EntityCard` at the bottom routes
// by domain. Cards are read-only here; interactive controls live in
// controls.tsx and are composed in by views when config.showControls is on.

import React from 'react';
import type { HAStateObject } from './types';
import { entityDomain } from './types';
import { friendlyName, formatValue, relativeTime, isActiveState, isAlertState, batteryAlert } from './utils';
import { Icon, iconFor } from './icons';

// ── Shared CardShell ────────────────────────────────────────────────────────

interface CardShellProps {
  state: HAStateObject;
  compact?: boolean;
  spanFull?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  tone?: 'default' | 'on' | 'active' | 'alert';
}

const TONE_STYLES: Record<NonNullable<CardShellProps['tone']>, React.CSSProperties> = {
  default: {
    background: 'rgba(255, 255, 255, 0.04)',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    color: 'rgba(255, 255, 255, 0.75)',
  },
  on: {
    background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.12), rgba(255, 255, 255, 0.03))',
    borderColor: 'rgba(251, 191, 36, 0.22)',
    color: '#fef3c7',
  },
  active: {
    background: 'linear-gradient(135deg, rgba(251, 146, 60, 0.14), rgba(251, 146, 60, 0.04))',
    borderColor: 'rgba(251, 146, 60, 0.28)',
    color: '#fed7aa',
  },
  alert: {
    background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.12), rgba(239, 68, 68, 0.02))',
    borderColor: 'rgba(239, 68, 68, 0.26)',
    color: '#fecaca',
  },
};

export function CardShell({ state, compact, spanFull, onClick, children, tone = 'default' }: CardShellProps) {
  const toneStyle = TONE_STYLES[tone];
  return (
    <div
      onClick={onClick}
      style={{
        ...toneStyle,
        border: `1px solid ${toneStyle.borderColor}`,
        borderRadius: 12,
        padding: compact ? 10 : 14,
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 4 : 6,
        minHeight: compact ? 72 : 100,
        gridColumn: spanFull ? '1 / -1' : undefined,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'transform 0.12s ease, background 0.15s ease',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </div>
  );
}

function CardHeader({ state, color }: { state: HAStateObject; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: color ?? 'currentColor' }}>
      <Icon name={iconFor(state)} size={18} />
      <span
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'rgba(255, 255, 255, 0.6)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {friendlyName(state)}
      </span>
    </div>
  );
}

function BigValue({ children, faint, compact }: {
  children: React.ReactNode; faint?: boolean; compact?: boolean;
}) {
  return (
    <div
      style={{
        fontSize: compact ? 20 : 24,
        fontWeight: 600,
        letterSpacing: '-0.02em',
        lineHeight: 1.15,
        color: faint ? 'rgba(255, 255, 255, 0.55)' : '#fff',
        fontVariantNumeric: 'tabular-nums',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

function SubText({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: 'rgba(255, 255, 255, 0.45)',
        marginTop: 'auto',
        display: 'flex',
        justifyContent: 'space-between',
        gap: 6,
      }}
    >
      {children}
    </div>
  );
}

// ── Individual cards ────────────────────────────────────────────────────────
//
// Cards that accept an optional `onTap` become tappable when the host config
// has showControls=true. Read-only domains (sensor, binary_sensor, weather,
// person) never use onTap — tapping should do nothing.

type CardProps = { state: HAStateObject; compact?: boolean; onTap?: () => void };
type ReadOnlyCardProps = { state: HAStateObject; compact?: boolean };

function SensorCard({ state, compact }: ReadOnlyCardProps) {
  const alert = batteryAlert(state);
  return (
    <CardShell state={state} compact={compact} tone={alert ? 'alert' : 'default'}>
      <CardHeader state={state} />
      <BigValue compact={compact}>{formatValue(state)}</BigValue>
      <SubText>
        <span>{relativeTime(state.last_changed)}</span>
      </SubText>
    </CardShell>
  );
}

function BinarySensorCard({ state, compact }: ReadOnlyCardProps) {
  const alert = isAlertState(state);
  const on = state.state === 'on';
  return (
    <CardShell state={state} compact={compact} tone={alert ? 'alert' : on ? 'on' : 'default'}>
      <CardHeader state={state} />
      <BigValue compact={compact} faint={state.state === 'off'}>{formatValue(state)}</BigValue>
      <SubText>
        <span>{relativeTime(state.last_changed)}</span>
        {alert && <span style={{ color: '#f87171' }}>● alert</span>}
      </SubText>
    </CardShell>
  );
}

function LightCard({ state, compact, onTap }: CardProps) {
  const on = state.state === 'on';
  const brightness = typeof state.attributes.brightness === 'number'
    ? Math.round((state.attributes.brightness / 255) * 100)
    : null;
  const temp = state.attributes.color_temp_kelvin;
  return (
    <CardShell state={state} compact={compact} tone={on ? 'on' : 'default'} onClick={onTap}>
      <CardHeader state={state} />
      <BigValue compact={compact} faint={!on}>
        {on ? 'On' : 'Off'}
        {on && brightness != null && (
          <span style={{ fontSize: 14, fontWeight: 400, color: 'rgba(255,255,255,0.55)', marginLeft: 6 }}>
            · {brightness}%
          </span>
        )}
      </BigValue>
      <SubText>
        {on && temp
          ? <span>Warm · {temp}K</span>
          : <span>{relativeTime(state.last_changed)}</span>}
      </SubText>
    </CardShell>
  );
}

function SwitchCard({ state, compact, onTap }: CardProps) {
  const on = state.state === 'on';
  return (
    <CardShell state={state} compact={compact} tone={on ? 'on' : 'default'} onClick={onTap}>
      <CardHeader state={state} />
      <BigValue compact={compact} faint={!on}>{formatValue(state)}</BigValue>
      <SubText><span>{relativeTime(state.last_changed)}</span></SubText>
    </CardShell>
  );
}

function ClimateCard({ state, compact }: ReadOnlyCardProps) {
  const active = isActiveState(state);
  const current = state.attributes.current_temperature;
  const target = state.attributes.temperature;
  const action = state.attributes.hvac_action;
  return (
    <CardShell state={state} compact={compact} tone={active ? 'active' : 'default'}>
      <CardHeader state={state} />
      <BigValue compact={compact}>
        {current != null ? `${current}°` : formatValue(state)}
      </BigValue>
      <SubText>
        <span>{target != null ? `target ${target}°` : ''}</span>
        <span style={{ textTransform: 'capitalize' }}>{action || state.state}</span>
      </SubText>
    </CardShell>
  );
}

function WeatherCard({ state, compact }: ReadOnlyCardProps) {
  const temp = state.attributes.temperature;
  return (
    <CardShell state={state} compact={compact} tone="default">
      <CardHeader state={state} />
      <BigValue compact={compact}>{temp != null ? `${temp}°` : formatValue(state)}</BigValue>
      <SubText>
        <span style={{ textTransform: 'capitalize' }}>{state.state.replace(/-/g, ' ')}</span>
        {typeof state.attributes.humidity === 'number' && <span>{state.attributes.humidity}% RH</span>}
      </SubText>
    </CardShell>
  );
}

function PersonCard({ state, compact }: ReadOnlyCardProps) {
  const home = state.state === 'home';
  return (
    <CardShell state={state} compact={compact} tone={home ? 'on' : 'default'}>
      <CardHeader state={state} />
      <BigValue compact={compact} faint={!home}>{formatValue(state)}</BigValue>
      <SubText><span>{relativeTime(state.last_changed)}</span></SubText>
    </CardShell>
  );
}

function MediaPlayerCard({ state, compact, onTap }: CardProps) {
  const active = isActiveState(state);
  const title = state.attributes.media_title;
  const artist = state.attributes.media_artist;
  return (
    <CardShell state={state} compact={compact} spanFull tone={active ? 'active' : 'default'} onClick={onTap}>
      <CardHeader state={state} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title || formatValue(state)}
        </div>
        {artist && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{artist}</div>}
      </div>
      <SubText><span style={{ textTransform: 'capitalize' }}>{state.state}</span></SubText>
    </CardShell>
  );
}

function CoverCard({ state, compact, onTap }: CardProps) {
  const open = state.state === 'open' || state.state === 'opening';
  const pos = state.attributes.current_position;
  return (
    <CardShell state={state} compact={compact} tone={open ? 'on' : 'default'} onClick={onTap}>
      <CardHeader state={state} />
      <BigValue compact={compact} faint={!open}>{formatValue(state)}</BigValue>
      <SubText>{typeof pos === 'number' && <span>{pos}% open</span>}</SubText>
    </CardShell>
  );
}

function LockCard({ state, compact }: ReadOnlyCardProps) {
  const unlocked = state.state === 'unlocked';
  const jammed = state.state === 'jammed';
  return (
    <CardShell state={state} compact={compact} tone={jammed ? 'alert' : unlocked ? 'on' : 'default'}>
      <CardHeader state={state} />
      <BigValue compact={compact} faint={!unlocked && !jammed}>{formatValue(state)}</BigValue>
      <SubText><span>{relativeTime(state.last_changed)}</span></SubText>
    </CardShell>
  );
}

function FanCard({ state, compact, onTap }: CardProps) {
  const on = state.state === 'on';
  const pct = state.attributes.percentage;
  return (
    <CardShell state={state} compact={compact} tone={on ? 'on' : 'default'} onClick={onTap}>
      <CardHeader state={state} />
      <BigValue compact={compact} faint={!on}>
        {on ? 'On' : 'Off'}
        {on && typeof pct === 'number' && (
          <span style={{ fontSize: 14, fontWeight: 400, color: 'rgba(255,255,255,0.55)', marginLeft: 6 }}>
            · {pct}%
          </span>
        )}
      </BigValue>
    </CardShell>
  );
}

function SceneCard({ state, compact, onTap }: CardProps) {
  return (
    <CardShell state={state} compact={compact} tone="default" onClick={onTap}>
      <CardHeader state={state} />
      <BigValue compact={compact} faint={!onTap}>
        {onTap ? 'Activate' : 'Scene'}
      </BigValue>
      <SubText><span>{relativeTime(state.last_changed)}</span></SubText>
    </CardShell>
  );
}

function GenericCard({ state, compact }: ReadOnlyCardProps) {
  return (
    <CardShell state={state} compact={compact}>
      <CardHeader state={state} />
      <BigValue compact={compact}>{formatValue(state)}</BigValue>
      <SubText><span>{relativeTime(state.last_changed)}</span></SubText>
    </CardShell>
  );
}

// ── Domain router ──────────────────────────────────────────────────────────

export type CardCommand = (
  state: HAStateObject, service: string, data?: Record<string, unknown>,
) => void;

interface EntityCardProps {
  state: HAStateObject;
  compact?: boolean;
  onCommand?: CardCommand;
}

// Default tap action by domain. null = tap is a no-op (read-only domain).
function defaultTapService(d: string): string | null {
  switch (d) {
    case 'light': case 'switch': case 'fan': case 'input_boolean': case 'automation':
      return 'toggle';
    case 'scene':
      return 'turn_on';
    case 'media_player':
      return 'media_play_pause';
    case 'cover':
      return 'toggle';
    default:
      return null;
  }
}

export function EntityCard({ state, compact, onCommand }: EntityCardProps) {
  if (state.state === 'unavailable') {
    return (
      <CardShell state={state} compact={compact} tone="default">
        <CardHeader state={state} />
        <div style={{
          fontSize: 13, color: 'rgba(255,255,255,0.35)',
          fontStyle: 'italic', marginTop: 'auto',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          Unavailable
        </div>
      </CardShell>
    );
  }
  const d = entityDomain(state.entity_id);
  const tapService = onCommand ? defaultTapService(d) : null;
  const onTap = tapService ? () => onCommand!(state, tapService) : undefined;

  switch (d) {
    case 'sensor': return <SensorCard state={state} compact={compact} />;
    case 'binary_sensor': return <BinarySensorCard state={state} compact={compact} />;
    case 'light': return <LightCard state={state} compact={compact} onTap={onTap} />;
    case 'switch': case 'input_boolean': case 'automation': return <SwitchCard state={state} compact={compact} onTap={onTap} />;
    case 'climate': return <ClimateCard state={state} compact={compact} />;
    case 'weather': return <WeatherCard state={state} compact={compact} />;
    case 'person': return <PersonCard state={state} compact={compact} />;
    case 'media_player': return <MediaPlayerCard state={state} compact={compact} onTap={onTap} />;
    case 'cover': return <CoverCard state={state} compact={compact} onTap={onTap} />;
    case 'lock': return <LockCard state={state} compact={compact} />;
    case 'fan': return <FanCard state={state} compact={compact} onTap={onTap} />;
    case 'scene': return <SceneCard state={state} compact={compact} onTap={onTap} />;
    default: return <GenericCard state={state} compact={compact} />;
  }
}
