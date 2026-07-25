// Home Assistant REST API types + plugin config type.

export interface HAStateObject {
  entity_id: string;
  state: string;
  attributes: HAAttributes;
  last_changed: string;
  last_updated: string;
  context?: { id: string; parent_id: string | null; user_id: string | null };
}

/** Service-call dispatcher the module passes down to views, cards, and the
 *  detail sheet. Lives here (not in cards.tsx) so low-level modules like
 *  controls.tsx never import upward from the card layer. */
export type CardCommand = (
  state: HAStateObject, service: string, data?: Record<string, unknown>,
) => void;

export interface HAAttributes {
  friendly_name?: string;
  device_class?: string;
  unit_of_measurement?: string;
  icon?: string;
  entity_picture?: string;
  supported_features?: number;
  assumed_state?: boolean;
  // Sensor
  state_class?: string;
  // Light
  brightness?: number;
  color_mode?: string;
  color_temp_kelvin?: number;
  hs_color?: [number, number];
  rgb_color?: [number, number, number];
  min_color_temp_kelvin?: number;
  max_color_temp_kelvin?: number;
  supported_color_modes?: string[];
  // Climate
  current_temperature?: number;
  temperature?: number;
  target_temp_high?: number;
  target_temp_low?: number;
  current_humidity?: number;
  target_humidity?: number;
  hvac_modes?: string[];
  hvac_action?: string;
  fan_modes?: string[];
  preset_mode?: string;
  preset_modes?: string[];
  min_temp?: number;
  max_temp?: number;
  /** HA's serialized name for the setpoint step (the Python property is
   *  target_temperature_step, but that name never reaches state attributes). */
  target_temp_step?: number;
  target_temperature_step?: number;
  // Media player
  volume_level?: number;
  is_volume_muted?: boolean;
  media_title?: string;
  media_artist?: string;
  media_album_name?: string;
  media_content_type?: string;
  media_duration?: number;
  media_position?: number;
  media_position_updated_at?: string;
  source?: string;
  source_list?: string[];
  // Cover
  current_position?: number;
  current_tilt_position?: number;
  // Lock
  code_format?: string;
  // Weather
  forecast?: unknown[];
  humidity?: number;
  pressure?: number;
  wind_speed?: number;
  wind_bearing?: number;
  // Fan
  percentage?: number;
  oscillating?: boolean;
  current_direction?: string;
  // anything else
  [k: string]: unknown;
}

export interface HAConfig {
  version: string;
  location_name?: string;
  latitude?: number;
  longitude?: number;
  unit_system?: {
    temperature?: string;
    length?: string;
    mass?: string;
    volume?: string;
    pressure?: string;
    wind_speed?: string;
  };
  time_zone?: string;
  components?: string[];
}

export interface HAArea {
  area_id: string;
  name: string;
  entities: string[];
}

export type HAView =
  | 'entity-card'
  | 'entity-row'
  | 'card-grid'
  | 'status-board'
  | 'room'
  | 'climate'
  | 'media'
  | 'cameras'
  | 'buttons'
  | 'alerts'
  | 'batteries'
  | 'power';

export type HAButtonTone = 'default' | 'amber' | 'blue' | 'green' | 'purple' | 'red';

/** One configured button in the `buttons` view. Buttons render config rows,
 *  not entities — each tap calls `domain.service`, optionally targeted at
 *  `entityId`, with `serviceData` merged into the payload. */
export interface HAButtonRow {
  /** Stable identity for React keys and reordering, minted by the editor. */
  id: string;
  label: string;
  /** IconName from icons.tsx; unknown values fall back at render time. */
  icon: string;
  tone: HAButtonTone;
  domain: string;
  service: string;
  entityId?: string;
  serviceData?: Record<string, unknown>;
  /** Require a 1s press before firing — locks, garage doors, anything that
   *  shouldn't trigger on an accidental bump. */
  holdToRun?: boolean;
}

/** Comparison vocabulary shared by alert rules and look rules — the host's
 *  state/numeric condition operators, one level simpler (no and/or trees;
 *  users add a second rule instead). */
export type HARuleOperator = 'is' | 'is_not' | 'above' | 'below';

/** One rule in the `alerts` view. When the entity matches (and nobody has
 *  tapped the tile away), a banner shows over the screen. */
export interface HAAlertRule {
  /** Stable identity for React keys, reordering, and the acknowledge store. */
  id: string;
  entityId: string;
  operator: HARuleOperator;
  value: string;
  /** What the tile says, e.g. "The garage door is open". */
  title: string;
  /** IconName from icons.tsx; unknown values fall back at render time. */
  icon: string;
  tone: HAButtonTone;
}

/** One appearance override, honored by every entity-rendering view. Rules
 *  are checked top to bottom per entity; the first match wins. */
export interface HALookRule {
  id: string;
  entityId: string;
  operator: HARuleOperator;
  value: string;
  /** Card tint / status dot color. Absent = keep the normal tone (the rule
   *  then only swaps icon/label); the editor's 'default' swatch and
   *  normalization both store "keep" as absent, never as 'default'. */
  tone?: Exclude<HAButtonTone, 'default'>;
  /** Icon override; absent = keep the entity's normal icon. */
  icon?: string;
  /** Replacement for the value text ("Open" → "Close me!"). */
  label?: string;
}

export interface HAPluginConfig {
  view: HAView;
  /** Resolved connection URL, injected by normalizeConfig from the
   *  plugin-level settings — never stored in module config. The connection
   *  is configured once at plugin scope (see settings.ts). */
  haUrl: string;
  entities: string[];
  area?: string | null;
  refreshInterval: number;
  showHeader: boolean;
  columns: number;
  showControls: boolean;
  compactMode: boolean;
  /** Shared 2s state-only poll on top of the full refresh cycle, so state
   *  changes (and visibility conditions gated on them) apply near-instantly. */
  fastUpdates: boolean;
  /** Inline 24h sparklines on measurement-sensor cards. Off by default —
   *  it costs one extra (batched, cached) history call per window. */
  showHistory: boolean;
  /** Rows for the `buttons` view. Ignored by every other view. */
  buttons: HAButtonRow[];
  /** Rules for the `alerts` view. Ignored by every other view. */
  alerts: HAAlertRule[];
  /** Per-entity appearance rules, applied by entity-rendering views. */
  lookRules: HALookRule[];
  /** Color entities by what their state means (heating amber, unlocked red,
   *  somebody home green) without configuring a rule for each one. On by
   *  default; look rules always win over it. */
  autoTones: boolean;
}

export function entityDomain(entityId: string): string {
  const dot = entityId.indexOf('.');
  return dot > 0 ? entityId.slice(0, dot) : '';
}
