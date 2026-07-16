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

/** Props the host passes to the `stateProvider` export (manifest
 *  `exports.stateProvider`). Keys arrive UNPREFIXED — the part after
 *  `plugin:<id>:` — matching what the plugin passes to publishState. */
export interface StateProviderProps {
  /** Deduped, sorted, referentially stable across renders when unchanged. */
  demandedKeys: string[];
  /** Plugin-level settings (manifest `settingsSchema` values). */
  settings: Record<string, unknown>;
}

/** One selectable raw value for an enum-like state key ("Alert (on)"). */
export interface StateKeyValueOption {
  value: string;
  label?: string;
}

/** Signature of the `searchStateKeys` conventional export (editor-only).
 *  The host MUST pass the plugin-level settings: the search reads its
 *  connection from `settings.haUrl` and silently returns [] without it.
 *  Passing a full prefixed bus key as the query resolves a committed
 *  condition's descriptor. */
export type SearchStateKeysFn = (
  query: string,
  opts?: { limit?: number; settings?: Record<string, unknown> },
) => Promise<StateKeyDescriptor[]>;

/** A state key described by the `searchStateKeys` export (editor-only):
 *  friendly label, grouping, and the raw value vocabulary the host's
 *  condition builder offers for selection instead of transcription. */
export interface StateKeyDescriptor {
  /** FULL bus key, prefixed (`plugin:home-assistant:<entity_id>`). */
  key: string;
  label: string;
  group?: string;
  valueType: 'enum' | 'numeric' | 'string';
  valueOptions?: StateKeyValueOption[];
  unit?: string;
  currentValue?: string;
}

/** Props for custom config section components (optional named export) */
export interface PluginConfigSectionProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  moduleId: string;
  screenId: string;
}

/** Declared plugin capabilities — transparency for users, not runtime-enforced */
export type PluginPermission =
  | 'network'
  | 'localNetwork'
  | 'secrets'
  | 'events'
  | 'storage';
