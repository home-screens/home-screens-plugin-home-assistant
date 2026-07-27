// Canned Home Assistant responses for the Playwright harness. Loaded as a
// plain script (no bundling) so the fixtures stay readable and editable.
(function () {
  const now = new Date('2026-07-26T10:00:00Z').toISOString();
  const ago = (min) => new Date(Date.parse(now) - min * 60_000).toISOString();

  const state = (entity_id, s, attributes = {}, changed = ago(12)) => ({
    entity_id,
    state: s,
    attributes: { friendly_name: undefined, ...attributes },
    last_changed: changed,
    last_updated: changed,
    context: { id: 'x', parent_id: null, user_id: null },
  });

  const STATES = [
    state('light.living_room', 'on', { friendly_name: 'Living Room', brightness: 204, color_temp_kelvin: 2700, supported_color_modes: ['color_temp'] }),
    state('light.kitchen', 'off', { friendly_name: 'Kitchen Lights', supported_color_modes: ['brightness'] }),
    // state_class 'measurement' is what isHistoryEligible looks for; without
    // it the sparkline path is unreachable no matter what /api/history says.
    state('sensor.outdoor_temp', '78.4', { friendly_name: 'Outdoor Temperature', unit_of_measurement: '°F', device_class: 'temperature', state_class: 'measurement' }),
    state('sensor.humidity', '46', { friendly_name: 'Hallway Humidity', unit_of_measurement: '%', device_class: 'humidity', state_class: 'measurement' }),
    state('binary_sensor.front_door', 'on', { friendly_name: 'Front Door', device_class: 'door' }),
    state('climate.hallway', 'heat', { friendly_name: 'Hallway Thermostat', current_temperature: 71, temperature: 70, hvac_action: 'idle', hvac_modes: ['off', 'heat', 'cool'], min_temp: 50, max_temp: 90 }),
    state('lock.front_door', 'locked', { friendly_name: 'Front Door Lock' }),
    state('cover.garage', 'closed', { friendly_name: 'Garage Door', current_position: 0, device_class: 'garage' }),
    state('fan.office', 'on', { friendly_name: 'Office Fan', percentage: 66, supported_features: 1 }),
    // supported_features is play|pause|volume_set|previous|next — without the
    // bits the transport row never renders, so the harness can't see its
    // buttons at all (they carry their labels in aria-label, which is also
    // why --pseudo can't check them).
    state('media_player.den', 'playing', { friendly_name: 'Den Speaker', media_title: 'Harvest Moon', media_artist: 'Neil Young', supported_features: 16384 | 1 | 4 | 16 | 32, volume_level: 0.4 }),
    state('person.jamie', 'home', { friendly_name: 'Jamie' }),
    state('switch.porch', 'off', { friendly_name: 'Porch Switch' }),
    state('sensor.phone_battery', '18', { friendly_name: 'Phone Battery', unit_of_measurement: '%', device_class: 'battery' }),
    state('sensor.remote_battery', '64', { friendly_name: 'Remote Battery', unit_of_measurement: '%', device_class: 'battery' }),
    state('sensor.door_sensor_battery', '92', { friendly_name: 'Door Sensor Battery', unit_of_measurement: '%', device_class: 'battery' }),
    state('sensor.house_power', '1840', { friendly_name: 'House Power', unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement' }),
    // Older than a week, so relativeTime falls out of "{n}d ago" and onto an
    // absolute calendar date — the one place the host timezone matters.
    state('sensor.attic_probe', '61', { friendly_name: 'Attic Probe', unit_of_measurement: '°F', device_class: 'temperature', state_class: 'measurement' },
      new Date(Date.parse(now) - 40 * 24 * 60 * 60_000).toISOString()),
  ];

  // A canned 24-hour series per sensor. Returning [] here used to make every
  // history-backed piece of markup unreachable from the harness — the power
  // view's Low/Avg/High row, the card sparklines, and the hero chart with the
  // theme's shade() scrim over it — so --light was silently not checking the
  // one part of the module that draws its own colors. The power view's white
  // stat values survived that gap.
  //
  // Deterministic by construction: no RNG, and the runner freezes the clock,
  // so the same curve comes out on every run and screenshots stay diffable.
  const SHAPES = {
    'sensor.house_power': { base: 1200, swing: 900 },
    'sensor.outdoor_temp': { base: 72, swing: 11 },
    'sensor.humidity': { base: 45, swing: 9 },
    'sensor.attic_probe': { base: 61, swing: 6 },
  };

  function history(entityId, samples = 96) {
    const shape = SHAPES[entityId];
    if (!shape) return [];
    const end = Date.now();
    const start = end - 24 * 60 * 60 * 1000;
    const out = [];
    for (let i = 0; i < samples; i++) {
      const f = i / (samples - 1);
      // A slow swing plus a faster harmonic, so the curve has a clear low and
      // high for the extreme labels to name rather than a flat line.
      const v = shape.base
        + shape.swing * (Math.sin(f * Math.PI * 2) * 0.6 + Math.sin(f * Math.PI * 6) * 0.4);
      const entry = {
        state: v.toFixed(1),
        last_changed: new Date(start + f * (end - start)).toISOString(),
      };
      // minimal_response puts entity_id on the first entry only, which is
      // what parseHistoryResponse keys the series by.
      if (i === 0) entry.entity_id = entityId;
      out.push(entry);
    }
    return out;
  }

  const CONFIG = {
    version: '2026.7.1',
    location_name: 'Test Home',
    unit_system: { temperature: '°F', length: 'mi' },
    time_zone: 'America/Chicago',
  };

  window.__MOCK__ = {
    states: STATES,
    route(path) {
      if (path.startsWith('/api/states')) return STATES;
      if (path.startsWith('/api/config')) return CONFIG;
      if (path.startsWith('/api/services')) return [];
      if (path.startsWith('/api/history')) {
        const ids = /filter_entity_id=([^&]*)/.exec(path);
        if (!ids) return [];
        return decodeURIComponent(ids[1]).split(',')
          .map((id) => history(id.trim()))
          .filter((series) => series.length > 0);
      }
      if (path.startsWith('/api/template')) return '';
      return {};
    },
  };
})();
