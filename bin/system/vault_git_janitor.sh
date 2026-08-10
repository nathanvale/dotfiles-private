#!/usr/bin/env bash
# Run one admitted vault-git Janitor attempt per Melbourne local date.

set -euo pipefail

readonly REQUIRED_TIMEZONE='Australia/Melbourne'
readonly LOG_MAX_BYTES=262144
readonly LOG_KEEP=5
# A nightly run that outlives this bound is treated as hung: it holds the
# singleton lock, so leaving it alive blocks every later run indefinitely.
readonly JANITOR_RUN_TIMEOUT_SECONDS=1800
# A lock directory with no pid file is a run that has not written its pid yet.
# Past this age it is an orphan from a kill in that window, which would
# otherwise wedge the schedule permanently.
readonly ORPHAN_LOCK_RECLAIM_SECONDS=3600
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
    rm -f "$STATE_DIR/current-run-id" "$STATE_DIR/run.lock/pid"
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
  read -r owner mode < <(/usr/bin/stat -f '%u %Lp' "$path") || return 1
  # An empty mode would make the arithmetic below abort the whole run under
  # set -e instead of returning a status the caller turns into a refusal.
  [[ "$owner" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]+$ ]] || return 1
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
  read -r owner mode < <(/usr/bin/stat -f '%u %Lp' "$path") || return 1
  # An empty mode would make the arithmetic below abort the whole run under
  # set -e instead of returning a status the caller turns into a refusal.
  [[ "$owner" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]+$ ]] || return 1
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
    if ! read -r owner mode < <(/usr/bin/stat -f '%u %Lp' "$current_path") \
      || [[ ! "$owner" =~ ^[0-9]+$ || ! "$mode" =~ ^[0-7]+$ ]]; then
      refuse 'entrypoint-path-unsafe'
      return 1
    fi
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
  local profile_seen=false
  local hour_seen=false
  local minute_seen=false

  ENTRYPOINT=''
  MACHINE_PROFILE=''
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
      profile)
        "$profile_seen" && return 1
        MACHINE_PROFILE="$value"
        profile_seen=true
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

  "$entrypoint_seen" && "$profile_seen" && "$hour_seen" && "$minute_seen"
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

previous_local_date() {
  local date_value="$1"

  date -j -v-1d -f '%Y-%m-%d' "$date_value" +'%Y-%m-%d'
}

uptime_seconds() {
  local boot_epoch

  if is_test_mode && [[ -n "${VAULT_GIT_JANITOR_UPTIME_SECONDS:-}" ]]; then
    printf '%s\n' "$VAULT_GIT_JANITOR_UPTIME_SECONDS"
    return
  fi
  boot_epoch="$(/usr/sbin/sysctl -n kern.boottime 2>/dev/null | sed -E 's/.*sec = ([0-9]+).*/\1/')"
  # An unexpected sysctl format leaves a non-numeric value, and the arithmetic
  # below would abort the run under set -e with no summary line -- the plist
  # discards stderr, so that failure would surface nowhere. Report a long
  # uptime instead, which classifies the trigger as an ordinary calendar run.
  if [[ ! "$boot_epoch" =~ ^[0-9]+$ ]]; then
    printf '%d\n' 86400
    return
  fi
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
  local machine_profile_file
  local machine_profile
  local scheduled_time
  local previous_day
  local latest_ran
  local last_success=''
  local last_attempt=''
  local lock_pid=''
  local lock_mtime=''
  local lock_age_seconds=0
  local command_capture=''
  local command_output=''
  local command_pid=''
  local waited=0
  local timed_out=false
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

  if verify_private_directory "$LOG_DIR"; then
    LOG_FILE="$LOG_DIR/janitor.log"
  fi

  if [[ ! -d "$STATE_DIR" || -L "$STATE_DIR" ]]; then
    refuse 'state-dir-unsafe'
    return 1
  fi
  # Ownership and mode must hold BEFORE the lock exists. Creating run.lock and
  # writing this pid into a directory owned by another user would publish the
  # run pid and let that user pre-create the lock to force a permanent
  # singleton-noop.
  if ! verify_private_directory "$STATE_DIR" || ! verify_private_directory "$LOG_DIR"; then
    refuse 'private-directory-unsafe'
    return 1
  fi
  if ! mkdir "$STATE_DIR/run.lock" 2>/dev/null; then
    if [[ -f "$STATE_DIR/run.lock/pid" && ! -L "$STATE_DIR/run.lock/pid" ]]; then
      lock_pid="$(<"$STATE_DIR/run.lock/pid")"
    fi
    if [[ "$lock_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
      rm -f "$STATE_DIR/run.lock/pid"
      rmdir "$STATE_DIR/run.lock" 2>/dev/null || true
    elif [[ ! -e "$STATE_DIR/run.lock/pid" ]]; then
      # A pid-less lock is normally a run that has not written its pid yet, so
      # it must stay a singleton no-op. But SIGKILL or a power loss in that
      # window leaves it forever: no pid means the reclaim above can never
      # fire, every later run reports singleton-noop and exits 0, and launchd
      # records success while the janitor never runs again. Reclaim only once
      # the directory is far older than that write window.
      lock_age_seconds=0
      if lock_mtime="$(/usr/bin/stat -f '%m' "$STATE_DIR/run.lock" 2>/dev/null)" \
        && [[ "$lock_mtime" =~ ^[0-9]+$ ]]; then
        lock_age_seconds=$(($(date +%s) - lock_mtime))
      fi
      if ((lock_age_seconds > ORPHAN_LOCK_RECLAIM_SECONDS)); then
        rmdir "$STATE_DIR/run.lock" 2>/dev/null || true
      fi
    fi
    if ! mkdir "$STATE_DIR/run.lock" 2>/dev/null; then
      if [[ -f "$STATE_DIR/current-run-id" && ! -L "$STATE_DIR/current-run-id" ]]; then
        RUN_ID="$(<"$STATE_DIR/current-run-id")"
      fi
      summary 'singleton-noop'
      return 0
    fi
  fi
  LOCK_HELD=true
  trap cleanup EXIT INT TERM
  printf '%s\n' "$$" >"$STATE_DIR/run.lock/pid"
  chmod 600 "$STATE_DIR/run.lock/pid"
  RUN_ID="$(date +%s)-$$"
  atomic_state_write "$STATE_DIR/current-run-id" "$RUN_ID"

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

  # Re-verify the server profile on every run: the persisted install-time
  # profile must be server, and the machine must still pass the same server
  # check the installer used.
  if [[ "$MACHINE_PROFILE" != 'server' ]]; then
    refuse 'runtime-profile-not-server'
    return 1
  fi
  machine_profile_file="${DOTFILES_STATE_DIR:-$HOME/.dotfiles_state}/profile"
  machine_profile='desktop'
  if [[ -f "$machine_profile_file" ]]; then
    machine_profile="$(<"$machine_profile_file")"
  fi
  if [[ "$machine_profile" != 'server' ]]; then
    refuse 'server-profile-required'
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

  # Before today's configured window, today's run is not yet due: exit as a
  # structured no-op WITHOUT recording the date so the calendar fire still
  # runs. A missed previous day keeps catch-up eligible at any time.
  printf -v scheduled_time '%02d:%02d' "$((10#$SCHEDULE_HOUR))" "$((10#$SCHEDULE_MINUTE))"
  if [[ "$now_time" < "$scheduled_time" ]]; then
    previous_day="$(previous_local_date "$LOCAL_DATE" 2>/dev/null || true)"
    if [[ ! "$previous_day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
      refuse 'local-time-invalid'
      return 1
    fi
    latest_ran="$last_success"
    if [[ "$last_attempt" > "$latest_ran" ]]; then
      latest_ran="$last_attempt"
    fi
    if [[ -z "$latest_ran" || ! "$latest_ran" < "$previous_day" ]]; then
      summary 'pre-window-noop'
      return 0
    fi
  fi

  atomic_state_write "$STATE_DIR/last-trigger-kind" "$TRIGGER_KIND"
  atomic_state_write "$STATE_DIR/last-attempt-date" "$LOCAL_DATE"
  # Bound the run. --no-input stops credential prompts but not a network
  # stall, and the wrapper holds the singleton lock for the whole run: a hung
  # process stays alive, so the pid reclaim above never treats it as stale and
  # every later run is blocked. Capture output too -- the plist sends stderr to
  # /dev/null, so an unrecorded failure would surface nowhere.
  command_capture="$STATE_DIR/last-run-output"
  set +e
  "$ENTRYPOINT" janitor --no-input >"$command_capture" 2>&1 &
  command_pid=$!
  waited=0
  timed_out=false
  while kill -0 "$command_pid" 2>/dev/null; do
    if [[ "$waited" -ge "$JANITOR_RUN_TIMEOUT_SECONDS" ]]; then
      timed_out=true
      kill -TERM "$command_pid" 2>/dev/null
      sleep 5
      kill -KILL "$command_pid" 2>/dev/null
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$command_pid"
  command_status=$?
  set -e
  chmod 600 "$command_capture" 2>/dev/null || true
  command_output="$(<"$command_capture")"
  if [[ "$timed_out" == true ]]; then
    command_status=124
  fi
  if [[ -n "$command_output" && -n "$LOG_FILE" ]]; then
    printf '%s run_id=%s janitor output: %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUN_ID" "$command_output" >>"$LOG_FILE"
  fi
  if [[ "$command_status" -eq 124 ]]; then
    summary 'failed' 'janitor-timeout'
    return 1
  fi
  if [[ "$command_status" -ne 0 ]]; then
    summary 'failed' "janitor-exit-$command_status"
    return "$command_status"
  fi

  atomic_state_write "$STATE_DIR/last-success-date" "$LOCAL_DATE"
  summary 'completed'
}

main "$@"
