import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HAPluginConfig, HAStateObject } from './types';
import { EntityCardView, StatusBoardView } from './views';
import { DashboardView } from './DashboardView';

const door: HAStateObject = {
  entity_id: 'binary_sensor.kitchen_door',
  state: 'on',
  attributes: { friendly_name: 'Kitchen Door', device_class: 'door' },
  last_changed: '2026-09-23T08:00:00Z',
  last_updated: '2026-09-23T08:00:00Z',
};

const windowSensor: HAStateObject = {
  ...door,
  entity_id: 'binary_sensor.kitchen_window',
  state: 'off',
  attributes: { friendly_name: 'Kitchen Window', device_class: 'window' },
};

function renderBoard(
  showHeader: boolean,
  hideContent = false,
  overrides: Partial<HAPluginConfig> = {},
): string {
  return renderToStaticMarkup(
    <StatusBoardView
      states={[door, windowSensor]}
      config={{ showHeader, ...overrides } as HAPluginConfig}
      lookFor={hideContent ? () => ({ icon: null, label: '' }) : undefined}
    />,
  );
}

const light: HAStateObject = {
  entity_id: 'light.porch', state: 'off',
  attributes: { friendly_name: 'Porch Light' },
  last_changed: '2026-09-23T08:00:00Z', last_updated: '2026-09-23T08:00:00Z',
};

const DIVIDER = /border-top:1px solid/g;

describe('StatusBoardView', () => {
  it('uses Show header for its domain heading', () => {
    expect(renderBoard(true)).toContain('Binary Sensors');
    expect(renderBoard(false)).not.toContain('Binary Sensors');
    expect(renderBoard(false)).toContain('Kitchen Door');
  });

  it('shows headings when the setting was never saved, as the display does', () => {
    // The editor preview renders raw module config, where the key can be
    // missing; the display normalizes a missing key to "on".
    const html = renderToStaticMarkup(
      <StatusBoardView states={[door, windowSensor]} config={{} as HAPluginConfig} />,
    );
    expect(html).toContain('Binary Sensors');
  });

  it('draws a divider above every row but the first when headings are hidden', () => {
    const states = [door, windowSensor, light, { ...light, entity_id: 'light.hall' }];
    const hidden = renderToStaticMarkup(
      <StatusBoardView states={states} config={{ showHeader: false } as HAPluginConfig} />,
    );
    expect(hidden.match(DIVIDER)).toHaveLength(3);
    // With headings, each group starts fresh under its own heading.
    const shown = renderToStaticMarkup(
      <StatusBoardView states={states} config={{ showHeader: true } as HAPluginConfig} />,
    );
    expect(shown.match(DIVIDER)).toHaveLength(2);
  });

  it('draws a Home Assistant icon from the path saved on the rule', () => {
    const html = renderToStaticMarkup(
      <StatusBoardView states={[door]} config={{ showHeader: false } as HAPluginConfig}
        lookFor={() => ({ icon: { ref: 'mdi:door-open', path: 'M4 4h16v16H4z' } })} />,
    );
    expect(html).toContain('<path d="M4 4h16v16H4z"');
    expect(html).toContain('fill="currentColor"');
  });

  it('honors explicit no-icon and no-label appearance overrides', () => {
    const html = renderBoard(false, true);
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('Open');
    expect(html).toContain('Kitchen Door');
  });

  it('can hide row dividers independently', () => {
    expect(renderBoard(false)).toContain('border-top:1px solid');
    expect(renderBoard(false, false, { showRowDividers: false }))
      .not.toContain('border-top:1px solid');
    expect(renderBoard(false, false, { showRowDividers: false }))
      .toContain('data-status-dot="true"');
  });

  it('can hide status dots independently', () => {
    expect(renderBoard(false)).toContain('data-status-dot="true"');
    const html = renderBoard(false, false, { showStatusDots: false });
    expect(html).not.toContain('data-status-dot="true"');
    expect(html).toContain('border-top:1px solid');
  });
});

describe('EntityCardView', () => {
  it('honors "show no icon"', () => {
    const plain = renderToStaticMarkup(
      <EntityCardView states={[door]} config={{} as HAPluginConfig} />,
    );
    expect(plain).toContain('<svg');
    const html = renderToStaticMarkup(
      <EntityCardView states={[door]} config={{} as HAPluginConfig}
        lookFor={() => ({ icon: null })} />,
    );
    expect(html).not.toContain('<svg');
    expect(html).toContain('Kitchen Door');
  });
});

describe('DashboardView scene buttons', () => {
  const scene: HAStateObject = {
    entity_id: 'scene.movie_night', state: '2026-09-20T19:02:11+00:00',
    attributes: { friendly_name: 'Movie Night' },
    last_changed: '2026-09-20T19:02:11Z', last_updated: '2026-09-20T19:02:11Z',
  };

  // The dashboard's clock strip asks the host SDK for the home's time zone.
  beforeEach(() => { vi.stubGlobal('window', { __HS_SDK__: {} }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps the scene name when a rule turns value text off', () => {
    const html = renderToStaticMarkup(
      <DashboardView states={[scene, light]}
        config={{ heroColumn: true, columns: 2 } as HAPluginConfig}
        lookFor={(s) => (s.entity_id === scene.entity_id ? { icon: null, label: '' } : undefined)} />,
    );
    expect(html).toContain('Movie Night');
  });
});
