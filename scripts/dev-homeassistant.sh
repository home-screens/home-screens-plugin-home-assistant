#!/usr/bin/env bash
set -euo pipefail

# Home Screens - DEVELOPMENT Home Assistant launcher.
#
# Spins up the latest Home Assistant container via Podman for local dev
# against the HA-integration surfaces of this app. NOT for production.
#
# Usage:
#   ./scripts/dev-homeassistant.sh up        # pull latest + start HA
#   ./scripts/dev-homeassistant.sh down      # stop + remove container (config kept)
#   ./scripts/dev-homeassistant.sh restart   # restart container
#   ./scripts/dev-homeassistant.sh status    # show container state
#   ./scripts/dev-homeassistant.sh logs      # follow container logs
#   ./scripts/dev-homeassistant.sh shell     # exec a shell inside the container
#   ./scripts/dev-homeassistant.sh nuke      # remove container AND config dir
#
# On first `up`, open http://localhost:8123 to complete onboarding.

CONTAINER_NAME="home-screens-ha-dev"
IMAGE="ghcr.io/home-assistant/home-assistant:stable"
HOST_PORT="${HA_PORT:-8123}"
TZ_NAME="${HA_TZ:-America/Chicago}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${REPO_ROOT}/.home-assistant-dev"

require_podman() {
  if ! command -v podman >/dev/null 2>&1; then
    echo "error: podman is not installed or not on PATH" >&2
    echo "install with: brew install podman && podman machine init && podman machine start" >&2
    exit 1
  fi
}

ensure_machine_running() {
  # Only relevant on macOS/Windows where Podman uses a VM.
  if podman machine list --format '{{.Name}} {{.Running}}' 2>/dev/null | grep -q ' true$'; then
    return 0
  fi
  if podman machine list --format '{{.Name}}' 2>/dev/null | grep -q .; then
    echo "podman machine is not running — starting it..."
    podman machine start
  fi
}

container_exists() {
  podman container exists "${CONTAINER_NAME}" 2>/dev/null
}

container_running() {
  [ "$(podman container inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null || echo false)" = "true" ]
}

cmd_up() {
  mkdir -p "${CONFIG_DIR}"

  if container_running; then
    echo "home assistant already running at http://localhost:${HOST_PORT}"
    exit 0
  fi

  echo "pulling ${IMAGE}..."
  podman pull "${IMAGE}"

  if container_exists; then
    echo "starting existing container ${CONTAINER_NAME}..."
    podman start "${CONTAINER_NAME}" >/dev/null
  else
    echo "creating container ${CONTAINER_NAME}..."
    podman run -d \
      --name "${CONTAINER_NAME}" \
      --restart=unless-stopped \
      -e "TZ=${TZ_NAME}" \
      -v "${CONFIG_DIR}:/config:Z" \
      -p "${HOST_PORT}:8123" \
      "${IMAGE}" >/dev/null
  fi

  echo ""
  echo "home assistant is starting — first boot takes ~1 minute."
  echo "  url:    http://localhost:${HOST_PORT}"
  echo "  config: ${CONFIG_DIR}"
  echo "  logs:   ./scripts/dev-homeassistant.sh logs"
}

cmd_down() {
  if ! container_exists; then
    echo "no container named ${CONTAINER_NAME} — nothing to stop"
    return 0
  fi
  echo "stopping ${CONTAINER_NAME}..."
  podman stop "${CONTAINER_NAME}" >/dev/null || true
  podman rm "${CONTAINER_NAME}" >/dev/null
  echo "stopped. config preserved at ${CONFIG_DIR}"
}

cmd_restart() {
  cmd_down
  cmd_up
}

cmd_status() {
  if ! container_exists; then
    echo "not created"
    return 0
  fi
  podman ps -a --filter "name=${CONTAINER_NAME}" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
}

cmd_logs() {
  podman logs -f "${CONTAINER_NAME}"
}

cmd_shell() {
  podman exec -it "${CONTAINER_NAME}" /bin/bash
}

cmd_nuke() {
  cmd_down || true
  if [ -d "${CONFIG_DIR}" ]; then
    echo "removing ${CONFIG_DIR}..."
    rm -rf "${CONFIG_DIR}"
  fi
  echo "nuked."
}

usage() {
  sed -n '3,20p' "$0"
  exit "${1:-1}"
}

main() {
  [ $# -ge 1 ] || usage 1
  require_podman
  ensure_machine_running

  case "$1" in
    up)      cmd_up ;;
    down)    cmd_down ;;
    restart) cmd_restart ;;
    status)  cmd_status ;;
    logs)    cmd_logs ;;
    shell)   cmd_shell ;;
    nuke)    cmd_nuke ;;
    -h|--help|help) usage 0 ;;
    *)
      echo "unknown command: $1" >&2
      usage 1
      ;;
  esac
}

main "$@"
