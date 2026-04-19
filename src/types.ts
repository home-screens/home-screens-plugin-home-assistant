// Home Assistant REST API types + plugin config type.

export interface HAStateObject {
  entity_id: string;
  state: string;
  attributes: HAAttributes;
  last_changed: string;
  last_updated: string;
  context?: { id: string; parent_id: string | null; user_id: string | null };
}

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
  | 'cameras';

export interface HAPluginConfig {
  view: HAView;
  haUrl: string;
  entities: string[];
  area?: string | null;
  refreshInterval: number;
  showHeader: boolean;
  columns: number;
  showControls: boolean;
  compactMode: boolean;
}

export function entityDomain(entityId: string): string {
  const dot = entityId.indexOf('.');
  return dot > 0 ? entityId.slice(0, dot) : '';
}
