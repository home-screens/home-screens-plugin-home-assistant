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
    state('sensor.solar_power', '5200', { friendly_name: 'Solar Power', unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement' }),
    state('sensor.grid_power', '-1600', { friendly_name: 'Grid Power', unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement' }),
    state('sensor.battery_power', '900', { friendly_name: 'Battery Power', unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement' }),
    state('sensor.battery_level', '78', { friendly_name: 'Battery Level', unit_of_measurement: '%', device_class: 'battery' }),
    state('scene.movie', 'unknown', { friendly_name: 'Movie Night' }),
    state('scene.bedtime', 'unknown', { friendly_name: 'Bedtime' }),
    // No `forecast` attribute: HA 2024.4 removed it. The dashboard asks the
    // weather.get_forecasts service instead (route below).
    state('weather.home', 'sunny', { friendly_name: 'Home', temperature: 81, humidity: 48, temperature_unit: '°F' }),
    state('person.emma', 'school', { friendly_name: 'Emma' }),
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

  // State transitions over the day for the things that turn on and off, as
  // hours-ago offsets. The timeline view draws these as lanes and a feed.
  const TRANSITIONS = {
    'light.living_room': [[24, 'off'], [20, 'on'], [14, 'off'], [2.5, 'on']],
    'light.kitchen': [[24, 'on'], [22, 'off'], [8, 'on'], [6, 'off']],
    'binary_sensor.front_door': [[24, 'off'], [17, 'on'], [16.9, 'off'], [9, 'on'], [8.95, 'off'], [0.4, 'on']],
    'lock.front_door': [[24, 'locked'], [9, 'unlocked'], [7, 'locked']],
    'person.jamie': [[24, 'home'], [10, 'not_home'], [3, 'home']],
    'person.emma': [[24, 'home'], [9, 'school']],
    'media_player.den': [[24, 'off'], [5, 'playing'], [3, 'paused'], [1, 'playing']],
    'cover.garage': [[24, 'closed'], [0.5, 'open'], [0.3, 'closed']],
    'fan.office': [[24, 'off'], [4, 'on']],
    'switch.porch': [[24, 'on'], [12, 'off']],
    'climate.hallway': [[24, 'heat']],
  };

  function transitions(entityId) {
    const list = TRANSITIONS[entityId];
    if (!list) return [];
    const end = Date.now();
    return list.map(([hoursAgo, s], i) => {
      const entry = { state: s, last_changed: new Date(end - hoursAgo * 3600_000).toISOString() };
      if (i === 0) entry.entity_id = entityId;
      return entry;
    });
  }

  function history(entityId, samples = 96) {
    const shape = SHAPES[entityId];
    if (!shape) return transitions(entityId);
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

  // What weather.get_forecasts answers for weather.home, in the shape the
  // REST API returns it (service_response keyed by entity).
  const FORECAST = [
    { datetime: '2026-07-27T12:00:00Z', condition: 'sunny', temperature: 84, templow: 66 },
    { datetime: '2026-07-28T12:00:00Z', condition: 'partlycloudy', temperature: 79, templow: 64 },
    { datetime: '2026-07-29T12:00:00Z', condition: 'rainy', temperature: 75, templow: 61 },
    { datetime: '2026-07-30T12:00:00Z', condition: 'cloudy', temperature: 77, templow: 62 },
    { datetime: '2026-07-31T12:00:00Z', condition: 'sunny', temperature: 80, templow: 63 },
  ];

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
      if (path.startsWith('/api/services/weather/get_forecasts')) {
        return { changed_states: [], service_response: { 'weather.home': { forecast: FORECAST } } };
      }
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
