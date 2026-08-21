import { describe, expect, it } from 'vitest';
import { ALL_VIEWS, entityDomain } from './types';
import { isPowerSensor } from './power';
import type { HAStateObject, HAView } from './types';
import {
  VIEW_ENTITIES, acceptsAnything, entitiesForView, unusedEntityIds,
} from './view-entities';
import { pickPowerEntity } from './power';
import { collectBatteries } from './batteries';

function state(entity_id: string, attributes: Record<string, unknown> = {}): HAStateObject {
  return {
    entity_id, state: '1', attributes,
    last_changed: '2026-01-01T00:00:00Z', last_updated: '2026-01-01T00:00:00Z',
  };
}

/**
 * What each view accepts and how many it draws, as one table.
 *
 * Same contract as view-capabilities.test.ts: adding a view fails this file
 * until somebody has said what it can render. Answer from the view's own code
 * — the entity it looks up in views.tsx — not from a neighbouring row.
 */
const MATRIX: Record<HAView, { accepts: string; max: 1 | 'many' }> = {
  //                accepts           max
  'entity-card':  { accepts: 'any', max: 1 },
  'entity-row':   { accepts: 'any', max: 1 },
  'card-grid':    { accepts: 'any', max: 'many' },
  'status-board': { accepts: 'any', max: 'many' },
  room:           { accepts: 'any', max: 'many' },
  dashboard:      { accepts: 'any', max: 'many' },
  climate:        { accepts: 'climate', max: 1 },
  media:          { accepts: 'media_player', max: 1 },
  cameras:        { accepts: 'camera', max: 'many' },
  buttons:        { accepts: 'any', max: 'many' },
  alerts:         { accepts: 'any', max: 'many' },
  batteries:      { accepts: 'battery', max: 'many' },
  power:          { accepts: 'sensor', max: 1 },
  'energy-flow':  { accepts: 'power', max: 'many' },
  timeline:       { accepts: 'changes', max: 'many' },
};

const SAMPLE = [
  state('light.kitchen'),
  state('climate.hallway'),
  state('media_player.tv'),
  state('camera.porch'),
  state('sensor.humidity', { device_class: 'humidity' }),
  state('sensor.house_power', { device_class: 'power' }),
  state('sensor.phone_battery', { device_class: 'battery' }),
  state('lock.front_door'),
];

describe('view entities', () => {
  it('covers every view', () => {
    expect(Object.keys(VIEW_ENTITIES).sort()).toEqual([...ALL_VIEWS].sort());
    expect(Object.keys(MATRIX).sort()).toEqual([...ALL_VIEWS].sort());
  });

  it.each(ALL_VIEWS)('%s accepts what it can draw', (view) => {
    const want = MATRIX[view];
    const spec = VIEW_ENTITIES[view];
    expect(spec.max).toBe(want.max);
    expect(acceptsAnything(view)).toBe(want.accepts === 'any');
    for (const s of SAMPLE) {
      const ok = want.accepts === 'any'
        ? true
        : want.accepts === 'battery'
          ? s.attributes.device_class === 'battery'
          : want.accepts === 'power'
            ? isPowerSensor(s) || s.attributes.device_class === 'battery'
            : want.accepts === 'changes'
              ? !['sensor', 'weather', 'camera'].includes(entityDomain(s.entity_id))
              : entityDomain(s.entity_id) === want.accepts;
      expect([s.entity_id, spec.accepts(s)]).toEqual([s.entity_id, ok]);
    }
  });

  // A restricted view has to name its set, or the browser's tab has nothing
  // to call it and the escape hatch has nothing to escape from.
  it.each(ALL_VIEWS)('%s labels its set when it restricts one', (view) => {
    expect(Boolean(VIEW_ENTITIES[view].label)).toBe(!acceptsAnything(view));
  });
});

/**
 * The half that can silently drift: the editor's idea of which entity a view
 * lands on has to be the view's own. Each case here mirrors the lookup in the
 * view (or in the module the view delegates to).
 */
describe('entitiesForView agrees with the views', () => {
  it('power picks what pickPowerEntity picks', () => {
    // Both orders: a plain sensor first is the case where "first accepted"
    // and "first preferred" disagree, which is the whole point of `prefers`.
    for (const picked of [SAMPLE, [...SAMPLE].reverse()]) {
      expect(entitiesForView('power', picked)[0])
        .toBe(pickPowerEntity(picked));
    }
  });

  it('power falls back to any sensor, like the view does', () => {
    const noPower = [state('light.kitchen'), state('sensor.water', { device_class: 'water' })];
    expect(entitiesForView('power', noPower).map((s) => s.entity_id))
      .toEqual(['sensor.water']);
    expect(entitiesForView('power', noPower)[0]).toBe(pickPowerEntity(noPower));
  });

  it('climate and media pick the first of their domain', () => {
    // views.tsx: states.find(entityDomain === 'climate' | 'media_player').
    expect(entitiesForView('climate', SAMPLE).map((s) => s.entity_id))
      .toEqual([SAMPLE.find((s) => entityDomain(s.entity_id) === 'climate')!.entity_id]);
    expect(entitiesForView('media', SAMPLE).map((s) => s.entity_id))
      .toEqual([SAMPLE.find((s) => entityDomain(s.entity_id) === 'media_player')!.entity_id]);
  });

  it('cameras keeps every camera, like CameraView filters', () => {
    const withTwo = [...SAMPLE, state('camera.drive')];
    expect(entitiesForView('cameras', withTwo).map((s) => s.entity_id))
      .toEqual(withTwo.filter((s) => entityDomain(s.entity_id) === 'camera')
        .map((s) => s.entity_id));
  });

  it('the hero views take states[0], whatever it is', () => {
    for (const view of ['entity-card', 'entity-row'] as const) {
      expect(entitiesForView(view, SAMPLE)).toEqual([SAMPLE[0]]);
    }
  });

  it('batteries accepts exactly what collectBatteries collects', () => {
    const accepted = SAMPLE.filter(VIEW_ENTITIES.batteries.accepts).map((s) => s.entity_id);
    expect(accepted).toEqual(collectBatteries(SAMPLE).map((e) => e.state.entity_id));
  });

  it('the grid views take everything, in the order given', () => {
    for (const view of ['card-grid', 'status-board', 'room'] as const) {
      expect(entitiesForView(view, SAMPLE)).toEqual(SAMPLE);
    }
  });

  it('has nothing to draw when nothing qualifies', () => {
    expect(entitiesForView('climate', [state('light.kitchen')])).toEqual([]);
    expect(entitiesForView('cameras', [])).toEqual([]);
  });
});

describe('unusedEntityIds', () => {
  const ids = SAMPLE.map((s) => s.entity_id);

  it('counts everything past the one a single view draws', () => {
    expect(unusedEntityIds('media', ids, SAMPLE)).toEqual(
      ids.filter((id) => id !== 'media_player.tv'));
    expect(unusedEntityIds('entity-card', ids, SAMPLE)).toEqual(ids.slice(1));
  });

  it('is empty when the view draws them all', () => {
    expect(unusedEntityIds('card-grid', ids, SAMPLE)).toEqual([]);
  });

  // Ids Home Assistant no longer reports draw nothing either, so they belong
  // in the count — the Selected tab flags them separately as missing.
  it('counts picks Home Assistant no longer reports', () => {
    expect(unusedEntityIds('card-grid', ['light.gone'], SAMPLE)).toEqual(['light.gone']);
  });

  it('leaves the preferred entity alone on the power view', () => {
    expect(unusedEntityIds('power', ids, SAMPLE))
      .toEqual(ids.filter((id) => id !== 'sensor.house_power'));
  });
});
