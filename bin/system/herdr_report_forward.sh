#!/usr/bin/env bash
# Purpose: Keep Laptop loopback forwards to the Mini's current Herdr Projects page server.
# Run by launchd (com.nathanvale.herdr-report-forward) with KeepAlive, so a
# dropped connection, a reboot or a page-server move starts it again. Safe to
# run manually.
#
# Every report link carries the port of the page server that minted it, and
# that server may since have moved. Each start therefore reads, from the Mini:
#   - the current page server port (serve.json), and
#   - every port found in report links (task.json files),
# then forwards each of those link ports on the Laptop to the current server,
# which serves every report path. The SSH session watches serve.json and ends
# when the port changes, so the next start follows the move.
#
# A link port that another Laptop process already listens on (for example a
# forward added to the shared interactive mac-mini mux) is left alone and
# checked every poll; once it is released the session ends so the next start
# takes it over. When every port is held this waits without opening an SSH
# connection, so it never competes for a port or repeats authentication; it
# still ends every REDISCOVER_SECONDS so the next start re-reads serve.json and
# follows a page server move.

set -euo pipefail

readonly SSH_HOST="${HERDR_REPORT_FORWARD_HOST:-mac-mini}"
# Herdr Projects data folder on the Mini, relative to its home folder.
readonly DATA_DIR="${HERDR_REPORT_FORWARD_DATA_DIR:-.herdr-projects/data}"
readonly POLL_SECONDS="${HERDR_REPORT_FORWARD_POLL_SECONDS:-15}"
readonly MAX_PORTS="${HERDR_REPORT_FORWARD_MAX_PORTS:-32}"
readonly REDISCOVER_SECONDS="${HERDR_REPORT_FORWARD_REDISCOVER_SECONDS:-300}"
readonly SSH_BIN="${HERDR_REPORT_FORWARD_SSH_BIN:-/usr/bin/ssh}"
readonly LSOF_BIN="${HERDR_REPORT_FORWARD_LSOF_BIN:-/usr/sbin/lsof}"

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

die() {
  log "status=failed reason=$*" >&2
  exit 1
}

# Always run in a subshell (command substitution or &), so exec makes the
# subshell the ssh process itself and its PID is the one to stop.
ssh_mini() {
  exec "${SSH_BIN}" -S none -n \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    "$@"
}

# Remote command printing the current server port, then each report-link port.
discovery_command() {
  printf '%s' "/usr/bin/plutil -extract port raw -o - '${DATA_DIR}/serve.json' && echo &&" \
    " find '${DATA_DIR}/tasks' -name task.json -exec grep -hoE" \
    " 'http://127[.]0[.]0[.]1:[0-9]+/[^/\"]+/[0-9]+/(report|review[.]html|plan)' {} + |" \
    " sed -E 's#^http://127[.]0[.]0[.]1:([0-9]+)/.*#\\1#' | sort -un"
}

# Remote command that lasts while the current server port is unchanged.
watch_command() {
  printf '%s' "while [ \"\$(/usr/bin/plutil -extract port raw -o - '${DATA_DIR}/serve.json' 2>/dev/null)\" = '$1' ];" \
    " do sleep ${POLL_SECONDS}; done"
}

valid_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && (($1 >= 1024 && $1 <= 65535))
}

# PIDs listening on a local port on any local address; empty when free.
port_listeners() {
  "${LSOF_BIN}" -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' || true
}

# First of the given ports that no process listens on any more; fails when all are held.
first_released() {
  local port
  for port in "$@"; do
    [[ -z "$(port_listeners "${port}")" ]] && echo "${port}" && return 0
  done
  return 1
}

# Retain the original per-port agents alongside automatic report discovery.
forward_configured_port() {
  local remote_port="$HERDR_REPORT_FORWARD_PORT"
  local local_port="${HERDR_REPORT_FORWARD_LOCAL_PORT:-$remote_port}" listeners
  valid_port "$remote_port" && valid_port "$local_port" || die "configured port is invalid"
  listeners="$(port_listeners "$local_port")"
  if [[ -n "$listeners" ]]; then
    log "status=deferred port=${local_port} listeners=${listeners% }"
    while [[ -n "$(port_listeners "$local_port")" ]]; do
      sleep "$POLL_SECONDS"
    done
  fi
  log "status=forwarding port=${local_port} remote_port=${remote_port} host=${SSH_HOST}"
  exec "$SSH_BIN" -S none \
    -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -N -L "127.0.0.1:${local_port}:127.0.0.1:${remote_port}" "$SSH_HOST"
}

main() {
  if [[ -n "${HERDR_REPORT_FORWARD_PORT:-}" ]]; then
    forward_configured_port
    return
  fi
  [[ "${DATA_DIR}" =~ ^[A-Za-z0-9._/-]+$ ]] || die "HERDR_REPORT_FORWARD_DATA_DIR has unsupported characters"
  [[ "${REDISCOVER_SECONDS}" =~ ^[1-9][0-9]*$ ]] || die "HERDR_REPORT_FORWARD_REDISCOVER_SECONDS must be a whole number of seconds"

  local discovered current port listeners
  discovered="$(ssh_mini "${SSH_HOST}" "$(discovery_command)")" ||
    die "could not read the page server port from ${SSH_HOST}:${DATA_DIR}/serve.json"
  current="$(head -n 1 <<<"${discovered}")"
  valid_port "${current}" || die "${SSH_HOST}:${DATA_DIR}/serve.json names no page server port"

  local -a ports=("${current}")
  while read -r port; do
    valid_port "${port}" && [[ "${port}" != "${current}" ]] && ports+=("${port}")
  done < <(tail -n +2 <<<"${discovered}")
  if ((${#ports[@]} > MAX_PORTS)); then
    # Keep the current port (first) and the lowest older ones.
    log "status=truncated found=${#ports[@]} kept=${MAX_PORTS} setting=HERDR_REPORT_FORWARD_MAX_PORTS"
    ports=("${ports[@]:0:${MAX_PORTS}}")
  fi

  local -a forwards=() forwarded=() held=()
  for port in "${ports[@]}"; do
    listeners="$(port_listeners "${port}")"
    if [[ -n "${listeners}" ]]; then
      log "status=deferred port=${port} listeners=${listeners% }"
      held+=("${port}")
    else
      forwards+=(-L "127.0.0.1:${port}:127.0.0.1:${current}")
      forwarded+=("${port}")
    fi
  done

  local freed
  if ((${#forwards[@]} == 0)); then
    # Wait locally until one held port frees, or long enough that the page
    # server may have moved; either way the next start rediscovers.
    local waited_from="${SECONDS}"
    until freed="$(first_released "${held[@]}")"; do
      if ((SECONDS - waited_from >= REDISCOVER_SECONDS)); then
        log "status=rediscovering after=${REDISCOVER_SECONDS}s"
        exit 0
      fi
      sleep "${POLL_SECONDS}"
    done
    log "status=released port=${freed}"
    exit 0
  fi

  log "status=forwarding remote_port=${current} ports=$(IFS=,; echo "${forwarded[*]}") host=${SSH_HOST}"
  ssh_mini -o ExitOnForwardFailure=yes "${forwards[@]}" "${SSH_HOST}" "$(watch_command "${current}")" &
  local ssh_pid=$! status=0
  trap 'kill "${ssh_pid}" 2>/dev/null || true; exit 143' TERM INT

  while kill -0 "${ssh_pid}" 2>/dev/null; do
    if ((${#held[@]} > 0)) && freed="$(first_released "${held[@]}")"; then
      log "status=reclaiming port=${freed}"
      kill "${ssh_pid}" 2>/dev/null || true
      wait "${ssh_pid}" 2>/dev/null || true
      exit 0
    fi
    # Backgrounded so a TERM from launchd is handled without waiting out the poll.
    sleep "${POLL_SECONDS}" &
    wait $! || true
  done
  wait "${ssh_pid}" || status=$?
  exit "${status}"
}

main "$@"
