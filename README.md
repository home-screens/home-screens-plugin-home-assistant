# Home Screens · Home Assistant plugin

A plugin for [Home Screens](https://homescreens.dev) — the open-source smart display system for Raspberry Pi — that brings beautiful entity cards, area grouping, and interactive controls for your Home Assistant instance to your kiosk.

- **No code.** Pick entities from a searchable browser. No Jinja2, no template strings.
- **Type-aware rendering.** Sensors get units + trend arrows, lights show brightness, climate gets a temperature arc, media shows album art.
- **15+ domains.** `sensor`, `binary_sensor`, `light`, `switch`, `climate`, `weather`, `person`, `media_player`, `cover`, `lock`, `fan`, `input_boolean`, `automation`, `scene`, `camera`.
- **8 views.** Card grid, status board, by area, single entity, single row, climate, media, cameras.
- **Interactive.** Tap lights/switches/fans/input_booleans/automations to toggle. Tap scenes to activate. Tap media_player to play/pause. Tap covers to toggle.
- **Tiny.** ~13 KB gzipped. No icon font. Shared display cache — N modules on one screen make one `/api/states` call per tick.

## Setup

### 1. Create a Long-Lived Access Token in HA

In Home Assistant, open your **Profile → Security → Long-Lived Access Tokens** (bottom of the page). Click **Create Token**. Copy it now — HA only shows it once. Tokens are valid for 10 years.

### 2. Install the plugin

Install from the **Plugin Store** inside the Home Screens editor, or download a release tarball from the [Releases](https://github.com/home-screens/home-screens-plugin-home-assistant/releases) page and side-load it.

For general Home Screens setup, see the [documentation](https://homescreens.dev/docs).

### 3. Configure

Open the editor, drop a **Home Assistant** module onto a screen, then:

1. Enter your HA URL — `http://homeassistant.local:8123`, `http://192.168.x.x:8123`, or your public HA URL.
2. Paste the token into the plugin secrets UI.
3. Click **Test Connection**. You should see `HA 2026.x · 247 entities`.
4. Pick a **View**, browse and check off **Entities**.

## Conditional visibility (state publishing)

This plugin publishes the states of your configured entities to Home Screens' shared-state bus, so **any** module — native or plugin — can show or hide based on a Home Assistant entity's state. Example: show a red door icon only while `binary_sensor.back_door_sensor_intrusion` reports intrusion (raw state `on`).

### Setup

1. Add a Home Assistant module instance and list the entities you want published (only configured entities are published, never your full entity registry).
2. In the editor's **Visibility** section for that instance, enable **Run hidden in the background**. The instance then runs continuously — surviving screen rotation — and never renders on screen. If you also want a visible HA widget, add a second instance without the flag.
3. On the module you want to gate (e.g. an icon), add a visibility condition and pick the entity key from the picker. To see the exact value to match, open the HA module's config and expand the **Visibility conditions** section: it lists every key with its live raw value, click a key to copy it.

### Keys and values

Keys are `plugin:home-assistant:<entity_id>`, e.g. `plugin:home-assistant:light.kitchen`.

Values are **raw Home Assistant states, matched exactly and case-sensitively**: lowercase `on`, not the `On` / `Alert` / `Open` text shown on cards. Three vocabularies exist for the same state, and only the raw one works in conditions:

| Where you see it | Example for a tripped safety sensor | Works in a condition? |
| --- | --- | --- |
| Raw HA state (what this plugin publishes) | `on` | yes |
| This plugin's cards (friendly text by device class) | `Alert` | no |
| Home Assistant's own UI (translated) | `Unsafe` | no |

Binary sensors always publish `on` or `off` regardless of device class. Lights, switches, fans and input booleans publish `on` / `off`; covers publish `open` / `closed` / `opening` / `closing`; locks publish `locked` / `unlocked`; numeric sensors publish the bare number without units (`72.5`, not `72.5 °F`). `unavailable` and `unknown` pass through verbatim (condition on `notEquals` those if you want "known-good only").

You don't need to memorize any of that: the **Visibility conditions** panel in the module config lists each entity's possible raw values (click a value to copy it), with the current one highlighted, and the editor's key picker shows sample values next to each key.

### Example

Door-alert icon: condition type `state`, key `plugin:home-assistant:binary_sensor.back_door_sensor_intrusion`, operator *equals*, value `on`.

### Debugging

Enable **Debug logging** in the module's Display settings, then open the display page's browser console (F12). The plugin logs every value it puts on the bus, so you can see exactly what a condition must match:

```
[home-assistant] publish plugin:home-assistant:binary_sensor.back_door_sensor_intrusion = "on"
[home-assistant] clear plugin:home-assistant:light.kitchen
```

### Limitations

- The host's bus is capped at **256 keys total** across all plugins and instances, and silently drops keys past the cap — publish only the entities you actually condition on.
- **Only entities that exist in Home Assistant publish.** A typo'd or deleted entity id still appears in the editor's key picker but never receives a value, so conditions on it stay unknown (hidden by default). Entity ids longer than 106 characters are likewise skipped (host key-length cap).
- On hosts that support `clearState`, removing an entity from **every** Home Assistant instance's list clears its key, so conditions on it fall back to unknown immediately; instances on the same display coordinate so removing an entity from one instance never wipes a key another still publishes. On older hosts without `clearState`, the last published value lingers until the display reloads — typically benign, since conditions default to hiding on unknown.

## Architecture notes

### LAN access

Home Assistant typically lives on your LAN — `homeassistant.local:8123` or `192.168.x.x`. Home Screens' plugin proxy normally blocks RFC1918 and mDNS targets for SSRF safety. This plugin declares the `localNetwork` permission, which relaxes that gate to allow private IPs while still blocking:

- Loopback (`127.0.0.1`, `::1`)
- Cloud metadata (`169.254.169.254`, `fd00:ec2::254`)
- Non-http protocols

### REST, not WebSocket

The plugin uses HA's REST API — no persistent connections, no leaks to worry about. Polls `/api/states` on your configured interval (15s–5min). Recovers automatically from HA restarts. Registry data (areas) is fetched through `POST /api/template` with Jinja2 since HA's area registry is WebSocket-only.

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
