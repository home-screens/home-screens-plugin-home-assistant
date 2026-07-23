#!/usr/bin/env bash
set -euo pipefail

# Home Screens - HA plugin test scenario runner.
#
# Drives the mock devices defined in .home-assistant-dev/packages/test_devices.yaml
# through the drills in home-screens/.claude/plans/shared-state/v1.8-release-test-plan.md.
# Works against the dev container (scripts/dev-homeassistant.sh) or any HA host.
#
# Token resolution order:
#   1. HA_TOKEN env var
#   2. scripts/.ha-token.local (plain text, gitignored via *.local)
#   3. ha_token from ../home-screens/data/plugin-secrets/home-assistant.json
#
# Usage:
#   ./scripts/test-scenarios.sh check                 # verify all mock entities exist
#   ./scripts/test-scenarios.sh status                # show current state of every test entity
#   ./scripts/test-scenarios.sh doorbell ring|on|off  # B3-B5, B11-B12 rule edges (+D4 last_triggered)
#   ./scripts/test-scenarios.sh door open|close|cycle # C11 ack recurrence
#   ./scripts/test-scenarios.sh garage open|close     # C14 look rules
#   ./scripts/test-scenarios.sh co2 <ppm>|alert|clear # A18/B6/C9: alert=1400, clear=420
#   ./scripts/test-scenarios.sh co2-power on|off      # C12 sensor unavailable drill
#   ./scripts/test-scenarios.sh temp <degF>           # deterministic temp sensor (thermostat "room temp")
#   ./scripts/test-scenarios.sh thermostat set <degF>  # target temp (climate.set_temperature)
#   ./scripts/test-scenarios.sh thermostat mode heat|off
#   ./scripts/test-scenarios.sh thermostat status     # mode, action, current/target temp, relay
#   ./scripts/test-scenarios.sh phone <0-100>         # A5 battery attribute
#   ./scripts/test-scenarios.sh alerts <1-5>|clear    # C13 simultaneous alerts (5 = "and 1 more")
#   ./scripts/test-scenarios.sh media play|idle|off   # A6/D6 media_title appears/vanishes
#   ./scripts/test-scenarios.sh media seed            # re-create the media player after an HA restart
#   ./scripts/test-scenarios.sh watch <entity_id>     # poll every 2s, print state changes
#
# NOTE: media_player.test_media is REST-pushed (core HA has no template media
# player), so it vanishes on HA restart. After drill D3, run `media seed`.

HA_URL="${HA_URL:-http://localhost:8123}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HUB_SECRETS="${REPO_ROOT}/../home-screens/data/plugin-secrets/home-assistant.json"

resolve_token() {
  if [ -n "${HA_TOKEN:-}" ]; then
    echo "${HA_TOKEN}"
  elif [ -f "${SCRIPT_DIR}/.ha-token.local" ]; then
    tr -d '[:space:]' < "${SCRIPT_DIR}/.ha-token.local"
  elif [ -f "${HUB_SECRETS}" ]; then
    python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['ha_token'])" "${HUB_SECRETS}"
  else
    echo "error: no HA token found (set HA_TOKEN, create scripts/.ha-token.local, or configure the hub plugin secret)" >&2
    exit 1
  fi
}

TOKEN="$(resolve_token)"

api() { # api METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "${method}" -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")
  [ -n "${body}" ] && args+=(-d "${body}")
  curl "${args[@]}" "${HA_URL}${path}"
}

svc() { # svc DOMAIN SERVICE ENTITY [EXTRA_JSON_FIELDS]
  local domain="$1" service="$2" entity="$3" extra="${4:-}"
  local body="{\"entity_id\": \"${entity}\"${extra:+, ${extra}}}"
  api POST "/api/services/${domain}/${service}" "${body}" > /dev/null
  echo "${domain}.${service} -> ${entity}${extra:+ (${extra})}"
}

get_state() {
  api GET "/api/states/$1" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get('state', '<missing>'))
except Exception:
    print('<missing>')"
}

TEST_ENTITIES=(
  input_boolean.test_doorbell
  input_boolean.test_front_door
  input_boolean.test_garage_door
  input_boolean.test_co2_available
  input_boolean.test_alert_1
  input_boolean.test_alert_2
  input_boolean.test_alert_3
  input_boolean.test_alert_4
  input_boolean.test_alert_5
  input_number.test_co2
  input_number.test_temp
  input_number.test_phone_battery
  binary_sensor.test_door
  binary_sensor.test_garage
  sensor.test_co2
  sensor.test_temp
  sensor.test_temp_wave
  sensor.test_phone
  light.test_dimmer
  climate.test_thermostat
  input_boolean.test_heater
  automation.test_doorbell_logger
  script.test_beep
  script.test_slow_beep
)

cmd_check() {
  local missing=0
  for e in "${TEST_ENTITIES[@]}"; do
    local state
    state="$(get_state "${e}")"
    if [ "${state}" = "<missing>" ]; then
      echo "MISSING  ${e}"
      missing=1
    else
      printf 'ok       %-40s %s\n' "${e}" "${state}"
    fi
  done
  local media
  media="$(get_state media_player.test_media)"
  if [ "${media}" = "<missing>" ]; then
    echo "note     media_player.test_media not seeded yet - run: $0 media seed"
  else
    printf 'ok       %-40s %s\n' "media_player.test_media" "${media}"
  fi
  [ "${missing}" = 0 ] && echo "all package entities present" || {
    echo "some entities missing - reload YAML (Developer Tools > YAML > All) or restart HA" >&2
    exit 1
  }
}

cmd_status() {
  for e in "${TEST_ENTITIES[@]}" media_player.test_media; do
    printf '%-40s %s\n' "${e}" "$(get_state "${e}")"
  done
}

push_media() { # push_media STATE [TITLE]
  local state="$1" title="${2:-}"
  local attrs="\"friendly_name\": \"Test Media\", \"device_class\": \"speaker\""
  [ -n "${title}" ] && attrs="${attrs}, \"media_title\": \"${title}\", \"media_artist\": \"Test Artist\""
  api POST "/api/states/media_player.test_media" \
    "{\"state\": \"${state}\", \"attributes\": {${attrs}}}" > /dev/null
  echo "media_player.test_media -> ${state}${title:+ (\"${title}\")}"
}

case "${1:-}" in
  check)  cmd_check ;;
  status) cmd_status ;;

  doorbell)
    case "${2:-ring}" in
      on)  svc input_boolean turn_on  input_boolean.test_doorbell ;;
      off) svc input_boolean turn_off input_boolean.test_doorbell ;;
      ring)
        svc input_boolean turn_on input_boolean.test_doorbell
        sleep 2
        svc input_boolean turn_off input_boolean.test_doorbell
        ;;
      *) echo "usage: $0 doorbell ring|on|off" >&2; exit 1 ;;
    esac ;;

  door)
    case "${2:-}" in
      open)  svc input_boolean turn_on  input_boolean.test_front_door ;;
      close) svc input_boolean turn_off input_boolean.test_front_door ;;
      cycle)
        svc input_boolean turn_on input_boolean.test_front_door
        sleep 3
        svc input_boolean turn_off input_boolean.test_front_door
        ;;
      *) echo "usage: $0 door open|close|cycle" >&2; exit 1 ;;
    esac ;;

  garage)
    case "${2:-}" in
      open)  svc input_boolean turn_on  input_boolean.test_garage_door ;;
      close) svc input_boolean turn_off input_boolean.test_garage_door ;;
      *) echo "usage: $0 garage open|close" >&2; exit 1 ;;
    esac ;;

  co2)
    case "${2:-}" in
      alert) svc input_number set_value input_number.test_co2 '"value": 1400' ;;
      clear) svc input_number set_value input_number.test_co2 '"value": 420' ;;
      ''|*[!0-9]*) echo "usage: $0 co2 <ppm>|alert|clear" >&2; exit 1 ;;
      *)     svc input_number set_value input_number.test_co2 "\"value\": ${2}" ;;
    esac ;;

  co2-power)
    case "${2:-}" in
      on)  svc input_boolean turn_on  input_boolean.test_co2_available ;;
      off) svc input_boolean turn_off input_boolean.test_co2_available ;;
      *) echo "usage: $0 co2-power on|off" >&2; exit 1 ;;
    esac ;;

  temp)
    [ -n "${2:-}" ] || { echo "usage: $0 temp <degF>" >&2; exit 1; }
    svc input_number set_value input_number.test_temp "\"value\": ${2}" ;;

  thermostat)
    case "${2:-status}" in
      set)
        [ -n "${3:-}" ] || { echo "usage: $0 thermostat set <degF>" >&2; exit 1; }
        svc climate set_temperature climate.test_thermostat "\"temperature\": ${3}" ;;
      mode)
        case "${3:-}" in
          heat|off) svc climate set_hvac_mode climate.test_thermostat "\"hvac_mode\": \"${3}\"" ;;
          *) echo "usage: $0 thermostat mode heat|off" >&2; exit 1 ;;
        esac ;;
      status)
        api GET "/api/states/climate.test_thermostat" | python3 -c "
import json,sys
d = json.load(sys.stdin)
a = d['attributes']
print(f\"mode: {d['state']}  action: {a.get('hvac_action')}  room: {a.get('current_temperature')}  target: {a.get('temperature')}\")"
        printf 'relay: %s\n' "$(get_state input_boolean.test_heater)" ;;
      *) echo "usage: $0 thermostat set <degF> | mode heat|off | status" >&2; exit 1 ;;
    esac ;;

  phone)
    [ -n "${2:-}" ] || { echo "usage: $0 phone <0-100>" >&2; exit 1; }
    svc input_number set_value input_number.test_phone_battery "\"value\": ${2}" ;;

  alerts)
    case "${2:-}" in
      clear)
        for i in 1 2 3 4 5; do
          svc input_boolean turn_off "input_boolean.test_alert_${i}"
        done ;;
      [1-5])
        for i in $(seq 1 "${2}"); do
          svc input_boolean turn_on "input_boolean.test_alert_${i}"
        done ;;
      *) echo "usage: $0 alerts <1-5>|clear" >&2; exit 1 ;;
    esac ;;

  media)
    case "${2:-}" in
      play) push_media playing "Walking on Test Data" ;;
      idle|seed) push_media idle ;;
      off)  push_media off ;;
      *) echo "usage: $0 media play|idle|off|seed" >&2; exit 1 ;;
    esac ;;

  watch)
    [ -n "${2:-}" ] || { echo "usage: $0 watch <entity_id>" >&2; exit 1; }
    echo "watching ${2} (ctrl-c to stop)..."
    last=""
    while true; do
      cur="$(get_state "${2}")"
      if [ "${cur}" != "${last}" ]; then
        printf '%s  %s\n' "$(date '+%H:%M:%S')" "${cur}"
        last="${cur}"
      fi
      sleep 2
    done ;;

  *)
    grep '^#   ' "$0" | sed 's/^#   //'
    exit 1 ;;
esac
