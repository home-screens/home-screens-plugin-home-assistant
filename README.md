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
