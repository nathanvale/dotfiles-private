#!/usr/bin/env bash
# Run one admitted vault-git Janitor attempt per Melbourne local date.

set -euo pipefail

readonly REQUIRED_TIMEZONE='Australia/Melbourne'
readonly LOG_MAX_BYTES=262144
readonly LOG_KEEP=5
LOCK_HELD=false
STATE_DIR=''
LOG_DIR=''
LOG_FILE=''
RUN_ID='unknown'
TRIGGER_KIND='unknown'
LOCAL_DATE='unknown'

usage() {
  cat <<'EOF'
Usage:
  vault_git_janitor.sh [--config <path>] [--state-dir <path>] [--log-dir <path>]

Run the installed, admitted vault-git janitor --no-input entry once for the
current Australia/Melbourne local date. Scheduling normally supplies all paths.

Options:
  --config <path>         Private installer-generated runtime config.
  --state-dir <path>      Private at-most-once state directory.
  --log-dir <path>        Private bounded log directory.
  --trigger <kind>        calendar, wake-catchup, or boot-catchup.
  -h, --help              Show this help.
EOF
}

is_test_mode() {
  [[ "${VAULT_GIT_JANITOR_TEST_MODE:-0}" == '1' ]]
}

timestamp() {
  date -u +'%Y-%m-%dT%H:%M:%SZ'
}

rotate_log() {
  local size=0
  local index

  [[ -f "$LOG_FILE" ]] || return 0
  size="$(wc -c <"$LOG_FILE" | tr -d ' ')"
  ((size < LOG_MAX_BYTES)) && return 0

  rm -f "$LOG_FILE.$LOG_KEEP"
  for ((index = LOG_KEEP - 1; index >= 1; index--)); do
    if [[ -f "$LOG_FILE.$index" ]]; then
      mv "$LOG_FILE.$index" "$LOG_FILE.$((index + 1))"
    fi
  done
  mv "$LOG_FILE" "$LOG_FILE.1"
}

summary() {
  local status="$1"
  local error_code="${2:-none}"
  local line

  line="timestamp=$(timestamp) run_id=$RUN_ID status=$status trigger=$TRIGGER_KIND local_date=$LOCAL_DATE error=$error_code"
  printf '%s\n' "$line"
  if [[ -n "$LOG_FILE" && -d "$LOG_DIR" ]]; then
    rotate_log
    printf '%s\n' "$line" >>"$LOG_FILE"
    chmod 600 "$LOG_FILE"
  fi
}

refuse() {
  summary 'refused' "$1"
  return 1
}

cleanup() {
  if "$LOCK_HELD"; then
    rm -f "$STATE_DIR/current-run-id"
    rmdir "$STATE_DIR/run.lock" 2>/dev/null || true
  fi
}

atomic_state_write() {
  local destination="$1"
  local value="$2"
  local temporary="$destination.tmp.$$"

  printf '%s\n' "$value" >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$destination"
}

system_timezone() {
  local zone_path

  if is_test_mode && [[ -n "${VAULT_GIT_JANITOR_SYSTEM_TIMEZONE:-}" ]]; then
    printf '%s\n' "$VAULT_GIT_JANITOR_SYSTEM_TIMEZONE"
    return
  fi

  zone_path="$(/bin/realpath /etc/localtime 2>/dev/null || true)"
  if [[ "$zone_path" == */zoneinfo/* ]]; then
    printf '%s\n' "${zone_path##*/zoneinfo/}"
  fi
}

verify_private_directory() {
  local path="$1"
  local owner
  local mode
  local mode_value

  if [[ ! -d "$path" || -L "$path" ]]; then
    return 1
  fi
  read -r owner mode < <(/usr/bin/stat -f '%u %Lp' "$path")
  mode_value=$((8#$mode))
  [[ "$owner" == "$(id -u)" ]] && ((!(mode_value & 0077)))
}

verify_private_file() {
  local path="$1"
  local owner
  local mode
  local mode_value

  if [[ ! -f "$path" || -L "$path" ]]; then
    return 1
  fi
  read -r owner mode < <(/usr/bin/stat -f '%u %Lp' "$path")
  mode_value=$((8#$mode))
  [[ "$owner" == "$(id -u)" ]] && ((!(mode_value & 0077)))
}

verify_admitted_entrypoint() {
  local entrypoint="$1"
  local canonical
  local security_root='/'
  local current_path
  local owner
  local mode
  local mode_value
  local current_uid

  if [[ "$entrypoint" != /* ]]; then
    refuse 'entrypoint-not-absolute'
    return 1
  fi
  if [[ ! -f "$entrypoint" || ! -x "$entrypoint" ]]; then
    refuse 'entrypoint-unavailable'
    return 1
  fi

  canonical="$(/bin/realpath "$entrypoint" 2>/dev/null || true)"
  if [[ -z "$canonical" || "$canonical" != "$entrypoint" ]]; then
    refuse 'entrypoint-not-canonical'
    return 1
  fi

  if is_test_mode && [[ -n "${VAULT_GIT_JANITOR_SECURITY_ROOT:-}" ]]; then
    security_root="$(/bin/realpath "$VAULT_GIT_JANITOR_SECURITY_ROOT")"
    if [[ "$canonical" != "$security_root" && "$canonical" != "$security_root/"* ]]; then
      refuse 'entrypoint-path-unsafe'
      return 1
    fi
  fi

  current_uid="$(id -u)"
  current_path="$canonical"
  while :; do
    read -r owner mode < <(/usr/bin/stat -f '%u %Lp' "$current_path")
    mode_value=$((8#$mode))
    if [[ "$owner" != "$current_uid" && "$owner" != '0' ]] || ((mode_value & 0022)); then
      refuse 'entrypoint-path-unsafe'
      return 1
    fi
    if [[ "$current_path" == "$security_root" || "$current_path" == '/' ]]; then
      break
    fi
    current_path="$(dirname "$current_path")"
  done
}

read_runtime_config() {
  local config_path="$1"
  local line
  local key
  local value
  local entrypoint_seen=false
  local hour_seen=false
  local minute_seen=false

  ENTRYPOINT=''
  SCHEDULE_HOUR=''
  SCHEDULE_MINUTE=''

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] || return 1
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      entrypoint)
        "$entrypoint_seen" && return 1
        ENTRYPOINT="$value"
        entrypoint_seen=true
        ;;
      hour)
        "$hour_seen" && return 1
        SCHEDULE_HOUR="$value"
        hour_seen=true
        ;;
      minute)
        "$minute_seen" && return 1
        SCHEDULE_MINUTE="$value"
        minute_seen=true
        ;;
      *)
        return 1
        ;;
    esac
  done <"$config_path"

  "$entrypoint_seen" && "$hour_seen" && "$minute_seen"
}

current_date() {
  if is_test_mode && [[ -n "${VAULT_GIT_JANITOR_NOW_DATE:-}" ]]; then
    printf '%s\n' "$VAULT_GIT_JANITOR_NOW_DATE"
  else
    TZ="$REQUIRED_TIMEZONE" date +'%Y-%m-%d'
  fi
}

current_time() {
  if is_test_mode && [[ -n "${VAULT_GIT_JANITOR_NOW_TIME:-}" ]]; then
    printf '%s\n' "$VAULT_GIT_JANITOR_NOW_TIME"
  else
    TZ="$REQUIRED_TIMEZONE" date +'%H:%M'
  fi
}

uptime_seconds() {
  local boot_epoch

  if is_test_mode && [[ -n "${VAULT_GIT_JANITOR_UPTIME_SECONDS:-}" ]]; then
    printf '%s\n' "$VAULT_GIT_JANITOR_UPTIME_SECONDS"
    return
  fi
  boot_epoch="$(/usr/sbin/sysctl -n kern.boottime | sed -E 's/.*sec = ([0-9]+).*/\1/')"
  printf '%d\n' "$(($(date +%s) - boot_epoch))"
}

infer_trigger() {
  local now_time="$1"
  local scheduled_time
  local uptime

  printf -v scheduled_time '%02d:%02d' "$((10#$SCHEDULE_HOUR))" "$((10#$SCHEDULE_MINUTE))"
  if [[ "$now_time" == "$scheduled_time" ]]; then
    printf 'calendar\n'
    return
  fi

  uptime="$(uptime_seconds)"
  if ((uptime < 900)); then
    printf 'boot-catchup\n'
  else
    printf 'wake-catchup\n'
  fi
}

read_date_state() {
  local path="$1"

  if [[ ! -e "$path" ]]; then
    return 0
  fi
  verify_private_file "$path" || return 1
  printf '%s\n' "$(<"$path")"
}

main() {
  local runtime_root="$HOME/.local/state/vault-git-janitor"
  local config_path=''
  local requested_trigger='auto'
  local timezone
  local now_time
  local last_success=''
  local last_attempt=''
  local command_status

  STATE_DIR="$runtime_root/state"
  LOG_DIR="$runtime_root/logs"

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --config)
        [[ "$#" -ge 2 ]] || { printf 'error=config-value-required\n' >&2; return 64; }
        config_path="$2"
        shift 2
        ;;
      --state-dir)
        [[ "$#" -ge 2 ]] || { printf 'error=state-dir-value-required\n' >&2; return 64; }
        STATE_DIR="$2"
        shift 2
        ;;
      --log-dir)
        [[ "$#" -ge 2 ]] || { printf 'error=log-dir-value-required\n' >&2; return 64; }
        LOG_DIR="$2"
        shift 2
        ;;
      --trigger)
        [[ "$#" -ge 2 ]] || { printf 'error=trigger-value-required\n' >&2; return 64; }
        requested_trigger="$2"
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        printf 'error=unknown-option option=%s repair=run-with---help\n' "$1" >&2
        return 64
        ;;
    esac
  done

  [[ -n "$config_path" ]] || config_path="$runtime_root/config/runtime.conf"
  if [[ "$config_path" != /* || "$STATE_DIR" != /* || "$LOG_DIR" != /* ]]; then
    printf 'error=runtime-path-not-absolute\n' >&2
    return 64
  fi
  case "$requested_trigger" in
    auto|calendar|wake-catchup|boot-catchup) ;;
    *)
      printf 'error=trigger-invalid\n' >&2
      return 64
      ;;
  esac

  if [[ ! -d "$STATE_DIR" || -L "$STATE_DIR" ]]; then
    printf 'timestamp=%s run_id=unknown status=refused trigger=unknown local_date=unknown error=state-dir-unsafe\n' "$(timestamp)"
    return 1
  fi
  if ! mkdir "$STATE_DIR/run.lock" 2>/dev/null; then
    if [[ -f "$STATE_DIR/current-run-id" && ! -L "$STATE_DIR/current-run-id" ]]; then
      RUN_ID="$(<"$STATE_DIR/current-run-id")"
    fi
    summary 'singleton-noop'
    return 0
  fi
  LOCK_HELD=true
  trap cleanup EXIT INT TERM
  RUN_ID="$(date +%s)-$$"
  atomic_state_write "$STATE_DIR/current-run-id" "$RUN_ID"

  if ! verify_private_directory "$STATE_DIR" || ! verify_private_directory "$LOG_DIR"; then
    refuse 'private-directory-unsafe'
    return 1
  fi
  LOG_FILE="$LOG_DIR/janitor.log"

  timezone="$(system_timezone)"
  if [[ "$timezone" != "$REQUIRED_TIMEZONE" ]]; then
    refuse 'timezone-mismatch'
    return 1
  fi
  if ! verify_private_file "$config_path" || ! read_runtime_config "$config_path"; then
    refuse 'runtime-config-unsafe'
    return 1
  fi
  if [[ ! "$SCHEDULE_HOUR" =~ ^[0-9]+$ ]] || ((10#$SCHEDULE_HOUR > 23)) || \
    [[ ! "$SCHEDULE_MINUTE" =~ ^[0-9]+$ ]] || ((10#$SCHEDULE_MINUTE > 59)); then
    refuse 'runtime-config-invalid'
    return 1
  fi

  LOCAL_DATE="$(current_date)"
  now_time="$(current_time)"
  if [[ ! "$LOCAL_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || [[ ! "$now_time" =~ ^[0-9]{2}:[0-9]{2}$ ]]; then
    refuse 'local-time-invalid'
    return 1
  fi
  if [[ "$requested_trigger" == 'auto' ]]; then
    TRIGGER_KIND="$(infer_trigger "$now_time")"
  else
    TRIGGER_KIND="$requested_trigger"
  fi
  atomic_state_write "$STATE_DIR/last-trigger-kind" "$TRIGGER_KIND"

  verify_admitted_entrypoint "$ENTRYPOINT" || return 1

  if [[ -e "$STATE_DIR/last-success-date" ]]; then
    last_success="$(read_date_state "$STATE_DIR/last-success-date")" || { refuse 'last-success-state-unsafe'; return 1; }
  fi
  if [[ -e "$STATE_DIR/last-attempt-date" ]]; then
    last_attempt="$(read_date_state "$STATE_DIR/last-attempt-date")" || { refuse 'last-attempt-state-unsafe'; return 1; }
  fi
  if [[ -n "$last_success" && "$last_success" > "$LOCAL_DATE" ]] || [[ -n "$last_attempt" && "$last_attempt" > "$LOCAL_DATE" ]]; then
    refuse 'local-date-regression'
    return 1
  fi
  if [[ "$last_success" == "$LOCAL_DATE" || "$last_attempt" == "$LOCAL_DATE" ]]; then
    summary 'already-ran'
    return 0
  fi

  atomic_state_write "$STATE_DIR/last-attempt-date" "$LOCAL_DATE"
  set +e
  "$ENTRYPOINT" janitor --no-input
  command_status=$?
  set -e
  if [[ "$command_status" -ne 0 ]]; then
    summary 'failed' "janitor-exit-$command_status"
    return "$command_status"
  fi

  atomic_state_write "$STATE_DIR/last-success-date" "$LOCAL_DATE"
  summary 'completed'
}

main "$@"
