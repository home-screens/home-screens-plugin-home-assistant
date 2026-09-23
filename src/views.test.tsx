import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HAPluginConfig, HAStateObject } from './types';
import { StatusBoardView } from './views';

const door: HAStateObject = {
  entity_id: 'binary_sensor.kitchen_door',
  state: 'on',
  attributes: { friendly_name: 'Kitchen Door', device_class: 'door' },
  last_changed: '2026-09-23T08:00:00Z',
  last_updated: '2026-09-23T08:00:00Z',
};

function renderBoard(showHeader: boolean, hideContent = false): string {
  return renderToStaticMarkup(
    <StatusBoardView
      states={[door]}
      config={{ showHeader } as HAPluginConfig}
      lookFor={hideContent ? () => ({ icon: null, label: '' }) : undefined}
    />,
  );
}

describe('StatusBoardView', () => {
  it('uses Show header for its domain heading', () => {
    expect(renderBoard(true)).toContain('Binary Sensors');
    expect(renderBoard(false)).not.toContain('Binary Sensors');
    expect(renderBoard(false)).toContain('Kitchen Door');
  });

  it('honors explicit no-icon and no-label appearance overrides', () => {
    const html = renderBoard(false, true);
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('Open');
    expect(html).toContain('Kitchen Door');
  });
});