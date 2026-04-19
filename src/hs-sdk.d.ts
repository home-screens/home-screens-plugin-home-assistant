/**
 * Type declarations for the Home Screens plugin SDK.
 * These globals are provided by the host app at runtime.
 *
 * The host exposes window.__HS_SDK__ with UI components, data hooks,
 * caching, event emission, host settings, and a server-side proxy.
 * Editor-only members (AccordionSection, useModuleConfig) are added
 * in the editor layout and may be undefined on the display page.
 */

import type { FC, ReactNode } from 'react';

// ─── Supporting Types ────────────────────────────────────────────────────────

/** Host settings snapshot — read-only */
interface HostSettings {
  timezone: string;
  units: 'metric' | 'imperial';
  latitude: number | null;
  longitude: number | null;
  displayWidth: number;
  displayHeight: number;
  appVersion: string;
}

/** Plugin events emitted to the host */
type PluginEvent =
  | { type: 'navigate'; direction: 'next' | 'prev' | 'screen'; screenIndex?: number }
  | { type: 'refresh' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Server-side proxy options */
interface PluginFetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  payload?: string;
  secretInjections?: {
    header?: Record<string, string>;
    query?: Record<string, string>;
  };
  cacheTtlMs?: number;
}

// ─── Component Props ─────────────────────────────────────────────────────────

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

interface ColorPickerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

interface SectionHeadingProps {
  children: ReactNode;
}

interface ModuleLoadingStateProps {
  loading?: boolean;
  error?: string;
  children: ReactNode;
}

/** AccordionSection component props (editor-only) */
interface AccordionSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** useModuleConfig return type (editor-only) */
interface ModuleConfigResult<T> {
  config: T;
  set: (updates: Partial<T>) => void;
}

// ─── Global Declarations ─────────────────────────────────────────────────────

declare global {
  interface Window {
    /** Provided by the host — do not bundle React */
    React: typeof import('react');
    /** Provided by the host — do not bundle ReactDOM */
    ReactDOM: typeof import('react-dom');

    /** Shared SDK from the host app */
    __HS_SDK__: {
      // ── CSS Classes ──
      /** Standard input styling for config panels */
      INPUT_CLASS: string;
      /** Nested/secondary input styling for config panels */
      NESTED_INPUT_CLASS: string;

      // ── UI Components ──
      /** Numeric range slider with label */
      Slider: FC<SliderProps>;
      /** Color picker with label */
      ColorPicker: FC<ColorPickerProps>;
      /** Boolean toggle switch with label */
      Toggle: FC<ToggleProps>;
      /** Section heading for grouping config fields */
      SectionHeading: FC<SectionHeadingProps>;
      /** Loading/error state wrapper for plugin content */
      ModuleLoadingState: FC<ModuleLoadingStateProps>;

      // ── Data Fetching ──
      /** React hook: polls a URL at an interval, returns [data | null, error | null] */
      useFetchData: <T>(url: string | null, refreshMs: number) => [T | null, string | null];

      // ── Display Cache ──
      /** In-memory cache for data between renders and screen transitions */
      displayCache: {
        get: (key: string) => unknown;
        set: (key: string, value: unknown) => void;
        prefetch: (keys: string[]) => Promise<void>;
      };

      // ── Host Settings ──
      /** Read-only snapshot of global display settings */
      getHostSettings: () => HostSettings;

      // ── Event Emitter ──
      /** Emit events to the host (navigate, refresh, log) */
      emit: (event: PluginEvent) => void;

      // ── Server-Side Proxy ──
      /** Fetch external APIs through the server-side proxy with optional secret injection */
      pluginFetch: (pluginId: string, options: PluginFetchOptions) => Promise<Response>;

      // ── Editor-Only (may be undefined on display page) ──
      /** Accordion section wrapper for grouping config fields */
      AccordionSection?: FC<AccordionSectionProps>;
      /** Convenience hook for typed config access in custom ConfigSection components */
      useModuleConfig?: <T = Record<string, unknown>>(
        moduleId: string,
        screenId: string,
      ) => ModuleConfigResult<T>;
    };

    /** Plugin export target — set by the IIFE wrapper, read by the host loader */
    __HS_PLUGIN__: Record<string, unknown>;
  }
}

export {};
