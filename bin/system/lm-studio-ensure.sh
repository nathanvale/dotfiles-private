#!/bin/zsh
# Recover the server-profile LM Studio stack without disturbing healthy state.

set -euo pipefail

profile="${DOTFILES_PROFILE:-desktop}"
if [[ -z "${DOTFILES_PROFILE:-}" && -r "$HOME/.dotfiles_state/profile" ]]; then
  profile="$(<"$HOME/.dotfiles_state/profile")"
fi

if [[ "$profile" != server ]]; then
  print -u2 'status=error cause=wrong-profile repair=run-with-DOTFILES_PROFILE-server'
  exit 2
fi

model="${LM_STUDIO_MODEL:-qwen3.8-27b}"
context_length="${LM_STUDIO_CONTEXT_LENGTH:-32768}"
parallel="${LM_STUDIO_PARALLEL:-4}"
port="${LM_STUDIO_PORT:-1234}"
command_timeout="${LM_STUDIO_COMMAND_TIMEOUT:-120}"
ready_attempts="${LM_STUDIO_READY_ATTEMPTS:-15}"
ready_delay="${LM_STUDIO_READY_DELAY:-1}"
http_timeout="${LM_STUDIO_HTTP_TIMEOUT:-2}"
lms_bin="${LM_STUDIO_LMS_BIN:-${commands[lms]:-$HOME/.lmstudio/bin/lms}}"
curl_bin="${LM_STUDIO_CURL_BIN:-/usr/bin/curl}"
jq_bin="${LM_STUDIO_JQ_BIN:-/opt/homebrew/bin/jq}"
sleep_bin="${LM_STUDIO_SLEEP_BIN:-/bin/sleep}"
pgrep_bin="${LM_STUDIO_PGREP_BIN:-/usr/bin/pgrep}"
lock_dir="${LM_STUDIO_LOCK_DIR:-$HOME/.local/state/lm-studio-ensure/lock}"
openai_url="http://127.0.0.1:${port}/v1/models"
native_url="http://127.0.0.1:${port}/api/v1/models"

for value in "$context_length" "$parallel" "$port" "$command_timeout" "$ready_attempts" "$http_timeout"; do
  if [[ "$value" != <-> || "$value" -lt 1 ]]; then
    print -u2 'status=error cause=invalid-numeric-configuration repair=use-positive-integers'
    exit 2
  fi
done
if [[ "$ready_delay" != <-> ]]; then
  print -u2 'status=error cause=invalid-ready-delay repair=use-a-nonnegative-integer'
  exit 2
fi

if [[ ! -x "$lms_bin" ]]; then
  print -u2 "status=error cause=lms-missing repair=install-lm-studio path=$lms_bin"
  exit 1
fi
if [[ ! -x "$curl_bin" ]]; then
  print -u2 "status=error cause=curl-missing repair=restore-system-curl path=$curl_bin"
  exit 1
fi
if [[ ! -x "$jq_bin" ]]; then
  print -u2 "status=error cause=jq-missing repair=apply-server-brewfile path=$jq_bin"
  exit 1
fi
if [[ -z "$lock_dir" || "$lock_dir" == / ]]; then
  print -u2 'status=error cause=unsafe-lock-path repair=use-an-owned-state-directory'
  exit 2
fi

lock_parent="${lock_dir:h}"
/bin/mkdir -p "$lock_parent"

release_lock() {
  local owner=''
  [[ -r "$lock_dir/pid" ]] && owner="$(<"$lock_dir/pid")"
  if [[ "$owner" == "$$" ]]; then
    /bin/rm -f "$lock_dir/pid"
    /bin/rmdir "$lock_dir" 2>/dev/null || true
  fi
}

acquire_lock() {
  local owner=''

  if /bin/mkdir "$lock_dir" 2>/dev/null; then
    print -r -- "$$" >"$lock_dir/pid"
    return 0
  fi

  [[ -r "$lock_dir/pid" ]] && owner="$(<"$lock_dir/pid")"
  if [[ "$owner" == <-> ]] && /bin/kill -0 "$owner" 2>/dev/null; then
    print -r -- "status=noop reason=already-running owner=$owner"
    return 1
  fi

  /bin/rm -f "$lock_dir/pid"
  /bin/rmdir "$lock_dir" 2>/dev/null || {
    print -u2 'status=error cause=lock-unavailable repair=inspect-owned-state-directory'
    exit 1
  }
  /bin/mkdir "$lock_dir"
  print -r -- "$$" >"$lock_dir/pid"
}

if ! acquire_lock; then
  exit 0
fi
trap release_lock EXIT HUP INT TERM

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  local started_at="$SECONDS"
  local command_pid=''

  "$@" &
  command_pid=$!
  while /bin/kill -0 "$command_pid" 2>/dev/null; do
    if (( SECONDS - started_at >= timeout_seconds )); then
      /bin/kill -TERM "$command_pid" 2>/dev/null || true
      "$sleep_bin" 1
      /bin/kill -KILL "$command_pid" 2>/dev/null || true
      wait "$command_pid" 2>/dev/null || true
      return 124
    fi
    "$sleep_bin" 1
  done
  wait "$command_pid"
}

http_get() {
  "$curl_bin" -fsS --connect-timeout "$http_timeout" --max-time "$http_timeout" "$1"
}

api_ready() {
  http_get "$openai_url" >/dev/null 2>&1 &&
    http_get "$native_url" >/dev/null 2>&1
}

daemon_ready() {
  local daemon_json=''
  daemon_json="$("$lms_bin" daemon status --json 2>/dev/null)" || return 1
  print -r -- "$daemon_json" | "$jq_bin" -e '.status == "running"' >/dev/null 2>&1
}

model_is_loaded() {
  print -r -- "$1" | "$jq_bin" -e \
    --arg model "$model" \
    '[.models[]? | select(.key == $model) | .loaded_instances[]? | select(.id == $model)] | length == 1' \
    >/dev/null 2>&1
}

model_is_exact() {
  print -r -- "$1" | "$jq_bin" -e \
    --arg model "$model" \
    --argjson minimum_context "$context_length" \
    --argjson expected_parallel "$parallel" \
    '[.models[]? | select(.key == $model) | .loaded_instances[]? | select(.id == $model)] as $instances |
      ($instances | length) == 1 and
      ($instances[0].config.context_length >= $minimum_context) and
      ($instances[0].config.parallel == $expected_parallel)' \
    >/dev/null 2>&1
}

wait_for_api() {
  local attempt=''
  for attempt in {1..$ready_attempts}; do
    api_ready && return 0
    "$sleep_bin" "$ready_delay"
  done
  return 1
}

wait_for_model() {
  local attempt='' native_json=''
  for attempt in {1..$ready_attempts}; do
    native_json="$(http_get "$native_url" 2>/dev/null)" || native_json=''
    if [[ -n "$native_json" ]] && model_is_exact "$native_json"; then
      return 0
    fi
    "$sleep_bin" "$ready_delay"
  done
  return 1
}

actions=()

if ! api_ready; then
  if ! daemon_ready; then
    if "$pgrep_bin" -q -f '/Applications/LM Studio.app/Contents/MacOS/LM Studio --run-as-service'; then
      print -u2 'status=error cause=core-process-unready repair=inspect-existing-lm-studio-process'
      exit 5
    fi
    daemon_status=0
    run_with_timeout "$command_timeout" "$lms_bin" daemon up --json || daemon_status=$?
    if (( daemon_status == 124 )); then
      print -u2 'status=error cause=daemon-start-timeout repair=inspect-lm-studio-daemon'
      exit 4
    elif (( daemon_status != 0 )); then
      print -u2 'status=error cause=daemon-start-failed repair=inspect-lm-studio-daemon'
      exit 1
    fi
    actions+=(daemon)
  fi

  server_status=0
  run_with_timeout "$command_timeout" "$lms_bin" server start --port "$port" --bind 127.0.0.1 || server_status=$?
  if (( server_status == 124 )); then
    print -u2 'status=error cause=server-start-timeout repair=inspect-lm-studio-server'
    exit 4
  elif (( server_status != 0 )); then
    print -u2 'status=error cause=server-start-failed repair=inspect-lm-studio-server'
    exit 1
  fi
  actions+=(server)

  if ! wait_for_api; then
    print -u2 "status=error cause=api-not-ready repair=inspect-loopback-server port=$port"
    exit 1
  fi
fi

native_json="$(http_get "$native_url")" || {
  print -u2 'status=error cause=native-inventory-unavailable repair=inspect-loopback-server'
  exit 1
}

if model_is_exact "$native_json"; then
  if (( ${#actions[@]} == 0 )); then
    print -r -- "status=noop reason=healthy model=$model"
  else
    print -r -- "status=repaired actions=${(j:,:)actions} model=$model"
  fi
  exit 0
fi

if model_is_loaded "$native_json"; then
  print -u2 "status=error cause=model-config-drift repair=reload-manually-after-review model=$model"
  exit 3
fi

load_status=0
run_with_timeout "$command_timeout" "$lms_bin" load "$model" \
  --identifier "$model" \
  --context-length "$context_length" \
  --parallel "$parallel" \
  --no-speculative-draft-mtp \
  --yes || load_status=$?
if (( load_status == 124 )); then
  print -u2 "status=error cause=model-load-timeout repair=inspect-model-loader model=$model"
  exit 4
elif (( load_status != 0 )); then
  print -u2 "status=error cause=model-load-failed repair=inspect-model-loader model=$model"
  exit 1
fi
actions+=(model)

if ! wait_for_model; then
  print -u2 "status=error cause=model-not-ready repair=inspect-native-model-inventory model=$model"
  exit 1
fi

print -r -- "status=repaired actions=${(j:,:)actions} model=$model"
