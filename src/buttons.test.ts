import { describe, expect, it } from 'vitest';
import {
  normalizeButtons, defaultIconForDomain, holdSweepColor, BUTTON_TONES,
  parseServicesResponse, groupServicesForPicker, findServiceDef,
  serviceGroupLabel, buttonSubtitle, parseServiceDataJson, buildServicePayload,
  SERVICE_PICKER_CAP,
  type HAServiceDef,
} from './buttons';
import type { HAButtonRow } from './types';

function row(overrides: Partial<HAButtonRow> = {}): HAButtonRow {
  return {
    id: 'b1', label: 'Lock the House', icon: 'lock', tone: 'red',
    domain: 'lock', service: 'lock', entityId: 'lock.front_door',
    ...overrides,
  };
}

describe('normalizeButtons', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeButtons(undefined)).toEqual([]);
    expect(normalizeButtons(null)).toEqual([]);
    expect(normalizeButtons('nope')).toEqual([]);
    expect(normalizeButtons({})).toEqual([]);
  });

  it('drops rows without a domain + service', () => {
    expect(normalizeButtons([
      { id: 'a', label: 'Incomplete', domain: '', service: '' },
      { id: 'b', domain: 'script', service: '' },
      null, 42, 'x',
    ])).toEqual([]);
  });

  it('keeps complete rows and applies defaults', () => {
    const [r] = normalizeButtons([{ domain: 'script', service: 'good_night' }]);
    expect(r).toEqual({
      id: 'button-0',
      label: 'script.good_night',
      icon: 'robot',
      tone: 'default',
      domain: 'script',
      service: 'good_night',
      entityId: undefined,
      serviceData: undefined,
      holdToRun: false,
    });
  });

  it('preserves explicit fields and trims strings', () => {
    const [r] = normalizeButtons([{
      id: 'x', label: '  Good Night  ', icon: 'moon', tone: 'purple',
      domain: ' script ', service: ' good_night ',
      entityId: ' lock.front_door ', serviceData: { code: '1234' }, holdToRun: true,
    }]);
    expect(r.label).toBe('Good Night');
    expect(r.icon).toBe('moon');
    expect(r.tone).toBe('purple');
    expect(r.domain).toBe('script');
    expect(r.service).toBe('good_night');
    expect(r.entityId).toBe('lock.front_door');
    expect(r.serviceData).toEqual({ code: '1234' });
    expect(r.holdToRun).toBe(true);
  });

  it('falls back on unknown icons and tones', () => {
    const [r] = normalizeButtons([{
      domain: 'light', service: 'turn_off', icon: 'not-a-glyph', tone: 'chartreuse',
    }]);
    expect(r.icon).toBe('lightbulb');
    expect(r.tone).toBe('default');
  });

  it('rejects array serviceData', () => {
    const [r] = normalizeButtons([{ domain: 'a', service: 'b', serviceData: [1] }]);
    expect(r.serviceData).toBeUndefined();
  });
});

describe('defaultIconForDomain', () => {
  it('maps known domains and falls back to bolt', () => {
    expect(defaultIconForDomain('lock')).toBe('lock');
    expect(defaultIconForDomain('scene')).toBe('palette');
    expect(defaultIconForDomain('notify')).toBe('megaphone');
    expect(defaultIconForDomain('some_integration')).toBe('bolt');
  });
});

describe('holdSweepColor', () => {
  it('uses the tone accent, with amber standing in for default', () => {
    expect(holdSweepColor('red')).toBe(BUTTON_TONES.red.accent);
    expect(holdSweepColor('default')).toBe(BUTTON_TONES.amber.accent);
  });
});

describe('parseServicesResponse', () => {
  const payload = [
    {
      domain: 'lock',
      services: {
        lock: { name: 'Lock', description: 'Locks a lock.', target: { entity: {} } },
        unlock: { name: 'Unlock', description: 'Unlocks a lock.', target: { entity: {} } },
      },
    },
    {
      domain: 'script',
      // Older HA payloads: bare objects, no name/target.
      services: { good_night: {} },
    },
  ];

  it('flattens domains and reads names, descriptions, and targets', () => {
    const parsed = parseServicesResponse(payload);
    expect(parsed).toHaveLength(3);
    const lock = findServiceDef(parsed, 'lock', 'lock')!;
    expect(lock.name).toBe('Lock');
    expect(lock.needsEntity).toBe(true);
    const script = findServiceDef(parsed, 'script', 'good_night')!;
    expect(script.name).toBe('good night');
    expect(script.needsEntity).toBe(false);
  });

  it('tolerates garbage', () => {
    expect(parseServicesResponse(null)).toEqual([]);
    expect(parseServicesResponse([{ domain: 42 }, 'x', { domain: 'a', services: null }])).toEqual([]);
  });
});

describe('groupServicesForPicker', () => {
  function svc(domain: string, service: string, name = service): HAServiceDef {
    return { domain, service, name, description: '', needsEntity: false };
  }
  const catalog = [
    svc('zwave_js', 'set_config_parameter'),
    svc('scene', 'turn_on', 'Activate'),
    svc('script', 'good_night', 'Good Night'),
    svc('lock', 'lock', 'Lock'),
  ];

  it('ranks family domains before alphabetical strays', () => {
    const { groups } = groupServicesForPicker(catalog, '');
    expect(groups.map((g) => g.domain)).toEqual(['script', 'scene', 'lock', 'zwave_js']);
    expect(groups[0].label).toBe('Scripts');
  });

  it('matches query against id, name, and group label', () => {
    expect(groupServicesForPicker(catalog, 'good').groups[0].services[0].service)
      .toBe('good_night');
    // "Locks" is the friendly group label for domain `lock`.
    expect(groupServicesForPicker(catalog, 'locks').groups[0].domain).toBe('lock');
    expect(groupServicesForPicker(catalog, 'zzz').groups).toEqual([]);
  });

  it('caps the result list and reports truncation', () => {
    const big = Array.from({ length: SERVICE_PICKER_CAP + 10 },
      (_, i) => svc('light', `svc_${i}`));
    const { groups, truncated } = groupServicesForPicker(big, '');
    expect(truncated).toBe(true);
    expect(groups[0].services).toHaveLength(SERVICE_PICKER_CAP);
  });
});

describe('serviceGroupLabel', () => {
  it('falls back to a capitalized domain', () => {
    expect(serviceGroupLabel('media_player')).toBe('Speakers & TVs');
    expect(serviceGroupLabel('zwave_js')).toBe('Zwave Js');
  });
});

describe('buttonSubtitle', () => {
  it('prefers kid-readable domain phrasing', () => {
    expect(buttonSubtitle(row({ domain: 'script', service: 'good_night' })))
      .toBe('Runs a script');
    expect(buttonSubtitle(row({ domain: 'scene', service: 'turn_on' })))
      .toBe('Sets a scene');
  });

  it('falls back to the catalog name, then domain.service', () => {
    const catalog: HAServiceDef[] = [
      { domain: 'lock', service: 'lock', name: 'lock a lock', description: '', needsEntity: true },
    ];
    expect(buttonSubtitle(row(), catalog)).toBe('Lock a lock');
    expect(buttonSubtitle(row({ domain: 'cover', service: 'toggle' }))).toBe('cover.toggle');
  });
});

describe('parseServiceDataJson', () => {
  it('treats empty text as "no extra settings"', () => {
    expect(parseServiceDataJson('')).toEqual({ ok: true, value: undefined });
    expect(parseServiceDataJson('   ')).toEqual({ ok: true, value: undefined });
  });

  it('accepts plain objects only', () => {
    expect(parseServiceDataJson('{ "code": "1234" }'))
      .toEqual({ ok: true, value: { code: '1234' } });
    expect(parseServiceDataJson('[1, 2]').ok).toBe(false);
    expect(parseServiceDataJson('"str"').ok).toBe(false);
    expect(parseServiceDataJson('null').ok).toBe(false);
    expect(parseServiceDataJson('{nope').ok).toBe(false);
  });
});

describe('buildServicePayload', () => {
  it('merges service data under the configured entity target', () => {
    expect(buildServicePayload(row({ serviceData: { code: '1' } })))
      .toEqual({ code: '1', entity_id: 'lock.front_door' });
  });

  it('omits entity_id when no device is configured', () => {
    expect(buildServicePayload(row({ entityId: undefined }))).toEqual({});
  });

  it('lets the configured device win over a stray entity_id in the JSON', () => {
    expect(buildServicePayload(row({ serviceData: { entity_id: 'lock.back_door' } })))
      .toEqual({ entity_id: 'lock.front_door' });
  });
});
