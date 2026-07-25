# Home Screens · Home Assistant plugin

A plugin for [Home Screens](https://homescreens.dev) — the open-source smart display system for Raspberry Pi — that brings beautiful entity cards, area grouping, and interactive controls for your Home Assistant instance to your kiosk.

- **No code.** Pick entities from a searchable browser. No Jinja2, no template strings.
- **Type-aware rendering.** Sensors get units + trend arrows, lights show brightness, climate gets a temperature arc, media shows album art, and people show the photo you gave them in Home Assistant.
- **15+ domains.** `sensor`, `binary_sensor`, `light`, `switch`, `climate`, `weather`, `person`, `media_player`, `cover`, `lock`, `fan`, `input_boolean`, `automation`, `scene`, `camera`.
- **12 views.** Card grid, status board, by area, single entity, single row, climate, media, cameras, buttons, alerts, batteries, power.
- **Interactive.** Tap lights/switches/fans/input_booleans/automations to toggle. Tap scenes to activate. Tap media_player to play/pause. Tap covers to toggle. Hold a light, cover, or fan card for full controls — brightness, warmth, color, blind position, fan speed — and tap a climate card for setpoints and modes. Locks take a deliberate one-second hold, so a passing elbow can't open the front door.
- **Automatic colors.** A running heater, an unlocked door, an open blind, somebody home: the things worth noticing color themselves, with no rules to write. Your own color rules still win, and the whole thing has an off switch.
- **Batteries.** One view that finds every battery level Home Assistant knows about, emptiest first, and says how many need charging.
- **Power.** What the house is pulling right now, big enough to read from the doorway, with the day's shape drawn behind it and the day's low, average, and high underneath.
- **Trends.** Turn on **24-hour history** to draw a sparkline with the day's range on sensor cards that measure things (temperature, power, CO₂...). The single-entity view draws that day full-width behind the number instead.
- **Tiny.** ~45 KB gzipped. No icon font. Shared display cache — N modules on one screen make one `/api/states` call per tick.

## Setup

### 1. Create a Long-Lived Access Token in HA

In Home Assistant, open your **Profile → Security → Long-Lived Access Tokens** (bottom of the page). Click **Create Token**. Copy it now — HA only shows it once. Tokens are valid for 10 years.

### 2. Install the plugin

Install from the **Plugin Store** inside the Home Screens editor, or download a release tarball from the [Releases](https://github.com/home-screens/home-screens-plugin-home-assistant/releases) page and side-load it.

For general Home Screens setup, see the [documentation](https://homescreens.dev/docs).

### 3. Configure

The connection is set up **once for the whole plugin** — every widget, condition search, and automatic state sharing use it. You can do it from either place:

- Drop a **Home Assistant** module onto a screen and open its settings — the Connection section is right there the first time.
- Or open the plugin's card in the editor's plugin manager.

Either way:

1. Enter your HA URL — `http://homeassistant.local:8123`, `http://192.168.x.x:8123`, or your public HA URL.
2. Paste the token. You should see `Connected — HA 2026.x · 247 entities`.
3. In the module, pick a **View**, then browse and check off **Entities** (this only chooses what the widget shows — state sharing doesn't need it).

## Conditional visibility (state publishing)

This plugin publishes Home Assistant entity states to Home Screens' shared-state bus, so **any** module — native or plugin — can show or hide based on an entity's state. Example: show a red door icon only while `binary_sensor.back_door_sensor_intrusion` reports intrusion (raw state `on`).

### Setup

Publishing is **automatic and demand-driven** (v1.4.0+, Home Screens 1.8+): any entity key referenced by a visibility condition or a Text-module token is published by the plugin's built-in state provider — no Home Assistant module needs to be placed, and there is no entity list to keep in sync.

1. In the editor's plugin manager, open the Home Assistant plugin's **Plugin settings** and set your server address (the token stays in the secrets UI as before).
2. On the module you want to gate (e.g. an icon), add a visibility condition and search for the entity by name: pick it from the list, then pick its value — options show the friendly text alongside the raw state ("Open (on)") and store the raw state for you.

**Upgrading from 1.3 or earlier?** State publishing now reads the server address from the plugin settings, so complete step 1 above or your existing visibility conditions will stop updating after the upgrade. The old hidden **Run hidden in the background** instance is no longer used and can be deleted.

### Keys and values

Keys are `plugin:home-assistant:<entity_id>`, e.g. `plugin:home-assistant:light.kitchen`. Values are raw Home Assistant states (`on`, not the `Alert` / `Open` text shown on cards), matched exactly and case-sensitively. The condition builder handles all of this for you — search picks the key, the value dropdown stores the raw state — so hand-typed values are only needed for entities the search can't see. Numeric sensors publish the bare number without units (`72.5`, not `72.5 °F`); `unavailable` and `unknown` pass through verbatim (condition on `notEquals` those if you want "known-good only").

### Attributes

Any scalar attribute publishes the same way, under `plugin:home-assistant:<entity_id>:<attribute>` — e.g. `plugin:home-assistant:sensor.phone:battery_level`. In the condition search, include part of the attribute name ("phone battery") and pick the "(attribute)" entry; in a Text module, reference the key directly. Attributes that are lists or objects (like weather `forecast`) can't publish; an attribute Home Assistant drops (like `media_title` when nothing is playing) clears its key and conditions on it fall back to unknown.

### Example

Door-alert icon: add a condition on the icon module, search for the door sensor by name, choose *is* and the alert value from the dropdown (e.g. "Open (on)").

Phone battery in a Text module (with the host's token filters): `Phone: {plugin:home-assistant:sensor.phone:battery_level|round:0|default:–}%`

### Debugging

Enable **Debug logging** in the plugin settings (plugin manager), then open the display page's browser console (F12). The provider logs every value it puts on the bus, so you can see exactly what a condition must match:

```
[home-assistant] provider publish plugin:home-assistant:binary_sensor.back_door_sensor_intrusion = "on"
[home-assistant] provider clear plugin:home-assistant:light.kitchen
```

### Limitations

- The host's bus is capped at **256 keys total** across all plugins, and silently drops keys past the cap. Demand-driven publishing keeps this comfortable — only keys actually referenced by a condition or token are ever published.
- **Only entities that exist in Home Assistant publish.** A typo'd or deleted entity id never receives a value, so conditions on it stay unknown (hidden by default). Entity ids longer than 106 characters are likewise skipped (host key-length cap).
- Removing the last condition or token that references an entity clears its key after a short grace window, so conditions on it fall back to unknown.

## Architecture notes

### LAN access

Home Assistant typically lives on your LAN — `homeassistant.local:8123` or `192.168.x.x`. Home Screens' plugin proxy normally blocks RFC1918 and mDNS targets for SSRF safety. This plugin declares the `localNetwork` permission, which relaxes that gate to allow private IPs while still blocking:

- Loopback (`127.0.0.1`, `::1`)
- Cloud metadata (`169.254.169.254`, `fd00:ec2::254`)
- Non-http protocols

### REST, not WebSocket

The plugin uses HA's REST API — no persistent connections, no leaks to worry about. Polls `/api/states` on your configured interval (5 seconds to 1 hour). Recovers automatically from HA restarts. Registry data (areas) is fetched through `POST /api/template` with Jinja2 since HA's area registry is WebSocket-only.

### Shared cache

`window.__HS_SDK__.displayCache` lets multiple HA module instances on the same screen share one fetch cycle. Service calls apply the response's updated states to the cache immediately, so tapping a light flips the card without waiting for the next poll.

## Build

```
npm install
npm run build
# → dist/bundle.js
```

## License

MIT
