#!/usr/bin/env bash
# Purpose: Restart Raycast only when its memory exceeds a threshold.
# Invoked periodically by launchd (com.nathanvale.raycast-restart). Safe to run manually.
# No-op when Raycast is lean or not running, so a fixed schedule never disrupts a healthy app.

set -euo pipefail

readonly THRESHOLD_MB="${RAYCAST_RESTART_THRESHOLD_MB:-300}"
readonly APP_NAME="Raycast"

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

# Total resident memory (MB) across all Raycast processes; 0 if not running.
raycast_rss_mb() {
  ps -axo rss,comm \
    | grep -i raycast \
    | grep -v grep \
    | awk '{s += $1} END {printf "%d", s / 1024}'
}

main() {
  if ! pgrep -x "${APP_NAME}" >/dev/null 2>&1; then
    log "Raycast not running; nothing to do."
    return 0
  fi

  local rss_mb
  rss_mb="$(raycast_rss_mb)"
  : "${rss_mb:=0}"

  if (( rss_mb < THRESHOLD_MB )); then
    log "Raycast at ${rss_mb}MB (threshold ${THRESHOLD_MB}MB); no restart needed."
    return 0
  fi

  log "Raycast at ${rss_mb}MB exceeds ${THRESHOLD_MB}MB; restarting."
  osascript -e "quit application \"${APP_NAME}\"" 2>/dev/null || true

  # Wait up to ~5s for a clean quit before forcing.
  local i
  for i in 1 2 3 4 5; do
    pgrep -x "${APP_NAME}" >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -x "${APP_NAME}" >/dev/null 2>&1; then
    log "Clean quit timed out; sending TERM."
    killall "${APP_NAME}" 2>/dev/null || true
    sleep 1
  fi

  open -a "${APP_NAME}"
  log "Raycast relaunched (was ${rss_mb}MB)."
}

main "$@"
