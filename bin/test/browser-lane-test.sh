#!/usr/bin/env bash
# Public process contract for bin/browser-lane.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
REAL_CLI="$REPO_ROOT/bin/browser-lane"
TEST_ROOT="$(mktemp -d)"
TEST_ROOT="$(realpath "$TEST_ROOT")"
trap 'rm -rf "$TEST_ROOT"' EXIT

# Independent oracle: the pinned row count. Adding or removing a row is a
# reviewable edit to this literal, never a drift the run absorbs silently.
# The established lane contract remains covered, including attended-login
# handoff, pre-admission reservation, and profile opening for identity,
# dispatch, isolation, reservation ownership, uncertain outcomes, and recovery.
readonly EXPECTED_ASSERTIONS=2000
readonly EXPECTED_PLAYWRIGHT_HARDENING_ASSERTIONS=128
readonly EXPECTED_INSPECT_ASSERTIONS=226
readonly EXPECTED_LEASE_ASSERTIONS=46
readonly EXPECTED_OPEN_ASSERTIONS=167
test_selection="${1:-all}"
[[ "$#" -le 1 && ( "$test_selection" == '--handoff-only' || "$test_selection" == '--handoff-security-only' || "$test_selection" == 'all' || "$test_selection" == '--open-only' || "$test_selection" == '--inspect-only' || "$test_selection" == '--lease-only' || "$test_selection" == '--adapter-hardening-only' ) ]] || {
  printf 'Usage: %s [--handoff-security-only|--handoff-only|--open-only|--inspect-only|--lease-only|--adapter-hardening-only]\n' "$0" >&2
  exit 2
}

assertion_count=0

pass() {
  assertion_count=$((assertion_count + 1))
  printf 'ok %d - %s\n' "$assertion_count" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_equals() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] || fail "$label (expected [$expected], got [$actual])"
  pass "$label"
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label (missing [$needle])"
  pass "$label"
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" != *"$needle"* ]] || fail "$label (found [$needle])"
  pass "$label"
}

assert_matches() {
  local actual="$1" pattern="$2" label="$3"
  [[ "$actual" =~ $pattern ]] || fail "$label (pattern [$pattern] did not match [$actual])"
  pass "$label"
}

assert_absent() {
  local path="$1" label="$2"
  [[ ! -e "$path" && ! -L "$path" ]] || fail "$label (exists [$path])"
  pass "$label"
}

assert_present() {
  local path="$1" label="$2"
  [[ -e "$path" ]] || fail "$label (missing [$path])"
  pass "$label"
}

mode_of() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

entry_count() {
  find "$1" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' '
}

sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

[[ -x "$REAL_CLI" ]] || fail 'browser-lane executable is missing'
pass 'browser-lane executable exists'

fixture_repo="$TEST_ROOT/repo"
fixture_state="$TEST_ROOT/state"
fixture_home="$TEST_ROOT/home"
export XDG_CONFIG_HOME="$TEST_ROOT/config"
fixture_bin="$TEST_ROOT/bin"
chrome_root="$TEST_ROOT/chrome"
profile_dir="$chrome_root/Profile 13"
download_dir="$TEST_ROOT/drive/daily"
registry_path="$fixture_state/browser-lanes/registry.json"
lease_dir="$fixture_state/browser-lanes/leases/daily-driver.lock"
recovery_root_dir="$fixture_state/browser-lanes/recovery"
recovery_lane_dir="$recovery_root_dir/daily-driver"
handoff_root_dir="$fixture_state/browser-lanes/handoffs"
handoff_dir="$handoff_root_dir/daily-driver.handoff"
handoff_record="$handoff_dir/handoff.json"
page_one='https://fixture.invalid/PAGE-URL-SENTINEL-ONE'
page_two='https://fixture.invalid/PAGE-URL-SENTINEL-TWO'
different_site_page='https://different.invalid/PAGE-URL-SENTINEL-TWO'
mkdir -p "$fixture_repo/bin" "$fixture_state/browser-lanes" "$fixture_home" "$fixture_bin" "$profile_dir" "$download_dir"
cp "$REAL_CLI" "$fixture_repo/bin/browser-lane"
chmod +x "$fixture_repo/bin/browser-lane"
# The Puppeteer helper is copied beside the executable so the copied tree
# resolves it the same way the installed symlink does. Its `puppeteer` import
# resolves upward from the copy to the test-owned fake module below, never to
# the repository's real package.
mkdir -p "$fixture_repo/bin/lib"
cp "$REPO_ROOT/bin/lib/browser-lane-puppeteer.js" "$fixture_repo/bin/lib/browser-lane-puppeteer.js"
cp "$REPO_ROOT/bin/lib/browser-lane-playwright.js" "$fixture_repo/bin/lib/browser-lane-playwright.js"
cp "$REPO_ROOT/bin/lib/browser-lane-site.js" "$fixture_repo/bin/lib/browser-lane-site.js"
mkdir -p "$fixture_repo/node_modules"
ln -s "$REPO_ROOT/node_modules/tldts" "$fixture_repo/node_modules/tldts"
cp "$REPO_ROOT/bin/lib/browser-lane-handoff.py" "$fixture_repo/bin/lib/browser-lane-handoff.py"
cp "$REPO_ROOT/bin/lib/browser-lane-open.py" "$fixture_repo/bin/lib/browser-lane-open.py"
cp "$REPO_ROOT/bin/lib/browser-lane-open.js" "$fixture_repo/bin/lib/browser-lane-open.js"
real_node="$(command -v node 2>/dev/null || true)"
[[ -n "$real_node" ]] || fail 'a real node executable is required to run the Puppeteer helper'
pass 'a real node executable is available for the Puppeteer helper'

site_vector_input="$TEST_ROOT/site-vectors.in"
site_vector_output="$TEST_ROOT/site-vectors.out"
declare -a site_vector_labels=() site_vector_expected=()
: >"$site_vector_input"
while IFS='|' read -r vector_label vector_url expected_site; do
  site_vector_labels+=("$vector_label")
  if [[ -n "$expected_site" ]]; then
    site_vector_expected+=("$(printf '%s' "$expected_site" | shasum -a 256 | awk '{print $1}')")
  else
    site_vector_expected+=('')
  fi
  printf '%s\0' "$vector_url" >>"$site_vector_input"
done <<'SITE_VECTORS'
example-com|https://example.com/path|https://example.com
example-subdomain|https://a.b.example.com/path|https://example.com
com-au|https://x.example.com.au/path|https://example.com.au
co-uk|https://y.example.co.uk/path|https://example.co.uk
github-user-a|https://user-a.github.io/path|https://user-a.github.io
github-user-b|https://user-b.github.io/path|https://user-b.github.io
azure-app-1|https://app1.azurewebsites.net/path|https://app1.azurewebsites.net
azure-app-2|https://app2.azurewebsites.net/path|https://app2.azurewebsites.net
localhost|https://localhost:8443/path|https://localhost
ipv4|https://127.0.0.1:8443/path|https://127.0.0.1
ipv6|https://[::1]:8443/path|https://[::1]
http-scheme|http://example.com/path|http://example.com
https-scheme|https://example.com/path|https://example.com
credentials|https://user:password@example.com/path|
unparsable|not a URL|
SITE_VECTORS
"$real_node" "$fixture_repo/bin/lib/browser-lane-site.js" \
  <"$site_vector_input" >"$site_vector_output"
site_vector_index=0
while IFS= read -r -d '' actual_hash; do
  assert_equals "$actual_hash" "${site_vector_expected[$site_vector_index]}" \
    "${site_vector_labels[$site_vector_index]} module site vector"
  site_vector_index=$((site_vector_index + 1))
done <"$site_vector_output"
assert_equals "$site_vector_index" "${#site_vector_labels[@]}" 'module site vector count preserves input order'

# Every sentinel below is a fake, obviously non-secret marker. The recovery rows
# prove each one is absent from the snapshot; none is ever a real value.
cat >"$chrome_root/Local State" <<'JSON'
{"profile":{"info_cache":{"Profile 13":{"name":"Daily"}}}}
JSON
cat >"$profile_dir/Preferences" <<JSON
{"credentials_enable_service":false,"autofill":{"profile_enabled":false,"credit_card_enabled":false},"download":{"default_directory":"$download_dir"},"sync":{"selected_types_per_account":{"account":{"sync.autofill":false,"sync.extensions":false,"sync.passwords":false,"sync.payments":false}}},"account_info":[{"email":"fixture-account@example.invalid"}],"google":{"services":{"signin_scoped_device_id":"FIXTURE-DEVICE-SENTINEL"}}}
JSON
cat >"$profile_dir/Secure Preferences" <<'JSON'
{"extensions":{"settings":{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"location":1},"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":{"location":4},"dddddddddddddddddddddddddddddddd":{"location":1,"was_installed_by_default":true}}},"protection":{"macs":{"extensions":"FIXTURE-MAC-SENTINEL"}}}
JSON
printf 'FIXTURE-COOKIE-SENTINEL\n' >"$profile_dir/Cookies"
printf 'FIXTURE-LOGIN-SENTINEL\n' >"$profile_dir/Login Data"
printf 'FIXTURE-WEBDATA-SENTINEL\n' >"$profile_dir/Web Data"
auth_sentinels=(
  'fixture-account@example.invalid'
  'FIXTURE-DEVICE-SENTINEL'
  'FIXTURE-MAC-SENTINEL'
  'FIXTURE-COOKIE-SENTINEL'
  'FIXTURE-LOGIN-SENTINEL'
  'FIXTURE-WEBDATA-SENTINEL'
)
cat >"$registry_path" <<JSON
{
  "schema_version": 1,
  "chrome_user_data_dir": "$chrome_root",
  "extension_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "lanes": {
    "daily-driver": {
      "provisioned": true,
      "profile_directory": "Profile 13",
      "profile_display_name": "Daily",
      "account_role": "owner",
      "relay_port": 18799,
      "expected_access_mode": "selected",
      "download_directory": "$download_dir",
      "required_extensions": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      "allowed_extensions": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      "chrome_autofill_expectations": {
        "credentials_enable_service": false,
        "autofill_profile_enabled": false,
        "autofill_credit_card_enabled": false
      },
      "sync_expectations": {
        "account_shape": "exactly-one",
        "selected_types": {
          "sync.autofill": false,
          "sync.extensions": false,
          "sync.passwords": false,
          "sync.payments": false
        }
      }
    },
    "specialist": {
      "provisioned": false,
      "profile_directory": null,
      "profile_display_name": "Specialist",
      "account_role": "specialist",
      "relay_port": 18798,
      "expected_access_mode": "selected"
    }
  }
}
JSON
chmod 600 "$registry_path"

cat >"$fixture_bin/openclaw" <<JSON
#!/usr/bin/env bash
if [[ -n "\${FAKE_OPENCLAW_CALLLOG:-}" ]]; then
  printf '%s\n' "\$*" >>"\$FAKE_OPENCLAW_CALLLOG"
fi
if [[ "\${FAKE_OPENCLAW_FAIL:-0}" == '1' ]]; then
  exit 1
fi
profile="\${FAKE_OPENCLAW_PROFILE:-Profile 13}"
cat <<STATUS
{"manualSetupRequired":false,"issues":[],"discovered":[{"userDataDir":"$chrome_root","profile":"\$profile","extensionId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}
STATUS
JSON
chmod +x "$fixture_bin/openclaw"

cat >"$fixture_bin/browser-lane-open" <<'SH'
#!/usr/bin/env bash
[[ -z "${FAKE_BROWSER_OPEN_ARGV:-}" ]] || printf '%s\n' "$@" >"$FAKE_BROWSER_OPEN_ARGV"
if [[ -n "${FAKE_BROWSER_OPEN_REQUIRE_FILE:-}" && ! -f "$FAKE_BROWSER_OPEN_REQUIRE_FILE" ]]; then
  exit 65
fi
if [[ -n "${FAKE_BROWSER_OPEN_STARTED_FILE:-}" ]]; then
  : >"$FAKE_BROWSER_OPEN_STARTED_FILE"
fi
if [[ -n "${FAKE_BROWSER_OPEN_HOLD_SECONDS:-}" ]]; then
  /bin/sleep "$FAKE_BROWSER_OPEN_HOLD_SECONDS"
fi
# Independent oracle: macOS `open -h` assigns `-n` the new-instance behavior
# needed to deliver argv when the application already has a running instance.
if [[ "${FAKE_CHROME_ALREADY_RUNNING:-0}" == '1' ]]; then
  found_new_instance='false'
  for arg in "$@"; do
    [[ "$arg" != '-n' ]] || found_new_instance='true'
  done
  [[ "$found_new_instance" == 'true' ]] || exit 64
fi
exit "${FAKE_BROWSER_OPEN_EXIT:-0}"
SH
chmod +x "$fixture_bin/browser-lane-open"

# Native host double. The real bounded Python runner consumes this protocol;
# these rows prove the public CLI decision, not macOS accessibility behavior.
cat >"$fixture_bin/osascript" <<'SH'
#!/usr/bin/env bash
[[ -z "${FAKE_NATIVE_OPEN_ARGV:-}" ]] || printf '%s\n' "$@" >"$FAKE_NATIVE_OPEN_ARGV"
if [[ -n "${FAKE_NATIVE_MODEL:-}" ]]; then
  exec "$FAKE_NATIVE_NODE" "$FAKE_NATIVE_MODEL_RUNNER" "$3" "$4" "$5"
fi
if [[ -n "${FAKE_NATIVE_OPEN_REQUIRE_FILE:-}" && ! -f "$FAKE_NATIVE_OPEN_REQUIRE_FILE" ]]; then
  exit 65
fi
if [[ -n "${FAKE_NATIVE_OPEN_STARTED_FILE:-}" ]]; then
  : >"$FAKE_NATIVE_OPEN_STARTED_FILE"
  /bin/sleep "${FAKE_NATIVE_OPEN_HOLD_SECONDS:-1}"
fi
if [[ "${FAKE_NATIVE_OPEN_STATE:-absent}" == 'interrupted' ]]; then
  printf '%s\n' "$$" >"$FAKE_NATIVE_PID_FILE"
  /bin/sleep 10 &
  native_sleep_pid=$!
  printf '%s\n' "$native_sleep_pid" >"$FAKE_NATIVE_SLEEP_PID_FILE"
  kill -TERM "$PPID"
  wait "$native_sleep_pid"
  exit 1
fi
if [[ "${FAKE_NATIVE_OPEN_STATE:-absent}" == 'malformed' ]]; then
  printf 'PRIVATE-NATIVE-ERROR-SENTINEL\n'
  exit 1
fi
printf '{"state":"%s","reason":"%s"}\n' "${FAKE_NATIVE_OPEN_STATE:-absent}" "${FAKE_NATIVE_OPEN_REASON:-exact_tab_absent}"
exit "${FAKE_NATIVE_OPEN_EXIT:-0}"
SH
chmod +x "$fixture_bin/osascript"
export BROWSER_LANE_OSASCRIPT_BIN="$fixture_bin/osascript"
cp "$REPO_ROOT/bin/test/browser-lane-native-host.cjs" "$fixture_bin/native-host.cjs"
export FAKE_NATIVE_MODEL_RUNNER="$fixture_bin/native-host.cjs"
export FAKE_NATIVE_NODE="$real_node"

cat >"$fixture_bin/mv" <<'SH'
#!/usr/bin/env bash
target="${!#}"
if [[ -n "${FAKE_MV_FAIL_MATCH:-}" && "$target" == *"$FAKE_MV_FAIL_MATCH"* ]]; then exit 77; fi
if [[ -n "${FAKE_MV_SIGNAL_BEFORE_MATCH:-}" && "$target" == *"$FAKE_MV_SIGNAL_BEFORE_MATCH"* ]]; then
  kill -TERM "$PPID"
  exit 130
fi
/bin/mv "$@"
target="${!#}"
if [[ -n "${FAKE_MV_SIGNAL_AFTER_MATCH:-}" && "$target" == *"$FAKE_MV_SIGNAL_AFTER_MATCH"* ]]; then
  kill -TERM "$PPID"
fi
SH
chmod +x "$fixture_bin/mv"

cat >"$fixture_bin/lsof" <<'SH'
#!/usr/bin/env bash
port=''
for arg in "$@"; do
  case "$arg" in
    -iTCP:*) port="${arg#-iTCP:}" ;;
  esac
done
[[ "$port" =~ ^[0-9]+$ ]] || exit 2
printf 'p12345\n'
printf 'c%s\n' "${FAKE_LSOF_COMMAND:-node}"
printf 'u%s\n' "$(id -u)"
printf 'f12\n'
printf 'n%s:%s\n' "${FAKE_LSOF_ADDRESS:-127.0.0.1}" "$port"
SH
chmod +x "$fixture_bin/lsof"

# The activity-cleanup row opts in to PID receipts from this test-owned wrapper.
# It delegates to the host sleep binary, so production code still exercises its
# normal child-management path rather than a simulated timer.
cat >"$fixture_bin/sleep" <<'SH'
#!/usr/bin/env bash
if [[ -n "${FAKE_SLEEP_PID_LOG:-}" ]]; then
  printf '%s\n' "$$" >>"$FAKE_SLEEP_PID_LOG"
fi
exec /bin/sleep "$@"
SH
chmod +x "$fixture_bin/sleep"

cat >"$fixture_bin/mcporter" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == 'chrome-relay' && "${2:-}" == '--help' ]]; then
  # Older MCPorter dispatches --help before validating a subcommand. Its
  # generic successful help therefore cannot establish status support unless
  # status is actually advertised here.
  printf '%s\n' 'Usage: mcporter chrome-relay exec [--relay-url <url>] [--timeout <ms>] -- <command> [args...]'
  [[ "${FAKE_MCPORTER_EXEC_ONLY_HELP:-0}" == '1' ]] ||
    printf '%s\n' '       mcporter chrome-relay status [--relay-url <url>] [--timeout <ms>]'
  [[ "${FAKE_MCPORTER_ACTIVITY_UNSUPPORTED:-0}" == '1' ]] ||
    printf '%s\n' '       mcporter chrome-relay activity <start|heartbeat|clear> [--relay-url <url>]'
  exit 0
fi
if [[ "${1:-}" == 'chrome-relay' && "${2:-}" == 'status' ]]; then
  [[ -n "${FAKE_MCPORTER_STATUS_ARGV:-}" ]] && printf '%s\n' "$@" >"$FAKE_MCPORTER_STATUS_ARGV"
  [[ "${FAKE_MCPORTER_INSTALLED_STATUS_UNSUPPORTED:-0}" == '1' && "${FAKE_MCPORTER_SOURCE_VERSION:-0}" != '1' ]] && exit 90
  case "${FAKE_MCPORTER_STATUS:-selected}" in
    selected) printf '%s\n' '{"schemaVersion":1,"runId":"fixture-status","command":"chrome-relay status","ok":true,"accessStatus":{"version":1,"mode":"selected","enabled":true,"transitioning":false},"error":null}' ;;
    all) printf '%s\n' '{"schemaVersion":1,"runId":"fixture-status","command":"chrome-relay status","ok":true,"accessStatus":{"version":1,"mode":"all","enabled":true,"transitioning":false},"error":null}' ;;
    disabled) printf '%s\n' '{"schemaVersion":1,"runId":"fixture-status","command":"chrome-relay status","ok":true,"accessStatus":{"version":1,"mode":"selected","enabled":false,"transitioning":false},"error":null}' ;;
    transitioning) printf '%s\n' '{"schemaVersion":1,"runId":"fixture-status","command":"chrome-relay status","ok":true,"accessStatus":{"version":1,"mode":"selected","enabled":true,"transitioning":true},"error":null}' ;;
    malformed) printf '%s\n' '{"schemaVersion":1,"runId":"fixture-status","command":"chrome-relay status","ok":true,"accessStatus":{"mode":"selected"},"error":null}' ;;
    empty) : ;;
    legacy) printf '%s\n' '{"mode":"selected","enabled":true,"transitioning":false}' ;;
    unknown-version) printf '%s\n' '{"schemaVersion":2,"runId":"fixture-status","command":"chrome-relay status","ok":true,"accessStatus":{"version":1,"mode":"selected","enabled":true,"transitioning":false},"error":null}' ;;
    unknown-status-version) printf '%s\n' '{"schemaVersion":1,"runId":"fixture-status","command":"chrome-relay status","ok":true,"accessStatus":{"version":2,"mode":"selected","enabled":true,"transitioning":false},"error":null}' ;;
    extra-fields) printf '%s\n' '{"schemaVersion":1,"runId":"fixture-status","command":"chrome-relay status","ok":true,"accessStatus":{"version":1,"mode":"selected","enabled":true,"transitioning":false},"error":null,"extra":true}' ;;
    extra-access-fields) printf '%s\n' '{"schemaVersion":1,"runId":"fixture-status","command":"chrome-relay status","ok":true,"accessStatus":{"version":1,"mode":"selected","enabled":true,"transitioning":false,"extra":true},"error":null}' ;;
    multiple) printf '%s\n%s\n' '{"schemaVersion":1,"runId":"fixture-status-one","command":"chrome-relay status","ok":true,"accessStatus":{"version":1,"mode":"selected","enabled":true,"transitioning":false},"error":null}' '{"schemaVersion":1,"runId":"fixture-status-two","command":"chrome-relay status","ok":true,"accessStatus":{"version":1,"mode":"selected","enabled":true,"transitioning":false},"error":null}' ;;
    redacted) printf '%s\n' 'STATUS-SECRET-SENTINEL' ;;
  esac
  exit "${FAKE_MCPORTER_STATUS_EXIT:-0}"
fi
if [[ "${1:-}" == 'chrome-relay' && "${2:-}" == 'activity' ]]; then
  activity_adapter='' activity_run_id='' activity_action='' activity_cleanup='' activity_exit='' activity_profile='' activity_scenario=''
  for ((activity_index=1; activity_index<=$#; activity_index++)); do
    activity_next=$((activity_index + 1))
    case "${!activity_index}" in
      --adapter) activity_adapter="${!activity_next}" ;;
      --run-id) activity_run_id="${!activity_next}" ;;
      --action-outcome) activity_action="${!activity_next}" ;;
      --cleanup-outcome) activity_cleanup="${!activity_next}" ;;
      --exit-code) activity_exit="${!activity_next}" ;;
      --profile-label) activity_profile="${!activity_next}" ;;
      --scenario) activity_scenario="${!activity_next}" ;;
    esac
  done
  [[ -n "${FAKE_MCPORTER_ACTIVITY_LOG:-}" ]] && printf '%s%s\n' "$3" "${activity_adapter:+:$activity_adapter}" >>"$FAKE_MCPORTER_ACTIVITY_LOG"
  if [[ -n "${FAKE_MCPORTER_ACTIVITY_FACTS:-}" ]]; then
    jq -cn --arg kind "$3" --arg action "$activity_action" --arg cleanup "$activity_cleanup" --arg code "$activity_exit" --arg profile "$activity_profile" --arg scenario "$activity_scenario" \
      '{kind:$kind,action:$action,cleanup:$cleanup,code:$code,profile:$profile,scenario:$scenario}' >>"$FAKE_MCPORTER_ACTIVITY_FACTS"
  fi
  [[ -n "${FAKE_MCPORTER_ACTIVITY_ARGV:-}" ]] && printf '%s\n' "$@" >>"$FAKE_MCPORTER_ACTIVITY_ARGV"
  if [[ "${FAKE_MCPORTER_ACTIVITY_STRICT:-0}" == '1' ]]; then
    [[ "$activity_run_id" =~ ^[A-Za-z0-9._-]{1,120}$ ]] || exit 91
    if [[ "$3" == 'start' ]]; then
      printf '%s\n' "$activity_run_id" >"$FAKE_MCPORTER_ACTIVITY_OWNER"
    elif [[ "$activity_run_id" != "$(<"$FAKE_MCPORTER_ACTIVITY_OWNER")" ]]; then
      exit 92
    fi
  fi
  [[ "${FAKE_MCPORTER_INSTALLED_ACTIVITY_UNSUPPORTED:-0}" == '1' && "${FAKE_MCPORTER_SOURCE_VERSION:-0}" != '1' ]] && exit 90
  [[ "$3" != 'heartbeat' || "${FAKE_MCPORTER_HEARTBEAT_STATUS:-0}" == '0' ]] || exit "$FAKE_MCPORTER_HEARTBEAT_STATUS"
  printf '%s\n' '{"schemaVersion":1,"command":"chrome-relay activity","ok":true,"activity":{"state":"active","adapter":"agent-browser"},"error":null}'
  exit "${FAKE_MCPORTER_ACTIVITY_STATUS:-0}"
fi
if [[ "${1:-}" == 'chrome-relay' && "${2:-}" == 'exec' ]]; then
  last_arg="${!#}"
  if [[ "$last_arg" == '--help' ]]; then
    [[ "${FAKE_MCPORTER_NO_CHROME_RELAY_HELP:-0}" == '1' ]] && exit 1
    exit 0
  fi
  joined=" $* "
  if [[ "$joined" == *' tab list --json '* ]]; then
    [[ -n "${FAKE_MCPORTER_CLEANUP_LOG:-}" ]] && printf 'list\n' >>"$FAKE_MCPORTER_CLEANUP_LOG"
    case "${FAKE_MCPORTER_CLEANUP_TABS:-blank}" in
      none)
        jq -cn --arg url "${FAKE_MCPORTER_CLEANUP_PAGE_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" '{success:true,data:{tabs:[{active:true,tabId:"t1",targetId:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",title:"fixture",type:"page",url:$url}]},error:null}' ;;
      ambiguous)
        jq -cn --arg url "${FAKE_MCPORTER_CLEANUP_PAGE_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" '{success:true,data:{tabs:[{active:true,tabId:"t1",targetId:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",title:"fixture",type:"page",url:$url},{active:false,tabId:"t2",targetId:"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",title:"about:blank",type:"page",url:"about:blank"},{active:false,tabId:"t3",targetId:"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",title:"about:blank",type:"page",url:"about:blank"}]},error:null}' ;;
      *)
        jq -cn --arg url "${FAKE_MCPORTER_CLEANUP_PAGE_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" '{success:true,data:{tabs:[{active:true,tabId:"t1",targetId:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",title:"fixture",type:"page",url:$url},{active:false,tabId:"t2",targetId:"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",title:"about:blank",type:"page",url:"about:blank"}]},error:null}' ;;
    esac
    exit 0
  fi
  if [[ "$joined" == *' tab close '* && "$joined" == *' --json '* ]]; then
    [[ -n "${FAKE_MCPORTER_CLEANUP_LOG:-}" ]] && printf 'close\n' >>"$FAKE_MCPORTER_CLEANUP_LOG"
    target="${@: -2:1}"
    jq -cn --arg target "$target" '{success:true,data:{closed:true,targetId:$target},error:null}'
    exit 0
  fi
  if [[ -n "${FAKE_MCPORTER_AGENT_ARGV:-}" ]]; then
    printf '%s\n' "$@" >"$FAKE_MCPORTER_AGENT_ARGV"
  fi
  # The staged Agent Browser route supplies one private runner to one relay
  # handoff. Execute it here so the public process test observes its real
  # attach, pin, URL-proof, work, and retirement ordering.
  if [[ "${6:-}" == */agent-cleanup.*/run ]]; then
    shift 5
    "$@"
    runner_status=$?
    stage_log="${FAKE_AGENT_BROWSER_STAGE_LOG:-${FAKE_MCPORTER_CLEANUP_LOG:-}}"
    [[ -n "$stage_log" ]] && printf 'handoff-exit\n' >>"$stage_log"
    exit "$runner_status"
  fi
  [[ "$last_arg" == '/usr/bin/true' ]] && exit 0
  if [[ "${FAKE_MCPORTER_EXEC_CHILD:-0}" == '1' ]]; then
    while [[ "$#" -gt 0 && "$1" != '--' ]]; do shift; done
    [[ "${1:-}" == '--' ]] || exit 91
    shift
    # Mirrors the real broker's custody: the child runs as a job, HUP, INT,
    # and TERM are forwarded to it, and the child's own status is returned.
    AGENT_BROWSER_CDP="${FAKE_MCPORTER_EXEC_ENDPOINT:-http://127.0.0.1:49152/ONE-USE-ENDPOINT-SENTINEL}" "$@" &
    exec_child=$!
    trap 'kill -TERM "$exec_child" 2>/dev/null' HUP INT TERM
    while :; do
      if wait "$exec_child"; then exec_status=0; else exec_status=$?; fi
      [[ "$exec_status" -gt 128 ]] && kill -0 "$exec_child" 2>/dev/null && continue
      break
    done
    exit "$exec_status"
  fi
  exit "${FAKE_MCPORTER_AGENT_STATUS:-0}"
fi
if [[ "${1:-}" != 'call' || "${2:-}" != chrome-devtools.* ]]; then
  exit 90
fi
tool_name="$2"
[[ "${FAKE_MCPORTER_CALL_STATUS:-0}" == '0' ]] || exit "$FAKE_MCPORTER_CALL_STATUS"
if [[ -n "${FAKE_MCPORTER_CALLLOG:-}" ]]; then
  printf '%s\n' "$tool_name" >>"$FAKE_MCPORTER_CALLLOG"
fi
# Independent oracle for the real child command line: one received argument per
# line, so a row can assert on exact argument identity and order rather than on
# a re-quoted string.
if [[ -n "${FAKE_MCPORTER_ARGV:-}" ]]; then
  printf '%s\n' "$@" >"$FAKE_MCPORTER_ARGV"
fi
if [[ "$tool_name" == 'chrome-devtools.list_pages' && -n "${FAKE_MCPORTER_PAGE_LIST_PID_FILE:-}" ]]; then
  printf '%s\n' "$$" >"$FAKE_MCPORTER_PAGE_LIST_PID_FILE"
fi
if [[ "$tool_name" == 'chrome-devtools.list_pages' && -n "${FAKE_MCPORTER_PAGE_LIST_DESCENDANT_PID_FILE:-}" ]]; then
  (
    printf '%s\n' "${BASHPID:-$$}" >"$FAKE_MCPORTER_PAGE_LIST_DESCENDANT_PID_FILE"
    trap '
      if [[ -n "${FAKE_MCPORTER_PAGE_LIST_DESCENDANT_STATE_FILE:-}" ]]; then
        if [[ -d "${FAKE_MCPORTER_PAGE_LIST_LEASE_DIR:-/nonexistent}" ]]; then
          printf "lease=present\n" >"$FAKE_MCPORTER_PAGE_LIST_DESCENDANT_STATE_FILE"
        else
          printf "lease=absent\n" >"$FAKE_MCPORTER_PAGE_LIST_DESCENDANT_STATE_FILE"
        fi
      fi
      exit 0
    ' HUP INT TERM
    while :; do
      sleep 10 &
      wait "$!" || true
    done
  ) &
fi
if [[ "$tool_name" != 'chrome-devtools.list_pages' && "${FAKE_MCPORTER_CHILD_CALL_STATUS:-0}" != '0' ]]; then
  exit "$FAKE_MCPORTER_CHILD_CALL_STATUS"
fi
hold_seconds="${FAKE_MCPORTER_HOLD_SECONDS:-0}"
if [[ "$tool_name" != 'chrome-devtools.list_pages' && -n "${FAKE_MCPORTER_CHILD_HOLD_SECONDS:-}" ]]; then
  hold_seconds="$FAKE_MCPORTER_CHILD_HOLD_SECONDS"
fi
if [[ "$hold_seconds" != '0' ]]; then
  sleep "$hold_seconds"
fi
if [[ -n "${FAKE_MCPORTER_RECEIPT:-}" ]]; then
  {
    printf 'policy=%s\n' "${MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY:-}"
    printf 'url=%s\n' "${MCPORTER_CHROME_DEVTOOLS_RELAY_URL:-}"
    printf 'keepalive=%s\n' "${MCPORTER_NO_KEEPALIVE:-}"
    printf 'lane=%s\n' "${BROWSER_LANE_NAME:-}"
    printf 'run_id=%s\n' "${BROWSER_LANE_RUN_ID:-}"
    printf 'page_id=%s\n' "${BROWSER_LANE_PAGE_ID:-}"
  } >"$FAKE_MCPORTER_RECEIPT"
fi
# Real chrome-devtools-mcp list_pages contract, observed live through mcporter
# on the paired relay: the MCP content envelope carries a Markdown page list as
# text, not a structured `pages` array.
#   {"content":[{"type":"text","text":"## Pages\n1: Title (URL) [selected]"}]}
# FAKE_MCPORTER_PAGE_TEXT supplies that text verbatim so a row can shape any
# title an attacker could choose; FAKE_MCPORTER_ENVELOPE replaces the whole
# stdout so a row can also shape malformed, non-object, or non-JSON output.
if [[ "$tool_name" == 'chrome-devtools.list_pages' ]]; then
  [[ -z "${FAKE_MCPORTER_INVENTORY_WARNING:-}" ]] || printf '%s\n' "$FAKE_MCPORTER_INVENTORY_WARNING" >&2
  if [[ -n "${FAKE_MCPORTER_ENVELOPE+set}" ]]; then
    printf '%s' "$FAKE_MCPORTER_ENVELOPE"
  else
    page_text="${FAKE_MCPORTER_PAGE_TEXT-$'## Pages\n0: FIXTURE-TITLE-ONE (https://fixture.invalid/one) [selected]'}"
    jq -cn --arg text "$page_text" '{content:[{type:"text",text:$text}]}'
  fi
else
  printf '{"content":[{"type":"text","text":"fixture"}]}\n'
fi
SH
chmod +x "$fixture_bin/mcporter"

mkdir -p "$fixture_home/code/mcporter/dist"
cat >"$fixture_home/code/mcporter/dist/cli.js" <<'SH'
#!/usr/bin/env bash
if [[ -n "${FAKE_MCPORTER_SOURCE_ARGV:-}" ]]; then
  printf '%s\n' "$@" >"$FAKE_MCPORTER_SOURCE_ARGV"
fi
if [[ -n "${FAKE_MCPORTER_SOURCE_CALLLOG:-}" ]]; then
  printf '%s\n' "$*" >>"$FAKE_MCPORTER_SOURCE_CALLLOG"
fi
if [[ "${1:-}" == 'chrome-relay' && "${2:-}" == '--help' ]]; then
  printf '%s\n' 'Usage: mcporter chrome-relay exec [--relay-url <url>] [--timeout <ms>] -- <command> [args...]'
  printf '%s\n' '       mcporter chrome-relay status [--relay-url <url>] [--timeout <ms>]'
  printf '%s\n' '       mcporter chrome-relay activity <start|heartbeat|clear> [--relay-url <url>]'
  exit 0
fi
if [[ "${1:-}" == 'chrome-relay' && ( "${2:-}" == 'status' || "${2:-}" == 'activity' ) ]]; then
  [[ "${FAKE_MCPORTER_SOURCE_STATUS_UNSUPPORTED:-0}" == '1' ]] && exit 90
  FAKE_MCPORTER_SOURCE_VERSION=1 exec mcporter "$@"
fi
exec mcporter "$@"
SH
chmod +x "$fixture_home/code/mcporter/dist/cli.js"

cat >"$fixture_bin/agent-browser" <<'SH'
#!/usr/bin/env bash
if [[ " $* " == *' tab list --json '* ]]; then
  stage_log="${FAKE_AGENT_BROWSER_STAGE_LOG:-${FAKE_MCPORTER_CLEANUP_LOG:-}}"
  if [[ "${FAKE_AGENT_BROWSER_SOCKET_LIMIT:-0}" == 1 ]]; then
    # Independent oracle: upstream's Unix socket ceiling and a synthetic home.
    socket_path="/Users/fixture/.agent-browser/${2}.sock"
    (( ${#socket_path} <= 103 )) || exit 1
  fi
  if [[ "${FAKE_AGENT_BROWSER_PREWORK_PIN_CHECK:-0}" == 1 && " $* " == *' --pin-tab tab list --json '* ]]; then
    [[ -n "$stage_log" ]] && printf 'pin-check\n' >>"$stage_log"
    if [[ "${FAKE_AGENT_BROWSER_UNRELATED_TAB:-0}" == 1 ]]; then
      jq -cn --arg url "${FAKE_AGENT_BROWSER_PAGE_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" \
        '{success:true,data:{tabs:[{targetId:"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",url:"https://different.invalid/"},{targetId:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",url:$url}]},error:null}'
    else
      jq -cn --arg url "${FAKE_AGENT_BROWSER_PAGE_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" \
        '{success:true,data:{tabs:[{targetId:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",url:$url}]},error:null}'
    fi
    exit 0
  fi
  [[ -n "$stage_log" ]] && printf 'attach\n' >>"$stage_log"
  [[ "${FAKE_AGENT_BROWSER_ATTACH_STATUS:-0}" == '0' ]] || exit "$FAKE_AGENT_BROWSER_ATTACH_STATUS"
  tab_list_count=1
  if [[ -n "${FAKE_AGENT_BROWSER_TAB_LIST_COUNT_FILE:-}" ]]; then
    [[ -f "$FAKE_AGENT_BROWSER_TAB_LIST_COUNT_FILE" ]] && tab_list_count=$(( $(<"$FAKE_AGENT_BROWSER_TAB_LIST_COUNT_FILE") + 1 ))
    printf '%s\n' "$tab_list_count" >"$FAKE_AGENT_BROWSER_TAB_LIST_COUNT_FILE"
  fi
  if [[ "$tab_list_count" -gt 1 ]]; then
    [[ -z "${FAKE_AGENT_BROWSER_TAB_LIST_LOG:-}" ]] || printf 'post\n' >>"$FAKE_AGENT_BROWSER_TAB_LIST_LOG"
    case "${FAKE_AGENT_BROWSER_POST_TAB_LIST_STATE:-same}" in
      unreadable) printf '{"success":false,"data":null,"error":"fixture revoked attachment"}\n'; exit 0 ;;
      malformed) printf '{"success":true,"data":{"tabs":null},"error":null}\n'; exit 0 ;;
      ambiguous)
        jq -cn --arg url "${FAKE_AGENT_BROWSER_POST_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" \
          '{success:true,data:{tabs:[{targetId:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",url:$url},{targetId:"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",url:$url}]},error:null}'
        exit 0 ;;
      changed)
        jq -cn --arg url "${FAKE_AGENT_BROWSER_POST_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" \
          '{success:true,data:{tabs:[{targetId:"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",url:$url}]},error:null}'
        exit 0 ;;
      changed-on-recheck)
        if [[ "$tab_list_count" -gt 2 ]]; then
          jq -cn --arg url "${FAKE_AGENT_BROWSER_POST_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" \
            '{success:true,data:{tabs:[{targetId:"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",url:$url}]},error:null}'
          exit 0
        fi ;;
    esac
    post_initial_observations="${FAKE_AGENT_BROWSER_POST_INITIAL_OBSERVATIONS:-0}"
    [[ "$post_initial_observations" =~ ^[0-9]+$ ]] || exit 97
    post_url="${FAKE_AGENT_BROWSER_POST_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}"
    if [[ "$tab_list_count" -le $((post_initial_observations + 1)) ]]; then
      post_url="${FAKE_AGENT_BROWSER_PAGE_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}"
    fi
    jq -cn --arg url "$post_url" \
      '{success:true,data:{tabs:[{targetId:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",url:$url}]},error:null}'
    exit 0
  fi
  [[ -z "${FAKE_AGENT_BROWSER_TAB_LIST_LOG:-}" ]] || printf 'initial\n' >>"$FAKE_AGENT_BROWSER_TAB_LIST_LOG"
  if [[ "${FAKE_AGENT_BROWSER_MALFORMED_UNRELATED:-0}" == 1 ]]; then
    jq -cn --arg url "${FAKE_AGENT_BROWSER_PAGE_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" \
      '{success:true,data:{tabs:[{targetId:null,url:null},"malformed fixture entry",{targetId:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",url:$url}]},error:null}'
  elif [[ "${FAKE_AGENT_BROWSER_SAME_SITE_SELECTED:-0}" == 1 ]]; then
    jq -cn \
      --arg first_url "${FAKE_AGENT_BROWSER_PAGE_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" \
      --arg selected_url "${FAKE_AGENT_BROWSER_SELECTED_PAGE_URL:-https://subdomain.fixture.invalid/PAGE-URL-SENTINEL-TWO}" \
      '{success:true,data:{tabs:[{active:false,targetId:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",url:$first_url},{active:true,targetId:"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",url:$selected_url}]},error:null}'
  elif [[ "${FAKE_AGENT_BROWSER_DUPLICATE_EXACT:-0}" == 1 ]]; then
    jq -cn --arg url "${FAKE_AGENT_BROWSER_PAGE_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" \
      '{success:true,data:{tabs:[{targetId:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",url:$url},{targetId:"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",url:$url}]},error:null}'
  elif [[ "${FAKE_AGENT_BROWSER_UNRELATED_TAB:-0}" == 1 ]]; then
    jq -cn --arg url "${FAKE_AGENT_BROWSER_PAGE_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" \
      '{success:true,data:{tabs:[{targetId:"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",url:"https://different.invalid/"},{targetId:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",url:$url}]},error:null}'
  else
    jq -cn --arg url "${FAKE_AGENT_BROWSER_PAGE_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" \
      '{success:true,data:{tabs:[{targetId:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",url:$url}]},error:null}'
  fi
  exit 0
fi
if [[ " $* " == *' tab AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA --json '* ||
      " $* " == *' tab BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB --json '* ]]; then
  stage_log="${FAKE_AGENT_BROWSER_STAGE_LOG:-${FAKE_MCPORTER_CLEANUP_LOG:-}}"
  [[ -n "$stage_log" ]] && printf 'select\n' >>"$stage_log"
  [[ -z "${FAKE_AGENT_BROWSER_SELECTED_TARGET_LOG:-}" ]] || printf '%s\n' "$*" >"$FAKE_AGENT_BROWSER_SELECTED_TARGET_LOG"
  if [[ "${FAKE_AGENT_BROWSER_SELECT_STATUS:-0}" != '0' ]]; then
    printf '{"success":false,"data":null,"error":"fixture selection failed"}\n'
    exit "$FAKE_AGENT_BROWSER_SELECT_STATUS"
  fi
  printf '{"success":true,"data":{"selected":true},"error":null}\n'
  exit 0
fi
if [[ " $* " == *' --pin-tab get url --json '* ]]; then
  stage_log="${FAKE_AGENT_BROWSER_STAGE_LOG:-${FAKE_MCPORTER_CLEANUP_LOG:-}}"
  [[ -n "$stage_log" ]] && printf 'pin-check\n' >>"$stage_log"
  url_read_count=1
  if [[ -n "${FAKE_AGENT_BROWSER_GET_URL_COUNT_FILE:-}" ]]; then
    [[ -f "$FAKE_AGENT_BROWSER_GET_URL_COUNT_FILE" ]] && url_read_count=$(( $(<"$FAKE_AGENT_BROWSER_GET_URL_COUNT_FILE") + 1 ))
    printf '%s\n' "$url_read_count" >"$FAKE_AGENT_BROWSER_GET_URL_COUNT_FILE"
  fi
  if [[ "${FAKE_AGENT_BROWSER_URL_STATE:-match}" == post-unreadable && "$url_read_count" -gt 1 ]]; then
    printf '{"success":false,"data":null,"error":"fixture attachment became unreadable"}\n'
    exit 0
  fi
  if [[ -n "${FAKE_AGENT_BROWSER_NAVIGATION_MARKER:-}" && -f "$FAKE_AGENT_BROWSER_NAVIGATION_MARKER" ]]; then
    jq -cn --arg url "${FAKE_AGENT_BROWSER_POST_URL:-https://changed.invalid/}" '{success:true,data:{url:$url},error:null}'
    exit 0
  fi
  case "${FAKE_AGENT_BROWSER_URL_STATE:-match}" in
    unreadable) printf '{"success":false,"data":null,"error":"fixture"}\n'; exit 0 ;;
    mismatch) printf '{"success":true,"data":{"url":"https://different.invalid/OTHER-PAGE"},"error":null}\n'; exit 0 ;;
    *)
      if [[ "$url_read_count" -gt 1 && -n "${FAKE_AGENT_BROWSER_POST_URL:-}" ]]; then
        jq -cn --arg url "$FAKE_AGENT_BROWSER_POST_URL" '{success:true,data:{url:$url},error:null}'
      else
        jq -cn --arg url "${FAKE_AGENT_BROWSER_PAGE_URL:-https://fixture.invalid/PAGE-URL-SENTINEL-ONE}" '{success:true,data:{url:$url},error:null}'
      fi ;;
  esac
  exit 0
fi
if [[ " $* " == *' --pin-tab batch --bail '* ]]; then
  stage_log="${FAKE_AGENT_BROWSER_STAGE_LOG:-${FAKE_MCPORTER_CLEANUP_LOG:-}}"
  [[ -n "$stage_log" ]] && printf 'work\n' >>"$stage_log"
  [[ -z "${FAKE_AGENT_BROWSER_ACTION_LOG:-}" ]] || printf '%s\n' "$@" >>"$FAKE_AGENT_BROWSER_ACTION_LOG"
  [[ -z "${FAKE_AGENT_BROWSER_RESULT:-}" ]] || printf '%s\n' "$FAKE_AGENT_BROWSER_RESULT"
  [[ -z "${FAKE_AGENT_BROWSER_NAVIGATION_MARKER:-}" ]] || touch "$FAKE_AGENT_BROWSER_NAVIGATION_MARKER"
  exit "${FAKE_MCPORTER_AGENT_STATUS:-0}"
fi
if [[ " $* " == *' session info --json '* ]]; then
  [[ -n "${FAKE_AGENT_BROWSER_INFO_ARGV:-}" ]] && printf '%s\n' "$@" >"$FAKE_AGENT_BROWSER_INFO_ARGV"
  case "${FAKE_AGENT_BROWSER_SESSION_STATE:-active-one}" in
    inactive) printf '{"success":true,"data":{"active":false,"runtime":null},"error":null}\n' ;;
    active-zero) printf '{"success":true,"data":{"active":true,"runtime":{"pageCount":0}},"error":null}\n' ;;
    active-one) printf '{"success":true,"data":{"active":true,"runtime":{"pageCount":1}},"error":null}\n' ;;
    *) printf '{"success":false,"data":null,"error":"fixture session info failure"}\n'; exit 97 ;;
  esac
  exit 0
fi
if [[ " $* " == *' close --json '* ]]; then
  stage_log="${FAKE_AGENT_BROWSER_STAGE_LOG:-${FAKE_MCPORTER_CLEANUP_LOG:-}}"
  [[ -n "$stage_log" ]] && printf 'retire\n' >>"$stage_log"
  [[ -n "${FAKE_AGENT_BROWSER_CLOSE_ARGV:-}" ]] && printf '%s\n' "$@" >"$FAKE_AGENT_BROWSER_CLOSE_ARGV"
  printf '{"success":true,"data":{"closed":true},"error":null}\n'
  exit 0
fi
exit 97
SH
chmod +x "$fixture_bin/agent-browser"

fixture_playwright_root="$TEST_ROOT/playwright-install"
fixture_playwright_cli="$fixture_playwright_root/playwright-cli.js"
fixture_playwright_daemon="$fixture_playwright_root/node_modules/playwright-core/lib/entry/cliDaemon.js"
mkdir -p "$(dirname "$fixture_playwright_daemon")"
cat >"$fixture_playwright_daemon" <<'JS'
// Fixture path marker. The fake node process owns daemon behaviour.
JS
cat >"$fixture_playwright_cli" <<'SH'
#!/usr/bin/env bash
if [[ -n "${FAKE_PLAYWRIGHT_CLI_LOG:-}" ]]; then
  {
    printf 'call\n'
    printf 'arg=%s\n' "$@"
    printf 'agent_endpoint=%s\n' "${AGENT_BROWSER_CDP:-}"
    printf 'playwright_endpoint=%s\n' "${PLAYWRIGHT_MCP_CDP_ENDPOINT:-}"
  } >>"$FAKE_PLAYWRIGHT_CLI_LOG"
fi
command_name=''
for arg in "$@"; do
  case "$arg" in
    -s=*|--raw|--json) ;;
    *) command_name="$arg"; break ;;
  esac
done
if [[ "$command_name" == 'run-code' ]]; then
  node -e '
    const vm = require("node:vm"), fs = require("node:fs");
    const moved = (process.env.FAKE_PLAYWRIGHT_NAVIGATION_MARKER && fs.existsSync(process.env.FAKE_PLAYWRIGHT_NAVIGATION_MARKER)) || (process.env.FAKE_PLAYWRIGHT_SCRIPT_MARKER && fs.existsSync(process.env.FAKE_PLAYWRIGHT_SCRIPT_MARKER));
    const targetUrl = moved || process.env.FAKE_PLAYWRIGHT_PAGE_MATCH === "false" ? "https://changed.invalid/" : (process.env.FAKE_PLAYWRIGHT_PAGE_URL || "https://fixture.invalid/PAGE-URL-SENTINEL-ONE");
    const target = {url: () => targetUrl};
    const duplicates = Array.from({length: Number(process.env.FAKE_PLAYWRIGHT_DUPLICATE_EXACT_COUNT || 0)}, () => ({url: () => targetUrl}));
    const unrelatedCount = Math.max(Number(process.env.FAKE_PLAYWRIGHT_UNRELATED_PAGE_COUNT || 0), process.env.FAKE_PLAYWRIGHT_SELECTED_TARGET === "false" ? 1 : 0);
    const unrelated = Array.from({length: unrelatedCount}, (_, index) => ({url: () => `https://different-${index}.invalid/`}));
    const pages = [target, ...duplicates, ...unrelated];
    for (const candidate of pages) candidate.context = () => ({pages: () => pages});
    const page = process.env.FAKE_PLAYWRIGHT_SELECTED_TARGET === "false" ? unrelated[0] : target;
    (async () => console.log(JSON.stringify({result: JSON.stringify(await vm.runInNewContext(process.argv[1], {})(page))})))();
  ' "${@: -1}"
  exit 0
fi
if [[ -n "${FAKE_PLAYWRIGHT_ACTION_TARGET_LOG:-}" && "$command_name" != 'detach' ]]; then
  if [[ "${FAKE_PLAYWRIGHT_SELECTED_TARGET:-true}" == 'false' ]]; then
    printf 'unrelated\n' >>"$FAKE_PLAYWRIGHT_ACTION_TARGET_LOG"
  else
    printf 'target\n' >>"$FAKE_PLAYWRIGHT_ACTION_TARGET_LOG"
  fi
fi
if [[ "$command_name" == snapshot && -n "${FAKE_PLAYWRIGHT_NAVIGATION_MARKER:-}" ]]; then
  touch "$FAKE_PLAYWRIGHT_NAVIGATION_MARKER"
fi
if [[ "$command_name" == 'eval' && "$*" != *'crypto.subtle.digest'* ]]; then
  [[ -z "${FAKE_PLAYWRIGHT_SCRIPT_MARKER:-}" ]] || touch "$FAKE_PLAYWRIGHT_SCRIPT_MARKER"
  node -e 'const vm = require("node:vm"); (async () => { try { const fn = vm.runInNewContext(process.argv[1], {}); const value = await fn(); console.log(process.argv[2] === "json" ? JSON.stringify({result: `SCRIPT-RESULT-${value}`}) : `SCRIPT-RESULT-${value}`); } catch (e) { console.log(process.argv[2] === "json" ? JSON.stringify({isError: true, error: e.message}) : `### Error\n${e.message}`); } })();' "${@: -1}" "$( [[ " $* " == *' --json '* ]] && echo json || echo text )"
  exit 0
fi
if [[ "$command_name" == 'eval' ]]; then
  if [[ -n "${FAKE_PLAYWRIGHT_SCRIPT_MARKER:-}" && -f "$FAKE_PLAYWRIGHT_SCRIPT_MARKER" ]]; then
    printf 'false\n'
    exit 0
  fi
  printf '%s\n' "${FAKE_PLAYWRIGHT_PAGE_MATCH:-true}"
  exit 0
fi
if [[ "$command_name" == "${FAKE_PLAYWRIGHT_HOLD_COMMAND:-}" ]]; then
  sleep "${FAKE_PLAYWRIGHT_HOLD_SECONDS:-2}"
fi
if [[ "$command_name" == 'detach' ]]; then
  if [[ -f "${FAKE_PLAYWRIGHT_DAEMON_PID:-/nonexistent}" ]]; then
    kill "$(<"$FAKE_PLAYWRIGHT_DAEMON_PID")" 2>/dev/null || true
  fi
  printf '{"status":"detached"}\n'
  exit "${FAKE_PLAYWRIGHT_DETACH_STATUS:-0}"
fi

if [[ "$command_name" == "${FAKE_PLAYWRIGHT_FAIL_COMMAND:-}" ]]; then
  exit "${FAKE_PLAYWRIGHT_ACTION_STATUS:-23}"
fi
if [[ " $* " == *' --json '* ]]; then
  jq -cn --arg result "PLAYWRIGHT-${command_name}-OK" '{result:$result}'
else
  printf 'PLAYWRIGHT-%s-OK\n' "$command_name"
fi
SH
chmod +x "$fixture_playwright_cli"
ln -s "$fixture_playwright_cli" "$fixture_bin/playwright-cli"

# The fake node owns only the Playwright daemon path. Every other invocation,
# which is how the Puppeteer helper runs, is handed to the real Node so the
# helper's JavaScript executes for real against the fake module below.
{
  printf '#!/usr/bin/env bash\n'
  printf 'REAL_NODE=%q\n' "$real_node"
  cat <<'SH'
if [[ "${1:-}" != *cliDaemon.js ]]; then
  exec "$REAL_NODE" "$@"
fi
if [[ -n "${FAKE_PLAYWRIGHT_NODE_LOG:-}" ]]; then
  {
    printf 'arg=%s\n' "$@"
    printf 'endpoint=%s\n' "${PLAYWRIGHT_MCP_CDP_ENDPOINT:-}"
  } >"$FAKE_PLAYWRIGHT_NODE_LOG"
fi
[[ -n "${FAKE_PLAYWRIGHT_DAEMON_PID:-}" ]] && printf '%s\n' "$$" >"$FAKE_PLAYWRIGHT_DAEMON_PID"
if [[ "${FAKE_PLAYWRIGHT_IGNORE_TERM:-0}" == 1 ]]; then trap '' TERM; else trap 'exit 0' HUP INT TERM; fi
printf 'Daemon listening on fixture-socket\n'
while :; do sleep 1; done
SH
} >"$fixture_bin/node"
chmod +x "$fixture_bin/node"

# Test-owned Puppeteer module. Node resolves `require('puppeteer')` from the
# copied helper upward to this file, so the real helper JavaScript runs against
# a recorded adapter. Every call lands in FAKE_PUPPETEER_LOG, one line each, as
# an independent oracle for order, arguments, disconnect, and the absence of
# close. Holds keep a live timer so a run that fails to exit explicitly would
# leave this process alive; FAKE_PUPPETEER_PID_FILE lets a row prove it did not.
mkdir -p "$fixture_repo/node_modules/puppeteer"
cat >"$fixture_repo/node_modules/puppeteer/index.js" <<'JS'
'use strict';
const fs = require('node:fs');
const logPath = process.env.FAKE_PUPPETEER_LOG;
const record = (line) => { if (logPath) fs.appendFileSync(logPath, `${line}\n`); };
if (process.env.FAKE_PUPPETEER_PID_FILE) fs.writeFileSync(process.env.FAKE_PUPPETEER_PID_FILE, String(process.pid));
const hold = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const holdFor = async (name) => {
  if (process.env.FAKE_PUPPETEER_HOLD_COMMAND === name) await hold(Number(process.env.FAKE_PUPPETEER_HOLD_MS || 5000));
};
const failFor = (name) => {
  if (process.env.FAKE_PUPPETEER_FAIL_COMMAND === name) {
    const error = new Error(process.env.FAKE_PUPPETEER_FAIL_MESSAGE || 'fixture failure');
    error.name = process.env.FAKE_PUPPETEER_FAIL_CLASS || 'FixtureSecretClass';
    throw error;
  }
};
let completedActions = 0;
const currentUrl = () => {
  const after = process.env.FAKE_PUPPETEER_URL_AFTER_FIRST_ACTION;
  return after && completedActions >= 1 ? after : (process.env.FAKE_PUPPETEER_PAGE_URL || '');
};
const action = async (name, args, result) => {
  record([name, ...args].join(' '));
  await holdFor(name);
  failFor(name);
  completedActions += 1;
  return result;
};
// url() is synchronous in Puppeteer, so a fixture that blocks inside it spends
// wall-clock time the helper cannot pre-empt: the row that uses it proves the
// helper rechecks the lease TTL after page discovery, immediately before an
// action.
let urlCalls = 0;
const blockUrl = () => {
  urlCalls += 1;
  const ms = Number(process.env.FAKE_PUPPETEER_URL_BLOCK_MS || 0);
  if (ms > 0 && urlCalls === Number(process.env.FAKE_PUPPETEER_BLOCK_URL_CALL || 1)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
};
const page = {
  isClosed: () => process.env.FAKE_PUPPETEER_PAGE_CLOSED === '1',
  url: () => { record('url'); blockUrl(); return currentUrl(); },
  setDefaultTimeout: (ms) => record(`setDefaultTimeout ${ms}`),
  title: () => action('title', [], 'FIXTURE-TITLE-ONE'),
  evaluate: (source) => action('page-evaluate', [source], require('node:vm').runInNewContext(source, {})),
  accessibility: { snapshot: () => action('snapshot', [], { role: 'WebArea', name: 'FIXTURE-TITLE-ONE' }) },
  $: async (selector) => {
    await action('text', [selector], null);
    if (selector === '#missing') return null;
    return { evaluate: async () => { record('evaluate'); return 'FIXTURE-TEXT'; }, dispose: async () => record('dispose') };
  },
  click: (selector) => action('click', [selector], undefined),
  hover: (selector) => action('hover', [selector], undefined),
  type: (selector, text) => action('type', [selector, text], undefined),
  keyboard: { press: (key) => action('press', [key], undefined) },
  select: (selector, ...values) => action('select', [selector, ...values], values),
  waitForSelector: async (selector) => { await action('wait', [selector], null); return { dispose: async () => record('dispose') }; },
};
const unrelatedPage = {
  ...page,
  isClosed: () => false,
  url: () => { record('unrelated-url'); return 'https://different.invalid/'; },
  title: () => action('unrelated-title', [], 'UNRELATED-TITLE'),
  accessibility: { snapshot: () => action('unrelated-snapshot', [], { role: 'WebArea', name: 'UNRELATED' }) },
};
let pagesCalls = 0;
const browser = {
  connected: true,
  pages: async () => {
    pagesCalls += 1;
    record('pages');
    if (pagesCalls === Number(process.env.FAKE_PUPPETEER_HOLD_PAGES_CALL || 1)) await holdFor('pages');
    const exactCount = Number(process.env.FAKE_PUPPETEER_PAGE_COUNT ?? (process.env.FAKE_PUPPETEER_DUPLICATE_AFTER_FIRST === '1' && pagesCalls > 1 ? 2 : 1));
    const unrelatedCount = Number(process.env.FAKE_PUPPETEER_UNRELATED_PAGE_COUNT ?? 0);
    return [
      ...Array.from({ length: exactCount }, (_, index) => (index === 0 ? page : { ...page })),
      ...Array.from({ length: unrelatedCount }, () => unrelatedPage),
    ];
  },
  disconnect: async () => {
    record('disconnect');
    await holdFor('disconnect');
    if (process.env.FAKE_PUPPETEER_DISCONNECT_FAIL === '1') throw new Error('fixture disconnect failure');
  },
  close: async () => { record('close'); },
};
module.exports = {
  connect: async (options) => {
    record(`connect ws=${options.browserWSEndpoint || ''} http=${options.browserURL || ''} viewport=${options.defaultViewport === null ? 'null' : 'set'} protocolTimeout=${options.protocolTimeout}`);
    await holdFor('connect');
    failFor('connect');
    return browser;
  },
};
JS

run_cli() {
  local stderr_file="$TEST_ROOT/stderr"
  local previous_arg='' fixture_arg
  for fixture_arg in "$@"; do
    [[ "$previous_arg" != '--nonce-output' ]] || last_token_output="$fixture_arg"
    previous_arg="$fixture_arg"
  done
  : >"$stderr_file"
  set +e
  cli_out="$(HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
    BROWSER_LANE_OPEN_BIN="${BROWSER_LANE_OPEN_BIN:-$fixture_bin/browser-lane-open}" \
    "$fixture_repo/bin/browser-lane" "$@" 2>"$stderr_file")"
  cli_status=$?
  set -e
  cli_err="$(<"$stderr_file")"
}

# Existing lifecycle rows retain fake token bytes for their independent hash
# and sanitation oracles. Transport those bytes through a private fixture file
# when exercising the new public file-input interface.
token_fixture() {
  local file
  file="$(mktemp "$TEST_ROOT/input-token.XXXXXX")"
  printf '%s\n' "$1" >"$file"
  chmod 600 "$file"
  printf '%s' "$file"
}

assert_logged_pids_dead() {
  local path="$1" label="$2" pid
  assert_present "$path" "$label records scoped PIDs"
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail "$label records only numeric PIDs"
    kill -0 "$pid" 2>/dev/null && fail "$label leaves sleep PID $pid alive"
  done <"$path"
  pass "$label reaps every logged sleep child"
}

assert_process_marker_absent() {
  local marker="$1" label="$2" processes
  processes="$(ps -axo pid=,command= | awk -v marker="$marker" 'index($0, marker) && $0 !~ /awk -v marker/ { print }')"
  assert_equals "$processes" '' "$label"
}

# A usage refusal exits 2, prints nothing on stdout, and never creates
# recovery state.
assert_usage_refused() {
  local label="$1"
  assert_equals "$cli_status" '2' "$label exits 2"
  assert_equals "$cli_out" '' "$label prints nothing on stdout"
  assert_absent "$recovery_root_dir" "$label creates no recovery state"
}

if [[ "$test_selection" == '--handoff-security-only' || "$test_selection" == 'all' ]]; then
  security_start="$assertion_count"
  security_token="$TEST_ROOT/security-token"
  security_open_log="$TEST_ROOT/security-open.argv"
  real_jq="$(command -v jq)"
  cat >"$fixture_bin/jq" <<SH
#!/usr/bin/env bash
printf '%s\\n' "\$@" >>"$TEST_ROOT/security-jq.argv"
exec "$real_jq" "\$@"
SH
  chmod 700 "$fixture_bin/jq"
  run_cli handoff open --lane daily-driver --account-role owner --task-ref missing-output --page-url "$page_one" --json
  assert_equals "$cli_status" '2' 'handoff open requires explicit private token delivery'
  assert_absent "$handoff_dir" 'missing output destination creates no reservation'
  FAKE_BROWSER_OPEN_ARGV="$security_open_log" run_cli handoff open --lane daily-driver --account-role owner --task-ref security-proof \
    --page-url "$page_one" --nonce-output "$security_token" --json
  assert_equals "$cli_status" '0' 'private token output opens a reservation'
  security_secret="$(<"$security_token")"
  assert_matches "$security_secret" '^[0-9a-f]{64}$' 'token file contains a bounded random token'
  assert_equals "$(mode_of "$security_token")" '600' 'token output is owner-only'
  assert_not_contains "$cli_out$cli_err$(<"$security_open_log")" "$security_secret" 'token is absent from both streams and opener arguments'
  assert_equals "$(jq -r '.data | has("nonce")' <<<"$cli_out")" 'false' 'open result has no token field'
  assert_not_contains "$(<"$handoff_record")" "$security_secret" 'reservation stores no raw token'
  security_record_sha="$(sha256_of "$handoff_record")"
  run_cli handoff release --lane daily-driver --nonce "$security_secret" --json
  assert_equals "$cli_status" '2' 'legacy token arguments are refused'
  assert_not_contains "$cli_out$cli_err" "$security_secret" 'legacy refusal does not repeat the token'
  assert_contains "$cli_err" '--nonce-file' 'legacy refusal gives the private input replacement'
  for unsafe in missing public symlink hardlink directory fifo oversized wrong; do
    unsafe_token="$TEST_ROOT/security-$unsafe"
    case "$unsafe" in
      public) cp "$security_token" "$unsafe_token"; chmod 644 "$unsafe_token" ;;
      symlink) ln -s "$security_token" "$unsafe_token" ;;
      hardlink) ln "$security_token" "$unsafe_token" ;;
      directory) mkdir "$unsafe_token" ;;
      fifo) mkfifo "$unsafe_token" ;;
      oversized) printf '%070d' 1 >"$unsafe_token"; chmod 600 "$unsafe_token" ;;
      wrong) printf '%064d' 1 >"$unsafe_token"; chmod 600 "$unsafe_token" ;;
    esac
    run_cli handoff release --lane daily-driver --nonce-file "$unsafe_token" --json
    assert_equals "$cli_status" '21' "$unsafe token input is refused"
    assert_equals "$(sha256_of "$handoff_record")" "$security_record_sha" "$unsafe token input preserves exact reservation bytes"
    [[ "$unsafe" != 'hardlink' ]] || rm "$unsafe_token"
  done
  security_before="$(find "$fixture_state/browser-lanes" -type f -exec shasum -a 256 {} \; | sort)"
  run_cli handoff recover --lane daily-driver --json
  assert_equals "$cli_status" '0' 'lost-token recovery preview succeeds'
  security_fingerprint="$(jq -r '.data.reservation_sha256' <<<"$cli_out")"
  assert_equals "$security_fingerprint" "$security_record_sha" 'preview fingerprint matches independently read reservation bytes'
  assert_equals "$(find "$fixture_state/browser-lanes" -type f -exec shasum -a 256 {} \; | sort)" "$security_before" 'preview changes no durable file'
  assert_absent "$fixture_state/browser-lanes/handoff-recovery" 'preview creates no audit directory'
  assert_absent "$lease_dir" 'preview creates no lease'
  run_cli handoff recover --lane daily-driver --reservation "$security_fingerprint" --execute --json
  assert_equals "$cli_status" '2' 'recovery execution requires explicit task acknowledgement'
  run_cli handoff recover --lane daily-driver --reservation "$security_fingerprint" --acknowledge another-task --execute --json
  assert_equals "$cli_status" '21' 'wrong task acknowledgement cannot release another reservation'
  assert_present "$handoff_record" 'wrong acknowledgement preserves reservation'
  # A busy lease blocks even an operator with the correct preview.
  mkdir "$lease_dir"
  run_cli handoff recover --lane daily-driver --reservation "$security_fingerprint" --acknowledge security-proof --execute --json
  assert_equals "$cli_status" '13' 'recovery refuses a competing command lease'
  rmdir "$lease_dir"
  mkdir "$fixture_state/browser-lanes/handoff-recovery"
  chmod 755 "$fixture_state/browser-lanes/handoff-recovery"
  run_cli handoff recover --lane daily-driver --reservation "$security_fingerprint" --acknowledge security-proof --execute --json
  assert_equals "$cli_status" '15' 'unsafe audit destination refuses recovery'
  assert_equals "$(sha256_of "$handoff_record")" "$security_record_sha" 'audit failure leaves exact reservation intact'
  assert_contains "$cli_err" 'Read handoff status' 'incomplete recovery names the observation before retry'
  chmod 700 "$fixture_state/browser-lanes/handoff-recovery"
  # Independent replacement simulates a changed reservation between preview
  # and operator execution. The old fingerprint cannot authorize the new one.
  jq '.task_ref="replacement-proof"' "$handoff_record" >"$TEST_ROOT/replacement.json"
  chmod 600 "$TEST_ROOT/replacement.json"
  mv "$TEST_ROOT/replacement.json" "$handoff_record"
  replacement_sha="$(sha256_of "$handoff_record")"
  run_cli handoff recover --lane daily-driver --reservation "$security_fingerprint" --acknowledge security-proof --execute --json
  assert_equals "$cli_status" '21' 'stale preview cannot release a replacement reservation'
  assert_equals "$(sha256_of "$handoff_record")" "$replacement_sha" 'stale fingerprint preserves replacement bytes'
  run_cli handoff recover --lane daily-driver --json
  security_fingerprint="$(jq -r '.data.reservation_sha256' <<<"$cli_out")"
  run_cli handoff recover --lane daily-driver --reservation "$security_fingerprint" --acknowledge replacement-proof --execute --json
  assert_equals "$cli_status" '0' 'exact operator recovery succeeds'
  assert_absent "$handoff_dir" 'operator recovery removes only the observed reservation'
  security_receipt="$(jq -r '.data.receipt_id' <<<"$cli_out")"
  before_receipt="$fixture_state/browser-lanes/handoff-recovery/$security_receipt.before.json"
  outcome_receipt="$fixture_state/browser-lanes/handoff-recovery/$security_receipt.outcome.json"
  assert_equals "$(jq -r '.state' "$before_receipt")" 'authorized' 'recovery retains a before-removal authorization receipt'
  assert_equals "$(jq -r '.state' "$outcome_receipt")" 'recovered' 'recovery retains a terminal outcome receipt'
  assert_equals "$(jq -r '.reservation_sha256' "$before_receipt")" "$replacement_sha" 'audit binds the exact independently observed reservation'
  assert_equals "$(mode_of "$before_receipt")$(mode_of "$outcome_receipt")" '600600' 'both recovery receipts are private'
  assert_not_contains "$(<"$before_receipt")$(<"$outcome_receipt")$cli_out$cli_err" "$security_secret" 'recovery audit and output contain no token'
  assert_present "$security_token" 'caller retains ownership of token cleanup'
  # Existing output and unsafe output paths must fail before browser dispatch.
  for output_case in existing symlink missing-parent public-parent; do
    output_path="$TEST_ROOT/output-$output_case"
    case "$output_case" in
      existing) cp "$security_token" "$output_path" ;;
      symlink) ln -s "$security_token" "$output_path" ;;
      missing-parent) output_path="$TEST_ROOT/absent-parent/token" ;;
      public-parent) mkdir "$TEST_ROOT/public-parent"; chmod 755 "$TEST_ROOT/public-parent"; output_path="$TEST_ROOT/public-parent/token" ;;
    esac
    : >"$security_open_log"
    FAKE_BROWSER_OPEN_ARGV="$security_open_log" run_cli handoff open --lane daily-driver --account-role owner \
      --task-ref output-proof --nonce-output "$output_path" --page-url "$page_one" --json
    assert_equals "$cli_status" '15' "$output_case output is refused"
    assert_absent "$handoff_dir" "$output_case output publishes no reservation"
    assert_equals "$(<"$security_open_log")" '' "$output_case output dispatches no opener"
  done
  # An uncertain launch keeps the already-persisted token usable.
  uncertain_token="$TEST_ROOT/security-uncertain-token"
  FAKE_BROWSER_OPEN_EXIT=130 run_cli handoff open --lane daily-driver --account-role owner \
    --task-ref uncertainty-proof --nonce-output "$uncertain_token" --page-url "$page_one" --json
  assert_equals "$cli_status" '22' 'uncertain launch reports its own typed exit'
  assert_not_contains "$cli_out$cli_err" "$(<"$uncertain_token")" 'uncertain launch keeps the token out of both streams'
  run_cli handoff release --lane daily-driver --nonce-file "$uncertain_token" --json
  assert_equals "$cli_status" '0' 'persisted token releases uncertain opening'
  assert_absent "$handoff_dir" 'uncertain opening recovery finishes cleanly'
  assert_not_contains "$(<"$TEST_ROOT/security-jq.argv")" "$security_secret" 'token never reaches jq process arguments'
  # Signal the public process only after the opener proves dispatch began.
  signal_token="$TEST_ROOT/security-signal-token"
  signal_started="$TEST_ROOT/security-signal-started"
  HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
    BROWSER_LANE_OPEN_BIN="$fixture_bin/browser-lane-open" \
    FAKE_BROWSER_OPEN_REQUIRE_FILE="$handoff_record" \
    FAKE_BROWSER_OPEN_STARTED_FILE="$signal_started" FAKE_BROWSER_OPEN_HOLD_SECONDS=1 \
    "$fixture_repo/bin/browser-lane" handoff open --lane daily-driver --account-role owner \
      --task-ref signal-security --nonce-output "$signal_token" --page-url "$page_one" --json \
      >"$TEST_ROOT/security-signal.out" 2>"$TEST_ROOT/security-signal.err" &
  signal_pid=$!
  for _ in {1..30}; do [[ -f "$signal_started" ]] && break; sleep 0.1; done
  assert_present "$signal_started" 'signal test reaches the controlled opener'
  signal_secret="$(<"$signal_token")"
  assert_not_contains "$(ps -axo command=)" "$signal_secret" 'live process arguments contain no reservation token'
  kill -TERM "$signal_pid"
  set +e
  wait "$signal_pid"
  signal_status=$?
  set -e
  assert_equals "$signal_status" '22' 'public signal keeps uncertain opening typed'
  assert_not_contains "$(<"$TEST_ROOT/security-signal.out")$(<"$TEST_ROOT/security-signal.err")" "$signal_secret" 'signal diagnostics contain no token'
  run_cli handoff release --lane daily-driver --nonce-file "$signal_token" --json
  assert_equals "$cli_status" '0' 'private token remains usable after process interruption'
  assert_absent "$handoff_dir" 'signal cleanup releases only through the explicit token file'
  # Inject failure and interruption at the existing filesystem process seam,
  # after token delivery but before final reservation publication.
  : >"$security_open_log"
  FAKE_MV_FAIL_MATCH='/handoff.json' FAKE_BROWSER_OPEN_ARGV="$security_open_log" \
    run_cli handoff open --lane daily-driver --account-role owner --task-ref writer-failure \
      --nonce-output "$TEST_ROOT/security-writer-token" --page-url "$page_one" --json
  assert_equals "$cli_status" '15' 'reservation writer failure is typed'
  assert_present "$TEST_ROOT/security-writer-token" 'writer failure retains caller token ownership'
  assert_absent "$handoff_dir" 'writer failure leaves no partial reservation'
  assert_equals "$(<"$security_open_log")" '' 'writer failure never opens the browser'
  FAKE_MV_SIGNAL_BEFORE_MATCH='/handoff.json' FAKE_BROWSER_OPEN_ARGV="$security_open_log" \
    run_cli handoff open --lane daily-driver --account-role owner --task-ref publication-signal \
      --nonce-output "$TEST_ROOT/security-publication-token" --page-url "$page_one" --json
  assert_equals "$cli_status" '130' 'signal during publication stops the public command'
  assert_present "$TEST_ROOT/security-publication-token" 'publication signal retains the private token file'
  assert_absent "$handoff_dir" 'publication signal removes only unpublished partial state'
  assert_absent "$lease_dir" 'publication signal releases its command lease'
  assert_equals "$(<"$security_open_log")" '' 'publication signal never reaches the opener'
  # Existing legacy state remains recoverable; malformed state fails closed.
  run_cli handoff open --lane daily-driver --account-role owner --task-ref legacy-security \
    --nonce-output "$TEST_ROOT/security-legacy-token" --page-url "$page_one" --json
  jq 'del(.start_mode,.profile_directory_sha256)' "$handoff_record" >"$TEST_ROOT/legacy-record"
  chmod 600 "$TEST_ROOT/legacy-record"
  mv "$TEST_ROOT/legacy-record" "$handoff_record"
  run_cli handoff recover --lane daily-driver --json
  assert_equals "$cli_status" '0' 'recovery preview accepts a validated legacy reservation'
  legacy_fingerprint="$(jq -r '.data.reservation_sha256' <<<"$cli_out")"
  cp "$handoff_record" "$TEST_ROOT/legacy-good"
  printf '{"malformed":true}\n' >"$handoff_record"
  malformed_sha="$(sha256_of "$handoff_record")"
  run_cli handoff recover --lane daily-driver --reservation "$legacy_fingerprint" --acknowledge legacy-security --execute --json
  assert_equals "$cli_status" '15' 'malformed reservation cannot be recovered by stale authority'
  assert_equals "$(sha256_of "$handoff_record")" "$malformed_sha" 'malformed state is preserved for inspection'
  cp "$TEST_ROOT/legacy-good" "$handoff_record"
  run_cli handoff recover --lane daily-driver --reservation "$legacy_fingerprint" --acknowledge legacy-security --execute --json
  assert_equals "$cli_status" '0' 'explicit recovery supports legacy reservation records'
  assert_absent "$handoff_dir" 'legacy recovery finishes without recreating state'
  legacy_receipt="$(jq -r '.data.receipt_id' <<<"$cli_out")"
  # Inject one fsync failure after the real unlink through the executable's
  # Python dependency. The production helper still performs every state change.
  run_cli handoff open --lane daily-driver --account-role owner --task-ref audit-interruption \
    --nonce-output "$TEST_ROOT/security-audit-token" --page-url "$page_one" --json
  run_cli handoff recover --lane daily-driver --json
  audit_fingerprint="$(jq -r '.data.reservation_sha256' <<<"$cli_out")"
  real_python="$(command -v python3)"
  cp "$handoff_record" "$TEST_ROOT/audit-good-record"
  # Replace state only after the shell has validated it, at the real helper
  # process boundary. No timing assumption or production test hook is needed.
  cat >"$fixture_bin/python3" <<SH
#!/usr/bin/env bash
exec "$real_python" -c '
import hashlib, os, runpy, sys
sys.argv = sys.argv[1:]
if len(sys.argv) > 2 and sys.argv[1] == "recover":
    sys.stderr = open(os.environ["FAKE_RECOVERY_STDERR"], "w")
    with open(sys.argv[2], "w") as stream:
        stream.write(os.environ["FAKE_RECOVERY_JSON"])
    sys.argv[3] = hashlib.sha256(os.environ["FAKE_RECOVERY_JSON"].encode()).hexdigest()
runpy.run_path(sys.argv[0], run_name="__main__")
' "\$@"
SH
  chmod 700 "$fixture_bin/python3"
  for malformed_json in '[]' 'null' '42' '"text"' '{"task_ref":[],"lane":"daily-driver"}' '{"task_ref":"audit-interruption","lane":42}'; do
    cp "$TEST_ROOT/audit-good-record" "$handoff_record"
    receipts_before="$(entry_count "$fixture_state/browser-lanes/handoff-recovery")"
    FAKE_RECOVERY_JSON="$malformed_json" FAKE_RECOVERY_STDERR="$TEST_ROOT/recovery-helper.err" run_cli handoff recover --lane daily-driver \
      --reservation "$audit_fingerprint" --acknowledge audit-interruption --execute --json
    assert_equals "$cli_status" '15' 'changed malformed recovery state fails with typed status'
    assert_not_contains "$cli_err$(<"$TEST_ROOT/recovery-helper.err")" 'Traceback' 'malformed recovery state emits no Python traceback'
    assert_equals "$(<"$handoff_record")" "$malformed_json" 'malformed recovery state remains untouched'
    assert_equals "$(entry_count "$fixture_state/browser-lanes/handoff-recovery")" "$receipts_before" 'malformed state creates no authorization receipt'
  done
  cp "$TEST_ROOT/audit-good-record" "$handoff_record"
  cat >"$fixture_bin/python3" <<SH
#!/usr/bin/env bash
exec "$real_python" -c '
import os, runpy, sys
real_open = os.open
sys.argv = sys.argv[1:]
if len(sys.argv) > 2 and sys.argv[1] == "recover":
    record_parent, audit_root = os.path.dirname(sys.argv[2]), sys.argv[5]
    def open_directory(path, *args, **kwargs):
        if path == record_parent and os.path.isdir(audit_root):
            import json
            for name in os.listdir(audit_root):
                if name.endswith(".before.json"):
                    with open(os.path.join(audit_root, name)) as stream:
                        receipt = json.load(stream)
                    if receipt["task_ref"] == "audit-interruption":
                        raise OSError("synthetic parent acquisition failure")
        return real_open(path, *args, **kwargs)
    os.open = open_directory
runpy.run_path(sys.argv[0], run_name="__main__")
' "\$@"
SH
  chmod 700 "$fixture_bin/python3"
  run_cli handoff recover --lane daily-driver --reservation "$audit_fingerprint" --acknowledge audit-interruption --execute --json
  assert_equals "$cli_status" '15' 'parent acquisition failure reports typed refusal'
  assert_equals "$(sha256_of "$handoff_record")" "$audit_fingerprint" 'parent acquisition failure preserves exact reservation'
  assert_not_contains "$cli_err" 'Traceback' 'parent acquisition failure has no traceback'
  refused_receipt="$(find "$fixture_state/browser-lanes/handoff-recovery" -name '*.outcome.json' -exec jq -r 'select(.state=="refused") | .receipt_id' {} \;)"
  assert_matches "$refused_receipt" '^[0-9a-f]{32}$' 'parent acquisition failure records a refused outcome'
  assert_equals "$(jq -r '.state' "$fixture_state/browser-lanes/handoff-recovery/$refused_receipt.before.json")" 'authorized' 'refused outcome has a prior authorization receipt'
  assert_equals "$(mode_of "$fixture_state/browser-lanes/handoff-recovery/$refused_receipt.outcome.json")" '600' 'refused outcome is private'
  rm "$fixture_state/browser-lanes/handoff-recovery/$refused_receipt.before.json" "$fixture_state/browser-lanes/handoff-recovery/$refused_receipt.outcome.json"
  cat >"$fixture_bin/python3" <<SH
#!/usr/bin/env bash
exec "$real_python" -c '
import os, runpy, sys
real_unlink, real_fsync = os.unlink, os.fsync
pending = False
def unlink(path, **kwargs):
    global pending
    real_unlink(path, **kwargs)
    if path == "handoff.json": pending = True
def fsync(fd):
    global pending
    if pending:
        pending = False
        raise OSError("synthetic fsync failure after unlink")
    return real_fsync(fd)
os.unlink, os.fsync = unlink, fsync
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
' "\$@"
SH
  chmod 700 "$fixture_bin/python3"
  run_cli handoff recover --lane daily-driver --reservation "$audit_fingerprint" --acknowledge audit-interruption --execute --json
  assert_equals "$cli_status" '15' 'failure after unlink reports incomplete recovery'
  assert_absent "$handoff_record" 'post-unlink failure does not pretend the record survived'
  incomplete_receipt="$(find "$fixture_state/browser-lanes/handoff-recovery" -name '*.outcome.json' -exec jq -r 'select(.state=="incomplete") | .receipt_id' {} \;)"
  assert_matches "$incomplete_receipt" '^[0-9a-f]{32}$' 'post-unlink failure records an incomplete outcome'
  assert_equals "$(jq -r '.state' "$fixture_state/browser-lanes/handoff-recovery/$incomplete_receipt.before.json")" 'authorized' 'incomplete recovery still has its before-removal audit'
  assert_contains "$cli_err" 'removal may have happened' 'post-unlink error truthfully directs state inspection'
  rm "$fixture_bin/python3"
  rmdir "$handoff_dir"
  # Preserve the original suite's isolated recovery-state baseline.
  rm "$before_receipt" "$outcome_receipt"
  rm "$fixture_state/browser-lanes/handoff-recovery/$legacy_receipt.before.json" "$fixture_state/browser-lanes/handoff-recovery/$legacy_receipt.outcome.json"
  rm "$fixture_state/browser-lanes/handoff-recovery/$incomplete_receipt.before.json" "$fixture_state/browser-lanes/handoff-recovery/$incomplete_receipt.outcome.json"
  rmdir "$fixture_state/browser-lanes/handoff-recovery"
  rm "$fixture_bin/jq"
  security_count=$((assertion_count - security_start))
  [[ "$security_count" -eq 121 ]] || fail "security assertion count drifted (expected 121, got $security_count)"
  if [[ "$test_selection" == '--handoff-security-only' ]]; then
    printf '1..%d\n' "$assertion_count"
    exit 0
  fi
fi

# ============================================================================
# open: declared profile dispatch without relay readiness or tab admission
# ============================================================================
if [[ "$test_selection" == 'all' || "$test_selection" == '--open-only' ]]; then
  open_argv="$TEST_ROOT/open.argv"
  openclaw_calllog="$TEST_ROOT/open.openclaw.calls"
  open_relay_argv="$TEST_ROOT/open.relay.argv"
  : >"$openclaw_calllog"
  rm -f "$open_argv" "$open_relay_argv"
  profile_sha_before_open="$(sha256_of "$profile_dir/Preferences")"
  registry_sha_before_open="$(sha256_of "$registry_path")"

  run_cli --help
  assert_equals "$cli_status" '0' 'help succeeds for open command discovery'
  assert_contains "$cli_out" 'browser-lane open --lane NAME --account-role ROLE --page-url URL' 'help discovers the open command'
  assert_contains "$cli_out" '22  browser opening outcome is uncertain' 'help documents the uncertain-opening exit'

  FAKE_BROWSER_OPEN_ARGV="$open_argv" FAKE_CHROME_ALREADY_RUNNING=1 FAKE_OPENCLAW_CALLLOG="$openclaw_calllog" \
    FAKE_OPENCLAW_FAIL=1 FAKE_MCPORTER_STATUS_ARGV="$open_relay_argv" FAKE_MCPORTER_STATUS_EXIT=41 \
    run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
  assert_equals "$cli_status" '0' 'open succeeds without a working OpenClaw relay'
  assert_equals "$cli_err" '' 'successful open keeps stderr empty'
  assert_equals "$(jq -r '.status' <<<"$cli_out")" 'ok' 'open returns a success envelope'
  assert_matches "$(jq -r '.run_id' <<<"$cli_out")" '^browser-lane:[0-9]{8}T[0-9]{6}Z:[0-9]+$' 'open returns run correlation'
  assert_equals "$(jq -r '.data.command' <<<"$cli_out")" 'open' 'open names its command'
  assert_equals "$(jq -r '.data.lane' <<<"$cli_out")" 'daily-driver' 'open reports the declared lane'
  assert_equals "$(jq -r '.data.profile_display_name' <<<"$cli_out")" 'Daily' 'open reports the verified profile display name'
  assert_equals "$(jq -c '[.data.opening,.data.authentication,.data.automation]' <<<"$cli_out")" \
    '[{"dispatch":"accepted","verification":"not_observed","focus":"requested","tab":"new_requested"},{"state":"not_checked"},{"readiness":"not_checked","admission":"unchanged"}]' \
    'open keeps dispatch, authentication, and automation observations distinct'
  assert_equals "$(jq -r '.data.retry_safe' <<<"$cli_out")" 'false' 'a successful dispatch is not safe to repeat blindly'
  assert_equals "$(jq -Rsc 'split("\n")[:-1]' "$open_argv")" \
    "[\"-n\",\"-b\",\"com.google.Chrome\",\"--args\",\"--user-data-dir=$chrome_root\",\"--profile-directory=Profile 13\",\"--new-tab\",\"$page_one\"]" \
    'open gives a running Chrome instance one exact profile-scoped new-tab request'
  assert_equals "$(<"$openclaw_calllog")" '' 'open performs no OpenClaw discovery or permission action'
  assert_absent "$open_relay_argv" 'open performs no relay readiness probe'
  assert_equals "$(sha256_of "$profile_dir/Preferences")" "$profile_sha_before_open" 'open does not read-modify-write profile preferences'
  assert_equals "$(sha256_of "$registry_path")" "$registry_sha_before_open" 'open preserves the lane registry'
  assert_absent "$lease_dir" 'successful open releases its short command lease'

  rm "$open_argv"
  FAKE_NATIVE_OPEN_STATE=reused FAKE_NATIVE_OPEN_REASON=exact_tab_reused FAKE_BROWSER_OPEN_ARGV="$open_argv" \
    run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
  assert_equals "$cli_status" '0' 'an existing exact tab can be prepared without admission'
  assert_equals "$(jq -r '.data.opening.tab' <<<"$cli_out")" 'reused' 'an exact existing tab is reported as reused'
  assert_equals "$(jq -r '.data.opening.verification' <<<"$cli_out")" 'exact_url_observed' 'reuse reports observed URL verification separately from authentication'
  assert_absent "$open_argv" 'reuse issues no new-tab launch request'
  assert_equals "$cli_err" '' 'reuse keeps stderr empty'
  assert_not_contains "$cli_out" "$page_one" 'reuse output omits the exact URL'
  assert_absent "$lease_dir" 'reuse releases the short command lease'

  for native_state in refused malformed; do
    FAKE_NATIVE_OPEN_STATE="$native_state" FAKE_NATIVE_OPEN_REASON=exact_tab_ambiguous FAKE_BROWSER_OPEN_ARGV="$open_argv" \
      run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
    assert_equals "$cli_status" '22' 'an ambiguous or unreadable tab check stops preparation'
    assert_absent "$open_argv" 'an uncertain native check never falls back to a new tab'
    assert_not_contains "$cli_out$cli_err" 'PRIVATE-NATIVE-ERROR-SENTINEL' 'native failure details remain private'
    assert_absent "$lease_dir" 'native refusal releases the short command lease'
  done

  # Execute the production JXA through the real transport, replacing only
  # macOS's Application object. No fake page-content API exists in this model.
  for model_case in reuse no-position partial-position duplicate absent hidden unreadable selection-race changed missing-profile ambiguous-profile closed; do
    rm -f "$open_argv"
    native_model_log="$TEST_ROOT/native-model.log"
    : >"$native_model_log"
    FAKE_NATIVE_MODEL="$model_case" FAKE_NATIVE_MODEL_LOG="$native_model_log" FAKE_BROWSER_OPEN_ARGV="$open_argv" \
      run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
    case "$model_case" in
      reuse|no-position|absent|closed) model_status=0 ;;
      *) model_status=22 ;;
    esac
    assert_equals "$cli_status" "$model_status" "native model $model_case reaches the expected public outcome"
    case "$model_case" in
      absent|closed) assert_present "$open_argv" "native model $model_case permits creation only after absence" ;;
      *) assert_absent "$open_argv" "native model $model_case never requests another tab" ;;
    esac
    assert_not_contains "$cli_out$cli_err" "$page_one" "native model $model_case keeps URL metadata out of output"
    if [[ "$model_case" == 'reuse' || "$model_case" == 'no-position' ]]; then
      assert_equals "$(jq -r '.data.opening.tab' <<<"$cli_out")" 'reused' 'real native algorithm finds the exact tab through the public command'
      assert_equals "$(jq -r '.data.opening.focus' <<<"$cli_out")" 'focused' 'real native algorithm confirms focus before public success'
      assert_contains "$(<"$native_model_log")" 'focused' 'the native algorithm actually requests focus in the host double'
    fi
    case "$model_case" in
      duplicate|absent) assert_equals "$(grep '^selected:' "$native_model_log" | tail -n 1)" 'selected:1' 'the native algorithm restores the original tab after absent or duplicate matching' ;;
      hidden|missing-profile) assert_contains "$(<"$native_model_log")" 'reads:0' 'an incomplete profile inventory reads no URL metadata' ;;
    esac
  done

  for model_case in bare-host bare-host-query bare-host-fragment query-distinct fragment-distinct; do
    case "$model_case" in
      bare-host) model_url='https://fixture.invalid'; expected_tab='reused' ;;
      bare-host-query) model_url='https://fixture.invalid?view=one'; expected_tab='reused' ;;
      bare-host-fragment) model_url='https://fixture.invalid#one'; expected_tab='reused' ;;
      query-distinct) model_url='https://fixture.invalid?view=one'; expected_tab='new_requested' ;;
      fragment-distinct) model_url='https://fixture.invalid#one'; expected_tab='new_requested' ;;
    esac
    rm -f "$open_argv"
    FAKE_NATIVE_MODEL="$model_case" FAKE_NATIVE_MODEL_LOG="$native_model_log" FAKE_BROWSER_OPEN_ARGV="$open_argv" \
      run_cli open --lane daily-driver --account-role owner --page-url "$model_url" --json
    assert_equals "$cli_status" '0' "native model $model_case succeeds through the public command"
    assert_equals "$(jq -r '.data.opening.tab' <<<"$cli_out")" "$expected_tab" "native model $model_case preserves URL matching semantics"
    if [[ "$expected_tab" == 'reused' ]]; then
      assert_absent "$open_argv" "native model $model_case avoids duplicate creation"
    else
      assert_present "$open_argv" "native model $model_case preserves distinct query or fragment"
    fi
  done

  rm -f "$open_argv"
  : >"$native_model_log"
  FAKE_NATIVE_MODEL=scaled FAKE_NATIVE_MODEL_LOG="$native_model_log" FAKE_BROWSER_OPEN_ARGV="$open_argv" \
    run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
  assert_equals "$cli_status" '0' 'a realistic twelve-tab native scan finishes within its deadline'
  assert_equals "$(jq -r '.data.opening.tab' <<<"$cli_out")" 'reused' 'the scaled scan reuses its exact target'
  assert_absent "$open_argv" 'the scaled scan creates no duplicate tab'

  rm -f "$open_argv"
  FAKE_NATIVE_OPEN_STATE=interrupted FAKE_NATIVE_PID_FILE="$TEST_ROOT/native.pid" FAKE_NATIVE_SLEEP_PID_FILE="$TEST_ROOT/native-sleep.pid" FAKE_BROWSER_OPEN_ARGV="$open_argv" \
    run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
  assert_equals "$cli_status" '22' 'an interrupted native transport refuses public opening'
  assert_absent "$open_argv" 'native transport interruption creates no tab'
  if kill -0 "$(<"$TEST_ROOT/native.pid")" 2>/dev/null; then fail 'native transport must retire before the public command returns'; fi
  pass 'native transport retires its child before public command completion'
  if kill -0 "$(<"$TEST_ROOT/native-sleep.pid")" 2>/dev/null; then fail 'native transport must retire its sleep descendant before the public command returns'; fi
  pass 'native transport retires its sleep descendant before public command completion'

  HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
    BROWSER_LANE_OPEN_BIN="$fixture_bin/browser-lane-open" FAKE_BROWSER_OPEN_ARGV="$open_argv" \
    FAKE_NATIVE_OPEN_STARTED_FILE="$TEST_ROOT/native-open-started" \
    "$fixture_repo/bin/browser-lane" open --lane daily-driver --account-role owner --page-url "$page_one" --json \
    >"$TEST_ROOT/native-signal.out" 2>"$TEST_ROOT/native-signal.err" &
  native_signal_pid=$!
  for _ in {1..30}; do [[ -f "$TEST_ROOT/native-open-started" ]] && break; sleep 0.1; done
  assert_present "$TEST_ROOT/native-open-started" 'public cancellation reaches the native selection interval'
  kill -TERM "$native_signal_pid"
  set +e
  wait "$native_signal_pid"
  native_signal_status=$?
  set -e
  assert_equals "$native_signal_status" '22' 'public cancellation during the native check cannot continue to opening'
  assert_absent "$open_argv" 'public cancellation never falls through to a new-tab request'
  assert_absent "$lease_dir" 'public cancellation releases custody only on terminal exit'

  FAKE_NATIVE_OPEN_STATE=reused FAKE_NATIVE_OPEN_REASON=exact_tab_reused \
    run_cli open --lane daily-driver --account-role owner --page-url "$page_one"
  assert_equals "$cli_status" '0' 'human reuse output succeeds'
  assert_contains "$cli_out" 'opening=reused' 'human open output distinguishes reuse from dispatch'
  assert_not_contains "$cli_out" 'opening=dispatched' 'human reuse output never claims a new-tab dispatch'
  assert_equals "$cli_err" '' 'human reuse output keeps stderr empty'

  real_jq="$(command -v jq)"
  cat >"$fixture_bin/jq" <<'SH'
#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == '{status:"ok",run_id:$run_id,data:$data}' ]]; then
    kill -TERM "$PPID"
    break
  fi
done
exec "$FAKE_REAL_JQ" "$@"
SH
  chmod 700 "$fixture_bin/jq"
  FAKE_REAL_JQ="$real_jq" FAKE_NATIVE_OPEN_STATE=reused FAKE_NATIVE_OPEN_REASON=exact_tab_reused \
    run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
  rm "$fixture_bin/jq"
  assert_equals "$cli_status" '0' 'a signal during success rendering does not misclassify completed preparation'
  assert_equals "$(jq -r '.data.opening.tab' <<<"$cli_out")" 'reused' 'late signal preserves the observed preparation result'
  assert_equals "$cli_err" '' 'late signal emits no contradictory uncertain-opening error'
  assert_absent "$lease_dir" 'late signal releases the completed command lease'

  FAKE_CHROME_ALREADY_RUNNING=0 run_cli open --lane daily-driver --account-role owner --page-url "$page_two"
  assert_equals "$cli_status" '0' 'open dispatch succeeds when Chrome is closed'
  assert_contains "$cli_out" 'opening=dispatched' 'human open output reports dispatch without overstating verification'
  assert_contains "$cli_out" 'authentication=not_checked' 'human open output does not infer authentication'
  assert_contains "$cli_out" 'automation=not_checked' 'human open output does not infer automation readiness'

  : >"$open_argv"
  run_cli open --lane daily-driver --account-role wrong --page-url "$page_one" --json
  assert_equals "$cli_status" '11' 'open refuses the wrong account role'
  assert_contains "$cli_err" 'account_role_mismatch' 'wrong-role refusal is typed'
  assert_equals "$(<"$open_argv")" '' 'wrong-role refusal launches no browser'

  run_cli open --lane daily-driver --account-role owner --page-url 'https://fixture-user@fixture.invalid/' --json
  assert_equals "$cli_status" '2' 'open refuses a URL containing user information'
  assert_contains "$cli_err" 'ordinary HTTP or HTTPS URL' 'unsafe URL refusal names the accepted input'
  assert_equals "$(<"$open_argv")" '' 'unsafe URL refusal launches no browser'

  open_handoff_nonce_hash="$(printf fixture-open-handoff | shasum -a 256 | awk '{print $1}')"
  mkdir -p "$handoff_dir"
  chmod 700 "$handoff_dir"
  jq -cn --arg hash "$open_handoff_nonce_hash" --argjson opened_at_epoch "$(date +%s)" \
    '{schema_version:1,lane:"daily-driver",account_role:"owner",task_ref:"open-proof",site_origin:"https://fixture.invalid",opened_at_epoch:$opened_at_epoch,window_seconds:86400,nonce_sha256:$hash}' \
    >"$handoff_record"
  chmod 600 "$handoff_record"
  handoff_sha_before_open="$(sha256_of "$handoff_record")"
  run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
  assert_equals "$cli_status" '19' 'an active reservation blocks a new profile opening'
  assert_contains "$cli_err" 'handoff_open' 'reservation ownership stays distinct from browser-opening failure'
  assert_equals "$(sha256_of "$handoff_record")" "$handoff_sha_before_open" 'blocked open preserves the reservation bytes'
  assert_equals "$(<"$open_argv")" '' 'reserved-lane refusal launches no browser'
  assert_absent "$lease_dir" 'reserved-lane refusal releases its short command lease'
  rm "$handoff_record"
  rmdir "$handoff_dir"

  mkdir "$lease_dir"
  run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
  assert_equals "$cli_status" '13' 'an active lane owner blocks a profile opening'
  assert_contains "$cli_err" 'lane_busy_initializing' 'busy ownership stays distinct from browser-opening failure'
  assert_equals "$(<"$open_argv")" '' 'busy refusal launches no browser'
  rmdir "$lease_dir"

  cp "$registry_path" "$TEST_ROOT/open-registry.original"
  cp "$chrome_root/Local State" "$TEST_ROOT/open-local-state.original"
  mkdir -p "$chrome_root/Profile 14"
  cp "$profile_dir/Preferences" "$chrome_root/Profile 14/Preferences"
  jq '.profile.info_cache["Profile 14"]={"name":"Work"}' "$chrome_root/Local State" >"$TEST_ROOT/open-local-state.work"
  mv "$TEST_ROOT/open-local-state.work" "$chrome_root/Local State"
  jq '.lanes.specialist=(.lanes["daily-driver"] + {profile_directory:"Profile 14",profile_display_name:"Work",account_role:"specialist",relay_port:18798})' \
    "$registry_path" >"$TEST_ROOT/open-registry.work"
  mv "$TEST_ROOT/open-registry.work" "$registry_path"
  chmod 600 "$registry_path"
  : >"$open_argv"
  FAKE_BROWSER_OPEN_ARGV="$open_argv" run_cli open --lane specialist --account-role specialist --page-url "$page_one" --json
  assert_equals "$cli_status" '0' 'open resolves the second configured profile role'
  assert_equals "$(jq -r '.data.profile_display_name' <<<"$cli_out")" 'Work' 'second-role open reports its profile display name'
  assert_contains "$(<"$open_argv")" '--profile-directory=Profile 14' 'second-role open dispatches to its own profile directory'

  jq '.lanes.specialist=(.lanes["daily-driver"] + {profile_directory:"Profile 13",profile_display_name:"Daily",account_role:"specialist",relay_port:18798})' \
    "$registry_path" >"$TEST_ROOT/open-registry.ambiguous"
  mv "$TEST_ROOT/open-registry.ambiguous" "$registry_path"
  chmod 600 "$registry_path"
  : >"$open_argv"
  run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
  assert_equals "$cli_status" '11' 'open refuses a profile directory declared by multiple lanes'
  assert_contains "$cli_err" 'profile_mapping_ambiguous' 'ambiguous profile mapping is typed'
  assert_equals "$(<"$open_argv")" '' 'ambiguous mapping launches no browser'

  mv "$TEST_ROOT/open-registry.original" "$registry_path"
  chmod 600 "$registry_path"
  jq '.profile.info_cache["Profile 14"].name="Daily"' "$chrome_root/Local State" >"$TEST_ROOT/open-duplicate-name"
  mv "$TEST_ROOT/open-duplicate-name" "$chrome_root/Local State"
  run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
  assert_equals "$cli_status" '11' 'native reuse refuses duplicate local profile display names'
  assert_contains "$cli_err" 'profile_mapping_ambiguous' 'duplicate display-name refusal reports profile ambiguity'
  assert_equals "$(<"$open_argv")" '' 'duplicate local profile names cause no tab creation'
  mv "$TEST_ROOT/open-local-state.original" "$chrome_root/Local State"
  rm -rf "$chrome_root/Profile 14"

  : >"$open_argv"
  FAKE_BROWSER_OPEN_ARGV="$open_argv" FAKE_BROWSER_OPEN_EXIT=130 \
    run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
  assert_equals "$cli_status" '22' 'an interrupted browser dispatch has a dedicated exit status'
  interrupted_error="$(tail -n 1 <<<"$cli_err")"
  assert_equals "$(jq -r '.error.code' <<<"$interrupted_error")" 'browser_opening_uncertain' 'interrupted dispatch is typed as uncertain'
  assert_equals "$(jq -r '.error.retry_safe' <<<"$interrupted_error")" 'false' 'interrupted dispatch forbids blind retry'
  assert_contains "$(jq -r '.error.next' <<<"$interrupted_error")" 'visible profile' 'interrupted dispatch directs visible inspection before retry'
  assert_not_contains "$cli_out$cli_err" "$page_one" 'uncertain dispatch diagnostics omit the requested URL'
  assert_absent "$lease_dir" 'uncertain dispatch releases its short command lease'

  BROWSER_LANE_OPEN_BIN="$TEST_ROOT/missing-opener" run_cli open --lane daily-driver --account-role owner --page-url "$page_one" --json
  assert_equals "$cli_status" '14' 'a missing browser opener is a typed dependency failure'
  assert_contains "$cli_err" 'browser_opener_missing' 'missing opener failure names its cause'
  assert_equals "$cli_out" '' 'missing opener failure keeps stdout empty'

  if [[ "$test_selection" == '--open-only' ]]; then
    [[ "$assertion_count" -eq "$EXPECTED_OPEN_ASSERTIONS" ]] ||
      fail "open assertion count drifted (expected $EXPECTED_OPEN_ASSERTIONS, got $assertion_count)"
    printf '1..%d\n' "$assertion_count"
    exit 0
  fi
fi

# Installed Playwright CLI 0.1.17 reports tool errors in JSON while exiting 0.
# Public process oracle: failure status, no subsequent mutation, clean custody.
if [[ "$test_selection" == 'all' || "$test_selection" == '--adapter-hardening-only' ]]; then
  hardening_plan="$TEST_ROOT/playwright-hardening.json"
  hardening_log="$TEST_ROOT/playwright-hardening.log"
  for failure_kind in throw reject; do
    script_source="() => { throw new Error('SCRIPT-FAILURE-SENTINEL'); }"
    [[ "$failure_kind" != reject ]] || script_source="async () => { await Promise.reject(new Error('SCRIPT-FAILURE-SENTINEL')); }"
    jq -cn --arg source "$script_source" '{schema_version:2,actions:[{command:"evaluate",args:[$source]},{command:"click",args:["e7"]}]}' >"$hardening_plan"
    chmod 600 "$hardening_plan"
    : >"$hardening_log"
    FAKE_MCPORTER_EXEC_CHILD=1 \
    FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
    FAKE_PLAYWRIGHT_CLI_LOG="$hardening_log" FAKE_PLAYWRIGHT_DAEMON_PID="$TEST_ROOT/hardening-daemon.pid" \
      run_cli playwright --lane daily-driver --account-role owner --run-id "hardening-$failure_kind" --page-url "$page_one" --plan "$hardening_plan"
    assert_equals "$cli_status" '1' "Playwright $failure_kind is a command failure despite vendor exit zero"
    assert_contains "$cli_err" 'playwright_action_failed' "Playwright $failure_kind has typed failure"
    assert_contains "$cli_out" 'SCRIPT-FAILURE-SENTINEL' "Playwright $failure_kind preserves script diagnosis"
    assert_not_contains "$(cat "$hardening_log")" 'arg=click' "Playwright $failure_kind stops remaining actions"
    assert_contains "$(cat "$hardening_log")" 'arg=detach' "Playwright $failure_kind retires the session"
    assert_absent "$lease_dir" "Playwright $failure_kind releases custody after retirement"
  done
  jq -cn '{schema_version:2,actions:[{command:"evaluate",args:["() => false"]}]}' >"$hardening_plan"
  FAKE_MCPORTER_EXEC_CHILD=1 \
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
  FAKE_PLAYWRIGHT_DAEMON_PID="$TEST_ROOT/hardening-daemon.pid" \
    run_cli playwright --lane daily-driver --account-role owner --run-id hardening-false --page-url "$page_one" --plan "$hardening_plan"
  assert_equals "$cli_status" '0' 'Playwright returned false remains successful data'
  assert_contains "$cli_out" 'SCRIPT-RESULT-false' 'Playwright returned false is preserved'
  jq -cn '{schema_version:1,actions:[{command:"snapshot",args:[]},{command:"click",args:["e7"]}]}' >"$hardening_plan"
  : >"$hardening_log"
  FAKE_MCPORTER_EXEC_CHILD=1 \
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
  FAKE_PLAYWRIGHT_NAVIGATION_MARKER="$TEST_ROOT/navigation-marker" \
  FAKE_PLAYWRIGHT_CLI_LOG="$hardening_log" FAKE_PLAYWRIGHT_DAEMON_PID="$TEST_ROOT/hardening-daemon.pid" \
    run_cli playwright --lane daily-driver --account-role owner --run-id hardening-navigation --page-url "$page_one" --plan "$hardening_plan"
  assert_equals "$cli_status" '16' 'Playwright stops at a changed URL after an ordinary action'
  assert_not_contains "$(cat "$hardening_log")" 'arg=click' 'Playwright never dispatches the next action to a changed URL'
  assert_contains "$(cat "$hardening_log")" 'arg=run-code' 'Playwright obtains URL evidence from the host Page object'
  assert_not_contains "$(cat "$hardening_log")" 'crypto.subtle' 'Playwright URL proof does not execute page-owned hashing'
  assert_absent "$lease_dir" 'Playwright changed-page failure retires custody'
  assert_contains "$cli_err" 'current ordinary URL' 'Playwright navigation recovery observes the current URL'
  assert_contains "$cli_err" 'Do not replay' 'Playwright navigation recovery preserves uncertain effects'

  for held_command in snapshot detach ignored-termination; do
    : >"$hardening_log"
    ignore_term=0
    [[ "$held_command" != ignored-termination ]] || ignore_term=1
    FAKE_PLAYWRIGHT_IGNORE_TERM="$ignore_term" FAKE_SLEEP_PID_LOG="$TEST_ROOT/held-$held_command.pids" \
    FAKE_MCPORTER_EXEC_CHILD=1 \
    FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
    FAKE_PLAYWRIGHT_HOLD_COMMAND="$held_command" FAKE_PLAYWRIGHT_HOLD_SECONDS=5 \
    FAKE_PLAYWRIGHT_CLI_LOG="$hardening_log" FAKE_PLAYWRIGHT_DAEMON_PID="$TEST_ROOT/hardening-daemon.pid" \
      run_cli playwright --lane daily-driver --account-role owner --run-id "hardening-held-$held_command" --ttl 1 --page-url "$page_one" --plan "$hardening_plan"
    expected_status=124
    [[ "$held_command" == snapshot ]] || expected_status=17
    assert_equals "$cli_status" "$expected_status" "Playwright bounds held $held_command"
    assert_absent "$lease_dir" "Playwright held $held_command releases custody after retirement"
    if kill -0 "$(cat "$TEST_ROOT/hardening-daemon.pid")" 2>/dev/null; then
      fail "Playwright held $held_command leaves daemon alive"
    fi
    pass "Playwright held $held_command retires the daemon"
    assert_logged_pids_dead "$TEST_ROOT/held-$held_command.pids" "Playwright held $held_command"
  done

  : >"$hardening_log"
  HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
  FAKE_MCPORTER_EXEC_CHILD=1 FAKE_PLAYWRIGHT_HOLD_COMMAND=snapshot FAKE_PLAYWRIGHT_HOLD_SECONDS=5 \
  FAKE_SLEEP_PID_LOG="$TEST_ROOT/public-signal.pids" \
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
  FAKE_PLAYWRIGHT_CLI_LOG="$hardening_log" FAKE_PLAYWRIGHT_DAEMON_PID="$TEST_ROOT/hardening-daemon.pid" \
    "$fixture_repo/bin/browser-lane" playwright --lane daily-driver --account-role owner --run-id hardening-public-signal --ttl 30 --page-url "$page_one" --plan "$hardening_plan" >"$TEST_ROOT/public-signal.out" 2>"$TEST_ROOT/public-signal.err" &
  public_signal_pid=$!
  for _ in {1..100}; do
    rg -q 'arg=snapshot' "$hardening_log" && break
    /bin/sleep 0.05
  done
  assert_contains "$(cat "$hardening_log")" 'arg=snapshot' 'public Playwright signal reaches a running action'
  assert_present "$lease_dir" 'public Playwright retains custody while action runs'
  kill -TERM "$public_signal_pid"
  set +e
  wait "$public_signal_pid"
  public_signal_status=$?
  set -e
  assert_equals "$public_signal_status" '130' 'public Playwright forwards cancellation and reports interruption'
  assert_absent "$lease_dir" 'public Playwright releases custody after cancelled helper retires'
  assert_contains "$(cat "$hardening_log")" 'arg=detach' 'public Playwright cancellation attempts session detach'
  assert_logged_pids_dead "$TEST_ROOT/public-signal.pids" 'public Playwright cancellation'

  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
  FAKE_AGENT_BROWSER_NAVIGATION_MARKER="$TEST_ROOT/agent-navigation" FAKE_AGENT_BROWSER_ACTION_LOG="$TEST_ROOT/agent-actions" \
    run_cli agent-browser --lane daily-driver --account-role owner --run-id hardening-agent-navigation --page-url "$page_one" -- 'click @e1' 'fill @e2 forbidden-value'
  assert_equals "$cli_status" '16' 'Agent Browser stops after action navigation'
  assert_not_contains "$(cat "$TEST_ROOT/agent-actions")" 'forbidden-value' 'Agent Browser never dispatches the next action after navigation'
  assert_contains "$cli_err" 'agent_browser_page_mismatch' 'Agent Browser navigation failure is typed'
  assert_contains "$cli_err" 'current ordinary URL' 'Agent Browser navigation recovery observes the current URL'
  assert_contains "$cli_err" 'Do not replay' 'Agent Browser navigation recovery preserves uncertain effects'
  assert_absent "$lease_dir" 'Agent Browser navigation failure releases retired custody'

  same_site_agent_actions="$TEST_ROOT/agent-same-site-actions"
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
  FAKE_AGENT_BROWSER_NAVIGATION_MARKER="$TEST_ROOT/agent-same-site-navigation" \
  FAKE_AGENT_BROWSER_POST_URL="$page_two" FAKE_AGENT_BROWSER_ACTION_LOG="$same_site_agent_actions" \
    run_cli agent-browser --lane daily-driver --account-role owner --run-id hardening-agent-same-site \
      --page-url "$page_one" -- 'click @e1' 'snapshot'
  assert_equals "$cli_status" '0' 'Agent Browser keeps a batch running after same-site navigation'
  assert_equals "$(rg -c '^snapshot$' "$same_site_agent_actions")" '1' 'Agent Browser dispatches the next action after same-site navigation'
  assert_contains "$(<"$same_site_agent_actions")" 'snapshot' 'Agent Browser completes work on the same-site path'
  assert_absent "$lease_dir" 'Agent Browser same-site navigation releases retired custody'

  # A caller may explicitly name one expected ordinary destination for one
  # terminal action. The initial and post-action Agent Browser tab snapshots
  # are independent fixture facts: a same-site URL is not enough when the
  # original CDP target changed, vanished, or became ambiguous.
  next_page="$page_one?after=save"
  agent_next_tabs="$TEST_ROOT/agent-next-tabs.log"
  agent_next_tab_count="$TEST_ROOT/agent-next-tabs.count"
  agent_next_url_count="$TEST_ROOT/agent-next-url.count"
  agent_next_actions="$TEST_ROOT/agent-next-actions.log"
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
  FAKE_AGENT_BROWSER_PAGE_URL="$page_one" FAKE_AGENT_BROWSER_POST_URL="$next_page" \
  FAKE_AGENT_BROWSER_TAB_LIST_LOG="$agent_next_tabs" FAKE_AGENT_BROWSER_TAB_LIST_COUNT_FILE="$agent_next_tab_count" \
  FAKE_AGENT_BROWSER_GET_URL_COUNT_FILE="$agent_next_url_count" FAKE_AGENT_BROWSER_ACTION_LOG="$agent_next_actions" \
    run_cli agent-browser --lane daily-driver --account-role owner --run-id hardening-agent-next-page \
      --page-url "$page_one" --next-page-url "$next_page" -- 'click @save'
  assert_equals "$cli_status" '0' 'Agent Browser accepts one explicitly expected same-site navigation'
  assert_equals "$cli_out" '{"status":"ok","action":"completed","page":"transitioned","remaining":0,"cleanup":"confirmed"}' \
    'expected Agent Browser navigation emits its bounded success receipt'
  assert_equals "$(<"$agent_next_tabs")" $'initial\npost' 'expected navigation rechecks the original target in a post-action tab snapshot'
  assert_contains "$(<"$agent_next_actions")" 'click @save' 'expected navigation executes its terminal action once'
  assert_absent "$lease_dir" 'expected navigation retires custody before success'

  agent_delayed_tabs="$TEST_ROOT/agent-delayed-next-tabs.log"
  agent_delayed_tab_count="$TEST_ROOT/agent-delayed-next-tabs.count"
  agent_delayed_actions="$TEST_ROOT/agent-delayed-next-actions.log"
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
  FAKE_AGENT_BROWSER_PAGE_URL="$page_one" FAKE_AGENT_BROWSER_POST_URL="$next_page" FAKE_AGENT_BROWSER_POST_INITIAL_OBSERVATIONS=2 \
  FAKE_AGENT_BROWSER_TAB_LIST_LOG="$agent_delayed_tabs" FAKE_AGENT_BROWSER_TAB_LIST_COUNT_FILE="$agent_delayed_tab_count" \
  FAKE_AGENT_BROWSER_GET_URL_COUNT_FILE="$TEST_ROOT/agent-delayed-next-url.count" FAKE_AGENT_BROWSER_ACTION_LOG="$agent_delayed_actions" \
    run_cli agent-browser --lane daily-driver --account-role owner --run-id hardening-agent-next-delayed \
      --page-url "$page_one" --next-page-url "$next_page" -- 'click @save'
  assert_equals "$cli_status" '0' 'expected navigation tolerates one unchanged post-action observation'
  assert_equals "$(<"$agent_delayed_tabs")" $'initial\npost\npost' 'delayed expected navigation makes one bounded observation-only retry'
  assert_equals "$(<"$agent_delayed_tab_count")" '3' 'delayed expected navigation observes the tab only through its converged destination'
  assert_equals "$(rg -c '^click @save$' "$agent_delayed_actions")" '1' 'delayed expected navigation never replays its action'
  assert_absent "$lease_dir" 'delayed expected navigation retires custody before success'

  agent_recheck_tabs="$TEST_ROOT/agent-recheck-next-tabs.log"
  agent_recheck_tab_count="$TEST_ROOT/agent-recheck-next-tabs.count"
  agent_recheck_actions="$TEST_ROOT/agent-recheck-next-actions.log"
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
  FAKE_AGENT_BROWSER_PAGE_URL="$page_one" FAKE_AGENT_BROWSER_POST_URL="$next_page" FAKE_AGENT_BROWSER_POST_INITIAL_OBSERVATIONS=2 FAKE_AGENT_BROWSER_POST_TAB_LIST_STATE=changed-on-recheck \
  FAKE_AGENT_BROWSER_TAB_LIST_LOG="$agent_recheck_tabs" FAKE_AGENT_BROWSER_TAB_LIST_COUNT_FILE="$agent_recheck_tab_count" \
  FAKE_AGENT_BROWSER_GET_URL_COUNT_FILE="$TEST_ROOT/agent-recheck-next-url.count" FAKE_AGENT_BROWSER_ACTION_LOG="$agent_recheck_actions" \
    run_cli agent-browser --lane daily-driver --account-role owner --run-id hardening-agent-next-recheck-changed \
      --page-url "$page_one" --next-page-url "$next_page" -- 'click @save'
  assert_equals "$cli_status" '16' 'changed target after a current destination read fails closed'
  assert_contains "$cli_err" 'agent_browser_page_mismatch' 'changed target after current destination read has a typed proof failure'
  assert_contains "$cli_err" '"retry_safe":false' 'changed target after current destination read never advertises replay'
  assert_equals "$(<"$agent_recheck_tabs")" $'initial\npost\npost' 'changed target after current destination read performs an identity recheck'
  assert_equals "$(rg -c '^click @save$' "$agent_recheck_actions")" '1' 'changed target after current destination read never repeats the action'
  assert_absent "$lease_dir" 'changed target after current destination read retires custody'

  agent_static_tabs="$TEST_ROOT/agent-static-next-tabs.log"
  agent_static_tab_count="$TEST_ROOT/agent-static-next-tabs.count"
  agent_static_actions="$TEST_ROOT/agent-static-next-actions.log"
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
  FAKE_AGENT_BROWSER_PAGE_URL="$page_one" FAKE_AGENT_BROWSER_POST_URL="$next_page" FAKE_AGENT_BROWSER_POST_INITIAL_OBSERVATIONS=5 \
  FAKE_AGENT_BROWSER_TAB_LIST_LOG="$agent_static_tabs" FAKE_AGENT_BROWSER_TAB_LIST_COUNT_FILE="$agent_static_tab_count" \
  FAKE_AGENT_BROWSER_ACTION_LOG="$agent_static_actions" \
    run_cli agent-browser --lane daily-driver --account-role owner --run-id hardening-agent-next-static \
      --page-url "$page_one" --next-page-url "$next_page" -- 'click @save'
  assert_equals "$cli_status" '16' 'unchanged post-action tab state fails after the bounded observation window'
  assert_contains "$cli_err" 'agent_browser_page_mismatch' 'unchanged post-action tab state remains typed as a destination mismatch'
  assert_contains "$cli_err" '"retry_safe":false' 'unchanged post-action tab state never advertises replay'
  assert_equals "$(<"$agent_static_tabs")" $'initial\npost\npost\npost\npost\npost' 'unchanged post-action tab state makes exactly five observations'
  assert_equals "$(rg -c '^click @save$' "$agent_static_actions")" '1' 'unchanged post-action tab state never repeats the action'
  assert_absent "$lease_dir" 'unchanged post-action tab state retires custody'

  agent_unreadable_tabs="$TEST_ROOT/agent-unreadable-next-tabs.log"
  agent_unreadable_tab_count="$TEST_ROOT/agent-unreadable-next-tabs.count"
  agent_unreadable_url_count="$TEST_ROOT/agent-unreadable-next-url.count"
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
  FAKE_AGENT_BROWSER_PAGE_URL="$page_one" FAKE_AGENT_BROWSER_POST_URL="$next_page" FAKE_AGENT_BROWSER_URL_STATE=post-unreadable \
  FAKE_AGENT_BROWSER_TAB_LIST_LOG="$agent_unreadable_tabs" FAKE_AGENT_BROWSER_TAB_LIST_COUNT_FILE="$agent_unreadable_tab_count" \
  FAKE_AGENT_BROWSER_GET_URL_COUNT_FILE="$agent_unreadable_url_count" \
    run_cli agent-browser --lane daily-driver --account-role owner --run-id hardening-agent-next-unreadable \
      --page-url "$page_one" --next-page-url "$next_page" -- 'click @save'
  assert_equals "$cli_status" '0' 'expected navigation survives a post-action Agent Browser URL read failure'
  assert_equals "$(<"$agent_unreadable_tabs")" $'initial\npost' 'post-action URL failure rechecks the same target and exact expected destination'
  assert_absent "$lease_dir" 'post-action URL recovery retires custody before success'

  assert_expected_navigation_refused() {
    local state="$1" label="$2" expected_code tabs tab_count url_count actions
    expected_code='agent_browser_page_unreadable'
    tabs="$TEST_ROOT/agent-next-$state-tabs.log"
    tab_count="$TEST_ROOT/agent-next-$state-tabs.count"
    url_count="$TEST_ROOT/agent-next-$state-url.count"
    actions="$TEST_ROOT/agent-next-$state-actions.log"
    FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
    FAKE_AGENT_BROWSER_PAGE_URL="$page_one" FAKE_AGENT_BROWSER_POST_URL="$next_page" FAKE_AGENT_BROWSER_POST_TAB_LIST_STATE="$state" \
    FAKE_AGENT_BROWSER_TAB_LIST_LOG="$tabs" FAKE_AGENT_BROWSER_TAB_LIST_COUNT_FILE="$tab_count" \
    FAKE_AGENT_BROWSER_GET_URL_COUNT_FILE="$url_count" FAKE_AGENT_BROWSER_ACTION_LOG="$actions" \
      run_cli agent-browser --lane daily-driver --account-role owner --run-id "hardening-agent-next-$state" \
        --page-url "$page_one" --next-page-url "$next_page" -- 'click @save'
    assert_equals "$cli_status" '16' "$label remains page-unresolved"
    assert_contains "$cli_err" "$expected_code" "$label has the typed target refusal"
    assert_contains "$cli_err" '"retry_safe":false' "$label never advertises replay"
    assert_equals "$(<"$tabs")" $'initial\npost' "$label obtains independent post-action target evidence"
    assert_contains "$(<"$actions")" 'click @save' "$label retains the uncertain terminal effect without replay"
    assert_absent "$lease_dir" "$label retires custody"
  }
  assert_expected_navigation_refused unreadable 'revoked post-navigation attachment'
  assert_expected_navigation_refused changed 'replacement tab with an index-equivalent destination'
  assert_expected_navigation_refused ambiguous 'ambiguous post-navigation target set'

  agent_failed_tabs="$TEST_ROOT/agent-next-failed-tabs.log"
  agent_failed_tab_count="$TEST_ROOT/agent-next-failed-tabs.count"
  agent_failed_actions="$TEST_ROOT/agent-next-failed-actions.log"
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE ('"$page_one"$') [selected]' \
  FAKE_AGENT_BROWSER_PAGE_URL="$page_one" FAKE_AGENT_BROWSER_POST_URL="$next_page" FAKE_MCPORTER_AGENT_STATUS=19 \
  FAKE_AGENT_BROWSER_TAB_LIST_LOG="$agent_failed_tabs" FAKE_AGENT_BROWSER_TAB_LIST_COUNT_FILE="$agent_failed_tab_count" \
  FAKE_AGENT_BROWSER_ACTION_LOG="$agent_failed_actions" \
    run_cli agent-browser --lane daily-driver --account-role owner --run-id hardening-agent-next-failed \
      --page-url "$page_one" --next-page-url "$next_page" -- 'click @save'
  assert_equals "$cli_status" '19' 'a failed Save action cannot infer expected-navigation success'
  assert_equals "$(<"$agent_failed_tabs")" 'initial' 'a failed Save action has no post-action navigation proof'
  assert_contains "$(<"$agent_failed_actions")" 'click @save' 'a failed Save action remains observable without replay'
  assert_absent "$lease_dir" 'a failed Save action retires custody'

  for invalid_next in 'https://changed.invalid/after-save' "$page_one" 'not-a-url'; do
    invalid_next_agent="$TEST_ROOT/invalid-next-agent.argv"
    FAKE_MCPORTER_AGENT_ARGV="$invalid_next_agent" \
      run_cli agent-browser --lane daily-driver --account-role owner --run-id hardening-agent-invalid-next \
        --page-url "$page_one" --next-page-url "$invalid_next" -- 'click @save'
    assert_equals "$cli_status" '2' 'invalid expected destination is rejected before launch'
    assert_absent "$invalid_next_agent" 'invalid expected destination never reaches the relay'
  done
  invalid_next_agent="$TEST_ROOT/invalid-next-agent.argv"
  FAKE_MCPORTER_AGENT_ARGV="$invalid_next_agent" \
    run_cli agent-browser --lane daily-driver --account-role owner --run-id hardening-agent-next-multi \
      --page-url "$page_one" --next-page-url "$next_page" -- 'click @save' 'snapshot'
  assert_equals "$cli_status" '2' 'expected navigation refuses a nonterminal batch'
  assert_absent "$invalid_next_agent" 'nonterminal expected navigation never reaches the relay'

  invalid_next_receipt="$TEST_ROOT/invalid-next-route.receipt"
  FAKE_MCPORTER_RECEIPT="$invalid_next_receipt" \
    run_cli run --lane daily-driver --account-role owner --run-id hardening-run-next-flag \
      --page-url "$page_one" --next-page-url "$next_page" -- mcporter call chrome-devtools.list_pages --args '{}'
  assert_equals "$cli_status" '2' 'non-Agent Browser routes reject the expected-navigation flag'
  assert_absent "$invalid_next_receipt" 'a rejected non-Agent Browser navigation flag launches no relay child'

fi
if [[ "$test_selection" == '--adapter-hardening-only' ]]; then
  [[ "$assertion_count" -eq "$EXPECTED_PLAYWRIGHT_HARDENING_ASSERTIONS" ]] || fail "Playwright hardening assertion count drifted: $assertion_count"
  printf '1..%d\n' "$assertion_count"
  exit 0
fi

# Hold mkdir after creation, before owner publication. Both contenders execute
# the unchanged public CLI; only the filesystem scheduling boundary is delayed.
if [[ "$test_selection" != '--inspect-only' ]]; then
  cat >"$fixture_bin/mkdir" <<'SH'
#!/usr/bin/env bash
/bin/mkdir "$@"
result=$?
if [[ "$result" == 0 && "$*" == *daily-driver.lock && -n "${FAKE_LEASE_SIGNAL:-}" ]]; then
  : >"$FAKE_LEASE_SIGNAL"
  for _ in {1..500}; do
    [[ -f "$FAKE_LEASE_RELEASE" ]] && exit 0
    /bin/sleep 0.02
  done
  exit 1
fi
exit "$result"
SH
  chmod +x "$fixture_bin/mkdir"
  HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
    FAKE_LEASE_SIGNAL="$TEST_ROOT/lease-signal" FAKE_LEASE_RELEASE="$TEST_ROOT/lease-release" \
    "$fixture_repo/bin/browser-lane" inspect --lane daily-driver --account-role owner --json \
    >"$TEST_ROOT/lease-holder.out" 2>"$TEST_ROOT/lease-holder.err" &
  publication_pid=$!
  for _ in {1..200}; do
    [[ -f "$TEST_ROOT/lease-signal" ]] && break
    /bin/sleep 0.02
  done
  assert_present "$TEST_ROOT/lease-signal" 'first inspection reaches owner-publication barrier'
  : >"$TEST_ROOT/lease-contender.calls"
  FAKE_MCPORTER_CALLLOG="$TEST_ROOT/lease-contender.calls" \
    run_cli inspect --lane daily-driver --account-role owner --json
  publication_status="$cli_status"
  publication_out="$cli_out"
  publication_error="$(tail -n 1 <<<"$cli_err")"
  # Always let the holder finish before asserting a contender result.
  : >"$TEST_ROOT/lease-release"
  wait "$publication_pid"
  assert_equals "$publication_status" '13' 'overlapping inspection exits busy during owner publication'
  assert_equals "$(jq -r '.error.code' <<<"$publication_error")" 'lane_busy_initializing' 'owner publication is distinguished from unsafe state'
  assert_equals "$(jq -r '.error.retry_safe' <<<"$publication_error")" 'true' 'publication refusal permits a bounded same-input retry'
  assert_equals "$publication_out" '' 'publication refusal leaves stdout empty'
  assert_equals "$(cat "$TEST_ROOT/lease-contender.calls")" '' 'contender launches no relay call while owner is unpublished'
  assert_equals "$(jq -r '.status' "$TEST_ROOT/lease-holder.out")" 'ok' 'first inspection completes after owner publication'
  assert_absent "$lease_dir" 'first inspection retires its own lease after publication'
  rm "$fixture_bin/mkdir"

  mkdir "$lease_dir"
  printf '%s\n' '{"run_id":"incomplete-owner","pid":999999,"process_start":"never","acquired_at_epoch":1}' >"$lease_dir/owner.json"
  chmod 600 "$lease_dir/owner.json"
  incomplete_owner_sha="$(sha256_of "$lease_dir/owner.json")"
  run_cli inspect --lane daily-driver --account-role owner --json
  assert_equals "$cli_status" '13' 'missing expiry refuses stale-owner recovery'
  assert_equals "$(tail -n 1 <<<"$cli_err" | jq -r '.error.code')" 'lane_busy_unreadable' 'malformed owner refusal is typed'
  assert_equals "$(sha256_of "$lease_dir/owner.json")" "$incomplete_owner_sha" 'malformed owner bytes are preserved'
  rm "$lease_dir/owner.json"
  rmdir "$lease_dir"

  mkdir "$TEST_ROOT/lease-target"
  ln -s "$TEST_ROOT/lease-target" "$lease_dir"
  run_cli inspect --lane daily-driver --account-role owner --json
  assert_equals "$cli_status" '13' 'symlink lease remains refused'
  assert_equals "$(tail -n 1 <<<"$cli_err" | jq -r '.error.code')" 'lane_busy_unreadable' 'symlink lease remains unsafe rather than initializing'
  assert_equals "$(tail -n 1 <<<"$cli_err" | jq -r '.error.retry_safe')" 'false' 'symlink refusal does not suggest automatic retry'
  assert_equals "$(entry_count "$TEST_ROOT/lease-target")" '0' 'unsafe lease target remains untouched'
  rm "$lease_dir"
  run_cli inspect --lane daily-driver --account-role owner --json
  assert_equals "$cli_status" '0' 'inspection recovers after test-owned unsafe state is removed'

  # Two reclaimers meet while A is paused before deleting the expired owner.
  # B must refuse before deletion, not repeat A's stale decision later.
  mkdir "$lease_dir"
  printf '%s\n' '{"run_id":"expired-owner","pid":999999,"process_start":"never","acquired_at_epoch":1,"expires_at_epoch":1}' >"$lease_dir/owner.json"
  chmod 600 "$lease_dir/owner.json"
  cat >"$fixture_bin/rm" <<'SH'
#!/usr/bin/env bash
if [[ -n "${FAKE_RECLAIM_SIGNAL:-}" && "$*" == *daily-driver.lock/owner.json && ! -e "$FAKE_RECLAIM_SIGNAL" ]]; then
  : >"$FAKE_RECLAIM_SIGNAL"
  for _ in {1..500}; do
    [[ -f "$FAKE_RECLAIM_RELEASE" ]] && break
    /bin/sleep 0.02
  done
fi
exec /bin/rm "$@"
SH
  chmod +x "$fixture_bin/rm"
  HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
    FAKE_RECLAIM_SIGNAL="$TEST_ROOT/reclaim-signal" FAKE_RECLAIM_RELEASE="$TEST_ROOT/reclaim-release" \
    "$fixture_repo/bin/browser-lane" inspect --lane daily-driver --account-role owner --run-id reclaim-a --json \
    >"$TEST_ROOT/reclaim-a.out" 2>"$TEST_ROOT/reclaim-a.err" &
  reclaim_pid=$!
  for _ in {1..200}; do
    [[ -f "$TEST_ROOT/reclaim-signal" ]] && break
    /bin/sleep 0.02
  done
  assert_present "$TEST_ROOT/reclaim-signal" 'first reclaimer reaches stale-deletion barrier'
  : >"$TEST_ROOT/reclaim-b.calls"
  FAKE_MCPORTER_CALLLOG="$TEST_ROOT/reclaim-b.calls" \
    run_cli inspect --lane daily-driver --account-role owner --run-id reclaim-b --json
  reclaim_status="$cli_status"
  reclaim_error="$(tail -n 1 <<<"$cli_err")"
  : >"$TEST_ROOT/reclaim-release"
  wait "$reclaim_pid" || true
  assert_equals "$reclaim_status" '13' 'second reclaimer cannot act on the same expired owner'
  assert_equals "$(jq -r '.error.retry_safe' <<<"$reclaim_error")" 'true' 'serialized recovery refusal permits retry after the owner finishes'
  assert_equals "$(cat "$TEST_ROOT/reclaim-b.calls")" '' 'second reclaimer never enters relay preflight'
  assert_equals "$(jq -r '.status' "$TEST_ROOT/reclaim-a.out")" 'ok' 'first reclaimer owns and completes the replacement lease'
  assert_absent "$lease_dir" 'replacement owner removes its own lease'
  assert_absent "$fixture_state/browser-lanes/leases/daily-driver.transition" 'successful recovery releases its transition claim'
  rm "$fixture_bin/rm"
  run_cli inspect --lane daily-driver --account-role owner --json
  assert_equals "$cli_status" '0' 'later inspection acquires after serialized recovery completes'

  # A signal after removing our transition must not recursively remove a
  # successor's claim at the same path. The wrapper injects that exact order.
  cat >"$fixture_bin/rmdir" <<'SH'
#!/usr/bin/env bash
/bin/rmdir "$@"
result=$?
if [[ "$result" == 0 && "$*" == *daily-driver.transition && -n "${FAKE_TRANSITION_SUCCESSOR:-}" && ! -e "$FAKE_TRANSITION_SUCCESSOR" ]]; then
  /bin/mkdir "$1"
  : >"$FAKE_TRANSITION_SUCCESSOR"
  kill -HUP "$PPID"
fi
exit "$result"
SH
  chmod +x "$fixture_bin/rmdir"
  : >"$TEST_ROOT/signal.calls"
  FAKE_TRANSITION_SUCCESSOR="$TEST_ROOT/successor-created" FAKE_MCPORTER_CALLLOG="$TEST_ROOT/signal.calls" \
    run_cli inspect --lane daily-driver --account-role owner --json
  assert_equals "$cli_status" '129' 'signal interrupts acquisition before browser work'
  assert_present "$TEST_ROOT/successor-created" 'successor transition is created at cleanup boundary'
  assert_present "$fixture_state/browser-lanes/leases/daily-driver.transition" 'signal cleanup preserves successor transition ownership'
  assert_equals "$(cat "$TEST_ROOT/signal.calls")" '' 'interrupted acquisition performs no relay call'
  rm "$fixture_bin/rmdir"
  rmdir "$fixture_state/browser-lanes/leases/daily-driver.transition"
  rm "$lease_dir/owner.json"
  rmdir "$lease_dir"
fi
if [[ "$test_selection" == '--lease-only' ]]; then
  [[ "$assertion_count" -eq "$EXPECTED_LEASE_ASSERTIONS" ]] ||
    fail "lease assertion count drifted (expected $EXPECTED_LEASE_ASSERTIONS, got $assertion_count)"
  printf '1..%d\n' "$EXPECTED_LEASE_ASSERTIONS"
  exit 0
fi

# inspect shares the production inventory parser with every engine gate.
# Literal states below are independent public-contract oracles, not calculated
# from the parser. No fixture operation changes live profiles or admission.
inspect_calllog="$TEST_ROOT/inspect.calllog"
inspect_receipt="$TEST_ROOT/inspect.receipt"
inspect_profile_sha="$(sha256_of "$profile_dir/Preferences")"
inspect_registry_sha="$(sha256_of "$registry_path")"

inspect_row() {
  local text="$1"
  shift
  : >"$inspect_calllog"
  FAKE_MCPORTER_PAGE_TEXT="$text" FAKE_MCPORTER_CALLLOG="$inspect_calllog" \
    FAKE_MCPORTER_RECEIPT="$inspect_receipt" \
    run_cli inspect --lane daily-driver --account-role owner --run-id inspect-test --ttl 30 "$@"
}

inspect_row '' --json
assert_equals "$cli_status" '0' 'empty visible inventory is a successful inspection'
assert_equals "$cli_err" '' 'successful inspection keeps stderr empty'
assert_equals "$(jq -c '.data' <<<"$cli_out")" \
  '{"transport":"authenticated","inventory":"readable","visible_page_count":0,"target":{"requested":false,"match_count":null,"selected":null},"readiness":"no_visible_pages","access_mode":{"expected":"selected","observed":"selected"},"stored_grants":"unknown"}' \
  'empty text reports only observable facts, with unknown stored grants and mode'
assert_equals "$(<"$inspect_calllog")" 'chrome-devtools.list_pages' 'inspection calls only the page inventory tool'
assert_contains "$(<"$inspect_receipt")" 'policy=require' 'inspection requires authenticated relay policy'
assert_contains "$(<"$inspect_receipt")" 'url=http://127.0.0.1:18799' 'inspection stays on the declared relay'
assert_contains "$(<"$inspect_receipt")" 'keepalive=*' 'inspection disables cross-lane daemon reuse'
assert_absent "$lease_dir" 'empty inspection releases its lease'

inspect_row '' --page-url "$page_one" --json
assert_equals "$cli_status" '16' 'empty inventory cannot make an exact target ready'
assert_equals "$cli_out" '' 'target refusal leaves stdout empty'
inspect_error="$(tail -n 1 <<<"$cli_err")"
assert_equals "$(jq -r '.error.code' <<<"$inspect_error")" 'page_not_admitted' 'empty inventory has the existing typed target refusal'
assert_equals "$(jq -c '[.data.visible_page_count,.data.target.match_count,.data.target.selected,.data.readiness]' <<<"$inspect_error")" \
  '[0,0,null,"target_absent"]' 'empty target inspection reports zero matches without claiming selection'
assert_contains "$cli_err" 'ask the human to admit it' 'target recovery preserves human admission authority'
assert_contains "$cli_err" 'existing profile' 'target recovery checks the exact existing profile'
assert_contains "$cli_err" 'stored grants' 'empty inventory refusal disclaims stored grant evidence'
assert_absent "$lease_dir" 'target refusal releases its lease'

inspect_row "## Pages
7: TITLE-SECRET-SENTINEL ($page_one) [selected]" --page-url "$page_one" --json
assert_equals "$cli_status" '0' 'one exact selected target is ready'
assert_equals "$(jq -c '[.data.visible_page_count,.data.target,.data.readiness]' <<<"$cli_out")" \
  '[1,{"requested":true,"match_count":1,"selected":true},"ready"]' 'exact selected target has explicit readiness evidence'
assert_not_contains "$cli_out$cli_err" 'TITLE-SECRET-SENTINEL' 'successful inspection hides page titles'
assert_not_contains "$cli_out$cli_err" "$page_one" 'successful inspection hides the requested URL'
assert_equals "$(<"$inspect_calllog")" 'chrome-devtools.list_pages' 'ready inspection performs no page action'

inspect_row "## Pages
7: TITLE-SECRET-SENTINEL ($page_two) [selected]" --page-url "$page_one" --json
assert_equals "$cli_status" '0' 'a same-site different path satisfies the inspected target'
assert_equals "$(jq -c '[.data.visible_page_count,.data.target.match_count,.data.readiness]' <<<"$cli_out")" \
  '[1,1,"ready"]' 'same-site inspection reports one ready match'
assert_not_contains "$cli_out$cli_err" "$page_two" 'same-site diagnostics hide the live URL'
assert_not_contains "$cli_out$cli_err" "$page_one" 'same-site diagnostics hide the requested URL'

inspect_row "## Pages
7: TITLE-SECRET-SENTINEL ($page_one)" --page-url "$page_one" --json
assert_equals "$cli_status" '0' 'one unselected same-site target is ready'
assert_equals "$(jq -c '[.data.target.selected,.data.readiness]' <<<"$cli_out")" \
  '[false,"ready"]' 'a unique same-site match does not require selection'

# Installed Chrome DevTools emits the URL alone when fetchPageTitle is empty.
inspect_row "## Pages
7: $page_one [selected]" --page-url "$page_one" --json
assert_equals "$cli_status" '0' 'titleless upstream page can prove the exact selected target'
assert_equals "$(jq -r '.data.readiness' <<<"$cli_out")" 'ready' 'title availability does not determine page readiness'
assert_not_contains "$cli_out$cli_err" "$page_one" 'titleless page proof hides the URL'
assert_absent "$lease_dir" 'titleless page inspection releases custody'

inspect_row "## Pages
7: $page_one" --page-url "$page_one" --json
assert_equals "$cli_status" '0' 'titleless unique same-site target is ready without selection'
assert_equals "$(jq -r '.data.readiness' <<<"$cli_out")" 'ready' 'titleless unique target follows the same-site selection rule'
inspect_row "## Pages
7: $different_site_page [selected]" --page-url "$page_one" --json
assert_equals "$cli_status" '16' 'titleless unrelated URL cannot satisfy target proof'
assert_contains "$cli_err" 'page_not_admitted' 'titleless unrelated URL retains site matching'
inspect_row "## Pages
7: missing-title-and-url [selected]" --page-url "$page_one" --json
assert_equals "$cli_status" '16' 'titleless fallback refuses non-URI text'
assert_contains "$cli_err" 'page_list_unreadable' 'invalid titleless record remains unreadable'

# Stderr is a diagnostic stream, not part of the MCP JSON response.
FAKE_MCPORTER_INVENTORY_WARNING='PRIVATE-WARNING-SENTINEL' \
  inspect_row "## Pages
7: expected ($page_one) [selected]" --page-url "$page_one" --json
assert_equals "$cli_status" '0' 'valid inventory survives upstream stderr warning'
assert_equals "$(jq -r '.data.readiness' <<<"$cli_out")" 'ready' 'warning does not alter exact-target proof'
assert_not_contains "$cli_out$cli_err" 'PRIVATE-WARNING-SENTINEL' 'upstream stderr remains private'
assert_absent "$lease_dir" 'warning-bearing inventory releases custody'

inspect_row "## Pages
7: first ($page_one) [selected]
8: unrelated ($page_two)" --page-url "$page_one" --json
assert_equals "$cli_status" '0' 'one selected exact match remains ready beside unrelated admitted pages'
assert_equals "$(jq -c '[.data.visible_page_count,.data.target.match_count,.data.target.selected,.data.readiness]' <<<"$cli_out")" \
  '[2,2,true,"ready"]' 'selected same-site readiness wins among two matching pages'

inspect_row "## Pages
7: first ($page_one) [selected]
8: unrelated ($page_two) [selected]" --page-url "$page_one" --json
assert_equals "$cli_status" '16' 'multiple selected pages remain ambiguous'
assert_equals "$(tail -n 1 <<<"$cli_err" | jq -c '[.error.code,.data.target.match_count,.data.readiness]')" \
  '["page_ambiguous",2,"ambiguous"]' 'multiple selected same-site matches remain ambiguous'

inspect_row "## Pages
7: first ($page_one) [selected]
8: second ($page_one)" --page-url "$page_one" --json
assert_equals "$cli_status" '0' 'a selected page wins among duplicate same-site URLs'
assert_equals "$(jq -c '[.data.target.match_count,.data.target.selected,.data.readiness]' <<<"$cli_out")" \
  '[2,true,"ready"]' 'selected-page preference resolves duplicate same-site URLs'

inspect_row "## Pages
7: first ($page_one)
8: second ($page_two)" --page-url "$page_one" --json
assert_equals "$cli_status" '16' 'two unselected same-site pages remain ambiguous'
assert_equals "$(tail -n 1 <<<"$cli_err" | jq -c '[.error.code,.data.target.match_count,.data.readiness]')" \
  '["page_ambiguous",2,"ambiguous"]' 'unselected same-site ambiguity keeps the typed refusal'

inspect_row "## Pages
7: TITLE-SECRET-SENTINEL ($page_one) [selected]" --json
assert_equals "$cli_status" '0' 'inventory without a requested target is readable'
assert_equals "$(jq -c '[.data.target,.data.readiness]' <<<"$cli_out")" \
  '[{"requested":false,"match_count":null,"selected":null},"target_not_requested"]' 'inventory alone never proves task readiness'

inspect_row ''
assert_equals "$cli_status" '0' 'human inspection exits successfully'
assert_contains "$cli_out" 'visible_pages=0' 'human inspection makes an empty inventory explicit'
assert_contains "$cli_out" 'access_mode=selected' 'human inspection reports the fresh access-mode snapshot'
assert_contains "$cli_out" 'stored_grants=unknown' 'human inspection keeps stored grants unknown'

# A fresh status response is exactly one known schema object. Every malformed,
# legacy, extra, streamed, or nonzero response is unavailable before inventory;
# neither raw relay output nor a private status tempfile survives the refusal.
assert_status_snapshot_unavailable() {
  local status_fixture="$1" status_exit="$2" label="$3" status_calllog="$TEST_ROOT/status-$3.calllog"
  : >"$status_calllog"
  if [[ "$status_exit" == '0' ]]; then
    FAKE_MCPORTER_STATUS="$status_fixture" FAKE_MCPORTER_CALLLOG="$status_calllog" \
      run_cli inspect --lane daily-driver --account-role owner --run-id "status-$status_fixture-$status_exit" --json
  else
    FAKE_MCPORTER_STATUS="$status_fixture" FAKE_MCPORTER_STATUS_EXIT="$status_exit" \
      FAKE_MCPORTER_CALLLOG="$status_calllog" \
      run_cli inspect --lane daily-driver --account-role owner --run-id "status-$status_fixture-$status_exit" --json
  fi
  assert_equals "$cli_status" '12' "$label is unavailable before page inventory"
  assert_contains "$cli_err" 'access_mode_live_check_unavailable' "$label has the typed unavailable refusal"
  assert_equals "$cli_out" '' "$label leaves stdout empty"
  assert_equals "$(<"$status_calllog")" '' "$label never inventories a page"
  assert_absent "$lease_dir" "$label releases the lease"
  assert_equals "$(find "$fixture_state/browser-lanes" -name 'access-status.*' | wc -l | tr -d ' ')" '0' "$label removes its private status tempfile"
}

assert_status_snapshot_unavailable empty 0 'empty status output'
assert_status_snapshot_unavailable legacy 0 'legacy status output'
assert_status_snapshot_unavailable unknown-version 0 'unknown schema version'
assert_status_snapshot_unavailable unknown-status-version 0 'unknown access-status version'
assert_status_snapshot_unavailable extra-fields 0 'extra status fields'
assert_status_snapshot_unavailable extra-access-fields 0 'extra access-status fields'
assert_status_snapshot_unavailable multiple 0 'multiple status objects'
assert_status_snapshot_unavailable selected 41 'nonzero status with valid-looking stdout'
assert_status_snapshot_unavailable selected 124 'timeout status response'
assert_status_snapshot_unavailable redacted 0 'redacted status failure'
assert_not_contains "$cli_out$cli_err" 'STATUS-SECRET-SENTINEL' 'redacted status failure hides raw relay output'

# Non-JSON, invalid envelopes, MCP errors, partial/unknown lines, and multiple
# documents are unreadable, never silently treated as an empty inventory.
inspect_bad_envelopes=(
  ''
  'not-json SECRET-ERROR-SENTINEL'
  '[]'
  '{"content":"SECRET-ERROR-SENTINEL"}'
  '{"content":[{"type":"text","text":5}]}'
  '{"content":[{"type":"image","data":"SECRET-ERROR-SENTINEL"}]}'
  '{"isError":true,"content":[{"type":"text","text":""}]}'
  '{"content":[{"type":"text","text":"0: SECRET-ERROR-SENTINEL"}]}'
  '{"content":[{"type":"text","text":"unexpected SECRET-ERROR-SENTINEL"}]}'
  '{"content":[{"type":"text","text":""}]} {"content":[{"type":"text","text":""}]}'
)
for inspect_bad in "${inspect_bad_envelopes[@]}"; do
  FAKE_MCPORTER_ENVELOPE="$inspect_bad" \
    run_cli inspect --lane daily-driver --account-role owner --run-id inspect-bad --json
  assert_equals "$cli_status" '16' 'malformed inventory fails closed'
  assert_equals "$cli_out" '' 'malformed inventory leaves stdout empty'
  assert_equals "$(tail -n 1 <<<"$cli_err" | jq -c '[.error.code,.data.transport,.data.inventory,.data.visible_page_count,.data.readiness]')" \
    '["page_list_unreadable","authenticated","unreadable",null,"unknown"]' 'malformed evidence is unknown, not zero pages or failed transport'
  assert_not_contains "$cli_out$cli_err" 'SECRET-ERROR-SENTINEL' 'malformed inventory hides upstream content'
  assert_absent "$lease_dir" 'malformed inventory releases the lease'
done

inspect_bad_args=( '--plan /unused' '--retention-days 1' '--ttl 0' '--page-url ftp://fixture.invalid' )
for inspect_args in "${inspect_bad_args[@]}"; do
  read -r inspect_flag inspect_value <<<"$inspect_args"
  run_cli inspect --lane daily-driver --account-role owner "$inspect_flag" "$inspect_value"
  assert_equals "$cli_status" '2' 'inspection refuses incompatible or invalid options'
done
run_cli inspect --lane daily-driver --account-role owner -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '2' 'inspection accepts no child command'
run_cli inspect --lane daily-driver
assert_equals "$cli_status" '2' 'inspection requires an explicit account role'
run_cli inspect --lane daily-driver --account-role wrong --json
assert_equals "$cli_status" '11' 'inspection refuses the wrong account role'
FAKE_OPENCLAW_FAIL=1 run_cli inspect --lane daily-driver --account-role owner --json
assert_equals "$cli_status" '12' 'inspection cannot imply inventory readiness on transport failure'
assert_absent "$lease_dir" 'inspection preflight failure releases its lease'
mkdir -p "$lease_dir"
run_cli inspect --lane daily-driver --account-role owner --json
assert_equals "$cli_status" '13' 'inspection respects another owner lease'
rmdir "$lease_dir"
assert_equals "$(sha256_of "$profile_dir/Preferences")" "$inspect_profile_sha" 'inspection preserves profile preferences'
assert_equals "$(sha256_of "$registry_path")" "$inspect_registry_sha" 'inspection preserves registry bytes'
assert_equals "$(find "$fixture_state/browser-lanes" -name 'page-list.*' | wc -l | tr -d ' ')" '0' 'all inspection paths remove private inventory files'
assert_absent "$recovery_root_dir" 'inspection creates no recovery snapshots'
# Public-process free-mode oracle: the requested command reaches the child only
# while the real config contains true. Restoring false restores the old gate.
mkdir -p "$XDG_CONFIG_HOME/browser-lanes"
free_config="$XDG_CONFIG_HOME/browser-lanes/config.json"
printf '%s\n' '{"free_mode":true}' >"$free_config"
free_argv="$TEST_ROOT/free-mode.argv"
free_activity_log="$TEST_ROOT/free-mode.activity.log"
free_activity_facts="$TEST_ROOT/free-mode.activity.jsonl"
FAKE_MCPORTER_ACTIVITY_LOG="$free_activity_log" FAKE_MCPORTER_ACTIVITY_FACTS="$free_activity_facts" \
BROWSER_LANE_ACTIVITY_HEARTBEAT_SECONDS=1 FAKE_MCPORTER_CHILD_HOLD_SECONDS=3 \
FAKE_MCPORTER_STATUS=all FAKE_MCPORTER_ARGV="$free_argv" \
  run_cli run --lane daily-driver --account-role owner --run-id free-navigation -- \
  mcporter call chrome-devtools.navigate_page pageId=7 url=https://fixture.invalid/next
assert_equals "$cli_status" '0' 'free mode navigates without tab approval or a page URL'
assert_contains "$(cat "$free_argv")" 'pageId=7' 'free mode preserves the requested current page ID'
assert_absent "$lease_dir" 'free mode releases the lane lease'
assert_equals "$(head -1 "$free_activity_log")" 'start:chrome-devtools' 'free mode starts Chrome DevTools activity'
assert_contains "$(cat "$free_activity_log")" 'heartbeat' 'free mode refreshes activity while its child runs'
assert_equals "$(tail -1 "$free_activity_log")" 'clear' 'free mode clears activity after its child exits'
assert_equals "$(jq -c 'select(.kind == "finish") | [.action,.cleanup,.code]' "$free_activity_facts")" '["completed","unknown","0"]' 'free mode reports successful action with unknown cleanup'
assert_equals "$(find "$fixture_state/browser-lanes" -name 'activity-outcome.*' | wc -l | tr -d ' ')" '0' 'free mode removes its private activity receipt'
FAKE_MCPORTER_STATUS=all FAKE_MCPORTER_CHILD_CALL_STATUS=23 \
FAKE_MCPORTER_ACTIVITY_LOG="$TEST_ROOT/free-failed.activity.log" \
FAKE_MCPORTER_ACTIVITY_FACTS="$TEST_ROOT/free-failed.activity.jsonl" \
  run_cli run --lane daily-driver --account-role owner --run-id free-failed -- \
  mcporter call chrome-devtools.navigate_page pageId=7 url=https://fixture.invalid/next
assert_equals "$cli_status" '23' 'free mode preserves a failed child status'
assert_equals "$(cat "$TEST_ROOT/free-failed.activity.log")" $'start:chrome-devtools\nfinish\nclear' 'free mode finishes and clears activity after child failure'
assert_equals "$(jq -c 'select(.kind == "finish") | [.action,.cleanup,.code]' "$TEST_ROOT/free-failed.activity.jsonl")" '["failed","unknown","23"]' 'free mode reports the failed child outcome'
FAKE_MCPORTER_STATUS=all FAKE_MCPORTER_ACTIVITY_STATUS=1 \
FAKE_MCPORTER_ACTIVITY_LOG="$TEST_ROOT/free-unavailable.activity.log" \
  run_cli run --lane daily-driver --account-role owner --run-id free-unavailable -- \
  mcporter call chrome-devtools.navigate_page pageId=7 url=https://fixture.invalid/next
assert_equals "$cli_status" '0' 'unavailable activity does not block free mode'
assert_equals "$(cat "$TEST_ROOT/free-unavailable.activity.log")" 'start:chrome-devtools' 'failed free-mode activity start launches no heartbeat or cleanup'
assert_contains "$cli_err" 'lane_activity_unavailable' 'free mode reports unavailable activity as advisory'
FAKE_MCPORTER_STATUS=all run_cli health --lane daily-driver --json
assert_equals "$cli_status" '0' 'free mode health accepts All tabs'
FAKE_MCPORTER_STATUS=disabled run_cli run --lane daily-driver --account-role owner -- mcporter call chrome-devtools.new_page
assert_equals "$cli_status" '15' 'free mode respects disabled access'
run_cli run --lane daily-driver --account-role wrong -- mcporter call chrome-devtools.new_page
assert_equals "$cli_status" '11' 'free mode retains account identity'
mkdir "$lease_dir"
run_cli run --lane daily-driver --account-role owner -- mcporter call chrome-devtools.new_page
assert_equals "$cli_status" '13' 'free mode retains lane exclusion'
rmdir "$lease_dir"
printf '%s\n' '{"free_mode":false}' >"$free_config"
run_cli run --lane daily-driver --account-role owner -- mcporter call chrome-devtools.navigate_page pageId=7
assert_equals "$cli_status" '2' 'turning free mode off restores prohibited tool refusal'
assert_contains "$cli_err" 'prohibited_tool' 'off mode reports the original restriction'
FAKE_MCPORTER_STATUS=all run_cli health --lane daily-driver --json
assert_equals "$cli_status" '15' 'off mode immediately refuses All tabs'
for invalid_config in '{"free_mode":"true"}' '{"free_mode":null}' '{' '{"free_mode":false} {"free_mode":true}' '{"free_mode":true} {"free_mode":false}' ; do
  printf '%s\n' "$invalid_config" >"$free_config"
  run_cli list --json
  assert_equals "$cli_status" '2' 'malformed free-mode config is refused'
done
rm "$free_config"
run_cli run --lane daily-driver --account-role owner -- mcporter call chrome-devtools.new_page
assert_equals "$cli_status" '2' 'missing config preserves secured mode'
assert_contains "$cli_err" 'prohibited_tool' 'missing config does not opt into free mode'

if [[ "$test_selection" == '--inspect-only' ]]; then
  [[ "$assertion_count" -eq "$EXPECTED_INSPECT_ASSERTIONS" ]] ||
    fail "inspection assertion count drifted (expected $EXPECTED_INSPECT_ASSERTIONS, got $assertion_count)"
  printf '1..%d\n' "$EXPECTED_INSPECT_ASSERTIONS"
  exit 0
fi

run_cli --help
assert_equals "$cli_status" '0' 'help exits zero'
assert_contains "$cli_out" 'browser-lane run' 'help discovers the run command'
assert_contains "$cli_out" 'browser-lane agent-browser' 'help discovers the Agent Browser command'
assert_contains "$cli_out" 'browser-lane playwright' 'help discovers the Playwright command'
assert_contains "$cli_out" 'browser-lane recovery create' 'help discovers the recovery command'
assert_contains "$cli_out" 'browser-lane handoff open' 'help discovers the attended-login handoff command'
assert_contains "$cli_out" 'handoff resume --lane NAME --account-role ROLE --run-id ID --nonce-file PATH --page-url URL' \
  'help discovers the exact-page continuation seam'
assert_contains "$cli_out" '15  baseline drift detected' 'help documents the drift exit'
assert_contains "$cli_out" '13  lane busy' 'help documents the busy exit'
assert_contains "$cli_out" '19  attended-login handoff is open' 'help documents the open-handoff exit'
assert_contains "$cli_out" '20  attended-login handoff is stale' 'help documents the stale-handoff exit'
assert_contains "$cli_out" '21  attended-login handoff token is invalid' 'help documents the token exit'

# ============================================================================
# attended login handoff: usage and private state
# ============================================================================
run_cli handoff
assert_usage_refused 'handoff without an action'
assert_contains "$cli_err" 'handoff requires one of: open, status, resume, release' \
  'handoff without an action names the available actions'

run_cli handoff bogus --lane daily-driver
assert_usage_refused 'handoff with an unknown action'

run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --task-ref login-proof
assert_usage_refused 'handoff open without an account role'

run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner
assert_usage_refused 'handoff open without a task reference'

run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --task-ref 'bad ref'
assert_usage_refused 'handoff open with an unsafe task reference'
assert_contains "$cli_err" '--task-ref must be a safe task label' \
  'unsafe task-reference refusal names the constraint'

run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --task-ref login-proof --window 0
assert_usage_refused 'handoff open with a zero window'
assert_contains "$cli_err" '--window must be 1 through 86400 seconds' \
  'zero-window refusal states the accepted range'

run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --task-ref login-proof --window 86401
assert_usage_refused 'handoff open above the maximum window'

run_cli handoff status --lane daily-driver --account-role owner
assert_usage_refused 'handoff status with an account role'

run_cli handoff resume --lane daily-driver --account-role owner
assert_usage_refused 'handoff resume without a token'

run_cli handoff resume --lane daily-driver --account-role owner --nonce-file "$(printf 'a%.0s' {1..64})"
assert_usage_refused 'handoff resume without an exact page URL'
assert_contains "$cli_err" 'handoff resume requires --page-url' \
  'missing continuation URL names the required exact-page input'

run_cli handoff release --lane daily-driver
assert_usage_refused 'handoff release without a token'

run_cli list --task-ref login-proof
assert_usage_refused 'list with a handoff flag'

run_cli handoff status --lane daily-driver --json
assert_equals "$cli_status" '0' 'handoff status succeeds when no handoff exists'
assert_equals "$(jq -r '.data.state' <<<"$cli_out")" 'absent' \
  'handoff status reports the absent state'
assert_equals "$(jq -r '.data | has("nonce")' <<<"$cli_out")" 'false' \
  'absent handoff status carries no token'

# A pre-admission handoff reserves the lane before the profile opener runs.
# Neither the reservation nor its output retains the full application URL.
preadmission_url='https://fixture.invalid/login?AUTH-QUERY-SENTINEL=secret#AUTH-FRAGMENT-SENTINEL'
preadmission_open_argv="$TEST_ROOT/preadmission-open.argv"
preadmission_openclaw_log="$TEST_ROOT/preadmission-openclaw.log"
preadmission_relay_log="$TEST_ROOT/preadmission-relay.log"
: >"$preadmission_openclaw_log"
: >"$preadmission_relay_log"
FAKE_BROWSER_OPEN_ARGV="$preadmission_open_argv" \
  FAKE_BROWSER_OPEN_REQUIRE_FILE="$handoff_record" \
  FAKE_OPENCLAW_CALLLOG="$preadmission_openclaw_log" \
  FAKE_MCPORTER_CALLLOG="$preadmission_relay_log" \
  run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner \
    --run-id preadmission-open --task-ref preadmission-proof \
    --page-url "$preadmission_url" --window 600 --json
assert_equals "$cli_status" '0' 'pre-admission handoff opens without an admitted page'
assert_equals "$cli_err" '' 'successful pre-admission handoff keeps stderr empty'
assert_equals "$(jq -c '[.data.state,.data.start_mode,.data.opening.dispatch,.data.authentication.state,.data.automation.admission]' <<<"$cli_out")" \
  '["open","pre_admission","accepted","waiting_for_human","not_requested"]' \
  'pre-admission result separates reservation, opening, authentication, and admission'
preadmission_nonce="$(<"$last_token_output")"
assert_matches "$preadmission_nonce" '^[0-9a-f]{64}$' \
  'pre-admission handoff privately delivers its token'
assert_present "$handoff_record" 'pre-admission handoff persists its reservation before dispatch'
assert_equals "$(jq -r '.start_mode' "$handoff_record")" 'pre_admission' \
  'pre-admission record names its compatibility mode'
assert_equals "$(jq -r '.site_origin' "$handoff_record")" 'https://fixture.invalid' \
  'pre-admission record retains only the intended application origin'
assert_equals "$(jq -r '.profile_directory_sha256' "$handoff_record")" \
  '422fcc2f0866e3e58005253d42875dab837a4eb72a17d8d0e5c24a65a59088db' \
  'pre-admission record binds the exact declared profile by independent digest'
assert_not_contains "$(<"$handoff_record")$cli_out$cli_err" '/login' \
  'pre-admission state and output omit the login path'
assert_not_contains "$(<"$handoff_record")$cli_out$cli_err" 'AUTH-QUERY-SENTINEL' \
  'pre-admission state and output omit secret-shaped query data'
assert_not_contains "$(<"$handoff_record")$cli_out$cli_err" 'AUTH-FRAGMENT-SENTINEL' \
  'pre-admission state and output omit secret-shaped fragment data'
assert_equals "$(<"$preadmission_openclaw_log")" '' \
  'pre-admission start performs no OpenClaw discovery or grant action'
assert_equals "$(<"$preadmission_relay_log")" '' \
  'pre-admission start performs no relay or page inspection'
assert_contains "$(<"$preadmission_open_argv")" '--profile-directory=Profile 13' \
  'pre-admission start opens the declared profile'
assert_contains "$(<"$preadmission_open_argv")" "$preadmission_url" \
  'pre-admission start sends the intended page only to the visible opener'

run_cli handoff resume --lane daily-driver --account-role owner \
  --nonce-file "$(token_fixture "$(printf 'd%.0s' {1..64})")" --page-url "$preadmission_url" --json
assert_equals "$cli_status" '21' 'invalid pre-admission recovery evidence is refused'
assert_contains "$cli_err" 'handoff_token_invalid' \
  'invalid pre-admission recovery evidence has a typed repair path'
assert_present "$handoff_record" 'invalid pre-admission recovery evidence preserves the reservation'

preadmission_block_log="$TEST_ROOT/preadmission-block.log"
: >"$preadmission_block_log"
FAKE_MCPORTER_CALLLOG="$preadmission_block_log" \
  run_cli run --lane daily-driver --account-role owner --run-id preadmission-blocked -- \
    mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '19' 'pre-admission human work blocks browser automation'
assert_equals "$(<"$preadmission_block_log")" '' \
  'pre-admission human work blocks before relay inspection'

jq '.opened_at_epoch = 1' "$handoff_record" >"$TEST_ROOT/preadmission-stale.json"
cp "$TEST_ROOT/preadmission-stale.json" "$handoff_record"
chmod 600 "$handoff_record"
run_cli handoff status --lane daily-driver --json
assert_equals "$(jq -r '.data.state' <<<"$cli_out")" 'stale' \
  'pre-admission inactivity marks the reservation stale without releasing it'
run_cli handoff release --lane daily-driver --nonce-file "$(token_fixture "$preadmission_nonce")" --json
assert_equals "$cli_status" '0' 'explicit cancellation releases a stale pre-admission reservation'
assert_absent "$handoff_dir" 'pre-admission cancellation removes the exact reservation'

# Identity-provider redirects are human-visible work outside router
# observation. The start performs no relay or page call, then handback proves
# only the application origin after the task tab is deliberately admitted.
provider_start_calllog="$TEST_ROOT/provider-start.calllog"
: >"$provider_start_calllog"
FAKE_MCPORTER_CALLLOG="$provider_start_calllog" \
  run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner \
  --run-id provider-redirect --task-ref provider-redirect \
  --page-url "$preadmission_url" --json
provider_handoff_nonce="$(<"$last_token_output")"
assert_equals "$(<"$provider_start_calllog")" '' \
  'provider-redirect interval starts without relay or page observation'
provider_return_url='https://fixture.invalid/application?RETURN-QUERY-SENTINEL=1'
provider_missing_log="$TEST_ROOT/provider-missing.calllog"
: >"$provider_missing_log"
FAKE_MCPORTER_CALLLOG="$provider_missing_log" FAKE_MCPORTER_PAGE_TEXT='' \
  run_cli handoff resume --lane daily-driver --account-role owner \
    --run-id provider-missing --nonce-file "$(token_fixture "$provider_handoff_nonce")" \
    --page-url "$provider_return_url" --json
assert_equals "$cli_status" '16' 'pre-admission resume reports the absent exact-page grant'
assert_contains "$cli_err" 'handoff_grant_required' \
  'absent exact-page permission has a continuation-specific typed refusal'
assert_contains "$cli_err" "focus the intended task tab and click OpenClaw's Allow on this tab once" \
  'absent same-site permission returns one concise human grant instruction'
assert_not_contains "$cli_err" 'pin' 'the human grant instruction never asks for Chrome pinning'
assert_not_contains "$cli_err" 'RETURN-QUERY-SENTINEL' \
  'the grant refusal omits the exact page query'
assert_present "$handoff_record" 'the missing grant preserves the login reservation'

provider_unrelated_url='https://subdomain.fixture.invalid/unrelated'
provider_page_text=$'0: Post login ('"$provider_return_url"$') [selected]\n1: Unrelated ('"$provider_unrelated_url"$')'
FAKE_MCPORTER_PAGE_TEXT="$provider_page_text" \
  run_cli handoff resume --lane daily-driver --account-role owner \
    --run-id provider-return --nonce-file "$(token_fixture "$provider_handoff_nonce")" \
    --page-url "$provider_return_url" --json
assert_equals "$cli_status" '0' 'pre-admission resume prefers the selected page among same-site tabs'
assert_equals "$(jq -c '[.data.state,.data.start_mode,.data.continuation]' <<<"$cli_out")" \
  '["resumed","pre_admission",{"page":"exact_selected","access_mode":"selected","permission":"reused"}]' \
  'pre-admission resume reports only the verified continuation facts'
assert_absent "$handoff_dir" 'successful pre-admission resume removes the reservation'

provider_adapter_log="$TEST_ROOT/provider-adapter.log"
provider_adapter_close="$TEST_ROOT/provider-adapter-close.argv"
FAKE_AGENT_BROWSER_STAGE_LOG="$provider_adapter_log" \
FAKE_AGENT_BROWSER_PAGE_URL="$provider_return_url" \
FAKE_AGENT_BROWSER_CLOSE_ARGV="$provider_adapter_close" \
FAKE_AGENT_BROWSER_RESULT='{"success":true,"data":{"snapshot":"OBSERVED-PAGE-SNAPSHOT-SENTINEL"}}' \
FAKE_MCPORTER_PAGE_TEXT="$provider_page_text" \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id provider-adapter --page-url "$provider_return_url" -- 'snapshot'
assert_equals "$cli_status" '0' 'a harmless public adapter operation succeeds after resume'
assert_equals "$cli_out" '{"success":true,"data":{"snapshot":"OBSERVED-PAGE-SNAPSHOT-SENTINEL"}}' \
  'post-resume adapter proof returns an observed page snapshot result'
assert_equals "$(<"$provider_adapter_log")" $'attach\npin-check\nwork\npin-check\nretire\nhandoff-exit' \
  'post-resume proof reaches adapter work and retires its run-scoped session'
assert_present "$provider_adapter_close" 'post-resume adapter proof retires its exact session'

# Reuse happens only after reservation publication. A refusal retains custody
# and its token, and never creates another tab as a fallback.
reuse_handoff_open="$TEST_ROOT/reuse-handoff.open"
FAKE_NATIVE_OPEN_STATE=reused FAKE_NATIVE_OPEN_REASON=exact_tab_reused \
  FAKE_NATIVE_OPEN_REQUIRE_FILE="$handoff_record" FAKE_BROWSER_OPEN_ARGV="$reuse_handoff_open" \
  run_cli handoff open --nonce-output "$TEST_ROOT/reuse-handoff.token" --lane daily-driver --account-role owner \
    --run-id reuse-handoff --task-ref reuse-handoff --page-url "$preadmission_url" --json
assert_equals "$cli_status" '0' 'handoff reuse observes a published reservation before native selection'
assert_equals "$(jq -r '.data.opening.tab' <<<"$cli_out")" 'reused' 'handoff reports an existing task tab reused'
assert_absent "$reuse_handoff_open" 'handoff reuse creates no new tab'
assert_present "$handoff_record" 'handoff reuse keeps the human reservation active'
assert_present "$TEST_ROOT/reuse-handoff.token" 'handoff reuse retains its private token file'
run_cli handoff release --lane daily-driver --nonce-file "$TEST_ROOT/reuse-handoff.token" --json
assert_equals "$cli_status" '0' 'reused handoff remains explicitly releasable'

FAKE_NATIVE_OPEN_STATE=refused FAKE_NATIVE_OPEN_REASON=exact_tab_ambiguous \
  FAKE_NATIVE_OPEN_REQUIRE_FILE="$handoff_record" FAKE_BROWSER_OPEN_ARGV="$reuse_handoff_open" \
  run_cli handoff open --nonce-output "$TEST_ROOT/refused-reuse.token" --lane daily-driver --account-role owner \
    --run-id refused-reuse --task-ref refused-reuse --page-url "$preadmission_url" --json
assert_equals "$cli_status" '22' 'an ambiguous handoff tab check stops with an uncertain-effect result'
assert_absent "$reuse_handoff_open" 'ambiguous handoff selection never opens another tab'
assert_present "$handoff_record" 'ambiguous handoff selection preserves the reservation'
assert_present "$TEST_ROOT/refused-reuse.token" 'ambiguous handoff selection preserves the private token'
assert_not_contains "$cli_out$cli_err" "$(<"$TEST_ROOT/refused-reuse.token")" 'native refusal keeps the retained token out of diagnostics'
run_cli handoff release --lane daily-driver --nonce-file "$TEST_ROOT/refused-reuse.token" --json
assert_equals "$cli_status" '0' 'native refusal can be released with the retained token'
assert_absent "$handoff_dir" 'native refusal recovery leaves no reservation'

# A launcher failure can have an external effect. The public error therefore
# retains the private token file and leaves the reservation recoverable.
uncertain_relay_log="$TEST_ROOT/preadmission-uncertain-relay.log"
: >"$uncertain_relay_log"
FAKE_BROWSER_OPEN_EXIT=130 FAKE_MCPORTER_CALLLOG="$uncertain_relay_log" \
  run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner \
    --run-id preadmission-interrupted --task-ref interruption-proof \
    --page-url "$preadmission_url" --json
assert_equals "$cli_status" '22' 'interrupted pre-admission opening has an uncertain-effect exit'
uncertain_handoff_error="$(tail -n 1 <<<"$cli_err")"
assert_equals "$(jq -r '.error.code' <<<"$uncertain_handoff_error")" 'browser_opening_uncertain' \
  'interrupted pre-admission opening is typed'
assert_equals "$(jq -r '.error.retry_safe' <<<"$uncertain_handoff_error")" 'false' \
  'interrupted pre-admission opening forbids blind replay'
uncertain_handoff_nonce="$(<"$last_token_output")"
assert_matches "$uncertain_handoff_nonce" '^[0-9a-f]{64}$' \
  'interrupted pre-admission opening retains its private token'
assert_present "$handoff_record" 'interrupted pre-admission opening preserves the reservation'
assert_not_contains "$cli_out$cli_err$(<"$handoff_record")" 'AUTH-QUERY-SENTINEL' \
  'interrupted pre-admission diagnostics and state omit the full login URL'
assert_equals "$(<"$uncertain_relay_log")" '' \
  'interrupted pre-admission opening performs no relay inspection'
run_cli handoff release --lane daily-driver --nonce-file "$(token_fixture "$uncertain_handoff_nonce")" --json
assert_equals "$cli_status" '0' 'the retained token cancels an uncertain pre-admission opening'

signal_handoff_out="$TEST_ROOT/preadmission-signal.out"
signal_handoff_err="$TEST_ROOT/preadmission-signal.err"
signal_handoff_started="$TEST_ROOT/preadmission-signal-started"
HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
  BROWSER_LANE_OPEN_BIN="$fixture_bin/browser-lane-open" \
  FAKE_BROWSER_OPEN_REQUIRE_FILE="$handoff_record" \
  FAKE_BROWSER_OPEN_STARTED_FILE="$signal_handoff_started" \
  FAKE_BROWSER_OPEN_HOLD_SECONDS=1 \
  "$fixture_repo/bin/browser-lane" handoff open --nonce-output "$TEST_ROOT/signal-token" --lane daily-driver \
    --account-role owner --run-id preadmission-signal --task-ref signal-proof \
    --page-url "$preadmission_url" --json >"$signal_handoff_out" 2>"$signal_handoff_err" &
signal_handoff_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -f "$signal_handoff_started" ]] && break
  sleep 0.1
done
kill -TERM "$signal_handoff_pid"
set +e
wait "$signal_handoff_pid"
signal_handoff_status=$?
set -e
assert_equals "$signal_handoff_status" '22' \
  'a signal during pre-admission dispatch preserves uncertain-effect recovery'
signal_handoff_nonce="$(<"$TEST_ROOT/signal-token")"
assert_matches "$signal_handoff_nonce" '^[0-9a-f]{64}$' \
  'signal recovery retains its private token'
assert_present "$handoff_record" 'signal recovery preserves the pre-admission reservation'
run_cli handoff release --lane daily-driver --nonce-file "$(token_fixture "$signal_handoff_nonce")" --json
assert_equals "$cli_status" '0' 'signal recovery token cancels the interrupted reservation'

# While the opener is in flight, a contender sees the command lease. Once the
# opener returns, the same contender sees the durable reservation.
preadmission_bg_out="$TEST_ROOT/preadmission-bg.out"
preadmission_bg_err="$TEST_ROOT/preadmission-bg.err"
preadmission_started="$TEST_ROOT/preadmission-started"
HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
  BROWSER_LANE_OPEN_BIN="$fixture_bin/browser-lane-open" \
  FAKE_BROWSER_OPEN_REQUIRE_FILE="$handoff_record" \
  FAKE_BROWSER_OPEN_STARTED_FILE="$preadmission_started" \
  FAKE_BROWSER_OPEN_HOLD_SECONDS=1 \
  "$fixture_repo/bin/browser-lane" handoff open --nonce-output "$TEST_ROOT/preadmission-bg-token" --lane daily-driver \
    --account-role owner --run-id preadmission-order --task-ref preadmission-order \
    --page-url "$preadmission_url" --json >"$preadmission_bg_out" 2>"$preadmission_bg_err" &
preadmission_bg_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -f "$preadmission_started" ]] && break
  sleep 0.1
done
assert_present "$preadmission_started" 'pre-admission opener reaches its controlled dispatch'
assert_present "$handoff_record" 'pre-admission reservation exists before controlled dispatch'
run_cli run --lane daily-driver --account-role owner --run-id preadmission-contender -- \
  mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '13' 'a contender sees lane busy during pre-admission dispatch'
preadmission_bg_status=0
wait "$preadmission_bg_pid" || preadmission_bg_status=$?
assert_equals "$preadmission_bg_status" '0' 'background pre-admission dispatch completes'
preadmission_order_nonce="$(<"$TEST_ROOT/preadmission-bg-token")"
run_cli run --lane daily-driver --account-role owner --run-id preadmission-after -- \
  mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '19' 'a contender sees the reservation after pre-admission dispatch'
run_cli handoff release --lane daily-driver --nonce-file "$(token_fixture "$preadmission_order_nonce")" --json
assert_equals "$cli_status" '0' 'ordered pre-admission reservation cancels cleanly'

handoff_full_url='https://fixture.invalid/login?QUERY-SENTINEL=1#FRAGMENT-SENTINEL'
handoff_page_text="0: EVIL-TITLE-SENTINEL ($handoff_full_url) [selected]"
FAKE_MCPORTER_ACTIVITY_LOG="$TEST_ROOT/handoff-activity.log" FAKE_MCPORTER_PAGE_TEXT="$handoff_page_text" \
  run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --run-id handoff-open \
    --task-ref login-proof --window 600 --json
assert_equals "$cli_status" '0' 'handoff open succeeds for one selected admitted page'
assert_equals "$(<"$TEST_ROOT/handoff-activity.log")" 'waiting' 'successful human handoff publishes a waiting notice'

assert_equals "$cli_err" '' 'handoff open keeps stderr empty on success'
assert_equals "$(jq -r '.data.state' <<<"$cli_out")" 'open' \
  'handoff open reports the open state'
assert_equals "$(jq -r '.data.site_origin' <<<"$cli_out")" 'https://fixture.invalid' \
  'handoff output reduces the admitted page to its origin'
assert_equals "$(jq -r '.data.task_ref' <<<"$cli_out")" 'login-proof' \
  'handoff output carries the safe task reference'
assert_equals "$(jq -r '.data | has("profile")' <<<"$cli_out")" 'false' \
  'handoff output omits profile identity metadata'
assert_equals "$(jq -r '.data | has("account_role")' <<<"$cli_out")" 'false' \
  'handoff output omits account-role metadata'
assert_not_contains "$cli_out" 'Daily' 'handoff output omits the profile display name'
assert_not_contains "$cli_out" '/login' 'handoff output omits the page path'
assert_not_contains "$cli_out" 'QUERY-SENTINEL' 'handoff output omits the page query'
assert_not_contains "$cli_out" 'FRAGMENT-SENTINEL' 'handoff output omits the page fragment'
assert_not_contains "$cli_out" 'EVIL-TITLE-SENTINEL' 'handoff output omits the page title'
handoff_nonce="$(<"$last_token_output")"
assert_matches "$handoff_nonce" '^[0-9a-f]{64}$' 'handoff open writes one random hex token privately'
assert_present "$handoff_record" 'handoff open writes one reservation record'
assert_equals "$(mode_of "$handoff_root_dir")" '700' 'handoff root is private'
assert_equals "$(mode_of "$handoff_dir")" '700' 'handoff directory is private'
assert_equals "$(mode_of "$handoff_record")" '600' 'handoff record is private'
assert_equals "$(entry_count "$handoff_dir")" '1' 'handoff directory has one record'
assert_equals "$(jq -c 'keys' "$handoff_record")" \
  '["account_role","lane","nonce_sha256","opened_at_epoch","profile_directory_sha256","schema_version","site_origin","start_mode","task_ref","window_seconds"]' \
  'handoff record exposes only the fixed state fields'
assert_not_contains "$(<"$handoff_record")" "$handoff_nonce" \
  'handoff record never stores the plaintext token'
assert_equals "$(jq -r '.nonce_sha256' "$handoff_record")" \
  "$(printf '%s' "$handoff_nonce" | shasum -a 256 | awk '{print $1}')" \
  'handoff record stores the independently calculated token digest'
assert_not_contains "$(<"$handoff_record")" '/login' 'handoff record omits the page path'
assert_not_contains "$(<"$handoff_record")" 'QUERY-SENTINEL' 'handoff record omits the page query'
assert_not_contains "$(<"$handoff_record")" 'EVIL-TITLE-SENTINEL' 'handoff record omits the page title'

run_cli handoff status --lane daily-driver --json
assert_equals "$cli_status" '0' 'handoff status reads an open reservation'
assert_equals "$(jq -r '.data.state' <<<"$cli_out")" 'open' \
  'handoff status derives the open state'
assert_equals "$(jq -r '.data | has("nonce")' <<<"$cli_out")" 'false' \
  'handoff status never repeats the token'

handoff_run_calllog="$TEST_ROOT/handoff-run.calllog"
: >"$handoff_run_calllog"
FAKE_MCPORTER_CALLLOG="$handoff_run_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id handoff-blocked -- \
    mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '19' 'an open handoff blocks an engine run'
assert_contains "$cli_err" 'handoff_open' 'open-handoff engine refusal is typed'
assert_equals "$(<"$handoff_run_calllog")" '' \
  'open-handoff engine refusal performs no relay call'
assert_absent "$lease_dir" 'open-handoff engine refusal releases its lease'

handoff_inspect_calllog="$TEST_ROOT/handoff-inspect.calllog"
: >"$handoff_inspect_calllog"
FAKE_MCPORTER_CALLLOG="$handoff_inspect_calllog" \
  run_cli inspect --lane daily-driver --account-role owner --page-url "$handoff_full_url" --json
assert_equals "$cli_status" '19' 'an open handoff blocks targeted inspection'
assert_contains "$cli_err" 'handoff_open' 'targeted inspection has the handoff refusal'
assert_equals "$(<"$handoff_inspect_calllog")" '' \
  'blocked targeted inspection performs no page inventory'

FAKE_MCPORTER_PAGE_TEXT="$handoff_page_text" \
  run_cli inspect --lane daily-driver --account-role owner --json
assert_equals "$cli_status" '0' 'bare inspection remains available during handoff'
assert_equals "$(jq -r '.data.visible_page_count' <<<"$cli_out")" '1' \
  'bare inspection reports only the admitted-page count during handoff'

run_cli recovery create --lane daily-driver --retention-days 7 --deletion-owner owner --json
assert_equals "$cli_status" '19' 'an open handoff blocks recovery creation'
assert_contains "$cli_err" 'handoff_open' 'recovery creation has the handoff refusal'

run_cli recovery verify --lane daily-driver --snapshot missing-proof --json
assert_equals "$cli_status" '15' 'recovery verification remains available during handoff'
assert_contains "$cli_err" 'recovery_snapshot_missing' \
  'recovery verification reaches its own result during handoff'

FAKE_MCPORTER_PAGE_TEXT="$handoff_page_text" \
  run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --task-ref second-open --json
assert_equals "$cli_status" '19' 'a second handoff cannot replace an open handoff'
assert_contains "$cli_err" 'handoff_open' 'second-open refusal reports the current state'

jq '.opened_at_epoch = 1' "$handoff_record" >"$TEST_ROOT/handoff-stale.json"
cp "$TEST_ROOT/handoff-stale.json" "$handoff_record"
chmod 600 "$handoff_record"
run_cli handoff status --lane daily-driver --json
assert_equals "$cli_status" '0' 'handoff status succeeds for stale state'
assert_equals "$(jq -r '.data.state' <<<"$cli_out")" 'stale' \
  'elapsed handoff state becomes stale without unlocking'

run_cli run --lane daily-driver --account-role owner --run-id stale-blocked -- \
  mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '20' 'a stale handoff still blocks an engine run'
assert_contains "$cli_err" 'handoff_stale' 'stale-handoff engine refusal is typed'

run_cli handoff resume --lane daily-driver --account-role owner --nonce-file "$(token_fixture "$(printf 'f%.0s' {1..64})")" \
  --page-url "$handoff_full_url" --json
assert_equals "$cli_status" '21' 'handoff resume refuses a wrong token'
assert_contains "$cli_err" 'handoff_token_invalid' 'wrong-token resume refusal is typed'
assert_present "$handoff_record" 'wrong-token resume preserves the reservation'

FAKE_MCPORTER_PAGE_TEXT="$handoff_page_text" \
  run_cli handoff resume --lane daily-driver --account-role owner --run-id handoff-resume \
    --nonce-file "$(token_fixture "$handoff_nonce")" --page-url "$handoff_full_url" --json
assert_equals "$cli_status" '0' 'handoff resume accepts the original token'
assert_equals "$(jq -r '.data.state' <<<"$cli_out")" 'resumed' \
  'handoff resume reports the resumed state'
assert_not_contains "$cli_out" "$handoff_nonce" 'handoff resume does not echo the token'
assert_absent "$handoff_dir" 'handoff resume removes the exact reservation'
assert_absent "$lease_dir" 'handoff resume releases the lane lease'

# A resumed lane admits ordinary automation again.
run_cli run --lane daily-driver --account-role owner --run-id after-resume -- \
  mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '0' 'automation resumes after explicit handback'

# ============================================================================
# attended login handoff: release, validation, and sanitation failures
# ============================================================================
handoff_other_url='https://fixture.invalid/other?SECOND-QUERY-SENTINEL=1'
handoff_other_page_text="0: SECOND-TITLE-SENTINEL ($handoff_other_url) [selected]"
FAKE_MCPORTER_PAGE_TEXT="$handoff_other_page_text" \
  run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --task-ref release-proof
assert_equals "$cli_status" '0' 'text-mode handoff open succeeds'
assert_contains "$cli_out" 'state=open' 'text-mode handoff open reports state'
assert_not_contains "$cli_out" '/other' 'text-mode handoff output omits the page path'
assert_not_contains "$cli_out" 'SECOND-QUERY-SENTINEL' 'text-mode handoff output omits query data'
release_nonce="$(<"$last_token_output")"
assert_matches "$release_nonce" '^[0-9a-f]{64}$' 'text-mode handoff open writes its token privately'

run_cli handoff release --lane daily-driver --nonce-file "$(token_fixture "$(printf 'e%.0s' {1..64})")" --json
assert_equals "$cli_status" '21' 'handoff release refuses a wrong token'
assert_present "$handoff_record" 'wrong-token release preserves the reservation'

run_cli handoff release --lane daily-driver --nonce-file "$(token_fixture "$release_nonce")" --json
assert_equals "$cli_status" '0' 'handoff release accepts the original token'
assert_equals "$(jq -r '.data.state' <<<"$cli_out")" 'released' \
  'handoff release reports the released state'
assert_absent "$handoff_dir" 'handoff release removes the exact reservation'

FAKE_MCPORTER_PAGE_TEXT=$'0: Title (https://fixture.invalid/one)\n1: Other (https://fixture.invalid/two) [selected]' \
  run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --task-ref ambiguous-proof --json
assert_equals "$cli_status" '0' 'handoff open prefers one selected page among multiple admitted pages'
assert_present "$handoff_dir" 'selected-page handoff open writes its reservation'
selected_handoff_nonce="$(<"$last_token_output")"
run_cli handoff release --lane daily-driver --nonce-file "$(token_fixture "$selected_handoff_nonce")" --json
assert_equals "$cli_status" '0' 'selected-page handoff fixture releases its reservation'

FAKE_MCPORTER_PAGE_TEXT='0: Title (https://fixture.invalid/one)' \
  run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --task-ref unselected-proof --json
assert_equals "$cli_status" '0' 'handoff open accepts one unselected admitted page'
assert_present "$handoff_dir" 'unique-page handoff open writes its reservation'
unique_handoff_nonce="$(<"$last_token_output")"
run_cli handoff release --lane daily-driver --nonce-file "$(token_fixture "$unique_handoff_nonce")" --json
assert_equals "$cli_status" '0' 'unique-page handoff fixture releases its reservation'

FAKE_MCPORTER_PAGE_TEXT='0: Title (https://user:password@fixture.invalid/login) [selected]' \
  run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --task-ref unsafe-origin --json
assert_equals "$cli_status" '16' 'handoff open refuses an origin containing user information'
assert_contains "$cli_err" 'handoff_origin_unusable' 'unsafe-origin refusal is typed'
assert_not_contains "$cli_err" 'user:password' 'unsafe-origin refusal does not echo user information'
assert_absent "$handoff_dir" 'unsafe-origin refusal writes no reservation'

mkdir "$handoff_dir"
chmod 700 "$handoff_dir"
printf '{"unexpected":true}\n' >"$handoff_record"
chmod 600 "$handoff_record"
run_cli run --lane daily-driver --account-role owner --run-id unsafe-state -- \
  mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '15' 'an invalid handoff record fails closed'
assert_contains "$cli_err" 'handoff_state_invalid' 'invalid handoff state has a typed refusal'
rm "$handoff_record"
rmdir "$handoff_dir"

ln -s "$TEST_ROOT" "$handoff_dir"
run_cli handoff status --lane daily-driver --json
assert_equals "$cli_status" '15' 'a symlinked handoff directory fails closed'
assert_contains "$cli_err" 'handoff_state_unsafe' 'symlinked handoff state has a typed refusal'
rm "$handoff_dir"

FAKE_MCPORTER_PAGE_TEXT="$handoff_page_text" \
  run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --task-ref origin-proof --json
origin_nonce="$(<"$last_token_output")"
assert_matches "$origin_nonce" '^[0-9a-f]{64}$' 'origin-check handoff opens with a token'

cp "$chrome_root/Local State" "$TEST_ROOT/resume-local-state.good"
jq '.profile.info_cache["Profile 13"].name = "Wrong Profile"' \
  "$TEST_ROOT/resume-local-state.good" >"$chrome_root/Local State"
run_cli handoff resume --lane daily-driver --account-role owner --nonce-file "$(token_fixture "$origin_nonce")" \
  --page-url "$handoff_full_url" --json
assert_equals "$cli_status" '11' 'handoff resume refuses a different Chrome profile'
assert_contains "$cli_err" 'profile_mismatch' 'different-profile resume refusal is typed'
assert_present "$handoff_record" 'different-profile resume preserves the reservation'
cp "$TEST_ROOT/resume-local-state.good" "$chrome_root/Local State"

FAKE_MCPORTER_STATUS=all \
  run_cli handoff resume --lane daily-driver --account-role owner --nonce-file "$(token_fixture "$origin_nonce")" \
    --page-url "$handoff_full_url" --json
assert_equals "$cli_status" '15' 'handoff resume refuses All-tabs access mode'
assert_contains "$cli_err" 'access_mode_mismatch' 'access-mode resume refusal is typed'
assert_present "$handoff_record" 'access-mode resume refusal preserves the reservation'

unadmitted_unrelated_url='https://different.invalid/other?UNRELATED-QUERY-SENTINEL=1'
FAKE_MCPORTER_PAGE_TEXT="0: Other ($unadmitted_unrelated_url) [selected]" \
  run_cli handoff resume --lane daily-driver --account-role owner --nonce-file "$(token_fixture "$origin_nonce")" \
    --page-url "$handoff_full_url" --json
assert_equals "$cli_status" '16' 'handoff resume remains recoverable when only unrelated pages are admitted'
assert_contains "$cli_err" 'handoff_grant_required' 'an unadmitted task site has the permission-specific refusal'
assert_contains "$cli_err" 'focus the intended task tab' 'the repair focuses only the intended task target'
assert_not_contains "$cli_err" 'UNRELATED-QUERY-SENTINEL' 'the repair neither names nor acts on unrelated admitted pages'
assert_present "$handoff_record" 'an unadmitted exact target preserves the reservation'

FAKE_MCPORTER_PAGE_TEXT=$'0: Intended ('"$handoff_full_url"$')\n1: Duplicate ('"$handoff_full_url"$')' \
  run_cli handoff resume --lane daily-driver --account-role owner --nonce-file "$(token_fixture "$origin_nonce")" \
    --page-url "$handoff_full_url" --json
assert_equals "$cli_status" '16' 'handoff resume refuses duplicate unselected same-site destinations'
assert_contains "$cli_err" 'handoff_page_ambiguous' 'ambiguous continuation refusal is typed'
assert_present "$handoff_record" 'ambiguous continuation preserves the reservation'

FAKE_MCPORTER_PAGE_TEXT=$'0: Intended ('"$handoff_full_url"$')\n1: Other (https://subdomain.fixture.invalid/other)' \
  run_cli handoff resume --lane daily-driver --account-role owner --nonce-file "$(token_fixture "$origin_nonce")" \
    --page-url "$handoff_full_url" --json
assert_equals "$cli_status" '16' 'handoff resume refuses two unselected same-site pages'
assert_contains "$cli_err" 'handoff_page_ambiguous' 'unselected same-site continuation refusal is typed'
assert_present "$handoff_record" 'ambiguous same-site continuation preserves the reservation'

origin_mismatch_calllog="$TEST_ROOT/origin-mismatch.calllog"
: >"$origin_mismatch_calllog"
FAKE_MCPORTER_CALLLOG="$origin_mismatch_calllog" \
  run_cli handoff resume --lane daily-driver --account-role owner --nonce-file "$(token_fixture "$origin_nonce")" \
    --page-url 'https://different.invalid/task?DESTINATION-SENTINEL=1' --json
assert_equals "$cli_status" '16' 'handoff resume refuses a declared destination on another origin'
assert_contains "$cli_err" 'handoff_destination_mismatch' 'different-origin destination refusal is typed'
assert_not_contains "$cli_err" 'different.invalid' 'different-origin refusal does not echo the requested origin'
assert_not_contains "$cli_err" 'DESTINATION-SENTINEL' 'different-origin refusal omits the requested query'
assert_equals "$(<"$origin_mismatch_calllog")" '' 'different-origin refusal performs no relay inspection'
assert_present "$handoff_record" 'different-origin resume preserves the reservation'
run_cli handoff release --lane daily-driver --nonce-file "$(token_fixture "$origin_nonce")" --json
assert_equals "$cli_status" '0' 'the original token releases the origin-mismatch reservation'

# Continuation holds the lane lease and durable reservation together until its
# exact-page proof completes. Another agent gets a busy refusal, never an
# unowned gap between human handback and verified continuation.
run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --run-id resume-order-open \
  --task-ref resume-order --page-url "$page_one" --json
resume_order_nonce="$(<"$last_token_output")"
resume_order_out="$TEST_ROOT/resume-order.out"
resume_order_err="$TEST_ROOT/resume-order.err"
resume_order_calls="$TEST_ROOT/resume-order.calls"
: >"$resume_order_calls"
HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
  FAKE_MCPORTER_HOLD_SECONDS=1 FAKE_MCPORTER_CALLLOG="$resume_order_calls" \
  FAKE_MCPORTER_PAGE_TEXT="0: Intended ($page_one) [selected]" \
  "$fixture_repo/bin/browser-lane" handoff resume --lane daily-driver \
    --account-role owner --run-id resume-order --nonce-file "$(token_fixture "$resume_order_nonce")" \
    --page-url "$page_one" --json >"$resume_order_out" 2>"$resume_order_err" &
resume_order_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -s "$resume_order_calls" ]] && break
  sleep 0.1
done
assert_present "$handoff_record" 'in-flight continuation retains the login reservation'
run_cli run --lane daily-driver --account-role owner --run-id resume-order-contender -- \
  mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '13' 'a competing agent sees the continuation lease as busy'
set +e
wait "$resume_order_pid"
resume_order_status=$?
set -e
assert_equals "$resume_order_status" '0' 'the owning continuation completes its exact-page proof'
assert_equals "$(jq -r '.data.state' "$resume_order_out")" 'resumed' \
  'only the owning continuation reports resumed state'
assert_absent "$handoff_record" 'completed continuation removes the reservation after proof'

# An interrupted continuation never consumes the reservation. The original
# token remains the only recovery authority.
run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --run-id resume-signal-open \
  --task-ref resume-signal --page-url "$page_one" --json
resume_signal_nonce="$(<"$last_token_output")"
resume_signal_out="$TEST_ROOT/resume-signal.out"
resume_signal_err="$TEST_ROOT/resume-signal.err"
resume_signal_calls="$TEST_ROOT/resume-signal.calls"
resume_signal_child_pids="$TEST_ROOT/resume-signal-child.pids"
resume_signal_descendant_pids="$TEST_ROOT/resume-signal-descendant.pids"
resume_signal_descendant_state="$TEST_ROOT/resume-signal-descendant.state"
: >"$resume_signal_calls"
HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
  FAKE_MCPORTER_HOLD_SECONDS=10 FAKE_MCPORTER_CALLLOG="$resume_signal_calls" \
  FAKE_MCPORTER_PAGE_LIST_PID_FILE="$resume_signal_child_pids" \
  FAKE_MCPORTER_PAGE_LIST_DESCENDANT_PID_FILE="$resume_signal_descendant_pids" \
  FAKE_MCPORTER_PAGE_LIST_DESCENDANT_STATE_FILE="$resume_signal_descendant_state" \
  FAKE_MCPORTER_PAGE_LIST_LEASE_DIR="$lease_dir" \
  FAKE_MCPORTER_PAGE_TEXT="0: Intended ($page_one) [selected]" \
  "$fixture_repo/bin/browser-lane" handoff resume --lane daily-driver \
    --account-role owner --run-id resume-signal --nonce-file "$(token_fixture "$resume_signal_nonce")" \
    --page-url "$page_one" --json >"$resume_signal_out" 2>"$resume_signal_err" &
resume_signal_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -s "$resume_signal_child_pids" && -s "$resume_signal_descendant_pids" ]] && break
  sleep 0.1
done
resume_signal_started_at=$SECONDS
kill -TERM "$resume_signal_pid"
set +e
wait "$resume_signal_pid"
resume_signal_status=$?
set -e
resume_signal_elapsed=$((SECONDS - resume_signal_started_at))
assert_equals "$resume_signal_status" '130' 'an interrupted continuation exits 130'
((resume_signal_elapsed < 4)) || fail 'interrupted continuation retires its MCPorter child promptly'
pass 'interrupted continuation retires its MCPorter child promptly'
assert_logged_pids_dead "$resume_signal_child_pids" 'interrupted continuation'
assert_logged_pids_dead "$resume_signal_descendant_pids" 'interrupted continuation descendant'
assert_present "$resume_signal_descendant_state" \
  'interrupted continuation descendant observes retirement'
assert_equals "$(<"$resume_signal_descendant_state")" 'lease=present' \
  'MCPorter descendant retirement begins before lane lease release'
resume_signal_error="$(tail -n 1 "$resume_signal_err")"
assert_contains "$resume_signal_error" 'handoff_resume_interrupted' \
  'interrupted continuation returns a dedicated typed page-proof failure'
assert_equals "$(jq -r '.error.retry_safe' <<<"$resume_signal_error")" 'true' \
  'interrupted read-only proof can retry with the retained inputs'
assert_present "$handoff_record" 'interrupted continuation preserves the reservation'
assert_absent "$lease_dir" 'interrupted continuation releases its command lease'
run_cli handoff status --lane daily-driver --json
assert_equals "$(jq -r '.data.state' <<<"$cli_out")" 'open' \
  'interrupted continuation leaves the handoff recoverable'
run_cli handoff release --lane daily-driver --nonce-file "$(token_fixture "$resume_signal_nonce")" --json
assert_equals "$cli_status" '0' 'the original token releases an interrupted continuation'
assert_absent "$handoff_record" 'interrupted continuation cleanup removes only on explicit release'

# A signal delivered after the atomic completion rename cannot advertise a
# nonce that no longer owns a reservation.
run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner --run-id resume-complete-open \
  --task-ref resume-complete --page-url "$page_one" --json
resume_complete_nonce="$(<"$last_token_output")"
FAKE_MV_SIGNAL_AFTER_MATCH='.handoff-complete.' \
FAKE_MCPORTER_PAGE_TEXT="0: Intended ($page_one) [selected]" \
  run_cli handoff resume --lane daily-driver --account-role owner \
    --run-id resume-complete-signal --nonce-file "$(token_fixture "$resume_complete_nonce")" \
    --page-url "$page_one" --json
assert_equals "$cli_status" '130' 'a signal after atomic completion reports interrupted output'
resume_complete_error="$(tail -n 1 <<<"$cli_err")"
assert_contains "$resume_complete_error" 'handoff_resume_completion_interrupted' \
  'post-completion interruption has a distinct typed result'
assert_equals "$(jq -r '.error.retry_safe' <<<"$resume_complete_error")" 'false' \
  'post-completion interruption forbids nonce reuse'
assert_not_contains "$cli_err" "$resume_complete_nonce" \
  'post-completion interruption does not echo obsolete recovery authority'
assert_absent "$handoff_record" 'atomic completion leaves no active reservation after its signal'
assert_equals "$(find "$handoff_root_dir" -name '.daily-driver.handoff-complete.*' | wc -l | tr -d ' ')" '0' \
  'post-completion interruption retires its private completion state'
run_cli handoff status --lane daily-driver --json
assert_equals "$(jq -r '.data.state' <<<"$cli_out")" 'absent' \
  'post-completion recovery truthfully reports that the nonce was consumed'

# Open holds the ordinary lane lease until the reservation exists. A contender
# sees busy during creation and handoff_open after creation, never an unowned gap.
handoff_bg_out="$TEST_ROOT/handoff-bg.out"
handoff_bg_err="$TEST_ROOT/handoff-bg.err"
HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
  FAKE_MCPORTER_HOLD_SECONDS=1 FAKE_MCPORTER_PAGE_TEXT="$handoff_page_text" \
  "$fixture_repo/bin/browser-lane" handoff open --nonce-output "$TEST_ROOT/handoff-bg-token" --lane daily-driver --account-role owner \
    --run-id handoff-order --task-ref ordering-proof --json >"$handoff_bg_out" 2>"$handoff_bg_err" &
handoff_bg_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -f "$lease_dir/owner.json" ]] && break
  sleep 0.1
done
assert_present "$lease_dir/owner.json" 'handoff open publishes the lane lease before state'
run_cli recovery create --lane daily-driver --retention-days 7 --deletion-owner owner --json
assert_equals "$cli_status" '13' 'recovery mutation sees lane busy while handoff opens'
assert_equals "$(find "$fixture_state/browser-lanes/recovery" -type f 2>/dev/null | wc -l | tr -d ' ')" '0' \
  'busy recovery mutation creates no snapshot during handoff open'
run_cli run --lane daily-driver --account-role owner --run-id ordering-contender -- \
  mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '13' 'a contender sees lane busy while handoff opens'
wait "$handoff_bg_pid"
assert_equals "$(jq -r '.data.state' "$handoff_bg_out")" 'open' \
  'background handoff completes with an open reservation'
ordering_nonce="$(<"$TEST_ROOT/handoff-bg-token")"
run_cli run --lane daily-driver --account-role owner --run-id ordering-after -- \
  mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '19' 'a contender sees the reservation after handoff creation'
run_cli handoff release --lane daily-driver --nonce-file "$(token_fixture "$ordering_nonce")" --json
assert_equals "$cli_status" '0' 'ordering-proof reservation releases cleanly'
assert_absent "$lease_dir" 'ordering proof leaves no lane lease'
assert_absent "$handoff_dir" 'ordering proof leaves no handoff reservation'

if [[ "$test_selection" == '--handoff-only' ]]; then
  [[ "$assertion_count" -eq 518 ]] || fail "handoff assertion count drifted (expected 518, got $assertion_count)"
  printf '1..%d\n' "$assertion_count"
  exit 0
fi

run_cli list --json
assert_equals "$cli_status" '0' 'list exits zero'
assert_equals "$(jq -r '.status' <<<"$cli_out")" 'ok' 'list emits a success envelope'
assert_equals "$(jq -r '.data.lanes | length' <<<"$cli_out")" '2' 'list reports every declared lane'

health_relay_argv="$TEST_ROOT/health-relay.argv"
health_page_calllog="$TEST_ROOT/health-page.calllog"
health_child_argv="$TEST_ROOT/health-child.argv"
: >"$health_page_calllog"
rm -f "$health_child_argv"
FAKE_MCPORTER_STATUS_ARGV="$health_relay_argv" FAKE_MCPORTER_CALLLOG="$health_page_calllog" \
  FAKE_MCPORTER_AGENT_ARGV="$health_child_argv" run_cli health --lane daily-driver --json
assert_equals "$cli_status" '0' 'healthy route with only observability warnings exits zero'
assert_equals "$(jq -r '.data.route' <<<"$cli_out")" 'pass' 'health proves the route'
assert_equals "$(jq -r '.data.baseline' <<<"$cli_out")" 'warning' 'health keeps unavailable access-mode and effective-policy proof visible'
assert_equals "$(jq -r '.data.findings | index("access_mode_live_check_unavailable") == null' <<<"$cli_out")" 'true' 'health replaces the live access-mode proof gap with its selected snapshot'
assert_equals "$(jq -r '.data.findings | index("effective_policy_check_unavailable") != null' <<<"$cli_out")" 'true' 'health names the effective-policy proof gap'
assert_equals "$(jq -r '.data.findings | index("extension_allowlist_drift") == null' <<<"$cli_out")" 'true' 'Chrome default extensions are outside the reviewed allowlist boundary'
assert_equals "$(<"$health_page_calllog")" '' 'health status never inventories a page'
assert_absent "$health_child_argv" 'health status never launches a relay child'
run_cli health --lane daily-driver
assert_equals "$cli_status" '0' 'human health output with only observability warnings exits zero'
assert_contains "$cli_out" 'effective_policy_check_unavailable' 'human health text names the effective-policy proof gap'
assert_equals "$(sed -n '1p' "$health_relay_argv")" 'chrome-relay' 'health probes the authenticated relay transport'
assert_equals "$(sed -n '2p' "$health_relay_argv")" 'status' 'health reads the live access snapshot'
assert_equals "$(sed -n '4p' "$health_relay_argv")" 'http://127.0.0.1:18799' 'health reads only the declared lane relay'
assert_equals "$(sed -n '6p' "$health_relay_argv")" '5000' 'health bounds its live status read'

assert_health_status() {
  local fixture="$1" route="$2" baseline="$3" finding="$4" label="$5"
  local calllog="$TEST_ROOT/health-$fixture.calllog" agentlog="$TEST_ROOT/health-$fixture.agentlog"
  : >"$calllog"
  rm -f "$agentlog"
  FAKE_MCPORTER_STATUS="$fixture" FAKE_MCPORTER_CALLLOG="$calllog" FAKE_MCPORTER_AGENT_ARGV="$agentlog" \
    run_cli health --lane daily-driver --json
  assert_equals "$cli_status" '15' "$label fails health"
  assert_equals "$(jq -r '.data.route' <<<"$cli_out")" "$route" "$label has the expected route state"
  assert_equals "$(jq -r '.data.baseline' <<<"$cli_out")" "$baseline" "$label has the expected baseline state"
  assert_equals "$(jq -r --arg finding "$finding" '.data.findings | index($finding) != null' <<<"$cli_out")" 'true' "$label names its access-status finding"
  assert_equals "$(jq -r '.data.findings | index("effective_policy_check_unavailable") != null' <<<"$cli_out")" 'true' "$label retains the effective-policy proof gap"
  assert_equals "$(<"$calllog")" '' "$label never inventories a page"
  assert_absent "$agentlog" "$label never launches a relay child"
}

assert_health_status all pass fail access_mode_mismatch 'all-mode status'
assert_health_status disabled pass fail access_mode_disabled 'disabled status'
assert_health_status transitioning pass fail access_mode_transitioning 'transitioning status'
assert_health_status malformed fail warning access_mode_live_check_unavailable 'unavailable status'

FAKE_LSOF_COMMAND='python' run_cli health --lane daily-driver --json
assert_equals "$cli_status" '15' 'a declared relay port owned by another runtime fails health'
assert_equals "$(jq -r '.data.route' <<<"$cli_out")" 'fail' 'listener ownership drift fails the route'
assert_equals "$(jq -r '.data.findings | index("relay_listener_mismatch") != null' <<<"$cli_out")" 'true' 'health names relay listener ownership drift'
FAKE_LSOF_ADDRESS='0.0.0.0' run_cli health --lane daily-driver --json
assert_equals "$cli_status" '15' 'a declared relay listener exposed beyond loopback fails health'
assert_equals "$(jq -r '.data.findings | index("relay_listener_mismatch") != null' <<<"$cli_out")" 'true' 'health names non-loopback relay listener drift'

jq '.lanes["daily-driver"].sync_expectations={"account_shape":"absent"}' "$registry_path" >"$TEST_ROOT/registry.tmp"
mv "$TEST_ROOT/registry.tmp" "$registry_path"
chmod 600 "$registry_path"
jq 'del(.sync.selected_types_per_account)' "$profile_dir/Preferences" >"$TEST_ROOT/preferences.tmp"
mv "$TEST_ROOT/preferences.tmp" "$profile_dir/Preferences"
run_cli health --lane daily-driver --json
assert_equals "$cli_status" '0' 'an absent Sync account matching the declared shape remains healthy'
assert_equals "$(jq -r '.data.findings | index("sync_account_shape_drift") == null' <<<"$cli_out")" 'true' 'health accepts the declared absent Sync account shape'
jq '.sync.selected_types_per_account={"new-account":{"sync.extensions":true}}' "$profile_dir/Preferences" >"$TEST_ROOT/preferences.tmp"
mv "$TEST_ROOT/preferences.tmp" "$profile_dir/Preferences"
run_cli health --lane daily-driver --json
assert_equals "$cli_status" '15' 'a Sync account appearing in an absent-policy lane fails health'
assert_equals "$(jq -r '.data.findings | index("sync_account_shape_drift") != null' <<<"$cli_out")" 'true' 'health names absent-account Sync drift'
assert_equals "$(jq -r '.data.baseline' <<<"$cli_out")" 'fail' 'absent-account Sync drift fails the baseline'
jq '.lanes["daily-driver"].sync_expectations={"account_shape":"exactly-one","selected_types":{"sync.autofill":false,"sync.extensions":false,"sync.passwords":false,"sync.payments":false}}' "$registry_path" >"$TEST_ROOT/registry.tmp"
mv "$TEST_ROOT/registry.tmp" "$registry_path"
chmod 600 "$registry_path"
jq '.sync.selected_types_per_account={"account":{"sync.autofill":false,"sync.extensions":false,"sync.passwords":false,"sync.payments":false}}' "$profile_dir/Preferences" >"$TEST_ROOT/preferences.tmp"
mv "$TEST_ROOT/preferences.tmp" "$profile_dir/Preferences"
jq '.sync.selected_types_per_account.account["sync.extensions"]=true' "$profile_dir/Preferences" >"$TEST_ROOT/preferences.tmp"
mv "$TEST_ROOT/preferences.tmp" "$profile_dir/Preferences"
run_cli health --lane daily-driver --json
assert_equals "$cli_status" '15' 'a reviewed Sync category changing value fails health'
assert_equals "$(jq -r '.data.findings | index("sync_selection_drift") != null' <<<"$cli_out")" 'true' 'health names reviewed Sync selection drift'
jq '.sync.selected_types_per_account.account["sync.extensions"]=false' "$profile_dir/Preferences" >"$TEST_ROOT/preferences.tmp"
mv "$TEST_ROOT/preferences.tmp" "$profile_dir/Preferences"

source_relay_argv="$TEST_ROOT/source-relay.argv"
source_page_calllog="$TEST_ROOT/source-page.calllog"
source_child_argv="$TEST_ROOT/source-child.argv"
: >"$source_page_calllog"
rm -f "$source_child_argv"
FAKE_MCPORTER_EXEC_ONLY_HELP=1 FAKE_MCPORTER_INSTALLED_STATUS_UNSUPPORTED=1 \
  FAKE_MCPORTER_SOURCE_ARGV="$source_relay_argv" FAKE_MCPORTER_CALLLOG="$source_page_calllog" \
  FAKE_MCPORTER_AGENT_ARGV="$source_child_argv" \
  run_cli health --lane daily-driver --json
assert_equals "$cli_status" '0' 'the source MCPorter fallback reads a selected live status'
assert_equals "$(jq -r '.data.route' <<<"$cli_out")" 'pass' 'the source MCPorter fallback preserves route health'
assert_equals "$(sed -n '1,2p' "$source_relay_argv")" $'chrome-relay\nstatus' 'the source MCPorter fallback invokes live status'
assert_equals "$(sed -n '4p' "$source_relay_argv")" 'http://127.0.0.1:18799' 'the source MCPorter fallback uses the declared relay'
assert_equals "$(sed -n '6p' "$source_relay_argv")" '5000' 'the source MCPorter fallback keeps the status timeout'
assert_equals "$(<"$source_page_calllog")" '' 'the source MCPorter fallback does not inventory pages'
assert_absent "$source_child_argv" 'the source MCPorter fallback does not launch a relay child'

# A core-incompatible install earlier on PATH must not hide a capable install.
shadow_bin="$TEST_ROOT/shadow-bin"
mkdir -p "$shadow_bin"
printf '#!/bin/sh\nexit 1\n' >"$shadow_bin/mcporter"
chmod +x "$shadow_bin/mcporter"
shadow_activity_log="$TEST_ROOT/shadow-activity.log"
shadow_source_log="$TEST_ROOT/shadow-source.log"
: >"$shadow_source_log"
set +e
cli_out="$(HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" \
  PATH="$shadow_bin:$fixture_bin:/usr/bin:/bin" \
  FAKE_MCPORTER_ACTIVITY_LOG="$shadow_activity_log" \
  FAKE_MCPORTER_SOURCE_CALLLOG="$shadow_source_log" \
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  "$fixture_repo/bin/browser-lane" run --lane daily-driver --account-role owner \
    --run-id shadowed-install --page-url "$page_one" -- \
    mcporter call chrome-devtools.take_snapshot --args '{}' 2>"$TEST_ROOT/shadow.stderr")"
cli_status=$?
set -e
assert_equals "$cli_status" '0' 'a shadowed capable MCPorter installation remains runnable'
assert_equals "$(<"$shadow_source_log")" '' 'a capable PATH installation precedes the older source fallback'
assert_equals "$(<"$shadow_activity_log")" $'start:chrome-devtools\nfinish\nclear' 'a shadowed capable installation publishes and clears activity'
assert_contains "$cli_out" 'fixture' 'installed discovery preserves adapter output'

source_activity_calllog="$TEST_ROOT/source-activity.calllog"
: >"$source_activity_calllog"
installed_activity_calllog="$TEST_ROOT/installed-activity.calllog"
: >"$installed_activity_calllog"
FAKE_MCPORTER_ACTIVITY_UNSUPPORTED=1 FAKE_MCPORTER_ACTIVITY_STATUS=90 \
  FAKE_MCPORTER_ACTIVITY_LOG="$installed_activity_calllog" \
  FAKE_MCPORTER_SOURCE_CALLLOG="$source_activity_calllog" \
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli run --lane daily-driver --account-role owner --run-id source-activity-skew --page-url "$page_one" -- \
    mcporter call chrome-devtools.take_snapshot --args '{}'
assert_equals "$cli_status" '0' 'installed core MCPorter keeps browser work available during activity skew'
assert_equals "$(<"$installed_activity_calllog")" 'start:chrome-devtools' 'installed core MCPorter attempts its unavailable advisory activity command'
assert_equals "$(<"$source_activity_calllog")" '' 'activity capability skew does not switch browser work to the source MCPorter'
assert_contains "$cli_out" 'fixture' 'installed core MCPorter still routes the requested child'

FAKE_MCPORTER_EXEC_ONLY_HELP=1 FAKE_MCPORTER_SOURCE_STATUS_UNSUPPORTED=1 \
  run_cli health --lane daily-driver --json
assert_equals "$cli_status" '15' 'an unsupported source MCPorter status check fails health'
assert_equals "$(jq -r '.data.route' <<<"$cli_out")" 'fail' 'an unsupported source status check is a route failure'
assert_equals "$(jq -r '.data.findings | index("access_mode_live_check_unavailable") != null' <<<"$cli_out")" 'true' 'an unsupported source status check remains explicit'

specialist_profile_dir="$chrome_root/Profile 14"
mkdir -p "$specialist_profile_dir"
cp "$profile_dir/Preferences" "$specialist_profile_dir/Preferences"
cp "$profile_dir/Secure Preferences" "$specialist_profile_dir/Secure Preferences"
cp "$registry_path" "$TEST_ROOT/registry-before-specialist.json"
jq '.profile.info_cache["Profile 14"]={"name":"Specialist"}' "$chrome_root/Local State" >"$TEST_ROOT/local-state.tmp"
mv "$TEST_ROOT/local-state.tmp" "$chrome_root/Local State"
jq '.lanes.specialist = (.lanes["daily-driver"] + {profile_directory:"Profile 14",profile_display_name:"Specialist",account_role:"specialist",relay_port:18798})' "$registry_path" >"$TEST_ROOT/registry.tmp"
mv "$TEST_ROOT/registry.tmp" "$registry_path"
chmod 600 "$registry_path"
specialist_relay_argv="$TEST_ROOT/specialist-relay.argv"
FAKE_OPENCLAW_PROFILE='Profile 14' FAKE_MCPORTER_STATUS_ARGV="$specialist_relay_argv" \
  run_cli health --lane specialist --json
assert_equals "$cli_status" '0' 'a valid isolated specialist profile passes health'
assert_equals "$(sed -n '1,2p' "$specialist_relay_argv")" $'chrome-relay\nstatus' 'the specialist lane reads live status'
assert_equals "$(sed -n '4p' "$specialist_relay_argv")" 'http://127.0.0.1:18798' 'the specialist lane uses its declared relay'
assert_equals "$(sed -n '6p' "$specialist_relay_argv")" '5000' 'the specialist lane keeps the status timeout'
cp "$TEST_ROOT/registry-before-specialist.json" "$registry_path"
chmod 600 "$registry_path"
jq 'del(.profile.info_cache["Profile 14"])' "$chrome_root/Local State" >"$TEST_ROOT/local-state.tmp"
mv "$TEST_ROOT/local-state.tmp" "$chrome_root/Local State"

jq 'del(.lanes["daily-driver"].allowed_extensions)' "$registry_path" >"$TEST_ROOT/registry.tmp"
mv "$TEST_ROOT/registry.tmp" "$registry_path"
chmod 600 "$registry_path"
run_cli health --lane daily-driver --json
assert_equals "$cli_status" '0' 'an unreviewed extension allowlist remains a visible warning'
assert_equals "$(jq -r '.data.findings | index("extension_allowlist_unreviewed") != null' <<<"$cli_out")" 'true' 'health names an unreviewed extension allowlist'
jq '.lanes["daily-driver"].allowed_extensions=["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]' "$registry_path" >"$TEST_ROOT/registry.tmp"
mv "$TEST_ROOT/registry.tmp" "$registry_path"
chmod 600 "$registry_path"

jq '.extensions.settings.cccccccccccccccccccccccccccccccc={"location":1}' "$profile_dir/Secure Preferences" >"$TEST_ROOT/secure-preferences.tmp"
mv "$TEST_ROOT/secure-preferences.tmp" "$profile_dir/Secure Preferences"
run_cli health --lane daily-driver --json
assert_equals "$cli_status" '15' 'an extension outside the reviewed allowlist fails health'
assert_equals "$(jq -r '.data.findings | index("extension_allowlist_drift") != null' <<<"$cli_out")" 'true' 'health names extension allowlist drift'
assert_equals "$(jq -r '.data.findings | index("effective_policy_check_unavailable") != null' <<<"$cli_out")" 'true' 'a baseline failure keeps the effective-policy proof gap visible'
assert_equals "$(jq -r '.data.baseline' <<<"$cli_out")" 'fail' 'extension allowlist drift fails the baseline'
assert_equals "$(jq -r '.data.route' <<<"$cli_out")" 'pass' 'extension drift does not misclassify the relay route'
jq 'del(.extensions.settings.cccccccccccccccccccccccccccccccc)' "$profile_dir/Secure Preferences" >"$TEST_ROOT/secure-preferences.tmp"
mv "$TEST_ROOT/secure-preferences.tmp" "$profile_dir/Secure Preferences"
run_cli health --lane daily-driver --json
assert_equals "$cli_status" '0' 'restoring the reviewed extension inventory restores health'
assert_equals "$(jq -r '.data.findings | index("extension_allowlist_drift") == null' <<<"$cli_out")" 'true' 'restored health removes extension allowlist drift'

run_cli health --lane specialist --json
assert_equals "$cli_status" '15' 'an unprovisioned lane does not pass health'
assert_equals "$(jq -r '.data.findings[0]' <<<"$cli_out")" 'lane_not_provisioned' 'health names the provisioning gap'

receipt="$TEST_ROOT/mcporter.receipt"
activity_log="$TEST_ROOT/route-activity.log"
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' FAKE_MCPORTER_ACTIVITY_LOG="$activity_log" FAKE_MCPORTER_RECEIPT="$receipt" run_cli run --lane daily-driver --account-role owner --run-id route-ok --page-url "$page_one" -- mcporter call chrome-devtools.list_pages --args '{}'
assert_equals "$cli_status" '0' 'run exits with the child success status'
assert_not_contains "$cli_out" 'chrome-relay activity' 'activity control never pollutes child stdout'
assert_equals "$(head -1 "$activity_log")" 'start:chrome-devtools' 'page-resolved lane work records its Chrome DevTools adapter before its child'
assert_equals "$(tail -1 "$activity_log")" 'clear' 'successful lane work clears matching activity on exit'

activity_protocol_argv="$TEST_ROOT/activity-protocol.argv"
activity_protocol_owner="$TEST_ROOT/activity-protocol.owner"
FAKE_MCPORTER_ACTIVITY_STRICT=1 FAKE_MCPORTER_ACTIVITY_OWNER="$activity_protocol_owner" \
FAKE_MCPORTER_ACTIVITY_ARGV="$activity_protocol_argv" \
FAKE_MCPORTER_ACTIVITY_FACTS="$TEST_ROOT/dashboard-facts.jsonl" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli run --lane daily-driver --account-role owner --page-url "$page_one" -- \
    mcporter call chrome-devtools.list_pages --args '{}'
assert_equals "$cli_status" '0' 'a generated colon-bearing lane run id has a safe activity owner'
activity_protocol_ids=()
while IFS= read -r activity_protocol_id; do
  activity_protocol_ids+=("$activity_protocol_id")
done < <(awk '/^--run-id$/{getline; print}' "$activity_protocol_argv")
assert_equals "${#activity_protocol_ids[@]}" '3' 'activity start, finish and clear each carry one owner id'
assert_equals "${activity_protocol_ids[0]}" "${activity_protocol_ids[2]}" 'activity clear uses exactly the start owner id'
assert_matches "${activity_protocol_ids[0]}" '^browser-lane-[0-9a-f]{64}$' 'activity owner is opaque and bounded to the MCPorter/OpenClaw grammar'
assert_not_contains "${activity_protocol_ids[0]}" ':' 'activity owner excludes generated run-id colons'
assert_equals "$(jq -sr '.[] | select(.kind=="finish") | [.action,.cleanup,.code] | join(":")' "$TEST_ROOT/dashboard-facts.jsonl")" 'completed:unknown:0' 'DevTools reports command completion without inventing session-cleanup proof'
assert_equals "$(jq -sr '.[] | select(.kind=="start") | .profile' "$TEST_ROOT/dashboard-facts.jsonl")" 'Daily' 'activity carries the declared profile display name'


activity_start_fail_log="$TEST_ROOT/activity-start-fail.log"
activity_start_fail_calllog="$TEST_ROOT/activity-start-fail.calllog"
FAKE_MCPORTER_ACTIVITY_STATUS=1 FAKE_MCPORTER_ACTIVITY_LOG="$activity_start_fail_log" \
FAKE_MCPORTER_CALLLOG="$activity_start_fail_calllog" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli run --lane daily-driver --account-role owner --run-id activity-start-fail --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot --args '{}'
assert_equals "$cli_status" '0' 'Chrome DevTools work survives unavailable activity publication'
assert_contains "$cli_err" 'lane_activity_unavailable' 'unavailable activity emits a bounded advisory diagnostic'
assert_contains "$(<"$activity_start_fail_calllog")" 'chrome-devtools.list_pages' 'unavailable activity follows exact-page preflight'
assert_contains "$(<"$activity_start_fail_calllog")" 'chrome-devtools.take_snapshot' 'unavailable activity still runs the requested child'
assert_contains "$cli_out" 'fixture' 'unavailable activity preserves Chrome DevTools child output'
assert_equals "$(<"$activity_start_fail_log")" 'start:chrome-devtools' 'failed activity start launches neither heartbeat nor clear'

activity_child_fail_log="$TEST_ROOT/activity-child-fail.log"
FAKE_MCPORTER_ACTIVITY_LOG="$activity_child_fail_log" FAKE_MCPORTER_CHILD_CALL_STATUS=23 \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli run --lane daily-driver --account-role owner --run-id activity-child-fail --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot --args '{}'
assert_equals "$cli_status" '23' 'child failure remains the public exit status after activity cleanup'
assert_equals "$(tail -1 "$activity_child_fail_log")" 'clear' 'child failure still clears matching activity'

activity_heartbeat_log="$TEST_ROOT/activity-heartbeat.log"
activity_heartbeat_sleep_pids="$TEST_ROOT/activity-heartbeat-sleep-pids.log"
FAKE_MCPORTER_ACTIVITY_LOG="$activity_heartbeat_log" FAKE_MCPORTER_HEARTBEAT_STATUS=1 \
FAKE_SLEEP_PID_LOG="$activity_heartbeat_sleep_pids" \
BROWSER_LANE_ACTIVITY_HEARTBEAT_SECONDS=1 FAKE_MCPORTER_HOLD_SECONDS=2 \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli run --lane daily-driver --account-role owner --run-id activity-heartbeat-fail --page-url "$page_one" -- mcporter call chrome-devtools.list_pages --args '{}'
assert_equals "$cli_status" '0' 'heartbeat failure remains best effort and preserves child success'
assert_contains "$(<"$activity_heartbeat_log")" 'heartbeat' 'held child permits an activity heartbeat attempt'
assert_equals "$(tail -1 "$activity_heartbeat_log")" 'clear' 'heartbeat worker is cleared after the child exits'
assert_absent "$lease_dir" 'heartbeat cleanup leaves no active lane lease'
assert_logged_pids_dead "$activity_heartbeat_sleep_pids" 'heartbeat cleanup'
assert_process_marker_absent 'activity-heartbeat-fail' 'heartbeat cleanup leaves no heartbeat worker process'

activity_killed_parent_log="$TEST_ROOT/activity-killed-parent.log"
activity_killed_parent_sleep_pids="$TEST_ROOT/activity-killed-parent-sleep-pids.log"
activity_killed_parent_stdout="$TEST_ROOT/activity-killed-parent.stdout"
activity_killed_parent_stderr="$TEST_ROOT/activity-killed-parent.stderr"
env HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
  FAKE_MCPORTER_ACTIVITY_LOG="$activity_killed_parent_log" \
  FAKE_SLEEP_PID_LOG="$activity_killed_parent_sleep_pids" \
  BROWSER_LANE_ACTIVITY_HEARTBEAT_SECONDS=1 FAKE_MCPORTER_CHILD_HOLD_SECONDS=3 \
  FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  "$fixture_repo/bin/browser-lane" run --lane daily-driver --account-role owner --run-id activity-killed-parent --ttl 3 --page-url "$page_one" -- \
    mcporter call chrome-devtools.take_snapshot --args '{}' >"$activity_killed_parent_stdout" 2>"$activity_killed_parent_stderr" &
activity_killed_parent_pid=$!
activity_worker_pid=''
for ((activity_attempt = 0; activity_attempt < 50; activity_attempt++)); do
  if [[ -f "$activity_killed_parent_sleep_pids" ]]; then
    while IFS= read -r activity_sleep_pid; do
      activity_worker_pid="$(ps -o ppid= -p "$activity_sleep_pid" 2>/dev/null | tr -d ' ')"
      activity_worker_command="$(ps -o command= -p "$activity_worker_pid" 2>/dev/null || true)"
      [[ "$activity_worker_command" == *'sleep_pid='* ]] && break 2
      activity_worker_pid=''
    done <"$activity_killed_parent_sleep_pids"
  fi
  sleep 0.1
done
assert_matches "$activity_worker_pid" '^[1-9][0-9]*$' 'killed public parent starts the bounded heartbeat worker'
kill -KILL "$activity_killed_parent_pid" 2>/dev/null || true
wait "$activity_killed_parent_pid" 2>/dev/null || true
activity_heartbeats_before="$(grep -c '^heartbeat$' "$activity_killed_parent_log" || true)"
sleep 2
activity_heartbeats_after="$(grep -c '^heartbeat$' "$activity_killed_parent_log" || true)"
assert_equals "$activity_heartbeats_after" "$activity_heartbeats_before" 'a SIGKILLed public parent cannot refresh activity after its worker checks custody'
sleep 2
assert_logged_pids_dead "$activity_killed_parent_sleep_pids" 'killed-parent heartbeat worker'
if kill -0 "$activity_worker_pid" 2>/dev/null; then
  fail 'killed-parent heartbeat worker exits before the lane deadline'
else
  pass 'killed-parent heartbeat worker exits before the lane deadline'
fi
# SIGKILL intentionally bypasses the public EXIT trap. This fixture-only stale
# owner is removed after liveness has been proved so later independent rows do
# not inherit the crash's private lease record.
rm -rf "$lease_dir"
assert_equals "$(sed -n 's/^policy=//p' "$receipt")" 'require' 'run forces relay-only policy'
assert_equals "$(sed -n 's/^url=//p' "$receipt")" 'http://127.0.0.1:18799' 'run selects only the declared loopback relay'
assert_equals "$(sed -n 's/^keepalive=//p' "$receipt")" '*' 'run disables cross-lane mcporter keepalive'
assert_equals "$(sed -n 's/^lane=//p' "$receipt")" 'daily-driver' 'run identifies the selected lane to the child'

run_cli run --lane daily-driver --account-role wrong --run-id wrong-role -- mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '11' 'a mismatched account role is refused'
assert_contains "$cli_err" 'account_role_mismatch' 'role refusal carries a structured category'

run_cli run --lane daily-driver --account-role owner --run-id wrong-tool -- curl https://example.com
assert_equals "$cli_status" '2' 'a non-mcporter child command is refused'

run_cli run --lane daily-driver --account-role owner --run-id empty-ttl --ttl "" -- mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '2' 'an explicit empty --ttl is refused rather than defaulted'
assert_contains "$cli_err" '--ttl must be' 'empty ttl refusal states the accepted range'
assert_absent "$lease_dir" 'empty ttl refusal acquires no lease'

hold_out="$TEST_ROOT/hold.out"
hold_err="$TEST_ROOT/hold.err"
HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
  FAKE_MCPORTER_HOLD_SECONDS=3 \
  "$fixture_repo/bin/browser-lane" run --lane daily-driver --account-role owner --run-id holder --ttl 30 -- \
    mcporter call chrome-devtools.list_pages >"$hold_out" 2>"$hold_err" &
holder_pid=$!

for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -f "$lease_dir/owner.json" ]] && break
  sleep 0.1
done
[[ -f "$lease_dir/owner.json" ]] || fail 'holder lease did not appear'
pass 'first run publishes an exclusive lease'

run_cli run --lane daily-driver --account-role owner --run-id contender --ttl 30 -- mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '13' 'a second live owner receives a busy refusal'
assert_contains "$cli_err" 'lane_busy' 'busy refusal carries a structured category'
wait "$holder_pid"
[[ ! -e "$lease_dir" ]] || fail 'clean exit did not release the lane'
pass 'clean exit releases the lane'

stale_dir="$lease_dir"
mkdir "$stale_dir"
cat >"$stale_dir/owner.json" <<'JSON'
{"run_id":"dead-owner","pid":999999,"process_start":"never","acquired_at_epoch":1,"expires_at_epoch":1}
JSON
chmod 600 "$stale_dir/owner.json"
run_cli run --lane daily-driver --account-role owner --run-id recovery --ttl 30 -- mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '0' 'an expired dead owner is recovered'
[[ ! -e "$stale_dir" ]] || fail 'stale recovery did not release its replacement lease'
pass 'stale recovery leaves no lease behind after success'

future_expiry=$(( $(date +%s) + 120 ))
mkdir "$stale_dir"
cat >"$stale_dir/owner.json" <<JSON
{"run_id":"dead-grace","pid":999999,"process_start":"never","acquired_at_epoch":1,"expires_at_epoch":$future_expiry}
JSON
chmod 600 "$stale_dir/owner.json"
run_cli run --lane daily-driver --account-role owner --run-id too-early --ttl 30 -- mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '13' 'a dead owner inside recovery grace remains busy'
assert_contains "$cli_err" 'lane_busy_stale_grace' 'stale grace refusal is typed'
rm -rf "$stale_dir"

cp "$chrome_root/Local State" "$TEST_ROOT/local-state.good"
printf '{"profile":{"info_cache":{"Profile 13":{"name":"Wrong"}}}}\n' >"$chrome_root/Local State"
run_cli run --lane daily-driver --account-role owner --run-id wrong-profile -- mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '11' 'a profile display-name mismatch fails before child execution'
assert_absent "$lease_dir" 'a preflight profile failure releases the lease'
mv "$TEST_ROOT/local-state.good" "$chrome_root/Local State"

# --- extension discovery failure: lease released, child never ran ---
ext_down_receipt="$TEST_ROOT/ext-down.receipt"
FAKE_OPENCLAW_FAIL=1 FAKE_MCPORTER_RECEIPT="$ext_down_receipt" run_cli run --lane daily-driver --account-role owner --run-id ext-down -- mcporter call chrome-devtools.list_pages
assert_equals "$cli_status" '12' 'an undiscovered extension fails before child execution'
assert_contains "$cli_err" 'extension_unavailable' 'extension refusal carries a structured category'
assert_absent "$lease_dir" 'a preflight extension failure releases the lease'
assert_absent "$ext_down_receipt" 'a preflight extension failure never runs the child'

# ============================================================================
# run: page-custody resolution and prohibited/remembered-identifier refusals
# ============================================================================
# The relay reports its page list as Markdown text whose title field is chosen
# by the page itself, so every row below shapes that text directly rather than a
# structured object the real relay never sends.
pages_text() {
  local text='## Pages' line
  for line in "$@"; do
    text+=$'\n'"$line"
  done
  printf '%s' "$text"
}

# Independent oracle for non-execution of parsed page text. A title that the
# shell expanded, sourced, or evaluated would create an entry here. Proved empty
# after the adversarial rows below.
canary_dir="$TEST_ROOT/canary"
mkdir -p "$canary_dir"

page_ok_calllog="$TEST_ROOT/page-ok.calllog"
page_ok_receipt="$TEST_ROOT/page-ok.receipt"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "7: FIXTURE-TITLE-ONE ($page_one) [selected]")" \
  FAKE_MCPORTER_CALLLOG="$page_ok_calllog" \
  FAKE_MCPORTER_RECEIPT="$page_ok_receipt" \
  run_cli run --lane daily-driver --account-role owner --run-id page-ok --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '0' 'an exactly selected page permits the child run'
assert_contains "$(<"$page_ok_calllog")" 'chrome-devtools.take_snapshot' 'an admitted page run reaches the child'
assert_contains "$(<"$page_ok_receipt")" 'page_id=7' 'an admitted page run exports the relay page index'
assert_absent "$lease_dir" 'an admitted page run releases the lease'
assert_equals "$(find "$fixture_state/browser-lanes" -name 'page-list.*' | wc -l | tr -d ' ')" '0' \
  'page-list temporary files are removed after page success'

page_not_selected_calllog="$TEST_ROOT/page-not-selected.calllog"
page_not_selected_activity_log="$TEST_ROOT/page-not-selected.activity.log"
page_not_selected_receipt="$TEST_ROOT/page-not-selected.receipt"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "8: FIXTURE-TITLE-ONE ($page_one)")" \
  FAKE_MCPORTER_CALLLOG="$page_not_selected_calllog" \
  FAKE_MCPORTER_RECEIPT="$page_not_selected_receipt" \
  FAKE_MCPORTER_ACTIVITY_LOG="$page_not_selected_activity_log" \
  run_cli run --lane daily-driver --account-role owner --run-id page-not-selected --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
page_not_selected_output="$cli_out$cli_err"
assert_equals "$cli_status" '0' 'one admitted page without the selected marker is usable'
assert_contains "$(<"$page_not_selected_calllog")" 'chrome-devtools.take_snapshot' \
  'one unselected same-site page runs the child'
assert_contains "$(<"$page_not_selected_receipt")" 'page_id=8' \
  'one unselected same-site page routes its resolved page ID'
assert_equals "$(head -1 "$page_not_selected_activity_log")" 'start:chrome-devtools' 'one unselected page publishes activity'
assert_absent "$lease_dir" 'one unselected page releases the lease'
assert_not_contains "$page_not_selected_output" "$page_one" \
  'successful unique-page output does not leak the declared URL'
assert_not_contains "$page_not_selected_output" "$page_two" \
  'successful unique-page output does not leak unrelated fixture URLs'

# Adversarial: the selected marker is a terminal suffix, never a substring a
# title can supply. A page that writes "[selected]" into its own title is not
# the relay's selected page.
page_marker_in_title_calllog="$TEST_ROOT/page-marker-in-title.calllog"
page_marker_in_title_receipt="$TEST_ROOT/page-marker-in-title.receipt"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "9: FIXTURE [selected] TITLE ($page_one)")" \
  FAKE_MCPORTER_CALLLOG="$page_marker_in_title_calllog" \
  FAKE_MCPORTER_RECEIPT="$page_marker_in_title_receipt" \
  run_cli run --lane daily-driver --account-role owner --run-id page-marker-in-title --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '0' 'a selected marker inside the title does not block one unique page'
assert_contains "$(<"$page_marker_in_title_receipt")" 'page_id=9' \
  'a title-supplied selected marker does not alter the unique resolved page ID'
assert_contains "$(<"$page_marker_in_title_calllog")" 'chrome-devtools.take_snapshot' \
  'a uniquely matched page still runs when its title contains a marker'
assert_absent "$lease_dir" 'a title-supplied selected marker releases the lease'

# Adversarial: the marker must close the line, not merely precede the URL field.
page_marker_before_url_calllog="$TEST_ROOT/page-marker-before-url.calllog"
page_marker_before_url_receipt="$TEST_ROOT/page-marker-before-url.receipt"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "10: FIXTURE-TITLE-ONE [selected] ($page_one)")" \
  FAKE_MCPORTER_CALLLOG="$page_marker_before_url_calllog" \
  FAKE_MCPORTER_RECEIPT="$page_marker_before_url_receipt" \
  run_cli run --lane daily-driver --account-role owner --run-id page-marker-before-url --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '0' 'a selected marker before the URL field does not block one unique page'
assert_contains "$(<"$page_marker_before_url_receipt")" 'page_id=10' \
  'a misplaced selected marker does not alter the unique resolved page ID'
assert_contains "$(<"$page_marker_before_url_calllog")" 'chrome-devtools.take_snapshot' \
  'a uniquely matched page still runs with a misplaced marker in its title'
assert_absent "$lease_dir" 'a misplaced selected marker releases the lease'

page_list_bare_receipt="$TEST_ROOT/page-list-bare.receipt"
FAKE_MCPORTER_RECEIPT="$page_list_bare_receipt" \
  run_cli run --lane daily-driver --account-role owner --run-id page-list-bare --ttl 30 \
    -- mcporter call chrome-devtools.list_pages --args '{}'
assert_equals "$cli_status" '0' 'bare list_pages still permits a run without --page-url'
assert_equals "$(grep -c '^page_id=$' "$page_list_bare_receipt" || true)" '1' \
  'bare list_pages leaves the page id unset'

page_zero_calllog="$TEST_ROOT/page-zero-match.calllog"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "0: FIXTURE-TITLE-TWO ($different_site_page) [selected]")" \
  FAKE_MCPORTER_CALLLOG="$page_zero_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-zero-match --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
page_zero_output="$cli_out$cli_err"
assert_equals "$cli_status" '16' 'a page URL with zero admitted matches is refused'
assert_contains "$cli_err" 'page_not_admitted' 'zero admitted matches carry a typed refusal'
assert_equals "$cli_out" '' 'zero admitted matches print nothing on stdout'
assert_not_contains "$(<"$page_zero_calllog")" 'chrome-devtools.take_snapshot' \
  'zero admitted matches never run the child'
assert_absent "$lease_dir" 'zero admitted matches release the lease'
assert_not_contains "$page_zero_output" "$page_one" 'zero-match refusal does not leak the declared URL'
assert_not_contains "$page_zero_output" "$different_site_page" 'zero-match refusal does not leak the admitted URL'

page_dup_calllog="$TEST_ROOT/page-dup-match.calllog"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "1: FIXTURE-TITLE-ONE ($page_one)" "2: FIXTURE-TITLE-TWO ($page_one)")" \
  FAKE_MCPORTER_CALLLOG="$page_dup_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-dup-match --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
page_dup_output="$cli_out$cli_err"
assert_equals "$cli_status" '16' 'duplicate unselected same-site page matches are refused'
assert_contains "$cli_err" 'page_ambiguous' 'duplicate admitted matches carry a typed refusal'
assert_not_contains "$(<"$page_dup_calllog")" 'chrome-devtools.take_snapshot' \
  'duplicate admitted matches never run the child'
assert_absent "$lease_dir" 'duplicate admitted matches release the lease'
assert_not_contains "$page_dup_output" "$page_one" 'ambiguous refusal does not leak the declared URL'
assert_not_contains "$page_dup_output" "$page_two" 'ambiguous refusal does not leak the unrelated URL'

page_unrelated_calllog="$TEST_ROOT/page-one-plus-unrelated.calllog"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "1: FIXTURE-TITLE-ONE ($page_one) [selected]" "2: FIXTURE-TITLE-TWO ($page_two)")" \
  FAKE_MCPORTER_CALLLOG="$page_unrelated_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-one-plus-unrelated --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '0' 'one selected same-site match remains usable beside another same-site page'
assert_equals "$cli_err" '' 'selected same-site resolution stays quiet on stderr'
assert_contains "$(<"$page_unrelated_calllog")" 'chrome-devtools.take_snapshot' \
  'one selected same-site match runs the child'
assert_absent "$lease_dir" 'two same-site pages release the lease after selected resolution'

page_selected_site_receipt="$TEST_ROOT/page-selected-site.receipt"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "1: FIRST ($page_one)" "2: SELECTED ($page_two) [selected]")" \
  FAKE_MCPORTER_RECEIPT="$page_selected_site_receipt" \
  run_cli run --lane daily-driver --account-role owner --run-id page-selected-site --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '0' 'Chrome DevTools accepts a selected same-site different path'
assert_contains "$(<"$page_selected_site_receipt")" 'page_id=2' \
  'Chrome DevTools routes the selected same-site page ID'
assert_absent "$lease_dir" 'selected same-site Chrome DevTools run releases the lease'

FAKE_MCPORTER_PAGE_TEXT="$(pages_text)" \
  run_cli run --lane daily-driver --account-role owner --run-id page-empty-list --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '16' 'a header-only page list is refused'
assert_contains "$cli_err" 'page_not_admitted' 'a header-only page list carries a typed refusal'
assert_not_contains "$cli_err" 'page_list_unreadable' 'a header-only page list is not classified as unreadable'
assert_absent "$lease_dir" 'a header-only page list releases the lease'

# ============================================================================
# run: adversarial page-list parsing and child non-execution
#
# Every row below feeds bin/browser-lane text a hostile page could put in its
# own title. The contract proved here is that the title can never impersonate
# the terminal URL field, can never select itself, can never reach a shell, and
# can never appear in a refusal.
# ============================================================================

# A title may contain a full parenthesised URL. The URL field is the last
# parenthesised group closing the line, so the decoy is title text and the real
# page is still admitted.
page_decoy_calllog="$TEST_ROOT/page-decoy-url.calllog"
page_decoy_receipt="$TEST_ROOT/page-decoy-url.receipt"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "3: Decoy (https://evil.invalid/DECOY) ($page_one) [selected]")" \
  FAKE_MCPORTER_CALLLOG="$page_decoy_calllog" \
  FAKE_MCPORTER_RECEIPT="$page_decoy_receipt" \
  run_cli run --lane daily-driver --account-role owner --run-id page-decoy-url --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '0' 'a parenthesised URL inside the title does not displace the URL field'
assert_contains "$(<"$page_decoy_calllog")" 'chrome-devtools.take_snapshot' \
  'a decoy URL in the title still admits the real page'
assert_contains "$(<"$page_decoy_receipt")" 'page_id=3' 'a decoy URL in the title keeps the real page index'
assert_absent "$lease_dir" 'a decoy URL in the title releases the lease'

# The mirror case: the declared URL appears in the title while the real URL
# field is a different page. A greedy parser would admit this; it must not.
page_impersonate_calllog="$TEST_ROOT/page-impersonate.calllog"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "4: Trap ($page_one) (https://evil.invalid/REAL) [selected]")" \
  FAKE_MCPORTER_CALLLOG="$page_impersonate_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-impersonate --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
page_impersonate_output="$cli_out$cli_err"
assert_equals "$cli_status" '16' 'a title carrying the declared URL does not match the declared page'
assert_contains "$cli_err" 'page_not_admitted' 'a title-impersonated URL carries a typed refusal'
assert_not_contains "$(<"$page_impersonate_calllog")" 'chrome-devtools.take_snapshot' \
  'a title-impersonated URL never runs the child'
assert_absent "$lease_dir" 'a title-impersonated URL releases the lease'
assert_not_contains "$page_impersonate_output" "$page_one" \
  'a title-impersonated URL refusal does not leak the declared URL'
assert_not_contains "$page_impersonate_output" 'evil.invalid' \
  'a title-impersonated URL refusal does not leak the admitted URL'

# Shell metacharacters in a title are data. The canary directory is the oracle:
# any expansion, substitution, or evaluation would create a file in it.
page_metachar_calllog="$TEST_ROOT/page-metachar.calllog"
page_metachar_receipt="$TEST_ROOT/page-metachar.receipt"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "5: \$(touch $canary_dir/SUBSHELL) \`touch $canary_dir/BACKTICK\` ; touch $canary_dir/SEMICOLON | touch $canary_dir/PIPE && \${IFS}* ($page_one) [selected]")" \
  FAKE_MCPORTER_CALLLOG="$page_metachar_calllog" \
  FAKE_MCPORTER_RECEIPT="$page_metachar_receipt" \
  run_cli run --lane daily-driver --account-role owner --run-id page-metachar --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '0' 'a title of shell metacharacters is parsed as data'
assert_contains "$(<"$page_metachar_receipt")" 'page_id=5' 'a metacharacter title keeps the real page index'
assert_equals "$(entry_count "$canary_dir")" '0' 'no part of a metacharacter title is executed by the lane'

# A title that looks like an option must never reach the child command line.
page_flag_argv="$TEST_ROOT/page-flag-title.argv"
page_flag_receipt="$TEST_ROOT/page-flag-title.receipt"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "6: --page-url https://evil.invalid/FLAG --args {} ($page_one) [selected]")" \
  FAKE_MCPORTER_ARGV="$page_flag_argv" \
  FAKE_MCPORTER_RECEIPT="$page_flag_receipt" \
  run_cli run --lane daily-driver --account-role owner --run-id page-flag-title --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '0' 'an option-shaped title is parsed as data'
assert_contains "$(<"$page_flag_receipt")" 'page_id=6' 'an option-shaped title keeps the real page index'
assert_not_contains "$(<"$page_flag_argv")" 'evil.invalid' \
  'an option-shaped title never reaches the child command line'

# A tab in a title cannot corrupt the internal tab-separated page summary,
# because no title field ever crosses that boundary.
page_tab_receipt="$TEST_ROOT/page-tab-title.receipt"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "2: FIXTURE"$'\t'"TAB"$'\t'"TITLE ($page_one) [selected]")" \
  FAKE_MCPORTER_RECEIPT="$page_tab_receipt" \
  run_cli run --lane daily-driver --account-role owner --run-id page-tab-title --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '0' 'a tab inside the title does not corrupt page resolution'
assert_contains "$(<"$page_tab_receipt")" 'page_id=2' 'a tab inside the title keeps the real page index'

# --- structurally unreadable relay output: refuse, never guess ---------------
assert_page_list_unreadable() {
  local label="$1" calllog="$2"
  assert_equals "$cli_status" '16' "$label is refused"
  assert_contains "$cli_err" 'page_list_unreadable' "$label carries a typed refusal"
  assert_equals "$cli_out" '' "$label prints nothing on stdout"
  assert_not_contains "$(<"$calllog")" 'chrome-devtools.take_snapshot' "$label never runs the child"
  assert_absent "$lease_dir" "$label releases the lease"
  assert_equals "$(find "$fixture_state/browser-lanes" -name 'page-list.*' | wc -l | tr -d ' ')" '0' \
    "$label removes its page-list temporary file"
}

run_unreadable_row() {
  local run_id="$1" envelope="$2"
  unreadable_calllog="$TEST_ROOT/$run_id.calllog"
  : >"$unreadable_calllog"
  FAKE_MCPORTER_ENVELOPE="$envelope" \
    FAKE_MCPORTER_CALLLOG="$unreadable_calllog" \
    run_cli run --lane daily-driver --account-role owner --run-id "$run_id" --ttl 30 \
      --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
}

run_unreadable_row 'page-envelope-array' '[]'
assert_page_list_unreadable 'a top-level JSON array page list' "$unreadable_calllog"

run_unreadable_row 'page-envelope-scalar' '"just a string"'
assert_page_list_unreadable 'a top-level JSON string page list' "$unreadable_calllog"

run_unreadable_row 'page-content-not-array' '{"content":"## Pages"}'
assert_page_list_unreadable 'a non-array content field' "$unreadable_calllog"

run_unreadable_row 'page-content-missing' '{"structuredContent":{"pages":[]}}'
assert_page_list_unreadable 'an envelope with no content field' "$unreadable_calllog"

run_unreadable_row 'page-text-not-string' '{"content":[{"type":"text","text":5}]}'
assert_page_list_unreadable 'a non-string text field' "$unreadable_calllog"

run_unreadable_row 'page-no-text-part' '{"content":[{"type":"image","data":"x"}]}'
assert_page_list_unreadable 'a content envelope with no text part' "$unreadable_calllog"

run_unreadable_row 'page-garbage' 'not json at all'
assert_page_list_unreadable 'non-JSON relay output' "$unreadable_calllog"

run_unreadable_row 'page-empty-output' ''
assert_page_list_unreadable 'empty relay output' "$unreadable_calllog"

# --- unparseable page lines: refuse the whole list, never a subset -----------
run_unparseable_row() {
  local run_id="$1"
  shift
  unreadable_calllog="$TEST_ROOT/$run_id.calllog"
  : >"$unreadable_calllog"
  FAKE_MCPORTER_PAGE_TEXT="$(pages_text "$@")" \
    FAKE_MCPORTER_CALLLOG="$unreadable_calllog" \
    run_cli run --lane daily-driver --account-role owner --run-id "$run_id" --ttl 30 \
      --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
}

run_unparseable_row 'page-no-url-field' '0: FIXTURE-TITLE-ONE [selected]'
assert_page_list_unreadable 'a page line with no URL field' "$unreadable_calllog"

run_unparseable_row 'page-url-has-space' "0: FIXTURE-TITLE-ONE (https://fixture.invalid/A B) [selected]"
assert_page_list_unreadable 'a page line whose URL field contains whitespace' "$unreadable_calllog"

run_unparseable_row 'page-empty-url' '0: FIXTURE-TITLE-ONE () [selected]'
assert_page_list_unreadable 'a page line with an empty URL field' "$unreadable_calllog"

run_unparseable_row 'page-negative-index' "-1: FIXTURE-TITLE-ONE ($page_one) [selected]"
assert_page_list_unreadable 'a page line with an option-shaped index' "$unreadable_calllog"

run_unparseable_row 'page-unknown-line' "0: FIXTURE-TITLE-ONE ($page_one) [selected]" 'an unexpected trailing note'
assert_page_list_unreadable 'an otherwise valid list carrying an unknown line' "$unreadable_calllog"

# A single unparseable line refuses the whole list rather than admitting the
# lines that happened to parse.
run_unparseable_row 'page-partial-parse' "0: FIXTURE-TITLE-ONE ($page_one) [selected]" '1: BROKEN-LINE-NO-URL'
assert_page_list_unreadable 'a list mixing a valid and an unparseable page line' "$unreadable_calllog"

assert_equals "$(entry_count "$canary_dir")" '0' \
  'no adversarial page list executed anything through the lane'

# ============================================================================
# run: routing the freshly resolved page index onto the child command line
#
# mcporter does not read BROWSER_LANE_PAGE_ID as tool input, so the resolved
# index is only a real handoff when it reaches the child argument vector. These
# rows read the argument vector the child actually received, one argument per
# line, rather than trusting the lane's own report.
# ============================================================================

# The routed page id is the one this run resolved, not a remembered value.
page_route_args_argv="$TEST_ROOT/page-route-args.argv"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "4: FIXTURE-TITLE-ONE ($page_one) [selected]")" \
  FAKE_MCPORTER_ARGV="$page_route_args_argv" \
  run_cli run --lane daily-driver --account-role owner --run-id page-route-args --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot --args '{}'
assert_equals "$cli_status" '0' 'a routed page id run reaches the child'
assert_equals "$(<"$page_route_args_argv")" \
  "$(printf 'call\nchrome-devtools.take_snapshot\n--args\n{}\npageId=4')" \
  'an existing --args payload is preserved and the resolved page id is routed after it'

# No --args at all: the named argument is still routed.
page_route_bare_argv="$TEST_ROOT/page-route-bare.argv"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "5: FIXTURE-TITLE-ONE ($page_one) [selected]")" \
  FAKE_MCPORTER_ARGV="$page_route_bare_argv" \
  run_cli run --lane daily-driver --account-role owner --run-id page-route-bare --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '0' 'a child without --args still runs'
assert_equals "$(<"$page_route_bare_argv")" \
  "$(printf 'call\nchrome-devtools.take_snapshot\npageId=5')" \
  'a child without --args receives the routed page id'

# Arbitrary unrelated flags keep their identity and order.
page_route_flags_argv="$TEST_ROOT/page-route-flags.argv"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "6: FIXTURE-TITLE-ONE ($page_one) [selected]")" \
  FAKE_MCPORTER_ARGV="$page_route_flags_argv" \
  run_cli run --lane daily-driver --account-role owner --run-id page-route-flags --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot \
      --args '{"format":"text"}' --output json --timeout 30
assert_equals "$cli_status" '0' 'a child carrying unrelated flags still runs'
assert_equals "$(<"$page_route_flags_argv")" \
  "$(printf 'call\nchrome-devtools.take_snapshot\n--args\n{"format":"text"}\n--output\njson\n--timeout\n30\npageId=6')" \
  'unrelated child flags keep their identity and order around the routed page id'

# mcporter stops reading named arguments at a literal --, so the routed
# argument has to land before the child's own terminator.
page_route_terminator_argv="$TEST_ROOT/page-route-terminator.argv"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "7: FIXTURE-TITLE-ONE ($page_one) [selected]")" \
  FAKE_MCPORTER_ARGV="$page_route_terminator_argv" \
  run_cli run --lane daily-driver --account-role owner --run-id page-route-terminator --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot --args '{}' -- trailing-value
assert_equals "$cli_status" '0' 'a child carrying its own terminator still runs'
assert_equals "$(<"$page_route_terminator_argv")" \
  "$(printf 'call\nchrome-devtools.take_snapshot\n--args\n{}\npageId=7\n--\ntrailing-value')" \
  'the routed page id is inserted before the child terminator'

# Only the first terminator is a boundary; later ones are ordinary values.
page_route_two_terminators_argv="$TEST_ROOT/page-route-two-terminators.argv"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "8: FIXTURE-TITLE-ONE ($page_one) [selected]")" \
  FAKE_MCPORTER_ARGV="$page_route_two_terminators_argv" \
  run_cli run --lane daily-driver --account-role owner --run-id page-route-two-terminators --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot -- first -- second
assert_equals "$cli_status" '0' 'a child carrying repeated terminators still runs'
assert_equals "$(<"$page_route_two_terminators_argv")" \
  "$(printf 'call\nchrome-devtools.take_snapshot\npageId=8\n--\nfirst\n--\nsecond')" \
  'the routed page id is inserted once, before the first child terminator'

# list_pages takes no input, so it is never given a page id.
page_route_list_bare_argv="$TEST_ROOT/page-route-list-bare.argv"
FAKE_MCPORTER_ARGV="$page_route_list_bare_argv" \
  run_cli run --lane daily-driver --account-role owner --run-id page-route-list-bare --ttl 30 \
    -- mcporter call chrome-devtools.list_pages --args '{}'
assert_equals "$cli_status" '0' 'bare list_pages still runs'
assert_equals "$(<"$page_route_list_bare_argv")" \
  "$(printf 'call\nchrome-devtools.list_pages\n--args\n{}')" \
  'bare list_pages reaches the child command line unchanged'
assert_not_contains "$(<"$page_route_list_bare_argv")" 'pageId' \
  'bare list_pages is never given a page id'

# list_pages with a declared page still resolves custody, but still takes no
# input, so the resolved index stays off its command line.
page_route_list_url_argv="$TEST_ROOT/page-route-list-url.argv"
page_route_list_url_receipt="$TEST_ROOT/page-route-list-url.receipt"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "9: FIXTURE-TITLE-ONE ($page_one) [selected]")" \
  FAKE_MCPORTER_ARGV="$page_route_list_url_argv" \
  FAKE_MCPORTER_RECEIPT="$page_route_list_url_receipt" \
  run_cli run --lane daily-driver --account-role owner --run-id page-route-list-url --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.list_pages --args '{}'
assert_equals "$cli_status" '0' 'list_pages with a declared page still runs'
assert_not_contains "$(<"$page_route_list_url_argv")" 'pageId' \
  'list_pages is never given a page id even when custody was resolved'
assert_contains "$(<"$page_route_list_url_receipt")" 'page_id=9' \
  'list_pages with a declared page still resolves custody for observability'

# The router owns the page id: a caller-supplied one is refused before the
# lease, so it can never race, override, or sit beside the routed value.
page_route_override_argv="$TEST_ROOT/page-route-override.argv"
page_route_override_calllog="$TEST_ROOT/page-route-override.calllog"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "4: FIXTURE-TITLE-ONE ($page_one) [selected]")" \
  FAKE_MCPORTER_ARGV="$page_route_override_argv" \
  FAKE_MCPORTER_CALLLOG="$page_route_override_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-route-override --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot pageId=99
assert_equals "$cli_status" '2' 'a caller-supplied named pageId is refused'
assert_contains "$cli_err" 'remembered_page_identifier' 'a caller-supplied named pageId is typed'
assert_absent "$page_route_override_argv" 'a caller-supplied named pageId never reaches a child'
assert_absent "$page_route_override_calllog" 'a caller-supplied named pageId makes no relay call'
assert_absent "$lease_dir" 'a caller-supplied named pageId acquires no lease'

# The same refusal holds behind the child's own terminator, where a caller
# might expect the argument to escape inspection.
page_route_override_after_argv="$TEST_ROOT/page-route-override-after.argv"
FAKE_MCPORTER_ARGV="$page_route_override_after_argv" \
  run_cli run --lane daily-driver --account-role owner --run-id page-route-override-after --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot -- pageId=99
assert_equals "$cli_status" '2' 'a caller-supplied pageId behind a terminator is refused'
assert_contains "$cli_err" 'remembered_page_identifier' 'a pageId behind a terminator is typed'
assert_absent "$page_route_override_after_argv" 'a pageId behind a terminator never reaches a child'

# The routed argument carries the index and nothing else: no page URL, no
# title, on the command line the child actually received.
page_route_noleak_argv="$TEST_ROOT/page-route-noleak.argv"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "3: FIXTURE-TITLE-SENTINEL ($page_one) [selected]")" \
  FAKE_MCPORTER_ARGV="$page_route_noleak_argv" \
  run_cli run --lane daily-driver --account-role owner --run-id page-route-noleak --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot --args '{}'
page_route_noleak_line="$(<"$page_route_noleak_argv")"
assert_equals "$cli_status" '0' 'a routed page id run with a sentinel title reaches the child'
assert_contains "$page_route_noleak_line" 'pageId=3' 'the routed argument carries the resolved index'
assert_not_contains "$page_route_noleak_line" "$page_one" \
  'the child command line never carries the declared page URL'
assert_not_contains "$page_route_noleak_line" 'FIXTURE-TITLE-SENTINEL' \
  'the child command line never carries the admitted page title'

page_prohibited_new_page_calllog="$TEST_ROOT/page-prohibited-new-page.calllog"
FAKE_MCPORTER_CALLLOG="$page_prohibited_new_page_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-prohibited-new-page --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.new_page
assert_equals "$cli_status" '2' 'new_page is prohibited inside a lane run'
assert_contains "$cli_err" 'prohibited_tool' 'new_page refusal carries a typed category'
assert_absent "$lease_dir" 'new_page refusal acquires no lease'
assert_absent "$page_prohibited_new_page_calllog" 'new_page refusal makes no relay call'

page_prohibited_navigate_page_calllog="$TEST_ROOT/page-prohibited-navigate-page.calllog"
FAKE_MCPORTER_CALLLOG="$page_prohibited_navigate_page_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-prohibited-navigate-page --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.navigate_page
assert_equals "$cli_status" '2' 'navigate_page is prohibited inside a lane run'
assert_contains "$cli_err" 'prohibited_tool' 'navigate_page refusal carries a typed category'
assert_absent "$lease_dir" 'navigate_page refusal acquires no lease'
assert_absent "$page_prohibited_navigate_page_calllog" 'navigate_page refusal makes no relay call'

page_prohibited_install_pwa_calllog="$TEST_ROOT/page-prohibited-install-pwa.calllog"
FAKE_MCPORTER_CALLLOG="$page_prohibited_install_pwa_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-prohibited-install-pwa --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.install_pwa
assert_equals "$cli_status" '2' 'install_pwa is prohibited inside a lane run'
assert_contains "$cli_err" 'prohibited_tool' 'install_pwa refusal carries a typed category'
assert_absent "$lease_dir" 'install_pwa refusal acquires no lease'
assert_absent "$page_prohibited_install_pwa_calllog" 'install_pwa refusal makes no relay call'

page_prohibited_launch_pwa_calllog="$TEST_ROOT/page-prohibited-launch-pwa.calllog"
FAKE_MCPORTER_CALLLOG="$page_prohibited_launch_pwa_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-prohibited-launch-pwa --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.launch_pwa
assert_equals "$cli_status" '2' 'launch_pwa is prohibited inside a lane run'
assert_contains "$cli_err" 'prohibited_tool' 'launch_pwa refusal carries a typed category'
assert_absent "$lease_dir" 'launch_pwa refusal acquires no lease'
assert_absent "$page_prohibited_launch_pwa_calllog" 'launch_pwa refusal makes no relay call'

page_prohibited_uninstall_pwa_calllog="$TEST_ROOT/page-prohibited-uninstall-pwa.calllog"
FAKE_MCPORTER_CALLLOG="$page_prohibited_uninstall_pwa_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-prohibited-uninstall-pwa --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.uninstall_pwa
assert_equals "$cli_status" '2' 'uninstall_pwa is prohibited inside a lane run'
assert_contains "$cli_err" 'prohibited_tool' 'uninstall_pwa refusal carries a typed category'
assert_absent "$lease_dir" 'uninstall_pwa refusal acquires no lease'
assert_absent "$page_prohibited_uninstall_pwa_calllog" 'uninstall_pwa refusal makes no relay call'

page_prohibited_execute_3p_calllog="$TEST_ROOT/page-prohibited-execute-3p.calllog"
FAKE_MCPORTER_CALLLOG="$page_prohibited_execute_3p_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-prohibited-execute-3p --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.execute_3p_developer_tool
assert_equals "$cli_status" '2' 'execute_3p_developer_tool is prohibited inside a lane run'
assert_contains "$cli_err" 'prohibited_tool' 'execute_3p_developer_tool refusal carries a typed category'
assert_absent "$lease_dir" 'execute_3p_developer_tool refusal acquires no lease'
assert_absent "$page_prohibited_execute_3p_calllog" 'execute_3p_developer_tool refusal makes no relay call'

page_prohibited_execute_webmcp_calllog="$TEST_ROOT/page-prohibited-execute-webmcp.calllog"
FAKE_MCPORTER_CALLLOG="$page_prohibited_execute_webmcp_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-prohibited-execute-webmcp --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.execute_webmcp_tool
assert_equals "$cli_status" '2' 'execute_webmcp_tool is prohibited inside a lane run'
assert_contains "$cli_err" 'prohibited_tool' 'execute_webmcp_tool refusal carries a typed category'
assert_absent "$lease_dir" 'execute_webmcp_tool refusal acquires no lease'
assert_absent "$page_prohibited_execute_webmcp_calllog" 'execute_webmcp_tool refusal makes no relay call'

page_evaluate_script_calllog="$TEST_ROOT/page-evaluate-script.calllog"
FAKE_MCPORTER_PAGE_TEXT="$(pages_text "9: FIXTURE-TITLE-ONE ($page_one) [selected]")" \
  FAKE_MCPORTER_CALLLOG="$page_evaluate_script_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-evaluate-script --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.evaluate_script --args '{}'
assert_equals "$cli_status" '0' 'evaluate_script remains allowed inside a lane run'
assert_contains "$(<"$page_evaluate_script_calllog")" 'chrome-devtools.evaluate_script' \
  'evaluate_script reaches the child process'
assert_absent "$lease_dir" 'evaluate_script releases the lease'

page_remembered_pageid_calllog="$TEST_ROOT/page-remembered-pageid.calllog"
FAKE_MCPORTER_CALLLOG="$page_remembered_pageid_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-remembered-pageid --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot --args '{"pageId":3}'
assert_equals "$cli_status" '2' 'pageId arguments are refused inside a lane run'
assert_contains "$cli_err" 'remembered_page_identifier' 'pageId refusal carries a typed category'
assert_absent "$lease_dir" 'pageId refusal acquires no lease'
assert_absent "$page_remembered_pageid_calllog" 'pageId refusal makes no relay call'

page_remembered_pageidx_calllog="$TEST_ROOT/page-remembered-pageidx.calllog"
FAKE_MCPORTER_CALLLOG="$page_remembered_pageidx_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-remembered-pageidx --ttl 30 \
    --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot --args '{"pageIdx":1}'
assert_equals "$cli_status" '2' 'pageIdx arguments are refused inside a lane run'
assert_contains "$cli_err" 'remembered_page_identifier' 'pageIdx refusal carries a typed category'
assert_absent "$lease_dir" 'pageIdx refusal acquires no lease'
assert_absent "$page_remembered_pageidx_calllog" 'pageIdx refusal makes no relay call'

page_required_known_calllog="$TEST_ROOT/page-url-required-known-tool.calllog"
FAKE_MCPORTER_CALLLOG="$page_required_known_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-url-required-known-tool --ttl 30 -- \
    mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '2' 'a known page-scoped tool requires --page-url'
assert_contains "$cli_err" 'page_url_required' 'known page-scoped tool refusal is typed'
assert_absent "$lease_dir" 'known page-scoped tool refusal acquires no lease'
assert_absent "$page_required_known_calllog" 'known page-scoped tool refusal makes no relay call'

page_required_unknown_calllog="$TEST_ROOT/page-url-required-unknown-tool.calllog"
FAKE_MCPORTER_CALLLOG="$page_required_unknown_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-url-required-unknown-tool --ttl 30 -- \
    mcporter call chrome-devtools.some_future_tool
assert_equals "$cli_status" '2' 'an unknown tool defaults to requiring --page-url'
assert_contains "$cli_err" 'page_url_required' 'unknown tool page URL refusal is typed'
assert_absent "$page_required_unknown_calllog" 'unknown tool page URL refusal makes no relay call'

page_invalid_calllog="$TEST_ROOT/page-url-invalid.calllog"
FAKE_MCPORTER_CALLLOG="$page_invalid_calllog" \
  run_cli run --lane daily-driver --account-role owner --run-id page-url-invalid --ttl 30 \
    --page-url 'not-a-url' -- mcporter call chrome-devtools.take_snapshot
assert_equals "$cli_status" '2' 'an invalid --page-url is refused'
assert_contains "$cli_err" '--page-url must be' 'invalid --page-url refusal states the URL constraint'
assert_absent "$lease_dir" 'invalid --page-url refusal acquires no lease'
assert_absent "$page_invalid_calllog" 'invalid --page-url refusal makes no relay call'

run_cli list --page-url "$page_one"
assert_usage_refused 'list with --page-url'
assert_contains "$cli_err" 'list accepts only --json' 'list refusal uses its existing accepts message'

run_cli health --lane daily-driver --page-url "$page_one"
assert_equals "$cli_status" '2' 'health with --page-url exits 2'
assert_contains "$cli_err" 'health accepts --lane and --json only' 'health refusal uses its existing accepts message'

# ============================================================================
# Playwright: private plans, exact-page custody, environment-only CDP, cleanup
# ============================================================================
playwright_plan_dir="$TEST_ROOT/playwright-plans"
playwright_plan="$playwright_plan_dir/plan.json"
mkdir -m 700 "$playwright_plan_dir"
cat >"$playwright_plan" <<'JSON'
{"schema_version":1,"actions":[{"command":"snapshot","args":[]},{"command":"click","args":["e1"]}]}
JSON
chmod 600 "$playwright_plan"

run_cli playwright --lane daily-driver --account-role owner --run-id playwright-no-plan \
  --page-url "$page_one"
assert_equals "$cli_status" '2' 'Playwright requires a private action plan'
assert_contains "$cli_err" 'requires --plan' 'missing Playwright plan names the required argument'
assert_absent "$lease_dir" 'missing Playwright plan acquires no lease'

run_cli playwright --lane daily-driver --account-role owner --run-id playwright-relative-plan \
  --page-url "$page_one" --plan relative.json
assert_equals "$cli_status" '2' 'Playwright refuses a relative plan path'
assert_contains "$cli_err" 'playwright_plan_unsafe' 'relative Playwright plan refusal is typed'
assert_absent "$lease_dir" 'relative Playwright plan acquires no lease'

chmod 644 "$playwright_plan"
run_cli playwright --lane daily-driver --account-role owner --run-id playwright-readable-plan \
  --page-url "$page_one" --plan "$playwright_plan"
assert_equals "$cli_status" '2' 'Playwright refuses an over-readable plan'
assert_contains "$cli_err" 'playwright_plan_permissions' 'over-readable Playwright plan refusal is typed'
assert_absent "$lease_dir" 'over-readable Playwright plan acquires no lease'
chmod 600 "$playwright_plan"

playwright_invalid_plan="$playwright_plan_dir/invalid.json"
cat >"$playwright_invalid_plan" <<'JSON'
{"schema_version":1,"actions":[{"command":"goto","args":["https://example.invalid/"]}]}
JSON
chmod 600 "$playwright_invalid_plan"
playwright_invalid_argv="$TEST_ROOT/playwright-invalid.argv"
FAKE_MCPORTER_AGENT_ARGV="$playwright_invalid_argv" \
  run_cli playwright --lane daily-driver --account-role owner --run-id playwright-navigation \
    --page-url "$page_one" --plan "$playwright_invalid_plan"
assert_equals "$cli_status" '2' 'Playwright refuses plan navigation'
assert_contains "$cli_err" 'playwright_plan_invalid' 'Playwright navigation refusal is typed'
assert_absent "$playwright_invalid_argv" 'refused Playwright navigation never reaches MCPorter'
assert_absent "$lease_dir" 'refused Playwright navigation acquires no lease'

cat >"$playwright_invalid_plan" <<'JSON'
{"schema_version":1,"actions":[{"command":"click","args":["--session=other"]}]}
JSON
chmod 600 "$playwright_invalid_plan"
run_cli playwright --lane daily-driver --account-role owner --run-id playwright-option-injection \
  --page-url "$page_one" --plan "$playwright_invalid_plan"
assert_equals "$cli_status" '2' 'Playwright refuses option-shaped plan arguments'
assert_contains "$cli_err" 'playwright_plan_invalid' 'Playwright option-injection refusal is typed'
assert_absent "$lease_dir" 'Playwright option-injection refusal acquires no lease'

playwright_parent_argv="$TEST_ROOT/playwright-parent.argv"
playwright_cli_log="$TEST_ROOT/playwright-cli.log"
playwright_node_log="$TEST_ROOT/playwright-node.log"
playwright_daemon_pid="$TEST_ROOT/playwright-daemon.pid"
playwright_action_target_log="$TEST_ROOT/playwright-action-target.log"
adapter_unrelated_url='https://different.invalid/task'
adapter_multi_page_text=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]\n1: UNRELATED ('"$adapter_unrelated_url"$')'

run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner \
  --run-id playwright-resume-open --task-ref playwright-resume \
  --page-url "$page_one" --json
playwright_resume_nonce="$(<"$last_token_output")"
FAKE_MCPORTER_PAGE_TEXT="$adapter_multi_page_text" \
  run_cli handoff resume --lane daily-driver --account-role owner \
    --run-id playwright-resume --nonce-file "$(token_fixture "$playwright_resume_nonce")" \
    --page-url "$page_one" --json
assert_equals "$cli_status" '0' 'Playwright journey resumes with an unrelated admitted page preserved'
assert_absent "$handoff_record" 'Playwright journey consumes its verified login reservation'

FAKE_MCPORTER_EXEC_CHILD=1 \
FAKE_MCPORTER_AGENT_ARGV="$playwright_parent_argv" \
FAKE_MCPORTER_ACTIVITY_FACTS="$TEST_ROOT/playwright-facts.jsonl" FAKE_MCPORTER_ACTIVITY_LOG="$TEST_ROOT/playwright-activity.log" \
FAKE_MCPORTER_PAGE_TEXT="$adapter_multi_page_text" \
FAKE_PLAYWRIGHT_PAGE_MATCH=true \
FAKE_PLAYWRIGHT_UNRELATED_PAGE_COUNT=1 \
FAKE_PLAYWRIGHT_ACTION_TARGET_LOG="$playwright_action_target_log" \
FAKE_PLAYWRIGHT_CLI_LOG="$playwright_cli_log" \
FAKE_PLAYWRIGHT_NODE_LOG="$playwright_node_log" \
FAKE_PLAYWRIGHT_DAEMON_PID="$playwright_daemon_pid" \
  run_cli playwright --lane daily-driver --account-role owner --run-id playwright-proof \
    --ttl 30 --page-url "$page_one" --plan "$playwright_plan"
assert_equals "$cli_status" '0' 'Playwright route exits with action success'
assert_equals "$(head -1 "$TEST_ROOT/playwright-activity.log")" 'start:playwright' 'Playwright records its bounded adapter value'
assert_equals "$(tail -1 "$TEST_ROOT/playwright-activity.log")" 'clear' 'Playwright clears matching activity on success'
assert_equals "$(jq -sr '.[] | select(.kind=="finish") | [.action,.cleanup,.code] | join(":")' "$TEST_ROOT/playwright-facts.jsonl")" 'completed:confirmed:0' 'playwright reports independent successful command and session-cleanup facts'
assert_equals "$cli_out" $'PLAYWRIGHT-snapshot-OK\nPLAYWRIGHT-click-OK' 'Playwright forwards only primary action output'
assert_equals "$(sed -n '1p' "$playwright_parent_argv")" 'chrome-relay' 'Playwright enters MCPorter chrome-relay'
assert_equals "$(sed -n '6p' "$playwright_parent_argv")" "$fixture_repo/bin/browser-lane" 'MCPorter launches only the lane-owned child'
assert_equals "$(sed -n '7p' "$playwright_parent_argv")" '__playwright-child' 'MCPorter receives no caller-supplied Playwright command'
assert_not_contains "$(<"$playwright_parent_argv")" 'ONE-USE-ENDPOINT-SENTINEL' 'the one-use endpoint is absent from MCPorter child arguments'
assert_not_contains "$(<"$playwright_parent_argv")" "$playwright_plan" 'the caller plan path is absent from MCPorter child arguments'
assert_contains "$(<"$playwright_node_log")" 'endpoint=http://127.0.0.1:49152/ONE-USE-ENDPOINT-SENTINEL' 'only the daemon receives the one-use endpoint through its environment'
assert_not_contains "$(<"$playwright_node_log")" 'arg=http://127.0.0.1:49152/ONE-USE-ENDPOINT-SENTINEL' 'the daemon argv contains no one-use endpoint'
assert_contains "$(<"$playwright_node_log")" 'arg=browser-lane-daily-driver-playwright-proof-' 'the Playwright daemon session is run-scoped'
assert_contains "$(<"$playwright_cli_log")" 'arg=run-code' 'Playwright rechecks the live page before actions'
assert_contains "$(<"$playwright_cli_log")" 'arg=snapshot' 'Playwright executes the first allowlisted action'
assert_contains "$(<"$playwright_cli_log")" 'arg=click' 'Playwright executes the second allowlisted action'
assert_contains "$(<"$playwright_cli_log")" 'arg=detach' 'Playwright detaches its run-scoped session'
assert_equals "$(<"$playwright_action_target_log")" $'target\ntarget' \
  'Playwright operations touch only the selected exact target beside unrelated pages'
assert_not_contains "$(<"$playwright_cli_log")" 'ONE-USE-ENDPOINT-SENTINEL' 'Playwright CLI action arguments and environment contain no endpoint'
assert_equals "$(find "$fixture_state/browser-lanes" -name 'playwright-plan.*' | wc -l | tr -d ' ')" '0' 'Playwright removes its private plan snapshot'
assert_equals "$(find "$fixture_state/browser-lanes" -name 'playwright-child.*' | wc -l | tr -d ' ')" '0' 'Playwright removes private daemon evidence'
assert_absent "$lease_dir" 'Playwright success releases the lane lease'
if kill -0 "$(<"$playwright_daemon_pid")" 2>/dev/null; then
  fail 'Playwright success leaves no run-scoped daemon'
else
  pass 'Playwright success leaves no run-scoped daemon'
fi

playwright_free_parent_argv="$TEST_ROOT/playwright-free-parent.argv"
: >"$playwright_cli_log"
printf '%s\n' '{"free_mode":true}' >"$free_config"
FAKE_MCPORTER_STATUS=all \
FAKE_MCPORTER_CALL_STATUS=42 \
FAKE_MCPORTER_EXEC_CHILD=1 \
FAKE_MCPORTER_AGENT_ARGV="$playwright_free_parent_argv" \
FAKE_PLAYWRIGHT_PAGE_MATCH=true \
FAKE_PLAYWRIGHT_PAGE_URL="$page_two" \
FAKE_PLAYWRIGHT_CLI_LOG="$playwright_cli_log" \
FAKE_PLAYWRIGHT_DAEMON_PID="$playwright_daemon_pid" \
  run_cli playwright --lane daily-driver --account-role owner --run-id playwright-free-inventory-unavailable \
    --page-url "$page_one" --plan "$playwright_plan"
assert_equals "$cli_status" '0' 'free-mode Playwright bypasses unavailable MCP page inventory'
assert_equals "$cli_out" $'PLAYWRIGHT-snapshot-OK\nPLAYWRIGHT-click-OK' \
  'free-mode Playwright accepts a same-site different path without MCP page inventory'
assert_equals "$(sed -n '1p' "$playwright_free_parent_argv")" 'chrome-relay' \
  'free-mode Playwright still uses the authenticated one-use relay handoff'
assert_contains "$(<"$playwright_cli_log")" 'arg=run-code' \
  'free-mode Playwright verifies the selected same-site page inside the handoff'
assert_absent "$lease_dir" 'free-mode Playwright releases the lane lease'

playwright_secured_parent_argv="$TEST_ROOT/playwright-secured-parent.argv"
printf '%s\n' '{"free_mode":false}' >"$free_config"
FAKE_MCPORTER_CALL_STATUS=42 \
FAKE_MCPORTER_EXEC_CHILD=1 \
FAKE_MCPORTER_AGENT_ARGV="$playwright_secured_parent_argv" \
FAKE_PLAYWRIGHT_PAGE_MATCH=true \
  run_cli playwright --lane daily-driver --account-role owner --run-id playwright-secured-inventory-unavailable \
    --page-url "$page_one" --plan "$playwright_plan"
assert_equals "$cli_status" '12' 'secured-mode Playwright blocks when MCP page inventory is unavailable'
assert_contains "$cli_err" 'relay_unavailable' \
  'secured-mode Playwright reports unavailable MCP page inventory'
assert_absent "$playwright_secured_parent_argv" \
  'secured-mode Playwright inventory failure launches no one-use handoff'

playwright_ambiguous_selection_parent="$TEST_ROOT/playwright-ambiguous-selection.argv"
FAKE_MCPORTER_EXEC_CHILD=1 \
FAKE_MCPORTER_AGENT_ARGV="$playwright_ambiguous_selection_parent" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]\n1: SAME-SITE ('"$page_two"$') [selected]' \
  run_cli playwright --lane daily-driver --account-role owner \
    --run-id playwright-ambiguous-selection --page-url "$page_one" --plan "$playwright_plan"
assert_equals "$cli_status" '16' 'Playwright refuses ambiguous selected-page state at public preflight'
assert_contains "$cli_err" 'page_ambiguous' 'Playwright ambiguous selection refusal is typed'
assert_absent "$playwright_ambiguous_selection_parent" 'Playwright ambiguous selection launches no helper'
assert_absent "$lease_dir" 'Playwright ambiguous selection releases the lease'

playwright_activity_unavailable_log="$TEST_ROOT/playwright-activity-unavailable.log"
: >"$playwright_cli_log"
FAKE_MCPORTER_ACTIVITY_STATUS=1 FAKE_MCPORTER_ACTIVITY_LOG="$playwright_activity_unavailable_log" \
FAKE_MCPORTER_EXEC_CHILD=1 \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
FAKE_PLAYWRIGHT_PAGE_MATCH=true FAKE_PLAYWRIGHT_CLI_LOG="$playwright_cli_log" \
FAKE_PLAYWRIGHT_NODE_LOG="$playwright_node_log" FAKE_PLAYWRIGHT_DAEMON_PID="$playwright_daemon_pid" \
  run_cli playwright --lane daily-driver --account-role owner --run-id playwright-activity-unavailable \
    --ttl 30 --page-url "$page_one" --plan "$playwright_plan"
assert_equals "$cli_status" '0' 'Playwright work survives unavailable activity publication'
assert_equals "$cli_out" $'PLAYWRIGHT-snapshot-OK\nPLAYWRIGHT-click-OK' 'unavailable activity preserves Playwright output'
assert_contains "$cli_err" 'lane_activity_unavailable' 'Playwright activity failure remains advisory'
assert_contains "$(<"$playwright_cli_log")" 'arg=snapshot' 'unavailable activity still executes Playwright actions'
assert_equals "$(<"$playwright_activity_unavailable_log")" 'start:playwright' 'failed Playwright activity start launches no heartbeat or clear'

: >"$playwright_cli_log"
FAKE_MCPORTER_EXEC_CHILD=1 \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
FAKE_PLAYWRIGHT_PAGE_MATCH=false \
FAKE_PLAYWRIGHT_CLI_LOG="$playwright_cli_log" \
FAKE_PLAYWRIGHT_DAEMON_PID="$playwright_daemon_pid" \
  run_cli playwright --lane daily-driver --account-role owner --run-id playwright-page-changed \
    --page-url "$page_one" --plan "$playwright_plan"
assert_equals "$cli_status" '16' 'Playwright fails closed when the page changes after preflight'
assert_contains "$cli_err" 'playwright_page_changed' 'Playwright page-change refusal is typed'
assert_not_contains "$(<"$playwright_cli_log")" 'arg=snapshot' 'Playwright page-change refusal executes no plan action'
assert_contains "$(<"$playwright_cli_log")" 'arg=detach' 'Playwright page-change refusal still detaches'
assert_absent "$lease_dir" 'Playwright page-change refusal releases the lease'

: >"$playwright_cli_log"
FAKE_MCPORTER_EXEC_CHILD=1 \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
FAKE_PLAYWRIGHT_PAGE_MATCH=true \
FAKE_PLAYWRIGHT_DUPLICATE_EXACT_COUNT=1 \
FAKE_PLAYWRIGHT_CLI_LOG="$playwright_cli_log" \
FAKE_PLAYWRIGHT_DAEMON_PID="$playwright_daemon_pid" \
  run_cli playwright --lane daily-driver --account-role owner \
    --run-id playwright-page-ambiguous --page-url "$page_one" --plan "$playwright_plan"
assert_equals "$cli_status" '0' 'Playwright prefers its selected page among duplicate same-site pages'
assert_not_contains "$cli_err" 'playwright_page_ambiguous' 'Playwright selected same-site page is not ambiguous'
assert_contains "$(<"$playwright_cli_log")" 'arg=snapshot' 'Playwright selected same-site page executes the plan'
assert_absent "$lease_dir" 'Playwright selected-page resolution releases the lease'

: >"$playwright_cli_log"
FAKE_MCPORTER_EXEC_CHILD=1 \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
FAKE_PLAYWRIGHT_PAGE_MATCH=true \
FAKE_PLAYWRIGHT_SELECTED_TARGET=false \
FAKE_PLAYWRIGHT_CLI_LOG="$playwright_cli_log" \
FAKE_PLAYWRIGHT_DAEMON_PID="$playwright_daemon_pid" \
  run_cli playwright --lane daily-driver --account-role owner \
    --run-id playwright-page-not-selected --page-url "$page_one" --plan "$playwright_plan"
assert_equals "$cli_status" '16' 'Playwright refuses a session attached to an unrelated page'
assert_contains "$cli_err" 'playwright_page_not_selected' 'Playwright wrong selected-page refusal is typed'
assert_not_contains "$(<"$playwright_cli_log")" 'arg=snapshot' 'Playwright wrong selected page executes no plan action'
assert_absent "$lease_dir" 'Playwright wrong selected-page refusal releases the lease'

: >"$playwright_cli_log"
FAKE_MCPORTER_EXEC_CHILD=1 \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
FAKE_PLAYWRIGHT_PAGE_MATCH=true \
FAKE_PLAYWRIGHT_CLI_LOG="$playwright_cli_log" \
FAKE_PLAYWRIGHT_DAEMON_PID="$playwright_daemon_pid" \
FAKE_PLAYWRIGHT_FAIL_COMMAND=click \
FAKE_PLAYWRIGHT_ACTION_STATUS=23 \
  run_cli playwright --lane daily-driver --account-role owner --run-id playwright-action-fail \
    --page-url "$page_one" --plan "$playwright_plan"
assert_equals "$cli_status" '23' 'Playwright preserves an action failure status'
assert_contains "$(<"$playwright_cli_log")" 'arg=detach' 'Playwright detaches after an action failure'
assert_absent "$lease_dir" 'Playwright action failure releases the lease'

: >"$playwright_cli_log"
FAKE_MCPORTER_EXEC_CHILD=1 \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
FAKE_PLAYWRIGHT_PAGE_MATCH=true \
FAKE_PLAYWRIGHT_CLI_LOG="$playwright_cli_log" \
FAKE_PLAYWRIGHT_DAEMON_PID="$playwright_daemon_pid" \
FAKE_PLAYWRIGHT_DETACH_STATUS=9 \
  run_cli playwright --lane daily-driver --account-role owner --run-id playwright-detach-fail \
    --page-url "$page_one" --plan "$playwright_plan"
assert_equals "$cli_status" '17' 'Playwright fails closed when detach cannot be proved'
assert_contains "$cli_err" 'playwright_lifecycle_unresolved' 'Playwright detach failure is typed'
assert_absent "$lease_dir" 'Playwright detach failure releases the lease'

: >"$playwright_cli_log"
FAKE_PLAYWRIGHT_PAGE_MATCH=true \
FAKE_PLAYWRIGHT_CLI_LOG="$playwright_cli_log" \
FAKE_PLAYWRIGHT_DAEMON_PID="$playwright_daemon_pid" \
FAKE_PLAYWRIGHT_HOLD_COMMAND=snapshot \
FAKE_PLAYWRIGHT_HOLD_SECONDS=2 \
HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
BROWSER_LANE_INTERNAL_CHILD=1 \
BROWSER_LANE_PLAYWRIGHT_PLAN="$playwright_plan" \
BROWSER_LANE_PLAYWRIGHT_SESSION='browser-lane-signal-proof' \
BROWSER_LANE_PAGE_URL_SHA256="$(printf '%s' 'https://fixture.invalid' | shasum -a 256 | awk '{print $1}')" \
BROWSER_LANE_RUN_ID='playwright-signal-proof' \
BROWSER_LANE_ACTIVITY_OUTCOME="$TEST_ROOT/playwright-signal-outcome.json" \
AGENT_BROWSER_CDP='http://127.0.0.1:49152/ONE-USE-ENDPOINT-SENTINEL' \
  "$fixture_repo/bin/browser-lane" __playwright-child >"$TEST_ROOT/playwright-signal.out" 2>"$TEST_ROOT/playwright-signal.err" &
playwright_signal_pid=$!
for _ in {1..50}; do
  grep -q 'arg=snapshot' "$playwright_cli_log" 2>/dev/null && break
  sleep 0.1
done
grep -q 'arg=snapshot' "$playwright_cli_log" 2>/dev/null || fail 'Playwright signal fixture did not reach its held action'
kill -TERM "$playwright_signal_pid"
set +e
wait "$playwright_signal_pid"
playwright_signal_status=$?
set -e
assert_equals "$playwright_signal_status" '130' 'Playwright signal cleanup returns an interrupted status'
assert_equals "$(jq -r '[.actionOutcome,.cleanupOutcome,.exitCode] | join(":")' "$TEST_ROOT/playwright-signal-outcome.json")" 'failed:confirmed:130' 'Playwright interruption records observed cleanup and command failure'
assert_contains "$(<"$playwright_cli_log")" 'arg=detach' 'Playwright signal cleanup attempts detach'
if kill -0 "$(<"$playwright_daemon_pid")" 2>/dev/null; then
  fail 'Playwright signal cleanup leaves no run-scoped daemon'
else
  pass 'Playwright signal cleanup leaves no run-scoped daemon'
fi
assert_equals "$(find "$fixture_state/browser-lanes" -name 'playwright-child.*' | wc -l | tr -d ' ')" '0' 'Playwright signal cleanup removes private daemon evidence'

# ============================================================================
# Puppeteer: private plans, environment-only endpoint, exact-page binding,
# fixed diagnostics, whole-run TTL, disconnect-only cleanup
#
# The seam is the public executable. Real Bash runs the router, the real Node
# runs the real helper, and only the `puppeteer` module is the test-owned fake
# above. Oracles: literal stdout, stderr, and exit values; the fake's recorded
# call log; the lease directory; private temp-file counts; and the helper's
# own process id checked after each run.
# ============================================================================
puppeteer_plan_dir="$TEST_ROOT/puppeteer-plans"
puppeteer_plan="$puppeteer_plan_dir/plan.json"
puppeteer_other_plan="$puppeteer_plan_dir/other.json"
mkdir -m 700 "$puppeteer_plan_dir"
cat >"$puppeteer_plan" <<'JSON'
{"schema_version":1,"actions":[{"command":"title","args":[]},{"command":"snapshot","args":[]}]}
JSON
chmod 600 "$puppeteer_plan"
puppeteer_ws_endpoint='ws://127.0.0.1:49153/ONE-USE-WS-SENTINEL?token=ONE-USE-TOKEN-SENTINEL'
puppeteer_log="$TEST_ROOT/puppeteer.log"
puppeteer_pid_file="$TEST_ROOT/puppeteer.pid"
puppeteer_parent_argv="$TEST_ROOT/puppeteer-parent.argv"
puppeteer_default_page_text=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]'

write_puppeteer_plan() {
  printf '%s\n' "$2" >"$1"
  chmod 600 "$1"
}

# One public invocation with the fixture relay, the fake module log, and the
# helper pid file wired in. Rows prefix extra FAKE_* knobs as needed.
run_puppeteer() {
  local run_id="$1"
  shift
  : >"$puppeteer_log"
  rm -f "$puppeteer_pid_file" "$puppeteer_parent_argv"
  FAKE_MCPORTER_EXEC_CHILD=1 \
  FAKE_MCPORTER_EXEC_ENDPOINT="$puppeteer_ws_endpoint" \
  FAKE_MCPORTER_AGENT_ARGV="$puppeteer_parent_argv" \
  FAKE_MCPORTER_PAGE_TEXT="${FAKE_MCPORTER_PAGE_TEXT-$puppeteer_default_page_text}" \
  FAKE_PUPPETEER_LOG="$puppeteer_log" \
  FAKE_PUPPETEER_PID_FILE="$puppeteer_pid_file" \
  FAKE_PUPPETEER_PAGE_URL="${FAKE_PUPPETEER_PAGE_URL-$page_one}" \
    run_cli puppeteer --lane daily-driver --account-role owner --run-id "$run_id" "$@"
}

assert_helper_exited() {
  local label="$1"
  [[ -f "$puppeteer_pid_file" ]] || fail "$label (helper pid file missing)"
  if kill -0 "$(<"$puppeteer_pid_file")" 2>/dev/null; then
    fail "$label"
  fi
  pass "$label"
}

assert_puppeteer_private_state_clean() {
  local label="$1"
  assert_equals "$(find "$fixture_state/browser-lanes" -name 'puppeteer-plan.*' | wc -l | tr -d ' ')" '0' "$label removes its private plan snapshot"
  assert_absent "$lease_dir" "$label releases the lane lease"
}

# Script support crosses the same public plan and custody seam as fixed actions.
# Literal outputs and fixture logs are independent oracles, not browser proof.
script_source=$'() => {\n  return 6 * 7;\n} // final comment\n\n'
script_plan="$TEST_ROOT/script-plan.json"
jq -cn --arg source "$script_source" '{schema_version:2,actions:[{command:"evaluate",args:[$source]}]}' >"$script_plan"
chmod 600 "$script_plan"
FAKE_MCPORTER_EXEC_CHILD=1 FAKE_PLAYWRIGHT_PAGE_MATCH=true \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
FAKE_PLAYWRIGHT_CLI_LOG="$playwright_cli_log" FAKE_PLAYWRIGHT_DAEMON_PID="$playwright_daemon_pid" \
  run_cli playwright --lane daily-driver --account-role owner --run-id script-playwright \
    --ttl 30 --page-url "$page_one" --plan "$script_plan"
assert_equals "$cli_status" '0' 'Playwright accepts opt-in multiline page script'
assert_equals "$cli_out" 'SCRIPT-RESULT-42' 'Playwright returns script result without guard output'
assert_contains "$(<"$playwright_cli_log")" "$script_source" 'Playwright forwards exact script bytes to page evaluation'
assert_absent "$lease_dir" 'Playwright script retires lane custody'

FAKE_MCPORTER_EXEC_CHILD=1 FAKE_PLAYWRIGHT_PAGE_MATCH=true \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
FAKE_PLAYWRIGHT_SCRIPT_MARKER="$TEST_ROOT/script-executed" \
FAKE_PLAYWRIGHT_CLI_LOG="$playwright_cli_log" FAKE_PLAYWRIGHT_DAEMON_PID="$playwright_daemon_pid" \
  run_cli playwright --lane daily-driver --account-role owner --run-id script-playwright-changed \
    --ttl 30 --page-url "$page_one" --plan "$script_plan"
assert_equals "$cli_status" '16' 'Playwright returns failure after script changes page binding'
assert_contains "$cli_err" 'playwright_page_changed' 'Playwright changed script page has typed failure'
assert_absent "$lease_dir" 'Playwright changed script page releases custody'

run_puppeteer script-puppeteer --ttl 30 --page-url "$page_one" --plan "$script_plan"
assert_equals "$cli_status" '0' 'Puppeteer accepts opt-in multiline page script'
assert_equals "$cli_out" '{"index":0,"command":"evaluate","status":"ok","result":42}' 'Puppeteer returns page script result'
assert_contains "$(<"$puppeteer_log")" "$script_source" 'Puppeteer evaluates exact script bytes in page context'
assert_puppeteer_private_state_clean 'Puppeteer script success'

FAKE_PUPPETEER_URL_AFTER_FIRST_ACTION='https://subdomain.fixture.invalid/changed' \
  run_puppeteer script-page-change --ttl 30 --page-url "$page_one" --plan "$script_plan"
assert_equals "$cli_status" '0' 'Puppeteer accepts a script path change on the declared site'
assert_equals "$cli_out" '{"index":0,"command":"evaluate","status":"ok","result":42}' 'same-site script result is reported as success'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'same-site script change still disconnects'
assert_puppeteer_private_state_clean 'Puppeteer same-site script change'

FAKE_PUPPETEER_FAIL_COMMAND='page-evaluate' \
  run_puppeteer script-puppeteer-error --ttl 30 --page-url "$page_one" --plan "$script_plan"
assert_equals "$cli_status" '18' 'Puppeteer script exception returns action failure'
assert_equals "$cli_out" '' 'Puppeteer script exception emits no successful result'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'Puppeteer script exception still disconnects'

for engine in playwright puppeteer; do
  jq -cn --arg source "$script_source" '{schema_version:1,actions:[{command:"evaluate",args:[$source]}]}' >"$script_plan"
  run_cli "$engine" --lane daily-driver --account-role owner --run-id script-version-one --page-url "$page_one" --plan "$script_plan"
  assert_equals "$cli_status" '2' "$engine version-one plan still refuses caller script"
  assert_absent "$lease_dir" "$engine refused script acquires no lease"
  printf '%s\n' '{"schema_version":2,"actions":[{"command":"evaluate","args":[]}]}' >"$script_plan"
  run_cli "$engine" --lane daily-driver --account-role owner --run-id script-arity --page-url "$page_one" --plan "$script_plan"
  assert_equals "$cli_status" '2' "$engine script requires exactly one source argument"
  printf '%s\n' '{"schema_version":2,"actions":[{"command":"run-code","args":["() => 42"]}]}' >"$script_plan"
  run_cli "$engine" --lane daily-driver --account-role owner --run-id script-host-code --page-url "$page_one" --plan "$script_plan"
  assert_equals "$cli_status" '2' "$engine page script contract does not expose host code"
done

# Live status is a pre-inventory gate for every public consumer. These rows use
# literal status fixtures and independent child/page call logs; no page list or
# engine handoff may occur when the snapshot is unsafe or unavailable.
assert_status_refusal_matrix() {
  local state="$1" expected_exit="$2" expected_code="$3" expected_retry="$4" label="$5"
  local calllog="$TEST_ROOT/status-$state.calllog" agentlog="$TEST_ROOT/status-$state.agentlog"
  : >"$calllog"
  rm -f "$agentlog"
  FAKE_MCPORTER_STATUS="$state" FAKE_MCPORTER_CALLLOG="$calllog" FAKE_MCPORTER_AGENT_ARGV="$agentlog" \
    run_cli inspect --lane daily-driver --account-role owner --run-id "status-$state-inspect" --json
  assert_equals "$cli_status" "$expected_exit" "$label inspect refuses before inventory"
  assert_contains "$cli_err" "$expected_code" "$label inspect has the exact refusal"
  assert_equals "$(<"$calllog")" '' "$label inspect performs no page inventory"
  assert_absent "$agentlog" "$label inspect launches no relay child"
  assert_absent "$lease_dir" "$label inspect releases its lease"

  : >"$calllog"; rm -f "$agentlog"
  FAKE_MCPORTER_STATUS="$state" FAKE_MCPORTER_CALLLOG="$calllog" FAKE_MCPORTER_AGENT_ARGV="$agentlog" \
    run_cli run --lane daily-driver --account-role owner --run-id "status-$state-run" --page-url "$page_one" -- mcporter call chrome-devtools.take_snapshot
  assert_equals "$cli_status" "$expected_exit" "$label run refuses before inventory or child"
  assert_contains "$cli_err" "$expected_code" "$label run has the exact refusal"
  assert_equals "$(<"$calllog")" '' "$label run performs no page or child call"
  assert_absent "$agentlog" "$label run launches no relay child"
  assert_absent "$lease_dir" "$label run releases its lease"

  : >"$calllog"; rm -f "$agentlog"
  FAKE_MCPORTER_STATUS="$state" FAKE_MCPORTER_CALLLOG="$calllog" FAKE_MCPORTER_AGENT_ARGV="$agentlog" \
    run_cli agent-browser --lane daily-driver --account-role owner --run-id "status-$state-agent" --page-url "$page_one" -- snapshot
  assert_equals "$cli_status" "$expected_exit" "$label Agent Browser refuses before engine launch"
  assert_contains "$cli_err" "$expected_code" "$label Agent Browser has the exact refusal"
  assert_equals "$(<"$calllog")" '' "$label Agent Browser performs no page call"
  assert_absent "$agentlog" "$label Agent Browser does not launch a relay child"
  assert_absent "$lease_dir" "$label Agent Browser releases its lease"

  : >"$calllog"; rm -f "$agentlog"
  FAKE_MCPORTER_STATUS="$state" FAKE_MCPORTER_CALLLOG="$calllog" FAKE_MCPORTER_AGENT_ARGV="$agentlog" \
    run_cli playwright --lane daily-driver --account-role owner --run-id "status-$state-playwright" --page-url "$page_one" --plan "$playwright_plan"
  assert_equals "$cli_status" "$expected_exit" "$label Playwright refuses before inventory or engine launch"
  assert_contains "$cli_err" "$expected_code" "$label Playwright has the exact refusal"
  assert_equals "$(<"$calllog")" '' "$label Playwright performs no page call"
  assert_absent "$agentlog" "$label Playwright does not launch a relay child"
  assert_absent "$lease_dir" "$label Playwright releases its lease"

  : >"$calllog"; rm -f "$agentlog"
  FAKE_MCPORTER_STATUS="$state" FAKE_MCPORTER_CALLLOG="$calllog" FAKE_MCPORTER_AGENT_ARGV="$agentlog" \
    run_cli puppeteer --lane daily-driver --account-role owner --run-id "status-$state-puppeteer" --page-url "$page_one" --plan "$puppeteer_plan"
  assert_equals "$cli_status" "$expected_exit" "$label Puppeteer refuses before inventory or engine launch"
  assert_contains "$cli_err" "$expected_code" "$label Puppeteer has the exact refusal"
  assert_equals "$(<"$calllog")" '' "$label Puppeteer performs no page call"
  assert_absent "$agentlog" "$label Puppeteer does not launch a relay child"
  assert_absent "$lease_dir" "$label Puppeteer releases its lease"
  assert_contains "$cli_err" "\"retry_safe\":$expected_retry" "$label retry classification is explicit"
}

assert_status_refusal_matrix all 15 access_mode_mismatch false 'all-mode snapshot'
assert_status_refusal_matrix disabled 15 access_mode_disabled false 'disabled snapshot'
assert_status_refusal_matrix transitioning 15 access_mode_transitioning true 'transitioning snapshot'
assert_status_refusal_matrix malformed 12 access_mode_live_check_unavailable true 'malformed snapshot'

# Every adapter command observes the same durable handoff gate. Valid plans and
# dependencies are present so the refusal is attributable only to the
# reservation, and the child-call log independently proves no relay handoff.
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner \
    --run-id adapter-handoff-open --task-ref adapter-gate --json
assert_equals "$cli_status" '0' 'adapter-gate handoff opens'
adapter_handoff_nonce="$(<"$last_token_output")"
assert_matches "$adapter_handoff_nonce" '^[0-9a-f]{64}$' 'adapter-gate handoff writes its token privately'

for blocked_adapter in agent-browser playwright puppeteer; do
  blocked_calllog="$TEST_ROOT/handoff-$blocked_adapter.calllog"
  blocked_childlog="$TEST_ROOT/handoff-$blocked_adapter.childlog"
  : >"$blocked_calllog"
  rm -f "$blocked_childlog"
  case "$blocked_adapter" in
    agent-browser)
      FAKE_MCPORTER_CALLLOG="$blocked_calllog" FAKE_MCPORTER_AGENT_ARGV="$blocked_childlog" \
        run_cli agent-browser --lane daily-driver --account-role owner \
          --run-id handoff-block-agent --page-url "$page_one" -- snapshot ;;
    playwright)
      FAKE_MCPORTER_CALLLOG="$blocked_calllog" FAKE_MCPORTER_AGENT_ARGV="$blocked_childlog" \
        run_cli playwright --lane daily-driver --account-role owner \
          --run-id handoff-block-playwright --page-url "$page_one" --plan "$playwright_plan" ;;
    puppeteer)
      FAKE_MCPORTER_CALLLOG="$blocked_calllog" FAKE_MCPORTER_AGENT_ARGV="$blocked_childlog" \
        run_cli puppeteer --lane daily-driver --account-role owner \
          --run-id handoff-block-puppeteer --page-url "$page_one" --plan "$puppeteer_plan" ;;
  esac
  assert_equals "$cli_status" '19' "open handoff blocks $blocked_adapter"
  assert_contains "$cli_err" 'handoff_open' "$blocked_adapter refusal is typed"
  assert_equals "$(<"$blocked_calllog")" '' "$blocked_adapter performs no relay call"
  assert_absent "$blocked_childlog" "$blocked_adapter launches no relay child"
  assert_absent "$lease_dir" "$blocked_adapter refusal releases its lease"
done
assert_equals "$(find "$fixture_state/browser-lanes" -name 'playwright-plan.*' | wc -l | tr -d ' ')" '0' \
  'blocked Playwright removes its private plan snapshot'
assert_equals "$(find "$fixture_state/browser-lanes" -name 'puppeteer-plan.*' | wc -l | tr -d ' ')" '0' \
  'blocked Puppeteer removes its private plan snapshot'
run_cli handoff release --lane daily-driver --nonce-file "$(token_fixture "$adapter_handoff_nonce")" --json
assert_equals "$cli_status" '0' 'adapter-gate handoff releases cleanly'
assert_absent "$handoff_dir" 'adapter-gate handoff leaves no reservation'

run_cli --help
assert_contains "$cli_out" 'browser-lane puppeteer' 'help discovers the Puppeteer command'
assert_contains "$cli_out" '18  an allowlisted in-page engine action failed or timed out' 'help documents the action-failure exit'
assert_contains "$cli_out" 'effective_policy_check_unavailable' 'help documents the effective-policy proof gap'
assert_contains "$cli_out" 'fresh live access-status snapshot' 'help documents the current live access-status requirement'
assert_contains "$cli_out" 'continuous access enforcement' 'help does not overclaim continuous access enforcement'
assert_not_contains "$cli_out" 'access_mode_live_check_unavailable and effective_policy_check_unavailable' 'help no longer claims every live access check is unavailable'

# --- usage refusals: no relay call, no lease, no private snapshot ---
run_puppeteer puppeteer-no-plan --page-url "$page_one"
assert_equals "$cli_status" '2' 'Puppeteer requires a private action plan'
assert_contains "$cli_err" 'requires --plan' 'missing Puppeteer plan names the required argument'
assert_absent "$puppeteer_parent_argv" 'missing Puppeteer plan never reaches MCPorter'
assert_absent "$lease_dir" 'missing Puppeteer plan acquires no lease'

run_puppeteer puppeteer-relative-plan --page-url "$page_one" --plan relative.json
assert_equals "$cli_status" '2' 'Puppeteer refuses a relative plan path'
assert_contains "$cli_err" 'puppeteer_plan_unsafe' 'relative Puppeteer plan refusal is typed'
assert_absent "$lease_dir" 'relative Puppeteer plan acquires no lease'

chmod 644 "$puppeteer_plan"
run_puppeteer puppeteer-readable-plan --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '2' 'Puppeteer refuses an over-readable plan'
assert_contains "$cli_err" 'puppeteer_plan_permissions' 'over-readable Puppeteer plan refusal is typed'
assert_absent "$lease_dir" 'over-readable Puppeteer plan acquires no lease'
chmod 600 "$puppeteer_plan"

write_puppeteer_plan "$puppeteer_other_plan" '{"schema_version":1,"actions":[{"command":"goto","args":["https://example.invalid/"]}]}'
run_puppeteer puppeteer-navigation --page-url "$page_one" --plan "$puppeteer_other_plan"
assert_equals "$cli_status" '2' 'Puppeteer refuses plan navigation'
assert_contains "$cli_err" 'puppeteer_plan_invalid' 'Puppeteer navigation refusal is typed'
assert_absent "$puppeteer_parent_argv" 'refused Puppeteer navigation never reaches MCPorter'
assert_absent "$lease_dir" 'refused Puppeteer navigation acquires no lease'

write_puppeteer_plan "$puppeteer_other_plan" '{"schema_version":1,"actions":[{"command":"click","args":[]}]}'
run_puppeteer puppeteer-arity --page-url "$page_one" --plan "$puppeteer_other_plan"
assert_equals "$cli_status" '2' 'Puppeteer refuses a command with the wrong argument count'
assert_contains "$cli_err" 'puppeteer_plan_invalid' 'Puppeteer arity refusal is typed'
assert_absent "$puppeteer_parent_argv" 'refused Puppeteer arity never reaches MCPorter'

write_puppeteer_plan "$puppeteer_other_plan" '{"schema_version":1,"actions":[{"command":"click","args":["--session=other"]}]}'
run_puppeteer puppeteer-option-injection --page-url "$page_one" --plan "$puppeteer_other_plan"
assert_equals "$cli_status" '2' 'Puppeteer refuses option-shaped plan arguments'
assert_contains "$cli_err" 'puppeteer_plan_invalid' 'Puppeteer option-injection refusal is typed'
assert_absent "$lease_dir" 'Puppeteer option-injection refusal acquires no lease'

# A Playwright-only command is not a Puppeteer command: the allowlists are
# engine-scoped even though one validator owns both.
write_puppeteer_plan "$puppeteer_other_plan" '{"schema_version":1,"actions":[{"command":"generate-locator","args":["e1"]}]}'
run_puppeteer puppeteer-foreign-command --page-url "$page_one" --plan "$puppeteer_other_plan"
assert_equals "$cli_status" '2' 'Puppeteer refuses a Playwright-only command'
assert_contains "$cli_err" 'puppeteer_plan_invalid' 'Puppeteer foreign-command refusal is typed'

run_puppeteer puppeteer-json --page-url "$page_one" --plan "$puppeteer_plan" --json
assert_equals "$cli_status" '2' 'Puppeteer refuses --json'
assert_contains "$cli_err" 'does not accept --json' 'Puppeteer --json refusal explains the stdout contract'

run_puppeteer puppeteer-trailing --page-url "$page_one" --plan "$puppeteer_plan" -- snapshot
assert_equals "$cli_status" '2' 'Puppeteer refuses a command after --'
assert_contains "$cli_err" 'accepts no command after --' 'Puppeteer trailing-command refusal names the rule'

run_puppeteer puppeteer-no-url --plan "$puppeteer_plan"
assert_equals "$cli_status" '2' 'Puppeteer requires the exact admitted URL'
assert_contains "$cli_err" 'requires --page-url' 'Puppeteer missing URL refusal names the argument'

run_cli puppeteer --lane daily-driver --account-role wrong --run-id puppeteer-wrong-role \
  --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '11' 'Puppeteer refuses a mismatched account role'
assert_contains "$cli_err" 'account_role_mismatch' 'Puppeteer role refusal is typed'
assert_absent "$lease_dir" 'Puppeteer role refusal acquires no lease'

mv "$fixture_repo/bin/lib/browser-lane-puppeteer.js" "$TEST_ROOT/helper.aside"
run_puppeteer puppeteer-helper-missing --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '14' 'a missing lane-owned helper fails before the lease'
assert_contains "$cli_err" 'puppeteer_helper_missing' 'missing helper refusal is typed'
assert_absent "$puppeteer_parent_argv" 'missing helper never reaches MCPorter'
assert_absent "$lease_dir" 'missing helper acquires no lease'
mv "$TEST_ROOT/helper.aside" "$fixture_repo/bin/lib/browser-lane-puppeteer.js"

# --- success: ordered actions, environment-only endpoint, disconnect only ---
run_cli handoff open --nonce-output "$TEST_ROOT/handoff-token-"$LINENO --lane daily-driver --account-role owner \
  --run-id puppeteer-resume-open --task-ref puppeteer-resume \
  --page-url "$page_one" --json
puppeteer_resume_nonce="$(<"$last_token_output")"
FAKE_MCPORTER_PAGE_TEXT="$adapter_multi_page_text" \
  run_cli handoff resume --lane daily-driver --account-role owner \
    --run-id puppeteer-resume --nonce-file "$(token_fixture "$puppeteer_resume_nonce")" \
    --page-url "$page_one" --json
assert_equals "$cli_status" '0' 'Puppeteer journey resumes with an unrelated admitted page preserved'
assert_absent "$handoff_record" 'Puppeteer journey consumes its verified login reservation'

FAKE_MCPORTER_PAGE_TEXT="$adapter_multi_page_text" \
FAKE_PUPPETEER_UNRELATED_PAGE_COUNT=1 \
FAKE_MCPORTER_ACTIVITY_FACTS="$TEST_ROOT/puppeteer-facts.jsonl" \
FAKE_MCPORTER_ACTIVITY_LOG="$TEST_ROOT/puppeteer-activity.log" \
  run_puppeteer puppeteer-proof --ttl 30 --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '0' 'Puppeteer route exits with action success'
assert_equals "$(head -1 "$TEST_ROOT/puppeteer-activity.log")" 'start:puppeteer' 'Puppeteer records its bounded adapter value'
assert_equals "$(tail -1 "$TEST_ROOT/puppeteer-activity.log")" 'clear' 'Puppeteer clears matching activity on success'
assert_equals "$(jq -sr '.[] | select(.kind=="finish") | [.action,.cleanup,.code] | join(":")' "$TEST_ROOT/puppeteer-facts.jsonl")" 'completed:confirmed:0' 'puppeteer reports independent successful command and session-cleanup facts'
assert_equals "$cli_out" \
  $'{"index":0,"command":"title","status":"ok","result":"FIXTURE-TITLE-ONE"}\n{"index":1,"command":"snapshot","status":"ok","result":{"role":"WebArea","name":"FIXTURE-TITLE-ONE"}}' \
  'Puppeteer prints exactly one JSON line per action on stdout'
assert_equals "$cli_err" '' 'Puppeteer success keeps stderr empty'
assert_equals "$(sed -n '1p' "$puppeteer_parent_argv")" 'chrome-relay' 'Puppeteer enters MCPorter chrome-relay'
assert_equals "$(sed -n '2p' "$puppeteer_parent_argv")" 'exec' 'Puppeteer uses the authenticated exec handoff'
assert_equals "$(sed -n '4p' "$puppeteer_parent_argv")" 'http://127.0.0.1:18799' 'Puppeteer selects only the declared lane relay'
assert_equals "$(sed -n '6p' "$puppeteer_parent_argv")" "$fixture_repo/bin/browser-lane" 'MCPorter launches only the lane-owned child'
assert_equals "$(sed -n '7p' "$puppeteer_parent_argv")" '__puppeteer-child' 'MCPorter receives no caller-supplied Puppeteer command'
assert_equals "$(wc -l <"$puppeteer_parent_argv" | tr -d ' ')" '7' 'the Puppeteer child command line carries nothing else'
assert_not_contains "$(<"$puppeteer_parent_argv")" 'ONE-USE' 'the one-use endpoint is absent from MCPorter child arguments'
assert_not_contains "$(<"$puppeteer_parent_argv")" "$puppeteer_plan" 'the caller plan path is absent from MCPorter child arguments'
assert_contains "$(<"$puppeteer_log")" "connect ws=$puppeteer_ws_endpoint http= viewport=null" 'the helper receives the one-use WebSocket endpoint only through its environment and leaves the viewport alone'
assert_equals "$(sed -n '1p' "$puppeteer_log")" "connect ws=$puppeteer_ws_endpoint http= viewport=null protocolTimeout=30000" 'connect is the first engine call'
assert_equals "$(grep -c '^pages$' "$puppeteer_log")" '3' 'the helper rechecks the admitted page set before binding and before each action'
assert_equals "$(grep -v '^setDefaultTimeout' "$puppeteer_log" | tr '\n' ' ')" \
  "connect ws=$puppeteer_ws_endpoint http= viewport=null protocolTimeout=30000 pages url unrelated-url pages url unrelated-url title pages url unrelated-url snapshot disconnect " \
  'engine calls run in the documented order: bind, then guard and action pairs, then disconnect'
assert_equals "$(grep '^unrelated-' "$puppeteer_log" | sort -u)" 'unrelated-url' \
  'Puppeteer reads unrelated URL metadata but performs no unrelated-page action'
assert_equals "$(grep -c '^disconnect$' "$puppeteer_log")" '1' 'Puppeteer disconnects exactly once'
assert_not_contains "$(<"$puppeteer_log")" 'close' 'Puppeteer never closes the external Chrome'
assert_not_contains "$(<"$puppeteer_log")" 'evaluate' 'a title-and-snapshot plan evaluates no in-page script'
assert_puppeteer_private_state_clean 'Puppeteer success'
assert_helper_exited 'Puppeteer success leaves no helper process'

printf '%s\n' '{"free_mode":true}' >"$free_config"
FAKE_MCPORTER_STATUS=all FAKE_MCPORTER_CALL_STATUS=42 \
FAKE_PUPPETEER_PAGE_URL="$page_two" \
  run_puppeteer puppeteer-free-inventory-unavailable --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '0' 'free-mode Puppeteer bypasses unavailable MCP page inventory'
assert_equals "$cli_out" \
  $'{"index":0,"command":"title","status":"ok","result":"FIXTURE-TITLE-ONE"}\n{"index":1,"command":"snapshot","status":"ok","result":{"role":"WebArea","name":"FIXTURE-TITLE-ONE"}}' \
  'free-mode Puppeteer accepts a same-site different path without MCP page inventory'
assert_equals "$(sed -n '1p' "$puppeteer_parent_argv")" 'chrome-relay' \
  'free-mode Puppeteer still uses the authenticated one-use relay handoff'
assert_contains "$(<"$puppeteer_log")" 'pages' \
  'free-mode Puppeteer verifies the same-site page inside the handoff'
assert_puppeteer_private_state_clean 'free-mode Puppeteer success'

printf '%s\n' '{"free_mode":false}' >"$free_config"
FAKE_MCPORTER_CALL_STATUS=42 \
  run_puppeteer puppeteer-secured-inventory-unavailable --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '12' 'secured-mode Puppeteer blocks when MCP page inventory is unavailable'
assert_contains "$cli_err" 'relay_unavailable' \
  'secured-mode Puppeteer reports unavailable MCP page inventory'
assert_absent "$puppeteer_parent_argv" \
  'secured-mode Puppeteer inventory failure launches no one-use handoff'

puppeteer_activity_unavailable_log="$TEST_ROOT/puppeteer-activity-unavailable.log"
FAKE_MCPORTER_ACTIVITY_STATUS=1 FAKE_MCPORTER_ACTIVITY_LOG="$puppeteer_activity_unavailable_log" \
  run_puppeteer puppeteer-activity-unavailable --ttl 30 --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '0' 'Puppeteer work survives unavailable activity publication'
assert_equals "$cli_out" \
  $'{"index":0,"command":"title","status":"ok","result":"FIXTURE-TITLE-ONE"}\n{"index":1,"command":"snapshot","status":"ok","result":{"role":"WebArea","name":"FIXTURE-TITLE-ONE"}}' \
  'unavailable activity preserves Puppeteer output'
assert_contains "$cli_err" 'lane_activity_unavailable' 'Puppeteer activity failure remains advisory'
assert_contains "$(<"$puppeteer_log")" 'title' 'unavailable activity still executes Puppeteer actions'
assert_equals "$(<"$puppeteer_activity_unavailable_log")" 'start:puppeteer' 'failed Puppeteer activity start launches no heartbeat or clear'

# --- the helper reads and runs the same allowlist through fixed API calls ---
write_puppeteer_plan "$puppeteer_other_plan" '{"schema_version":1,"actions":[{"command":"text","args":["#heading"]},{"command":"click","args":["#go"]},{"command":"type","args":["#field","hello"]},{"command":"press","args":["Enter"]},{"command":"hover","args":["#menu"]},{"command":"select","args":["#choice","a","b"]},{"command":"wait","args":["#done"]}]}'
run_puppeteer puppeteer-allowlist --ttl 30 --page-url "$page_one" --plan "$puppeteer_other_plan"
assert_equals "$cli_status" '0' 'every allowlisted Puppeteer command runs'
assert_equals "$(grep -E '^(text|evaluate|dispose|click|type|press|hover|select|wait) ?' "$puppeteer_log" | tr '\n' ' ')" \
  'text #heading evaluate dispose click #go type #field hello press Enter hover #menu select #choice a b wait #done dispose ' \
  'each command maps onto its fixed Puppeteer API call with its plan arguments'
assert_equals "$(jq -c '.result' <<<"$(sed -n '1p' <<<"$cli_out")")" '"FIXTURE-TEXT"' 'text returns the element text'
assert_equals "$(jq -c '.result' <<<"$(sed -n '6p' <<<"$cli_out")")" '["a","b"]' 'select returns the selected values'
assert_equals "$(jq -c '.result' <<<"$(sed -n '2p' <<<"$cli_out")")" 'null' 'click returns a null result'

# --- same-site binding refuses changed, gone, ambiguous, and closed pages ---
FAKE_MCPORTER_PAGE_TEXT=$'0: Intended ('"$page_one"$')\n1: Unrelated ('"$adapter_unrelated_url"$') [selected]' \
  run_puppeteer puppeteer-page-not-selected --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '0' 'Puppeteer accepts one same-site target when another site is selected'
assert_contains "$(<"$puppeteer_log")" 'title' 'Puppeteer unique same-site target reaches helper work'
assert_helper_exited 'Puppeteer unique same-site target retires its helper'

FAKE_MCPORTER_PAGE_TEXT=$'0: Intended ('"$page_one"$') [selected]\n1: SAME-SITE ('"$page_two"$') [selected]' \
  run_puppeteer puppeteer-ambiguous-selection --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '16' 'Puppeteer refuses ambiguous selected-page state at public preflight'
assert_contains "$cli_err" 'page_ambiguous' 'Puppeteer ambiguous selection refusal is typed'
assert_absent "$puppeteer_pid_file" 'Puppeteer ambiguous selection launches no helper'
assert_absent "$lease_dir" 'Puppeteer ambiguous selection releases the lease'

FAKE_PUPPETEER_PAGE_URL="$page_two" \
  run_puppeteer puppeteer-page-same-site --page-url "$page_one" --plan "$puppeteer_plan"
puppeteer_changed_output="$cli_out$cli_err"
assert_equals "$cli_status" '0' 'Puppeteer accepts a same-site path after secured preflight'
assert_contains "$(<"$puppeteer_log")" 'title' 'Puppeteer same-site page executes plan actions'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'Puppeteer same-site page disconnects'

FAKE_PUPPETEER_PAGE_URL="$different_site_page" \
  run_puppeteer puppeteer-page-changed --page-url "$page_one" --plan "$puppeteer_plan"
puppeteer_changed_output="$cli_out$cli_err"
assert_equals "$cli_status" '16' 'Puppeteer fails closed when the page leaves the site after preflight'
assert_contains "$cli_err" 'puppeteer_page_changed' 'Puppeteer cross-site page-change refusal is typed'
assert_contains "$cli_err" '"retry_safe":true' 'Puppeteer pre-action cross-site mismatch remains safe to retry after readiness repair'
assert_equals "$cli_out" '' 'Puppeteer cross-site refusal prints nothing on stdout'
assert_not_contains "$(<"$puppeteer_log")" 'title' 'Puppeteer cross-site refusal executes no plan action'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'Puppeteer cross-site refusal still disconnects'
assert_not_contains "$puppeteer_changed_output" "$page_one" 'cross-site refusal does not leak the declared URL'
assert_not_contains "$puppeteer_changed_output" "$different_site_page" 'cross-site refusal does not leak the live URL'
assert_absent "$lease_dir" 'Puppeteer cross-site refusal releases the lease'

FAKE_PUPPETEER_URL_AFTER_FIRST_ACTION="$page_two" \
  run_puppeteer puppeteer-page-drift-same-site --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '0' 'a same-site path change between actions keeps the batch running'
assert_contains "$(<"$puppeteer_log")" 'snapshot' 'the next action runs after a same-site path change'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'same-site between-action change still disconnects'

FAKE_PUPPETEER_URL_AFTER_FIRST_ACTION="$different_site_page" \
  run_puppeteer puppeteer-page-drift --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '16' 'a page that leaves the site between actions stops the run'
assert_contains "$cli_err" 'puppeteer_page_changed' 'between-action cross-site change is typed'
assert_contains "$cli_err" 'current ordinary URL' 'Puppeteer cross-site recovery observes the current URL'
assert_contains "$cli_err" 'Do not replay' 'Puppeteer cross-site recovery preserves uncertain effects'
assert_contains "$cli_err" '"retry_safe":false' 'Puppeteer partial-run cross-site navigation must not advertise safe replay'
assert_equals "$cli_out" '{"index":0,"command":"title","status":"ok","result":"FIXTURE-TITLE-ONE"}' 'the action that completed before the cross-site change keeps its output'
assert_not_contains "$(<"$puppeteer_log")" 'snapshot' 'no action runs on the cross-site page'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'between-action cross-site change still disconnects'

FAKE_PUPPETEER_DUPLICATE_AFTER_FIRST=1 \
  run_puppeteer puppeteer-bound-page-preferred --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '0' 'Puppeteer prefers its bound page when another same-site page appears'
assert_contains "$(<"$puppeteer_log")" 'snapshot' 'Puppeteer bound-page preference completes the plan'

FAKE_PUPPETEER_PAGE_COUNT=0 \
  run_puppeteer puppeteer-page-gone --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '16' 'a relay with no page refuses the run'
assert_contains "$cli_err" 'puppeteer_page_gone' 'gone-page refusal is typed'
assert_not_contains "$(<"$puppeteer_log")" 'title' 'gone-page refusal executes no plan action'

FAKE_PUPPETEER_PAGE_COUNT=2 \
  run_puppeteer puppeteer-page-ambiguous --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '16' 'a relay exposing two pages refuses the run'
assert_contains "$cli_err" 'puppeteer_page_ambiguous' 'ambiguous-page refusal is typed'
assert_not_contains "$(<"$puppeteer_log")" 'title' 'ambiguous-page refusal executes no plan action'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'ambiguous-page refusal still disconnects'

FAKE_PUPPETEER_PAGE_CLOSED=1 \
  run_puppeteer puppeteer-page-closed --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '16' 'a bound page that closes before an action refuses the run'
assert_contains "$cli_err" 'puppeteer_page_gone' 'closed-page refusal is typed'
assert_not_contains "$(<"$puppeteer_log")" 'title' 'closed-page refusal executes no plan action'

# --- action failure: fixed diagnostics, status 18, disconnect, no close ---
write_puppeteer_plan "$puppeteer_other_plan" '{"schema_version":1,"actions":[{"command":"title","args":[]},{"command":"type","args":["#FIXTURE-SELECTOR-SENTINEL","FIXTURE-TYPED-SENTINEL"]},{"command":"snapshot","args":[]}]}'
FAKE_MCPORTER_ACTIVITY_FACTS="$TEST_ROOT/action-fail-facts.jsonl" FAKE_PUPPETEER_FAIL_COMMAND=type \
FAKE_PUPPETEER_FAIL_MESSAGE='FIXTURE-SECRET-MESSAGE https://leak.invalid/FIXTURE-SECRET-PATH' \
  run_puppeteer puppeteer-action-fail --page-url "$page_one" --plan "$puppeteer_other_plan"
assert_equals "$cli_status" '18' 'a failed in-page action exits 18'
assert_contains "$cli_err" 'puppeteer_action_failed' 'action failure is typed'
assert_contains "$cli_err" 'action 1 (type) failed (Error)' 'action failure names only the index, command, and admitted error class'
assert_not_contains "$cli_err" 'FIXTURE-SELECTOR-SENTINEL' 'action failure does not leak the plan selector'
assert_not_contains "$cli_err" 'FIXTURE-TYPED-SENTINEL' 'action failure does not leak the typed text'
assert_not_contains "$cli_err" 'FIXTURE-SECRET-MESSAGE' 'action failure does not leak the engine message'
assert_not_contains "$cli_err" 'leak.invalid' 'action failure does not leak a URL from the engine message'
assert_not_contains "$cli_err" 'FixtureSecretClass' 'an unadmitted error class name collapses to Error'
assert_equals "$cli_out" '{"index":0,"command":"title","status":"ok","result":"FIXTURE-TITLE-ONE"}' 'the action that succeeded before the failure keeps its output'
assert_not_contains "$(<"$puppeteer_log")" 'snapshot' 'no action runs after a failure'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'Puppeteer disconnects after an action failure'
assert_equals "$(jq -sr '.[] | select(.kind=="finish") | [.action,.cleanup,.code] | join(":")' "$TEST_ROOT/action-fail-facts.jsonl")" 'failed:confirmed:18' 'failed action keeps independently confirmed cleanup'
assert_not_contains "$(<"$TEST_ROOT/action-fail-facts.jsonl")" 'FIXTURE-SELECTOR-SENTINEL' 'activity facts exclude the action selector'

assert_not_contains "$(<"$puppeteer_log")" 'close' 'action failure never closes the external Chrome'
assert_puppeteer_private_state_clean 'Puppeteer action failure'
assert_helper_exited 'Puppeteer action failure leaves no helper process'

# Positive control for the admitted error-class set: an engine TimeoutError is
# named, so the row above collapses the sentinel by vocabulary, not by accident.
FAKE_PUPPETEER_FAIL_COMMAND=title FAKE_PUPPETEER_FAIL_CLASS=TimeoutError \
  run_puppeteer puppeteer-action-fail-class --page-url "$page_one" --plan "$puppeteer_plan"
assert_contains "$cli_err" 'action 0 (title) failed (TimeoutError)' 'an admitted engine error class is named in the diagnostic'

# --- whole-run TTL: connect, page discovery, actions, and disconnect ---
FAKE_PUPPETEER_HOLD_COMMAND=connect FAKE_PUPPETEER_HOLD_MS=30000 \
  run_puppeteer puppeteer-connect-timeout --ttl 1 --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '12' 'a connect that outlives the lease TTL fails as relay unavailable'
assert_contains "$cli_err" 'puppeteer_connect_failed' 'connect timeout is typed'
assert_not_contains "$(<"$puppeteer_log")" 'pages' 'connect timeout reaches no page discovery'
assert_helper_exited 'connect timeout leaves no helper process behind the held socket'
assert_absent "$lease_dir" 'connect timeout releases the lease'

FAKE_PUPPETEER_FAIL_COMMAND=connect \
  run_puppeteer puppeteer-connect-fail --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '12' 'a rejected connect fails as relay unavailable'
assert_contains "$cli_err" 'puppeteer_connect_failed' 'rejected connect is typed'
assert_not_contains "$(<"$puppeteer_log")" 'disconnect' 'a rejected connect has nothing to disconnect'

FAKE_PUPPETEER_HOLD_COMMAND=pages FAKE_PUPPETEER_HOLD_MS=30000 \
  run_puppeteer puppeteer-pages-timeout --ttl 1 --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '16' 'page discovery that outlives the lease TTL refuses the run'
assert_contains "$cli_err" 'puppeteer_page_unresolved' 'page discovery timeout is typed'
assert_not_contains "$(<"$puppeteer_log")" 'title' 'page discovery timeout executes no plan action'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'page discovery timeout still disconnects'
assert_helper_exited 'page discovery timeout leaves no helper process'

FAKE_PUPPETEER_HOLD_COMMAND=title FAKE_PUPPETEER_HOLD_MS=30000 \
  run_puppeteer puppeteer-action-timeout --ttl 1 --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '18' 'an action that outlives the lease TTL exits 18'
assert_contains "$cli_err" 'puppeteer_action_timeout' 'action timeout is typed'
assert_equals "$cli_out" '' 'a timed-out action prints no result'
assert_not_contains "$(<"$puppeteer_log")" 'snapshot' 'no action runs after a timeout'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'action timeout still disconnects'
assert_helper_exited 'action timeout leaves no helper process behind the held action'
assert_puppeteer_private_state_clean 'Puppeteer action timeout'

# The guard before an action can spend the remaining TTL. Its asynchronous
# part is bounded, so a slow page discovery before the second action fails as
# an unresolved page inside the lease rather than running late.
FAKE_PUPPETEER_HOLD_COMMAND=pages FAKE_PUPPETEER_HOLD_MS=30000 FAKE_PUPPETEER_HOLD_PAGES_CALL=3 \
  run_puppeteer puppeteer-guard-timeout --ttl 1 --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '16' 'a slow guard before an action is bounded by the lease TTL'
assert_contains "$cli_err" 'puppeteer_page_unresolved' 'bounded guard refusal is typed'
assert_not_contains "$(<"$puppeteer_log")" 'snapshot' 'the action behind the slow guard never reaches the engine'
assert_helper_exited 'a bounded guard leaves no helper process behind the held discovery'

# The guard's synchronous URL read cannot be pre-empted, so this is the one
# way wall-clock time can pass the TTL between page discovery and an action.
# The helper rechecks the TTL immediately before invoking the action and
# refuses it; the action that completed inside the TTL keeps its output.
FAKE_PUPPETEER_URL_BLOCK_MS=1500 FAKE_PUPPETEER_BLOCK_URL_CALL=3 \
  run_puppeteer puppeteer-run-expired --ttl 1 --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '18' 'no action starts after the lease TTL has passed'
assert_contains "$cli_err" 'puppeteer_run_expired' 'post-expiry refusal is typed'
assert_equals "$cli_out" '{"index":0,"command":"title","status":"ok","result":"FIXTURE-TITLE-ONE"}' 'the action that completed inside the TTL keeps its output'
assert_not_contains "$(<"$puppeteer_log")" 'snapshot' 'the refused action never reaches the engine'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'post-expiry refusal still disconnects'

FAKE_PUPPETEER_HOLD_COMMAND=disconnect FAKE_PUPPETEER_HOLD_MS=30000 \
  run_puppeteer puppeteer-disconnect-timeout --ttl 1 --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '17' 'a disconnect that cannot be proved fails closed'
assert_contains "$cli_err" 'puppeteer_lifecycle_unresolved' 'disconnect timeout is typed'
assert_not_contains "$(<"$puppeteer_log")" 'close' 'disconnect timeout never escalates to close'
assert_helper_exited 'disconnect timeout leaves no helper process behind the held disconnect'
assert_absent "$lease_dir" 'disconnect timeout releases the lease'

FAKE_MCPORTER_ACTIVITY_FACTS="$TEST_ROOT/cleanup-fail-facts.jsonl" FAKE_PUPPETEER_DISCONNECT_FAIL=1 \
  run_puppeteer puppeteer-disconnect-fail --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '17' 'a rejected disconnect after success fails closed'
assert_contains "$cli_err" 'puppeteer_lifecycle_unresolved' 'rejected disconnect is typed'
assert_equals "$(jq -sr '.[] | select(.kind=="finish") | [.action,.cleanup,.code] | join(":")' "$TEST_ROOT/cleanup-fail-facts.jsonl")" 'completed:unconfirmed:17' 'successful action remains completed when cleanup fails'


FAKE_MCPORTER_ACTIVITY_FACTS="$TEST_ROOT/both-fail-facts.jsonl" FAKE_PUPPETEER_DISCONNECT_FAIL=1 FAKE_PUPPETEER_FAIL_COMMAND=snapshot \
  run_puppeteer puppeteer-disconnect-fail-after-action --page-url "$page_one" --plan "$puppeteer_plan"
assert_equals "$cli_status" '18' 'a rejected disconnect preserves an earlier action failure status'
assert_contains "$cli_err" 'puppeteer_action_failed' 'the action failure remains the typed refusal'
assert_contains "$cli_err" 'disconnect remained unresolved after action failure' 'the unresolved disconnect is noted'
assert_equals "$(jq -sr '.[] | select(.kind=="finish") | [.action,.cleanup,.code] | join(":")' "$TEST_ROOT/both-fail-facts.jsonl")" 'failed:unconfirmed:18' 'action failure and cleanup failure both survive telemetry'


# --- direct child: contract and signal cleanup ---
: >"$puppeteer_log"
HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
BROWSER_LANE_INTERNAL_CHILD=1 \
BROWSER_LANE_PUPPETEER_PLAN="$puppeteer_plan" \
BROWSER_LANE_PAGE_URL_SHA256="$(printf '%s' 'https://fixture.invalid' | shasum -a 256 | awk '{print $1}')" \
BROWSER_LANE_RUN_ID='puppeteer-contract' \
FAKE_PUPPETEER_LOG="$puppeteer_log" \
  "$fixture_repo/bin/browser-lane" __puppeteer-child >"$TEST_ROOT/puppeteer-contract.out" 2>"$TEST_ROOT/puppeteer-contract.err" ||
  puppeteer_contract_status=$?
assert_equals "${puppeteer_contract_status:-0}" '14' 'an internal child without an endpoint refuses the handoff'
assert_contains "$(<"$TEST_ROOT/puppeteer-contract.err")" 'puppeteer_child_contract_invalid' 'incomplete child contract is typed'
assert_equals "$(<"$puppeteer_log")" '' 'incomplete child contract never loads the engine'

: >"$puppeteer_log"
rm -f "$puppeteer_pid_file"
HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
BROWSER_LANE_INTERNAL_CHILD=1 \
BROWSER_LANE_PUPPETEER_PLAN="$puppeteer_plan" \
BROWSER_LANE_PAGE_URL_SHA256="$(printf '%s' 'https://fixture.invalid' | shasum -a 256 | awk '{print $1}')" \
BROWSER_LANE_RUN_ID='puppeteer-signal-proof' \
AGENT_BROWSER_CDP="$puppeteer_ws_endpoint" \
FAKE_PUPPETEER_LOG="$puppeteer_log" \
FAKE_PUPPETEER_PID_FILE="$puppeteer_pid_file" \
FAKE_PUPPETEER_PAGE_URL="$page_one" \
FAKE_PUPPETEER_HOLD_COMMAND=title FAKE_PUPPETEER_HOLD_MS=30000 \
  "$fixture_repo/bin/browser-lane" __puppeteer-child >"$TEST_ROOT/puppeteer-signal.out" 2>"$TEST_ROOT/puppeteer-signal.err" &
puppeteer_signal_pid=$!
for _ in {1..50}; do
  grep -q '^title$' "$puppeteer_log" 2>/dev/null && break
  sleep 0.1
done
grep -q '^title$' "$puppeteer_log" 2>/dev/null || fail 'Puppeteer signal fixture did not reach its held action'
kill -TERM "$puppeteer_signal_pid"
set +e
wait "$puppeteer_signal_pid"
puppeteer_signal_status=$?
set -e
assert_equals "$puppeteer_signal_status" '130' 'Puppeteer signal cleanup returns an interrupted status'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'Puppeteer signal cleanup disconnects'
assert_not_contains "$(<"$puppeteer_log")" 'close' 'Puppeteer signal cleanup never closes the external Chrome'
assert_contains "$(<"$TEST_ROOT/puppeteer-signal.err")" 'interrupted by SIGTERM' 'Puppeteer signal cleanup names the signal'
assert_helper_exited 'Puppeteer signal cleanup leaves no helper process'

# --- public command: parent signal custody ---
# The signal goes only to the public browser-lane process. The parent must
# forward it to the broker, the broker to the helper, and the parent must not
# release the lease or remove the plan snapshot until the helper is gone.
: >"$puppeteer_log"
rm -f "$puppeteer_pid_file"
HOME="$fixture_home" XDG_STATE_HOME="$fixture_state" PATH="$fixture_bin:/usr/bin:/bin" \
FAKE_MCPORTER_EXEC_CHILD=1 \
FAKE_MCPORTER_ACTIVITY_FACTS="$TEST_ROOT/puppeteer-signal-facts.jsonl" \
FAKE_MCPORTER_EXEC_ENDPOINT="$puppeteer_ws_endpoint" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
FAKE_PUPPETEER_LOG="$puppeteer_log" \
FAKE_PUPPETEER_PID_FILE="$puppeteer_pid_file" \
FAKE_PUPPETEER_PAGE_URL="$page_one" \
FAKE_PUPPETEER_HOLD_COMMAND=title FAKE_PUPPETEER_HOLD_MS=30000 \
  "$fixture_repo/bin/browser-lane" puppeteer --lane daily-driver --account-role owner \
    --run-id puppeteer-public-signal --ttl 60 --page-url "$page_one" --plan "$puppeteer_plan" \
    >"$TEST_ROOT/puppeteer-public-signal.out" 2>"$TEST_ROOT/puppeteer-public-signal.err" &
puppeteer_public_pid=$!
for _ in {1..100}; do
  grep -q '^title$' "$puppeteer_log" 2>/dev/null && break
  sleep 0.1
done
grep -q '^title$' "$puppeteer_log" 2>/dev/null || fail 'public Puppeteer signal fixture did not reach its held action'
assert_present "$lease_dir" 'the public run holds the lease while its action is in flight'
kill -TERM "$puppeteer_public_pid"
set +e
wait "$puppeteer_public_pid"
puppeteer_public_status=$?
set -e
assert_equals "$puppeteer_public_status" '130' 'a signalled public Puppeteer run exits interrupted'
assert_equals "$(jq -sr '.[] | select(.kind=="finish") | [.action,.cleanup,.code] | join(":")' "$TEST_ROOT/puppeteer-signal-facts.jsonl")" 'failed:confirmed:130' 'public Puppeteer interruption publishes its observed cleanup and failure'
assert_contains "$(<"$puppeteer_log")" 'disconnect' 'a signalled public run reaches the helper, which disconnects'
assert_not_contains "$(<"$puppeteer_log")" 'close' 'a signalled public run never closes the external Chrome'
assert_contains "$(<"$TEST_ROOT/puppeteer-public-signal.err")" 'relay handoff retired' 'the parent reports that it retired the relay handoff'
assert_helper_exited 'a signalled public run leaves no helper process'
assert_puppeteer_private_state_clean 'a signalled public run'

agent_argv="$TEST_ROOT/agent-browser.argv"
agent_cleanup_log="$TEST_ROOT/agent-browser-cleanup.log"
agent_session_close="$TEST_ROOT/agent-browser-session-close.argv"
FAKE_MCPORTER_AGENT_ARGV="$agent_argv" \
FAKE_MCPORTER_CLEANUP_LOG="$agent_cleanup_log" \
FAKE_MCPORTER_ACTIVITY_FACTS="$TEST_ROOT/agent-browser-facts.jsonl" FAKE_MCPORTER_ACTIVITY_LOG="$TEST_ROOT/agent-browser-activity.log" \
FAKE_AGENT_BROWSER_STAGE_LOG="$agent_cleanup_log" \
FAKE_AGENT_BROWSER_PAGE_URL="$page_one" \
FAKE_AGENT_BROWSER_CLOSE_ARGV="$agent_session_close" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-proof --scenario snapshot-check --ttl 30 --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '0' 'Agent Browser route exits with the child success status'
assert_equals "$(sed -n '1p' "$agent_argv")" 'chrome-relay' 'Agent Browser route enters MCPorter chrome-relay'
assert_equals "$(sed -n '2p' "$agent_argv")" 'exec' 'Agent Browser route uses the authenticated exec handoff'
assert_equals "$(sed -n '3p' "$agent_argv")" '--relay-url' 'Agent Browser route declares one relay URL'
assert_equals "$(sed -n '4p' "$agent_argv")" 'http://127.0.0.1:18799' 'Agent Browser route selects the lane relay'
assert_equals "$(sed -n '5p' "$agent_argv")" '--' 'MCPorter receives a literal child terminator'
assert_matches "$(sed -n '6p' "$agent_argv")" '.*/agent-cleanup\..*/run' 'MCPorter launches one private staged Agent Browser runner'
assert_equals "$(sed -n '7p' "$agent_argv")" 'snapshot' 'Agent Browser runner receives the requested command last'
assert_not_contains "$(<"$agent_argv")" "$page_one" 'Agent Browser handoff arguments do not reveal the admitted URL'
assert_equals "$(<"$agent_cleanup_log")" $'attach\npin-check\nwork\npin-check\nretire\nhandoff-exit' 'Agent Browser stages attach, pin, work, and retirement before handoff exit'
assert_not_contains "$(<"$agent_cleanup_log")" 'close' 'Agent Browser normal path creates and cleans no blank tab'
assert_contains "$(<"$agent_session_close")" 'close' 'Agent Browser cleanup retires the run-scoped session'
assert_equals "$(find "$fixture_state/browser-lanes" -name 'agent-cleanup.*' | wc -l | tr -d ' ')" '0' 'Agent Browser cleanup removes private temporary evidence'
assert_absent "$lease_dir" 'Agent Browser success releases the lane lease'
assert_equals "$(head -1 "$TEST_ROOT/agent-browser-activity.log")" 'start:agent-browser' 'Agent Browser records its bounded adapter value'
assert_equals "$(tail -1 "$TEST_ROOT/agent-browser-activity.log")" 'clear' 'Agent Browser clears matching activity on success'
assert_equals "$(jq -sr '.[] | select(.kind=="finish") | [.action,.cleanup,.code] | join(":")' "$TEST_ROOT/agent-browser-facts.jsonl")" 'completed:confirmed:0' 'agent-browser reports independent successful command and session-cleanup facts'
assert_equals "$(jq -sr '.[] | select(.kind=="start") | .scenario' "$TEST_ROOT/agent-browser-facts.jsonl")" 'snapshot-check' 'adapter scenario is propagated to retained history'
assert_equals "$(find "$fixture_state/browser-lanes" -name 'activity-outcome.*' | wc -l | tr -d ' ')" '0' 'completed adapter removes its private telemetry receipt'

agent_free_argv="$TEST_ROOT/agent-browser-free.argv"
agent_free_cleanup_log="$TEST_ROOT/agent-browser-free-cleanup.log"
printf '%s\n' '{"free_mode":true}' >"$free_config"
FAKE_MCPORTER_STATUS=all FAKE_MCPORTER_CALL_STATUS=42 \
FAKE_MCPORTER_AGENT_ARGV="$agent_free_argv" \
FAKE_AGENT_BROWSER_STAGE_LOG="$agent_free_cleanup_log" \
FAKE_AGENT_BROWSER_UNRELATED_TAB=1 \
FAKE_AGENT_BROWSER_PAGE_URL="$page_two" \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-free-inventory-unavailable --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '0' 'free-mode Agent Browser bypasses unavailable MCP page inventory'
assert_equals "$(sed -n '1p' "$agent_free_argv")" 'chrome-relay' \
  'free-mode Agent Browser still uses the authenticated one-use relay handoff'
assert_equals "$(<"$agent_free_cleanup_log")" $'attach\nselect\npin-check\nwork\npin-check\nretire\nhandoff-exit' \
  'free-mode Agent Browser selects a same-site path, preserves site checks, and cleans up inside the handoff'
assert_absent "$lease_dir" 'free-mode Agent Browser releases the lane lease'

agent_free_selected_log="$TEST_ROOT/agent-browser-free-selected.log"
agent_free_selected_target="$TEST_ROOT/agent-browser-free-selected-target.log"
FAKE_MCPORTER_STATUS=all FAKE_MCPORTER_CALL_STATUS=42 \
FAKE_AGENT_BROWSER_STAGE_LOG="$agent_free_selected_log" \
FAKE_AGENT_BROWSER_SELECTED_TARGET_LOG="$agent_free_selected_target" \
FAKE_AGENT_BROWSER_SAME_SITE_SELECTED=1 FAKE_AGENT_BROWSER_PAGE_URL="$page_one" \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-free-selected-site --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '0' 'free-mode Agent Browser prefers the active same-site tab'
assert_contains "$(<"$agent_free_selected_target")" 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' \
  'free-mode Agent Browser selects the active same-site target ID'
assert_equals "$(<"$agent_free_selected_log")" $'attach\nselect\npin-check\nwork\npin-check\nretire\nhandoff-exit' \
  'free-mode Agent Browser runs and retires the selected same-site target'

agent_free_zero_log="$TEST_ROOT/agent-browser-free-zero.log"
printf '%s\n' '{"free_mode":true}' >"$free_config"
FAKE_MCPORTER_STATUS=all FAKE_MCPORTER_CALL_STATUS=42 \
FAKE_AGENT_BROWSER_STAGE_LOG="$agent_free_zero_log" \
FAKE_AGENT_BROWSER_PAGE_URL="$adapter_unrelated_url" \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-free-zero-match --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '16' 'free-mode Agent Browser rejects zero same-site matches'
assert_contains "$cli_err" 'agent_browser_page_mismatch' \
  'free-mode Agent Browser zero same-site matches are typed'
assert_equals "$(<"$agent_free_zero_log")" $'attach\nretire\nhandoff-exit' \
  'free-mode Agent Browser zero matches retires without selecting a tab'
assert_not_contains "$(<"$agent_free_zero_log")" 'select' \
  'free-mode Agent Browser zero matches never selects a tab'
assert_not_contains "$(<"$agent_free_zero_log")" 'work' \
  'free-mode Agent Browser zero matches performs no work'

agent_free_duplicate_log="$TEST_ROOT/agent-browser-free-duplicate.log"
printf '%s\n' '{"free_mode":true}' >"$free_config"
FAKE_MCPORTER_STATUS=all FAKE_MCPORTER_CALL_STATUS=42 \
FAKE_AGENT_BROWSER_STAGE_LOG="$agent_free_duplicate_log" \
FAKE_AGENT_BROWSER_DUPLICATE_EXACT=1 FAKE_AGENT_BROWSER_PAGE_URL="$page_one" \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-free-duplicate-match --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '16' 'free-mode Agent Browser rejects two unselected same-site matches'
assert_contains "$cli_err" 'agent_browser_page_mismatch' \
  'free-mode Agent Browser unselected same-site ambiguity is typed'
assert_equals "$(<"$agent_free_duplicate_log")" $'attach\nretire\nhandoff-exit' \
  'free-mode Agent Browser duplicate matches retire without selecting a tab'
assert_not_contains "$(<"$agent_free_duplicate_log")" 'select' \
  'free-mode Agent Browser duplicate matches never select a tab'
assert_not_contains "$(<"$agent_free_duplicate_log")" 'work' \
  'free-mode Agent Browser duplicate matches perform no work'

agent_free_malformed_log="$TEST_ROOT/agent-browser-free-malformed.log"
printf '%s\n' '{"free_mode":true}' >"$free_config"
FAKE_MCPORTER_STATUS=all FAKE_MCPORTER_CALL_STATUS=42 \
FAKE_AGENT_BROWSER_STAGE_LOG="$agent_free_malformed_log" \
FAKE_AGENT_BROWSER_MALFORMED_UNRELATED=1 FAKE_AGENT_BROWSER_PAGE_URL="$page_one" \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-free-malformed-entries --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '0' \
  'free-mode Agent Browser ignores malformed unrelated tab entries'
assert_equals "$(<"$agent_free_malformed_log")" $'attach\nselect\npin-check\nwork\npin-check\nretire\nhandoff-exit' \
  'free-mode Agent Browser selects through malformed unrelated tab entries'

agent_free_select_failure_log="$TEST_ROOT/agent-browser-free-select-failure.log"
printf '%s\n' '{"free_mode":true}' >"$free_config"
FAKE_MCPORTER_STATUS=all FAKE_MCPORTER_CALL_STATUS=42 \
FAKE_AGENT_BROWSER_STAGE_LOG="$agent_free_select_failure_log" \
FAKE_AGENT_BROWSER_SELECT_STATUS=1 FAKE_AGENT_BROWSER_PAGE_URL="$page_one" \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-free-select-failure --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '17' 'free-mode Agent Browser reports tab selection failure'
assert_contains "$cli_err" 'agent_browser_attach_failed' \
  'free-mode Agent Browser tab selection failure is typed as attach failure'
assert_equals "$(<"$agent_free_select_failure_log")" $'attach\nselect\nretire\nhandoff-exit' \
  'free-mode Agent Browser tab selection failure retires the session'
assert_not_contains "$(<"$agent_free_select_failure_log")" 'work' \
  'free-mode Agent Browser tab selection failure performs no work'

agent_free_next_log="$TEST_ROOT/agent-browser-free-next-page.log"
printf '%s\n' '{"free_mode":true}' >"$free_config"
FAKE_MCPORTER_STATUS=all FAKE_MCPORTER_CALL_STATUS=42 \
FAKE_AGENT_BROWSER_STAGE_LOG="$agent_free_next_log" \
FAKE_AGENT_BROWSER_PREWORK_PIN_CHECK=1 FAKE_AGENT_BROWSER_UNRELATED_TAB=1 \
FAKE_AGENT_BROWSER_PAGE_URL="$page_one" \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-free-next-page-unrelated --page-url "$page_one" \
    --next-page-url "$next_page" -- 'click @save'
assert_not_contains "$(<"$agent_free_next_log")" 'work' \
  'free-mode Agent Browser next-page preflight performs no work'
assert_equals "$cli_status" '17' \
  'free-mode Agent Browser rejects unrelated tabs before expected navigation work'
assert_contains "$cli_err" 'agent_browser_attach_failed' \
  'free-mode Agent Browser next-page preflight failure is typed as attach failure'
assert_equals "$(<"$agent_free_next_log")" $'attach\nselect\npin-check\nretire\nhandoff-exit' \
  'free-mode Agent Browser next-page preflight retires before work'

agent_secured_argv="$TEST_ROOT/agent-browser-secured.argv"
printf '%s\n' '{"free_mode":false}' >"$free_config"
FAKE_MCPORTER_CALL_STATUS=42 FAKE_MCPORTER_AGENT_ARGV="$agent_secured_argv" \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-secured-inventory-unavailable --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '12' 'secured-mode Agent Browser blocks when MCP page inventory is unavailable'
assert_contains "$cli_err" 'relay_unavailable' \
  'secured-mode Agent Browser reports unavailable MCP page inventory'
assert_absent "$agent_secured_argv" \
  'secured-mode Agent Browser inventory failure launches no one-use handoff'

run_cli health --lane daily-driver --scenario snapshot-check
assert_equals "$cli_status" '2' 'scenario grouping is refused on non-adapter commands'
run_cli agent-browser --lane daily-driver --account-role owner --run-id invalid-scenario --scenario 'https://private.invalid' --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '2' 'scenario identifiers cannot contain URLs'


agent_long_name_log="$TEST_ROOT/agent-browser-long-name.log"
FAKE_AGENT_BROWSER_SOCKET_LIMIT=1 FAKE_AGENT_BROWSER_STAGE_LOG="$agent_long_name_log" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id browser-lane-interactive-attachment-regression-with-a-long-but-valid-public-run-identifier-20260905 \
    --ttl 30 --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '0' 'long public run identifiers fit the Agent Browser Unix socket limit'
assert_equals "$(<"$agent_long_name_log")" $'attach\npin-check\nwork\npin-check\nretire\nhandoff-exit' 'long run identifiers retire the same session before handoff exit'
assert_absent "$lease_dir" 'long run identifiers release lane custody'
assert_not_contains "$cli_err" 'agent_browser_attach_failed' 'long run identifiers do not misreport an admission failure'

agent_attach_failure_stage_log="$TEST_ROOT/agent-browser-attach-failure.log"
agent_attach_failure_close="$TEST_ROOT/agent-browser-attach-failure-close.argv"
FAKE_AGENT_BROWSER_ATTACH_STATUS=1 FAKE_AGENT_BROWSER_STAGE_LOG="$agent_attach_failure_stage_log" \
FAKE_AGENT_BROWSER_CLOSE_ARGV="$agent_attach_failure_close" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-attach-failure --ttl 30 --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '17' 'Agent Browser attach failure has the typed lifecycle exit'
assert_contains "$cli_err" 'agent_browser_attach_failed' 'Agent Browser attach failure is typed'
assert_not_contains "$cli_err" '85' 'Agent Browser attach failure never exposes its runner status'
assert_equals "$(<"$agent_attach_failure_stage_log")" $'attach\nretire\nhandoff-exit' 'attach failure retires inside the same relay handoff'
assert_present "$agent_attach_failure_close" 'attach failure closes its run-scoped session'
assert_equals "$(find "$fixture_state/browser-lanes" -name 'agent-cleanup.*' | wc -l | tr -d ' ')" '0' 'attach failure removes private session state'
assert_absent "$lease_dir" 'attach failure releases the lane lease'

agent_attach_retire_failure_stage_log="$TEST_ROOT/agent-browser-attach-retire-failure.log"
agent_attach_retire_failure_close="$TEST_ROOT/agent-browser-attach-retire-failure-close.argv"
FAKE_AGENT_BROWSER_ATTACH_STATUS=1 FAKE_AGENT_BROWSER_SESSION_STATE=error \
FAKE_AGENT_BROWSER_STAGE_LOG="$agent_attach_retire_failure_stage_log" \
FAKE_AGENT_BROWSER_CLOSE_ARGV="$agent_attach_retire_failure_close" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-attach-retire-failure --ttl 30 --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '17' 'attach failure preserves its typed exit when retirement also fails'
assert_contains "$cli_err" 'agent_browser_attach_failed' 'attach and retirement failure remains typed as attach failure'
assert_contains "$cli_err" 'retirement remained unresolved after attach failure' 'attach and retirement failure emits one bounded diagnostic'
assert_not_contains "$cli_err" '85' 'attach and retirement failure never exposes its runner status'
assert_absent "$agent_attach_retire_failure_close" 'failed attach retirement invents no session close receipt'
assert_equals "$(find "$fixture_state/browser-lanes" -name 'agent-cleanup.*' | wc -l | tr -d ' ')" '0' 'failed attach retirement removes private session state'
assert_absent "$lease_dir" 'failed attach retirement releases the lane lease'

agent_success_retire_failure_stage_log="$TEST_ROOT/agent-browser-success-retire-failure.log"
FAKE_AGENT_BROWSER_SESSION_STATE=error FAKE_AGENT_BROWSER_STAGE_LOG="$agent_success_retire_failure_stage_log" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-success-retire-failure --ttl 30 --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '17' 'successful work with unprovable retirement exits typed lifecycle failure'
assert_contains "$cli_err" 'agent_browser_lifecycle_unresolved' 'successful work retirement failure is typed'
assert_not_contains "$cli_err" '88' 'successful work retirement failure never exposes internal status 88'
assert_contains "$(<"$agent_success_retire_failure_stage_log")" 'work' 'successful work ran before retirement proof failed'
assert_absent "$lease_dir" 'successful work retirement failure releases the lane lease'

agent_failed_retire_failure_stage_log="$TEST_ROOT/agent-browser-failed-retire-failure.log"
FAKE_MCPORTER_AGENT_STATUS=23 FAKE_AGENT_BROWSER_SESSION_STATE=error \
FAKE_AGENT_BROWSER_STAGE_LOG="$agent_failed_retire_failure_stage_log" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-failed-retire-failure --ttl 30 --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '23' 'failed work preserves its original status when retirement is unprovable'
assert_contains "$cli_err" 'retirement remained unresolved after child failure' 'failed work retirement failure emits one bounded diagnostic'
assert_not_contains "$cli_err" '88' 'failed work retirement failure never exposes internal status 88'
assert_contains "$(<"$agent_failed_retire_failure_stage_log")" 'work' 'failed work ran before retirement proof failed'
assert_absent "$lease_dir" 'failed work retirement failure releases the lane lease'

agent_activity_unavailable_log="$TEST_ROOT/agent-browser-activity-unavailable.log"
agent_activity_unavailable_stage_log="$TEST_ROOT/agent-browser-activity-unavailable-stage.log"
FAKE_MCPORTER_ACTIVITY_STATUS=1 FAKE_MCPORTER_ACTIVITY_LOG="$agent_activity_unavailable_log" \
FAKE_AGENT_BROWSER_STAGE_LOG="$agent_activity_unavailable_stage_log" FAKE_AGENT_BROWSER_PAGE_URL="$page_one" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-activity-unavailable --ttl 30 --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '0' 'Agent Browser work survives unavailable activity publication'
assert_equals "$cli_out" '' 'unavailable activity preserves Agent Browser child output'
assert_contains "$cli_err" 'lane_activity_unavailable' 'Agent Browser activity failure remains advisory'
assert_contains "$(<"$agent_activity_unavailable_stage_log")" 'work' 'unavailable activity still executes Agent Browser work'
assert_equals "$(<"$agent_activity_unavailable_log")" 'start:agent-browser' 'failed Agent Browser activity start launches no heartbeat or clear'

agent_ambiguous_cleanup_log="$TEST_ROOT/agent-browser-ambiguous-cleanup.log"
agent_ambiguous_session_close="$TEST_ROOT/agent-browser-ambiguous-session-close.argv"
FAKE_MCPORTER_CLEANUP_TABS=ambiguous \
FAKE_MCPORTER_CLEANUP_LOG="$agent_ambiguous_cleanup_log" \
FAKE_MCPORTER_CLEANUP_PAGE_URL="$page_one" \
FAKE_AGENT_BROWSER_CLOSE_ARGV="$agent_ambiguous_session_close" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-ambiguous-cleanup --ttl 30 --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '0' 'Agent Browser ignores unrelated tab shapes after its bound session retires'
assert_not_contains "$cli_err" 'agent_browser_lifecycle_unresolved' 'unrelated tab shapes cannot create a lifecycle misclassification'
assert_not_contains "$(<"$agent_ambiguous_cleanup_log")" 'close' 'normal cleanup closes no external or blank tab'
assert_present "$agent_ambiguous_session_close" 'staged cleanup retires its resolved run-scoped session'
assert_absent "$lease_dir" 'staged cleanup releases the lane lease'

agent_no_blank_cleanup_log="$TEST_ROOT/agent-browser-no-blank-cleanup.log"
agent_no_blank_session_close="$TEST_ROOT/agent-browser-no-blank-session-close.argv"
FAKE_MCPORTER_CLEANUP_TABS=none \
FAKE_MCPORTER_CLEANUP_LOG="$agent_no_blank_cleanup_log" \
FAKE_MCPORTER_CLEANUP_PAGE_URL="$page_one" \
FAKE_AGENT_BROWSER_CLOSE_ARGV="$agent_no_blank_session_close" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-no-blank --ttl 30 --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '0' 'Agent Browser accepts a session that created no blank tab'
assert_not_contains "$(<"$agent_no_blank_cleanup_log")" 'close' 'staged cleanup performs no close action'
assert_present "$agent_no_blank_session_close" 'no-blank cleanup still retires the run-scoped session'

agent_unreadable_cleanup_log="$TEST_ROOT/agent-browser-unreadable.log"
FAKE_AGENT_BROWSER_URL_STATE=unreadable \
FAKE_MCPORTER_CLEANUP_LOG="$agent_unreadable_cleanup_log" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-unreadable --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '16' 'Agent Browser reports an unreadable bound page as page unresolved'
assert_contains "$cli_err" 'agent_browser_page_unreadable' 'Agent Browser unreadable page refusal is typed'
assert_not_contains "$cli_err" "$page_one" 'Agent Browser unreadable page refusal does not expose the admitted URL'
assert_not_contains "$(<"$agent_unreadable_cleanup_log")" 'work' 'Agent Browser unreadable page refusal performs no requested work'

agent_mismatch_cleanup_log="$TEST_ROOT/agent-browser-mismatch.log"
FAKE_AGENT_BROWSER_URL_STATE=mismatch \
FAKE_MCPORTER_CLEANUP_LOG="$agent_mismatch_cleanup_log" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-mismatch --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '16' 'Agent Browser reports a changed bound page as page unresolved'
assert_contains "$cli_err" 'agent_browser_page_mismatch' 'Agent Browser changed-page refusal is typed'
assert_not_contains "$cli_err" "$page_one" 'Agent Browser changed-page refusal does not expose the admitted URL'
assert_not_contains "$(<"$agent_mismatch_cleanup_log")" 'work' 'Agent Browser changed-page refusal performs no requested work'

run_cli agent-browser --lane daily-driver --account-role wrong \
  --run-id agent-wrong-role --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '11' 'Agent Browser refuses a mismatched account role'
assert_contains "$cli_err" 'account_role_mismatch' 'Agent Browser role refusal is typed'

run_cli agent-browser --lane daily-driver --account-role owner \
  --run-id agent-no-url -- 'snapshot'
assert_equals "$cli_status" '2' 'Agent Browser requires the exact admitted URL'
assert_contains "$cli_err" 'requires --page-url' 'Agent Browser missing URL refusal explains repair'

agent_prohibited_argv="$TEST_ROOT/agent-browser-prohibited.argv"
FAKE_MCPORTER_AGENT_ARGV="$agent_prohibited_argv" \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-prohibited --page-url "$page_one" -- 'tab new'
assert_equals "$cli_status" '2' 'Agent Browser refuses commands that change tab custody'
assert_contains "$cli_err" 'prohibited_agent_browser_command' 'Agent Browser custody refusal is typed'
assert_absent "$agent_prohibited_argv" 'a prohibited Agent Browser command never reaches MCPorter'

agent_failure_cleanup_log="$TEST_ROOT/agent-browser-failure-cleanup.log"
agent_failure_session_close="$TEST_ROOT/agent-browser-failure-session-close.argv"
FAKE_MCPORTER_AGENT_STATUS=23 \
FAKE_MCPORTER_CLEANUP_LOG="$agent_failure_cleanup_log" \
FAKE_MCPORTER_CLEANUP_PAGE_URL="$page_one" \
FAKE_AGENT_BROWSER_CLOSE_ARGV="$agent_failure_session_close" \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-child-fail --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '23' 'Agent Browser route preserves the child failure status'
assert_not_contains "$(<"$agent_failure_cleanup_log")" 'close' 'Agent Browser child failure creates and cleans no blank tab'
assert_present "$agent_failure_session_close" 'Agent Browser retires its session after child failure'
assert_absent "$lease_dir" 'Agent Browser child failure releases the lane lease'

agent_no_session_cleanup_log="$TEST_ROOT/agent-browser-no-session-cleanup.log"
agent_no_session_close="$TEST_ROOT/agent-browser-no-session-close.argv"
FAKE_MCPORTER_AGENT_STATUS=23 \
FAKE_MCPORTER_CLEANUP_LOG="$agent_no_session_cleanup_log" \
FAKE_AGENT_BROWSER_CLOSE_ARGV="$agent_no_session_close" \
FAKE_AGENT_BROWSER_SESSION_STATE=inactive \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-child-no-session --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '23' 'Agent Browser preserves a child failure before session creation'
assert_not_contains "$(<"$agent_no_session_cleanup_log")" 'retire' 'no-session child failure does not invent a session retirement'
assert_absent "$agent_no_session_close" 'no-session child failure does not invent a session to close'
assert_not_contains "$cli_err" 'agent_browser_lifecycle_unresolved' 'no-session child failure has no lifecycle misclassification'
assert_not_contains "$cli_err" 'cleanup remained unresolved' 'no-session child failure has no false cleanup warning'

agent_zero_page_cleanup_log="$TEST_ROOT/agent-browser-zero-page-cleanup.log"
agent_zero_page_session_close="$TEST_ROOT/agent-browser-zero-page-session-close.argv"
agent_zero_page_session_info="$TEST_ROOT/agent-browser-zero-page-session-info.argv"
FAKE_MCPORTER_AGENT_STATUS=23 \
FAKE_MCPORTER_CLEANUP_LOG="$agent_zero_page_cleanup_log" \
FAKE_AGENT_BROWSER_INFO_ARGV="$agent_zero_page_session_info" \
FAKE_AGENT_BROWSER_CLOSE_ARGV="$agent_zero_page_session_close" \
FAKE_AGENT_BROWSER_SESSION_STATE=active-zero \
FAKE_MCPORTER_PAGE_TEXT=$'## Pages\n0: FIXTURE-TITLE-ONE ('"$page_one"$') [selected]' \
  run_cli agent-browser --lane daily-driver --account-role owner \
    --run-id agent-child-zero-page-session --page-url "$page_one" -- 'snapshot'
assert_equals "$cli_status" '23' 'Agent Browser preserves a child failure during zero-page session creation'
agent_zero_page_session_name="$(sed -n '2p' "$agent_zero_page_session_info")"
assert_matches "$agent_zero_page_session_name" '^browser-lane-[a-f0-9]{24}-[0-9]+$' \
  'zero-page child failure scopes its local session state to this run'
assert_equals "$(<"$agent_zero_page_session_info")" $'--session\n'"$agent_zero_page_session_name"$'\nsession\ninfo\n--json' \
  'zero-page child failure reads only its local session state'
assert_contains "$(<"$agent_zero_page_cleanup_log")" 'retire' 'zero-page child failure retires inside its existing relay handoff'
assert_present "$agent_zero_page_session_close" 'zero-page child failure closes its run-scoped session directly'
assert_equals "$(<"$agent_zero_page_session_close")" $'--session\n'"$agent_zero_page_session_name"$'\nclose\n--json' \
  'zero-page child failure invokes direct session close'
assert_not_contains "$cli_err" 'cleanup remained unresolved' 'zero-page child failure has no false cleanup warning'

run_cli recovery create --lane daily-driver --retention-days 7 --deletion-owner owner \
  --page-url "$page_one"
assert_usage_refused 'recovery create with --page-url'
assert_contains "$cli_err" 'recovery does not accept --account-role, --ttl, --page-url, --plan, or a command after --' \
  'recovery refusal uses its existing does-not-accept message'

assert_equals "$(find "$fixture_state/browser-lanes" -name 'page-list.*' | wc -l | tr -d ' ')" '0' \
  'page-list temporary files are removed after page refusals'

chmod 644 "$registry_path"
run_cli list --json
assert_equals "$cli_status" '14' 'an over-readable registry is refused'
assert_contains "$cli_err" 'registry_permissions' 'registry permission refusal carries a repair category'
chmod 600 "$registry_path"

# --- schema-invalid registry: duplicate relay port ---
cp "$registry_path" "$TEST_ROOT/registry.good"
jq '.lanes.specialist.relay_port = 18799' "$TEST_ROOT/registry.good" >"$TEST_ROOT/registry.bad"
cat "$TEST_ROOT/registry.bad" >"$registry_path"
[[ "$(mode_of "$registry_path")" == '600' ]] || fail 'invalid registry fixture lost mode 600'
run_cli list --json
assert_equals "$cli_status" '14' 'a registry with duplicate relay ports is refused'
assert_contains "$cli_err" 'registry_invalid' 'registry schema refusal carries a repair category'
assert_equals "$cli_out" '' 'registry schema refusal prints nothing on stdout'
cat "$TEST_ROOT/registry.good" >"$registry_path"

jq 'del(.lanes["daily-driver"].sync_expectations)' "$TEST_ROOT/registry.good" >"$TEST_ROOT/registry.bad"
cat "$TEST_ROOT/registry.bad" >"$registry_path"
run_cli list --json
assert_equals "$cli_status" '14' 'a provisioned lane without a Sync account-shape contract is refused'
assert_contains "$cli_err" 'registry_invalid' 'missing Sync contract refusal is a registry failure'
assert_equals "$cli_out" '' 'missing Sync contract refusal prints nothing on stdout'
cat "$TEST_ROOT/registry.good" >"$registry_path"

# ============================================================================
# recovery: usage refusals never create state
# ============================================================================
run_cli recovery
assert_usage_refused 'recovery without an action'
assert_contains "$cli_err" 'recovery requires one of: create, verify, expire' 'recovery without an action names the actions'

run_cli recovery bogus --lane daily-driver
assert_usage_refused 'recovery with an unknown action'

run_cli recovery create --lane daily-driver --deletion-owner owner
assert_usage_refused 'recovery create without --retention-days'

run_cli recovery create --lane daily-driver --retention-days 7
assert_usage_refused 'recovery create without --deletion-owner'

run_cli recovery create --lane daily-driver --retention-days 0 --deletion-owner owner
assert_usage_refused 'recovery create with --retention-days 0'
assert_contains "$cli_err" '--retention-days must be 1 through 30' 'retention refusal states the accepted range'

run_cli recovery create --lane daily-driver --retention-days 31 --deletion-owner owner
assert_usage_refused 'recovery create with --retention-days 31'

run_cli recovery create --lane daily-driver --retention-days 7 --deletion-owner 'bad owner'
assert_usage_refused 'recovery create with an unsafe --deletion-owner'
assert_contains "$cli_err" '--deletion-owner must be a safe owner label' 'owner refusal names the constraint'

run_cli recovery verify --lane daily-driver
assert_usage_refused 'recovery verify without --snapshot'

run_cli recovery verify --lane daily-driver --snapshot ../evil
assert_usage_refused 'recovery verify with a traversal snapshot id'
assert_contains "$cli_err" 'invalid_snapshot_id' 'traversal snapshot refusal is typed'

run_cli recovery create --lane daily-driver --retention-days 7 --deletion-owner owner --account-role owner
assert_usage_refused 'recovery create with a foreign --account-role'

run_cli list --snapshot x
assert_usage_refused 'list with a recovery flag'

run_cli recovery expire --lane daily-driver --snapshot placeholder
assert_usage_refused 'recovery expire without --execute'
assert_contains "$cli_err" 'recovery expire requires --execute' 'expire refusal names the missing flag'

# ============================================================================
# recovery: lane gating
# ============================================================================
run_cli recovery create --lane nope --retention-days 7 --deletion-owner owner --json
assert_equals "$cli_status" '2' 'recovery create on an undeclared lane exits 2'
assert_contains "$cli_err" 'unknown_lane' 'undeclared lane refusal is typed'
assert_equals "$cli_out" '' 'undeclared lane refusal prints nothing on stdout'
assert_absent "$recovery_root_dir" 'undeclared lane refusal creates no recovery state'

run_cli recovery create --lane specialist --retention-days 7 --deletion-owner owner --json
assert_equals "$cli_status" '10' 'recovery create on an unprovisioned lane exits 10'
assert_contains "$cli_err" 'lane_not_provisioned' 'unprovisioned lane refusal is typed'
assert_equals "$cli_out" '' 'unprovisioned lane refusal prints nothing on stdout'
assert_absent "$recovery_root_dir" 'unprovisioned lane refusal creates no recovery state'

mkdir "$lease_dir"
run_cli recovery create --lane daily-driver --retention-days 7 --deletion-owner owner --json
assert_equals "$cli_status" '13' 'recovery create on a leased lane exits 13'
assert_contains "$cli_err" 'lane_busy' 'leased lane create refusal is typed'
assert_absent "$recovery_root_dir" 'leased lane create refusal creates no recovery state'
run_cli recovery expire --lane daily-driver --snapshot placeholder --execute --json
assert_equals "$cli_status" '13' 'recovery expire on a leased lane exits 13'
assert_contains "$cli_err" 'lane_busy' 'leased lane expire refusal is typed'
rmdir "$lease_dir"

# ============================================================================
# recovery: create A (json) and its on-disk shape
# ============================================================================
epoch_before="$(date +%s)"
run_cli recovery create --lane daily-driver --retention-days 7 --deletion-owner owner --json
epoch_after="$(date +%s)"
assert_equals "$cli_status" '0' 'recovery create exits zero'
assert_equals "$cli_err" '' 'recovery create keeps stderr empty on success'
assert_equals "$(jq -r '.status' <<<"$cli_out")" 'ok' 'recovery create emits a success envelope'
assert_equals "$(jq -r '.data.authentication_state_included' <<<"$cli_out")" 'false' 'recovery create declares no authentication state'
snapshot_a="$(jq -r '.data.snapshot_id' <<<"$cli_out")"
assert_matches "$snapshot_a" '^[0-9]{8}T[0-9]{6}Z-[0-9]+$' 'recovery create returns a timestamped snapshot id'
envelope_a_expires="$(jq -r '.data.expires_at_epoch' <<<"$cli_out")"
snapshot_a_dir="$recovery_lane_dir/$snapshot_a"
manifest_a="$snapshot_a_dir/manifest.json"
blueprint_a="$snapshot_a_dir/blueprint.json"

assert_equals "$(mode_of "$recovery_root_dir")" '700' 'recovery root is private'
assert_equals "$(mode_of "$recovery_lane_dir")" '700' 'recovery lane directory is private'
assert_equals "$(mode_of "$snapshot_a_dir")" '700' 'snapshot directory is private'
assert_equals "$(mode_of "$blueprint_a")" '600' 'blueprint file is private'
assert_equals "$(mode_of "$manifest_a")" '600' 'manifest file is private'
assert_equals "$(entry_count "$snapshot_a_dir")" '2' 'snapshot directory holds exactly two entries'

# --- retention metadata, read from the manifest rather than the envelope ---
assert_equals "$(jq -r '.retention_days' "$manifest_a")" '7' 'manifest records the requested retention'
assert_equals "$(jq -r '.deletion_owner' "$manifest_a")" 'owner' 'manifest records the deletion owner'
assert_equals "$(jq -r '.expires_at_epoch - .created_at_epoch' "$manifest_a")" '604800' 'manifest expiry is seven days after creation'
manifest_a_created="$(jq -r '.created_at_epoch' "$manifest_a")"
[[ "$manifest_a_created" -ge "$epoch_before" && "$manifest_a_created" -le "$epoch_after" ]] ||
  fail "manifest created_at_epoch outside the call window (got [$manifest_a_created], window [$epoch_before..$epoch_after])"
pass 'manifest created_at_epoch falls inside the call window'
assert_equals "$envelope_a_expires" "$(jq -r '.expires_at_epoch' "$manifest_a")" 'envelope expiry equals the manifest expiry'
manifest_a_sha="$(jq -r '.blueprint_sha256' "$manifest_a")"
assert_matches "$manifest_a_sha" '^[0-9a-f]{64}$' 'manifest records a SHA-256 digest'
assert_equals "$manifest_a_sha" "$(sha256_of "$blueprint_a")" 'manifest digest matches an independent shasum of the blueprint'
assert_equals "$(jq -r '.authentication_state_included' "$manifest_a")" 'false' 'manifest declares no authentication state'
assert_equals "$(jq -r '.schema_version' "$manifest_a")" '1' 'manifest carries schema version 1'

# --- no authentication state is copied ---
for sentinel in "${auth_sentinels[@]}"; do
  grep -rq "$sentinel" "$profile_dir" || fail "sentinel oracle cannot see [$sentinel] in the fixture profile"
  if grep -rq "$sentinel" "$snapshot_a_dir"; then
    fail "snapshot leaked sentinel [$sentinel]"
  fi
  pass "snapshot holds no [$sentinel]"
done
assert_equals "$(jq -c 'keys' "$blueprint_a")" '["authentication_state_included","baseline","lane","observed","profile","relay","schema_version"]' 'blueprint exposes only the declared top-level keys'
assert_equals "$(jq -c '.observed.sync == {"account_shape":"exactly-one","selected_types":{"sync.autofill":false,"sync.extensions":false,"sync.passwords":false,"sync.payments":false}}' "$blueprint_a")" 'true' 'blueprint observed sync records the account shape and exactly the four expectation keys'
assert_equals "$(jq -c '.observed.required_extensions == [{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","present":true},{"id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","present":true}]' "$blueprint_a")" 'true' 'blueprint observed extensions record presence only'
assert_equals "$(find "$recovery_root_dir" -name 'Cookies' | wc -l | tr -d ' ')" '0' 'no Cookies file exists under the recovery root'
assert_equals "$(find "$recovery_root_dir" -name 'Login Data' | wc -l | tr -d ' ')" '0' 'no Login Data file exists under the recovery root'
assert_equals "$(find "$recovery_root_dir" -name 'Web Data' | wc -l | tr -d ' ')" '0' 'no Web Data file exists under the recovery root'

# ============================================================================
# recovery: create B (text) and verify both
# ============================================================================
run_cli recovery create --lane daily-driver --retention-days 7 --deletion-owner owner
assert_equals "$cli_status" '0' 'text-mode recovery create exits zero'
assert_equals "$cli_err" '' 'text-mode recovery create keeps stderr empty'
[[ "$cli_out" == lane=daily-driver\ snapshot=*\ expires_at_epoch=*\ deletion_owner=owner\ authentication_state_included=false ]] ||
  fail "text-mode create output has the wrong shape (got [$cli_out])"
pass 'text-mode recovery create prints the documented line'
snapshot_b="$(sed -n 's/^lane=daily-driver snapshot=\([^ ]*\) .*$/\1/p' <<<"$cli_out")"
assert_matches "$snapshot_b" '^[0-9]{8}T[0-9]{6}Z-[0-9]+$' 'text-mode create returns a timestamped snapshot id'
[[ "$snapshot_b" != "$snapshot_a" ]] || fail 'two creates produced the same snapshot id'
pass 'consecutive creates produce distinct snapshot ids'
snapshot_b_dir="$recovery_lane_dir/$snapshot_b"
manifest_b="$snapshot_b_dir/manifest.json"

run_cli recovery verify --lane daily-driver --snapshot "$snapshot_a" --json
assert_equals "$cli_status" '0' 'verify of a fresh snapshot exits zero'
assert_equals "$cli_err" '' 'verify keeps stderr empty on success'
assert_equals "$(jq -r '.data.state' <<<"$cli_out")" 'active' 'verify reports the snapshot active'
assert_equals "$(jq -r '.data.integrity' <<<"$cli_out")" 'pass' 'verify reports integrity pass'
assert_equals "$(jq -r '.data.expires_at_epoch' <<<"$cli_out")" "$(jq -r '.expires_at_epoch' "$manifest_a")" 'verify envelope expiry equals the manifest expiry'

run_cli recovery verify --lane daily-driver --snapshot "$snapshot_b"
assert_equals "$cli_status" '0' 'text-mode verify exits zero'
assert_contains "$cli_out" 'state=active integrity=pass' 'text-mode verify prints state and integrity'

# ============================================================================
# recovery: integrity and permission drift
# ============================================================================
printf ' ' >>"$blueprint_a"
[[ "$(mode_of "$blueprint_a")" == '600' ]] || fail 'tamper fixture changed the blueprint mode'
run_cli recovery verify --lane daily-driver --snapshot "$snapshot_a" --json
assert_equals "$cli_status" '15' 'a tampered blueprint fails verify with 15'
assert_contains "$cli_err" 'recovery_integrity_mismatch' 'tamper refusal is typed'
assert_equals "$cli_out" '' 'tamper refusal prints nothing on stdout'

chmod 755 "$snapshot_b_dir"
run_cli recovery verify --lane daily-driver --snapshot "$snapshot_b" --json
assert_equals "$cli_status" '15' 'an over-readable snapshot directory fails verify with 15'
assert_contains "$cli_err" 'recovery_snapshot_permissions' 'directory permission refusal is typed'
assert_equals "$cli_out" '' 'directory permission refusal prints nothing on stdout'
chmod 700 "$snapshot_b_dir"

chmod 644 "$manifest_b"
run_cli recovery verify --lane daily-driver --snapshot "$snapshot_b" --json
assert_equals "$cli_status" '15' 'an over-readable manifest fails verify with 15'
assert_contains "$cli_err" 'recovery_snapshot_permissions' 'file permission refusal is typed'
assert_equals "$cli_out" '' 'file permission refusal prints nothing on stdout'
chmod 600 "$manifest_b"

printf 'stray\n' >"$snapshot_b_dir/extra"
run_cli recovery verify --lane daily-driver --snapshot "$snapshot_b" --json
assert_equals "$cli_status" '15' 'an unexpected snapshot entry fails verify with 15'
assert_contains "$cli_err" 'recovery_snapshot_unexpected_entry' 'unexpected entry refusal is typed'
assert_equals "$cli_out" '' 'unexpected entry refusal prints nothing on stdout'
rm "$snapshot_b_dir/extra"

# ============================================================================
# recovery: expiry is exact-target and refuses invalid snapshots
# ============================================================================
run_cli recovery expire --lane daily-driver --snapshot "$snapshot_b" --execute --json
assert_equals "$cli_status" '15' 'expire before expiry exits 15'
assert_contains "$cli_err" 'recovery_not_expired' 'premature expire refusal is typed'
assert_equals "$cli_out" '' 'premature expire refusal prints nothing on stdout'
assert_present "$snapshot_b_dir" 'premature expire leaves the snapshot in place'

# Force expiry by rewriting the manifest in place so its mode survives.
jq '.expires_at_epoch = 1' "$manifest_b" >"$TEST_ROOT/manifest-b.expired"
cat "$TEST_ROOT/manifest-b.expired" >"$manifest_b"
assert_equals "$(mode_of "$manifest_b")" '600' 'forced-expiry rewrite preserves manifest mode'

run_cli recovery verify --lane daily-driver --snapshot "$snapshot_b" --json
assert_equals "$cli_status" '15' 'verify of an expired snapshot exits 15'
assert_equals "$(jq -r '.status' <<<"$cli_out")" 'error' 'verify of an expired snapshot emits an error envelope'
assert_equals "$(jq -r '.data.state' <<<"$cli_out")" 'expired' 'verify of an expired snapshot reports state expired'

run_cli recovery create --lane daily-driver --retention-days 7 --deletion-owner owner --json
assert_equals "$cli_status" '0' 'a third snapshot can be created alongside the others'
snapshot_c="$(jq -r '.data.snapshot_id' <<<"$cli_out")"
snapshot_c_dir="$recovery_lane_dir/$snapshot_c"

run_cli recovery expire --lane daily-driver --snapshot "$snapshot_b" --execute --json
assert_equals "$cli_status" '0' 'expire of an expired verified snapshot exits zero'
assert_equals "$cli_err" '' 'successful expire keeps stderr empty'
assert_equals "$(jq -r '.data.state' <<<"$cli_out")" 'expired_and_removed' 'successful expire reports removal'
assert_absent "$snapshot_b_dir" 'expire removes the exact snapshot directory'
assert_present "$snapshot_a_dir" 'expire leaves the tampered sibling snapshot in place'
assert_equals "$(entry_count "$snapshot_a_dir")" '2' 'expire leaves both files of the tampered sibling'
assert_present "$snapshot_c_dir" 'expire leaves the fresh sibling snapshot in place'
assert_equals "$(entry_count "$snapshot_c_dir")" '2' 'expire leaves both files of the fresh sibling'
assert_present "$recovery_lane_dir" 'expire keeps the lane directory while siblings remain'

run_cli recovery expire --lane daily-driver --snapshot "$snapshot_b" --execute --json
assert_equals "$cli_status" '15' 'expire of a removed snapshot exits 15'
assert_contains "$cli_err" 'recovery_snapshot_missing' 'missing snapshot refusal is typed'

jq '.expires_at_epoch = 1' "$manifest_a" >"$TEST_ROOT/manifest-a.expired"
cat "$TEST_ROOT/manifest-a.expired" >"$manifest_a"
run_cli recovery expire --lane daily-driver --snapshot "$snapshot_a" --execute --json
assert_equals "$cli_status" '15' 'expire of an expired but tampered snapshot exits 15'
assert_contains "$cli_err" 'recovery_integrity_mismatch' 'destructive step refuses an invalid snapshot'
assert_present "$blueprint_a" 'refused expire leaves the tampered blueprint in place'
assert_present "$manifest_a" 'refused expire leaves the tampered manifest in place'

# ============================================================================
# recovery: baseline read failures leave no partial state
# ============================================================================
cp "$profile_dir/Preferences" "$TEST_ROOT/preferences.good"
jq 'del(.sync)' "$TEST_ROOT/preferences.good" >"$profile_dir/Preferences"
run_cli recovery create --lane daily-driver --retention-days 7 --deletion-owner owner --json
assert_equals "$cli_status" '15' 'create without a sync block exits 15'
assert_contains "$cli_err" 'recovery_sync_shape_drift' 'missing sync block refusal is typed'
assert_equals "$cli_out" '' 'missing sync block refusal prints nothing on stdout'
assert_equals "$(find "$recovery_lane_dir" -name '*.tmp' | wc -l | tr -d ' ')" '0' 'missing sync block leaves no temporary snapshot'
assert_equals "$(entry_count "$recovery_lane_dir")" '2' 'missing sync block leaves the snapshot count unchanged'
cat "$TEST_ROOT/preferences.good" >"$profile_dir/Preferences"

mv "$profile_dir/Secure Preferences" "$TEST_ROOT/secure-preferences.good"
run_cli recovery create --lane daily-driver --retention-days 7 --deletion-owner owner --json
assert_equals "$cli_status" '15' 'create without Secure Preferences exits 15'
assert_contains "$cli_err" 'recovery_baseline_unreadable' 'missing Secure Preferences refusal is typed'
assert_equals "$cli_out" '' 'missing Secure Preferences refusal prints nothing on stdout'
assert_equals "$(find "$recovery_lane_dir" -name '*.tmp' | wc -l | tr -d ' ')" '0' 'missing Secure Preferences leaves no temporary snapshot'
mv "$TEST_ROOT/secure-preferences.good" "$profile_dir/Secure Preferences"

printf '{not json\n' >"$profile_dir/Preferences"
run_cli recovery create --lane daily-driver --retention-days 7 --deletion-owner owner --json
assert_equals "$cli_status" '15' 'create with invalid Preferences JSON exits 15'
assert_contains "$cli_err" 'recovery_baseline_unreadable' 'invalid Preferences refusal is typed'
assert_equals "$cli_out" '' 'invalid Preferences refusal prints nothing on stdout'
assert_equals "$(entry_count "$recovery_lane_dir")" '2' 'invalid Preferences leaves the snapshot count unchanged'
cat "$TEST_ROOT/preferences.good" >"$profile_dir/Preferences"

[[ "$assertion_count" -eq "$EXPECTED_ASSERTIONS" ]] ||
  fail "assertion count drifted (expected $EXPECTED_ASSERTIONS, got $assertion_count)"
printf '1..%d\n' "$EXPECTED_ASSERTIONS"
