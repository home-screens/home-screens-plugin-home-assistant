// Curated inline-SVG icon set — Lucide-derived, ~24 glyphs. Domain +
// device_class maps to a glyph via iconFor().
//
// Inline SVGs keep the bundle small (<5KB vs. a ~40KB icon font) and let
// us color them via currentColor.

import React from 'react';
import type { HAStateObject } from './types';
import { entityDomain } from './types';

type IconName =
  | 'lightbulb' | 'power' | 'thermometer' | 'droplet' | 'gauge'
  | 'sun' | 'cloud' | 'wind' | 'bolt' | 'battery' | 'signal'
  | 'door' | 'window' | 'garage' | 'lock' | 'unlock' | 'motion'
  | 'smoke' | 'water' | 'leak' | 'house' | 'user' | 'music' | 'tv'
  | 'blinds' | 'curtains' | 'camera' | 'fan' | 'shield' | 'plug'
  | 'palette' | 'robot' | 'settings' | 'moon' | 'help';

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

const stroke: React.SVGProps<SVGSVGElement> = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const GLYPHS: Record<IconName, React.ReactNode> = {
  lightbulb: (<><path d="M9 21h6" /><path d="M10 17h4" /><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z" /></>),
  power: (<><path d="M12 2v10" /><path d="M5.5 6.5a7 7 0 1 0 13 0" /></>),
  thermometer: (<><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" /></>),
  droplet: (<><path d="M12 2l7 12a7 7 0 1 1-14 0L12 2z" /></>),
  gauge: (<><circle cx="12" cy="12" r="10" /><path d="M12 7v5l3 2" /></>),
  sun: (<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M5 5l1.5 1.5M17.5 17.5L19 19M2 12h2M20 12h2M5 19l1.5-1.5M17.5 6.5L19 5" /></>),
  cloud: (<><path d="M17.5 19a4.5 4.5 0 1 0 0-9h-.5a6 6 0 1 0-11 2H5a3 3 0 0 0 0 6h12.5z" /></>),
  wind: (<><path d="M9.59 4.59A2 2 0 1 1 11 8H2" /><path d="M12.59 19.41A2 2 0 1 0 14 16H2" /><path d="M17.73 7.73A2.5 2.5 0 1 1 19.5 12H2" /></>),
  bolt: (<><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></>),
  battery: (<><rect x="2" y="7" width="18" height="10" rx="2" /><path d="M22 10v4" /><path d="M6 10v4" /></>),
  signal: (<><path d="M2 20h.01" /><path d="M7 20v-4" /><path d="M12 20v-8" /><path d="M17 20V8" /><path d="M22 4v16" /></>),
  door: (<><path d="M4 22V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v18" /><path d="M2 22h20" /><circle cx="15" cy="13" r="1" /></>),
  window: (<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 12h18M12 3v18" /></>),
  garage: (<><path d="M4 9V6l8-3 8 3v3" /><rect x="4" y="9" width="16" height="12" rx="1" /><path d="M8 13h8M8 17h8" /></>),
  lock: (<><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>),
  unlock: (<><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></>),
  motion: (<><circle cx="12" cy="4" r="2" /><path d="M15 22l-3-8-2 3h-4l4-4-2-4h6l2 4 3 3" /></>),
  smoke: (<><circle cx="12" cy="12" r="10" /><path d="M8 12h8M8 16h8M10 8h4" /></>),
  water: (<><path d="M12 2l7 12a7 7 0 1 1-14 0L12 2z" /></>),
  leak: (<><path d="M12 22a7 7 0 0 1-7-7c0-3 7-13 7-13s7 10 7 13a7 7 0 0 1-7 7z" /><path d="M12 15v-3M10 12h4" /></>),
  house: (<><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 22V12h6v10" /></>),
  user: (<><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>),
  music: (<><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>),
  tv: (<><rect x="2" y="7" width="20" height="15" rx="2" /><path d="M7 2l5 5 5-5" /></>),
  blinds: (<><path d="M3 3h18v2H3zM3 9h18M3 13h18M3 17h18M3 21h18" /></>),
  curtains: (<><path d="M3 3h18v3H3z" /><path d="M6 6c0 4 0 10-3 15M18 6c0 4 0 10 3 15M12 6v15" /></>),
  camera: (<><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></>),
  fan: (<><circle cx="12" cy="12" r="2" /><path d="M12 10c0-4 2-6 5-6 0 3-1 6-5 6z" /><path d="M14 12c4 0 6 2 6 5-3 0-6-1-6-5z" /><path d="M12 14c0 4-2 6-5 6 0-3 1-6 5-6z" /><path d="M10 12c-4 0-6-2-6-5 3 0 6 1 6 5z" /></>),
  shield: (<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></>),
  plug: (<><path d="M12 22v-5M9 8V2M15 8V2M5 8h14v4a7 7 0 0 1-14 0V8z" /></>),
  palette: (<><circle cx="13.5" cy="6.5" r="1.5" /><circle cx="17.5" cy="10.5" r="1.5" /><circle cx="8.5" cy="7.5" r="1.5" /><circle cx="6.5" cy="12.5" r="1.5" /><path d="M12 22A10 10 0 0 1 12 2c5 0 10 4 10 8a5 5 0 0 1-5 5h-2a2 2 0 0 0-1 4c0 2-2 3-4 3z" /></>),
  robot: (<><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M8 4h8" /><circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" /></>),
  settings: (<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>),
  moon: (<><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></>),
  help: (<><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></>),
};

export function Icon({ name, size = 18, className, style }: IconProps) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" {...stroke}
      className={className} style={style} aria-hidden="true"
    >
      {GLYPHS[name] ?? GLYPHS.help}
    </svg>
  );
}

/** Map an HA entity to the best icon. Domain-first, device_class refines. */
export function iconFor(s: HAStateObject): IconName {
  const domain = entityDomain(s.entity_id);
  const dc = s.attributes.device_class as string | undefined;

  if (domain === 'sensor') return sensorIcon(dc);
  if (domain === 'binary_sensor') return binaryIcon(dc);
  if (domain === 'light') return 'lightbulb';
  if (domain === 'switch') return dc === 'outlet' ? 'plug' : 'power';
  if (domain === 'climate') return 'thermometer';
  if (domain === 'weather') return 'cloud';
  if (domain === 'person') return 'user';
  if (domain === 'media_player') return dc === 'tv' ? 'tv' : 'music';
  if (domain === 'cover') return coverIcon(dc);
  if (domain === 'lock') return s.state === 'unlocked' ? 'unlock' : 'lock';
  if (domain === 'fan') return 'fan';
  if (domain === 'camera') return 'camera';
  if (domain === 'alarm_control_panel') return 'shield';
  if (domain === 'scene') return 'palette';
  if (domain === 'automation' || domain === 'script') return 'robot';
  if (domain === 'input_boolean') return 'power';
  if (domain === 'input_number') return 'gauge';
  return 'help';
}

function sensorIcon(dc?: string): IconName {
  switch (dc) {
    case 'temperature': case 'dew_point': case 'temperature_delta': return 'thermometer';
    case 'humidity': case 'moisture': case 'absolute_humidity': return 'droplet';
    case 'pressure': case 'atmospheric_pressure': return 'gauge';
    case 'illuminance': case 'uv_index': case 'irradiance': return 'sun';
    case 'wind_speed': case 'wind_direction': return 'wind';
    case 'power': case 'energy': case 'voltage': case 'current':
    case 'apparent_power': case 'reactive_power': return 'bolt';
    case 'battery': return 'battery';
    case 'signal_strength': case 'data_rate': return 'signal';
    case 'gas': case 'water': case 'volume': case 'volume_flow_rate': return 'water';
    default: return 'gauge';
  }
}

function binaryIcon(dc?: string): IconName {
  switch (dc) {
    case 'door': case 'garage_door': return dc === 'garage_door' ? 'garage' : 'door';
    case 'window': case 'opening': return 'window';
    case 'motion': case 'moving': case 'vibration': return 'motion';
    case 'occupancy': case 'presence': return 'house';
    case 'smoke': case 'gas': case 'co': return 'smoke';
    case 'moisture': return 'leak';
    case 'battery': return 'battery';
    case 'connectivity': return 'signal';
    case 'lock': return 'lock';
    case 'plug': case 'power': return 'plug';
    case 'light': return 'sun';
    default: return 'help';
  }
}

function coverIcon(dc?: string): IconName {
  switch (dc) {
    case 'garage': return 'garage';
    case 'door': return 'door';
    case 'window': return 'window';
    case 'curtain': return 'curtains';
    case 'blind': case 'shade': case 'shutter': case 'awning': return 'blinds';
    default: return 'blinds';
  }
}
