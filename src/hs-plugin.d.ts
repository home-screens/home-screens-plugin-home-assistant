/**
 * Type declarations for Home Screens plugin component props.
 * These are the props injected by the host into your display component.
 */

/** Style properties applied to every module — matches the host's ModuleStyle */
export interface ModuleStyle {
  fontSize: number;
  fontFamily: string;
  textColor: string;
  backgroundColor: string;
  borderRadius: number;
  padding: number;
  opacity: number;
  backdropBlur: number;
}

/** Base props every plugin display component receives */
export interface PluginComponentProps {
  config: Record<string, unknown>;
  style: ModuleStyle;
  timezone?: string;
  // Injected if dataRequirements includes "location":
  latitude?: number;
  longitude?: number;
  // Injected if dataRequirements includes "weather":
  hourly?: unknown[];
  forecast?: unknown[];
  minutely?: unknown;
  alerts?: unknown;
  units?: string;
  locationMissing?: boolean;
  // Injected if dataRequirements includes "calendar":
  events?: unknown[];
}

/** Props for custom config section components (optional named export) */
export interface PluginConfigSectionProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  moduleId: string;
  screenId: string;
}

/** Declared plugin capabilities — transparency for users, not runtime-enforced */
export type PluginPermission = 'network' | 'secrets' | 'events' | 'storage';
