#!/usr/bin/env bash
# Public process contract for verified Mise toolchain revisions.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CLI="$REPO_ROOT/bin/dotfiles/toolchain"
TEST_ROOT="$(mktemp -d)"
FIXTURE_REPO="$TEST_ROOT/repo"
HOME_ROOT="$TEST_ROOT/home"
BIN="$TEST_ROOT/bin"
LEDGER="$TEST_ROOT/mise-ledger"
MISE_ENV_LEDGER="$TEST_ROOT/mise-env-ledger"
MISE_CONTEXT_LEDGER="$TEST_ROOT/mise-context-ledger"
MISE_PYTHON_ATTESTATION_LEDGER="$TEST_ROOT/mise-python-attestation-ledger"
ORACLE="$TEST_ROOT/oracle.tsv"
LOCK_ORACLE="$TEST_ROOT/lock.oracle"
LOCK_PRE_ORACLE="$TEST_ROOT/lock.pre.oracle"
LOCK_ENRICHED_ORACLE="$TEST_ROOT/lock.enriched.oracle"
LOCK_OUTPUT_LEDGER="$TEST_ROOT/lock-output-ledger"
CONTRACT_ORACLE="$TEST_ROOT/contract.oracle"
assertion_count=0

cleanup() { chmod -R u+w "$TEST_ROOT" 2>/dev/null || true; rm -rf "$TEST_ROOT"; }
trap cleanup EXIT
pass() { assertion_count=$((assertion_count + 1)); printf 'ok %d - %s\n' "$assertion_count" "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
assert_equals() { [[ "$1" == "$2" ]] || fail "$3 (expected [$1], got [$2])"; pass "$3"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3 (expected [$2] in [$1])"; pass "$3"; }
assert_file() { [[ -r "$1" ]] || fail "$2"; pass "$2"; }
assert_not_exists() { [[ ! -e "$1" && ! -L "$1" ]] || fail "$2"; pass "$2"; }
assert_process_gone() {
 local pid="$1" label="$2" state=''
 for _ in $(seq 1 100); do
  if ! kill -0 "$pid" 2>/dev/null; then pass "$label"; return; fi
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ "$state" == Z* ]] && { pass "$label"; return; }
  sleep 0.02
 done
 fail "$label (pid $pid remains live with state $state)"
}
assert_process_group_gone() {
 local pgid="$1" label="$2"
 for _ in $(seq 1 100); do
  if ! kill -0 -- "-$pgid" 2>/dev/null; then pass "$label"; return; fi
  sleep 0.02
 done
 fail "$label (process group $pgid remains live)"
}

# Independent oracle: these literals are not read from the source declaration.
cat >"$ORACLE" <<'EOF'
node|24.20.0|24.20.1|24.20.2|24.20.3|24.20.4|24.20.5|24.20.6
bun|1.4.0|1.4.0|1.4.0|1.4.0|1.4.0|1.4.0|1.4.0
python|3.11.9|3.11.9|3.11.9|3.11.9|3.11.9|3.11.9|3.11.9
npm|11.19.0|11.19.0|11.19.0|11.19.0|11.19.0|11.19.0|11.19.0
EOF
printf '%s\n' '# locked fixture' '# installed baseline platform' >"$LOCK_ORACLE"
printf '# locked fixture\n' >"$LOCK_PRE_ORACLE"
printf '%s\n' '# locked fixture' '# installed baseline platform' '# installed extra platform alias' >"$LOCK_ENRICHED_ORACLE"
printf 'mise-revision-v1\n' >"$CONTRACT_ORACLE"

mkdir -p "$HOME_ROOT" "$BIN"
mkdir -p "$FIXTURE_REPO/bin/dotfiles" "$FIXTURE_REPO/config/toolchain" "$FIXTURE_REPO/config/mise"
cp "$CLI" "$FIXTURE_REPO/bin/dotfiles/toolchain"
cp "$REPO_ROOT/config/toolchain/versions.tsv" "$FIXTURE_REPO/config/toolchain/versions.tsv"
cp "$REPO_ROOT/config/mise/source.toml" "$FIXTURE_REPO/config/mise/source.toml"
chmod +x "$FIXTURE_REPO/bin/dotfiles/toolchain"
CLI="$FIXTURE_REPO/bin/dotfiles/toolchain"
cat >"$BIN/mise" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

python_attestation_policy_is_not_persisted() {
  [[ -n "${MISE_GLOBAL_CONFIG_FILE:-}" ]] || return 1
  ! awk '
    /^\[settings\][[:space:]]*$/ { in_settings=1; next }
    /^\[/ { in_settings=0 }
    in_settings && $0 ~ /^[[:space:]]*python\.github_attestations[[:space:]]*=[[:space:]]*false([[:space:]]*#.*)?$/ { found=1 }
    END { exit !found }
  ' "$MISE_GLOBAL_CONFIG_FILE"
}

printf '%s\n' "$*" >>"$TOOLCHAIN_MISE_LEDGER"
printf '%s|%s|%s\n' "${MISE_DATA_DIR:-unset}" "${MISE_INSTALLS_DIR:-unset}" "${MISE_SHIMS_DIR:-unset}" >>"$TOOLCHAIN_MISE_ENV_LEDGER"
printf '%s|%s\n' "${MISE_PYTHON_GITHUB_ATTESTATIONS:-unset}" "$*" >>"$TOOLCHAIN_MISE_PYTHON_ATTESTATION_LEDGER"
if [[ -n "${MISE_GLOBAL_CONFIG_FILE:-}" ]]; then
  printf '%s|%s|%s|%s|%s\n' "$PWD" "${MISE_CEILING_PATHS:-unset}" "$MISE_GLOBAL_CONFIG_FILE" "${MISE_NODE_VERSION-unset},${MISE_BUN_VERSION-unset},${MISE_PYTHON_VERSION-unset},${MISE_NPM_VERSION-unset},${MISE_CONFIG_FILE-unset},${MISE_CONFIG_DIR-unset},${MISE_DEFAULT_CONFIG_FILENAME-unset}" "$*" >>"$TOOLCHAIN_MISE_CONTEXT_LEDGER"
  if [[ "$PWD" == "$TOOLCHAIN_ADVERSARIAL_PROJECT" ]]; then
    : >"$TOOLCHAIN_PROJECT_SIDE_EFFECT"
  fi
  if [[ -r "$PWD/mise.toml" ]]; then
    : >"$TOOLCHAIN_STATE_SIDE_EFFECT"
    exit 96
  fi
  [[ "$PWD" == "$TOOLCHAIN_EXPECTED_STATE/.mise-operation-"* ]] || exit 96
  [[ "${MISE_CEILING_PATHS:-}" == "$PWD" ]] || exit 96
  [[ "$MISE_GLOBAL_CONFIG_FILE" == "$TOOLCHAIN_EXPECTED_STATE/revisions/"*"/config.toml" ]] || exit 96
  [[ "${MISE_NODE_VERSION+x}${MISE_BUN_VERSION+x}${MISE_PYTHON_VERSION+x}${MISE_NPM_VERSION+x}${MISE_CONFIG_FILE+x}${MISE_CONFIG_DIR+x}${MISE_DEFAULT_CONFIG_FILENAME+x}" == '' ]] || exit 96
  python_attestation_policy_is_not_persisted || exit 71
fi
case "$1" in
 lock)
  [[ "$2" == --global && -n "${MISE_GLOBAL_CONFIG_FILE:-}" ]] || exit 97
  [[ "${MISE_TEST_NOISY:-false}" != true ]] || printf 'fixture lock progress\n'
  if [[ -n "${MISE_TEST_REPLACEMENT_CONFIG:-}" ]]; then
    cp "$MISE_TEST_REPLACEMENT_CONFIG" "$MISE_TEST_CANONICAL_CONFIG"
    cp "$MISE_TEST_REPLACEMENT_MANIFEST" "$MISE_TEST_CANONICAL_MANIFEST"
  fi
  lock_file="$(dirname "$MISE_GLOBAL_CONFIG_FILE")/mise.lock"
  if [[ ! -e "$lock_file" && ! -L "$lock_file" ]]; then
    if [[ -n "${MISE_TEST_LOCK_MUTATION_MARKER:-}" && -e "$MISE_TEST_LOCK_MUTATION_MARKER" ]]; then
      printf '%s\n' '# locked fixture' '# installed baseline platform' >"$lock_file"
    else
      printf '# locked fixture\n' >"$lock_file"
    fi
  fi
  if [[ -n "${MISE_TEST_LOCK_OUTPUT_LEDGER:-}" ]]; then
    shasum -a 256 "$lock_file" | awk '{print $1}' >>"$MISE_TEST_LOCK_OUTPUT_LEDGER"
  fi
  ;;
 install)
  [[ "${MISE_TEST_NOISY:-false}" != true ]] || printf 'fixture install progress\n'
  [[ "${MISE_TEST_FAIL_INSTALL:-false}" != true ]] || exit 70
  if [[ -n "${MISE_TEST_GRANDCHILD_PID_FILE:-}" ]]; then
    (while :; do sleep 0.05; done) &
    printf '%s\n' "$!" >"$MISE_TEST_GRANDCHILD_PID_FILE"
  fi
  [[ -z "${MISE_TEST_BLOCK_FILE:-}" ]] || { : >"$MISE_TEST_BLOCK_FILE"; while [[ ! -e "${MISE_TEST_RELEASE_FILE:-}" ]]; do sleep 0.05; done; }
  if [[ "${MISE_TEST_MUTATE_LOCK_ON_INSTALL:-false}" == true ]]; then
    lock_file="$(dirname "$MISE_GLOBAL_CONFIG_FILE")/mise.lock"
    if [[ -n "${MISE_TEST_LOCK_MUTATION_MARKER:-}" && ! -e "$MISE_TEST_LOCK_MUTATION_MARKER" ]]; then
      printf '# installed baseline platform\n' >>"$lock_file"
      printf '# installed extra platform alias\n' >>"$lock_file"
      if [[ -n "${MISE_TEST_LOCK_OUTPUT_LEDGER:-}" ]]; then
        shasum -a 256 "$lock_file" | awk '{print $1}' >>"$MISE_TEST_LOCK_OUTPUT_LEDGER"
      fi
      : >"$MISE_TEST_LOCK_MUTATION_MARKER"
    fi
  fi
  ;;
 which)
  case "$2" in node|bun|python) printf '%s/%s\n' "$TOOLCHAIN_FAKE_RUNTIME" "$2" ;; *) exit 97;; esac
  ;;
 exec)
  tool="$3"; column="${MISE_TEST_ORACLE_COLUMN:-2}"
  version="$(awk -F '|' -v tool="$tool" -v column="$column" '$1 == tool { print $column; exit }' "$TOOLCHAIN_ORACLE")"
  if [[ "$tool" == node && "${MISE_TEST_VERIFY_FAILURE_MODE:-}" == once && ! -e "${MISE_TEST_VERIFY_FAILURE_MARKER:-}" ]]; then
    : >"$MISE_TEST_VERIFY_FAILURE_MARKER"
    version='0.0.0'
  elif [[ "$tool" == node && "${MISE_TEST_VERIFY_FAILURE_MODE:-}" == always ]]; then
    version='0.0.0'
  fi
  case "$tool" in node) printf 'v%s\n' "$version";; bun) printf '%s\n' "$version";; python) printf 'Python %s\n' "$version";; *) exit 97;; esac
  ;;
 *) exit 97;;
esac
EOF
chmod +x "$BIN/mise"
cat >"$BIN/ln" <<'EOF'
#!/usr/bin/env bash
last=''
for arg in "$@"; do last="$arg"; done
if [[ "${MISE_TEST_CURRENT_LINK_RACE:-false}" == true && "$last" == */.current-* ]]; then
  /bin/ln -s foreign-selection "$last"
  printf '%s\n' "$last" >"$MISE_TEST_CURRENT_PATH_FILE"
  exit 1
fi
if [[ "${MISE_TEST_CURRENT_LINK_SIGNAL:-false}" == true && "$last" == */.current-* ]]; then
  /bin/ln "$@"
  printf '%s\n' "$last" >"$MISE_TEST_CURRENT_PATH_FILE"
  kill -TERM "$PPID"
  exit 0
fi
if [[ "${MISE_TEST_TAKEOVER_CLAIM_KILL:-false}" == true && "$last" == */takeover-* ]]; then
  /bin/ln "$@"
  printf '%s\n' "$last" >"$MISE_TEST_TAKEOVER_CLAIM_PATH_FILE"
  kill -KILL "$PPID"
  exit 0
fi
if [[ "${MISE_TEST_FAIL_LOCK_LINK:-false}" == true && "$last" == */run-lock ]]; then exit 73; fi
if [[ "${MISE_TEST_BLOCK_LOCK_LINK:-false}" == true && "$last" == */run-lock ]]; then
  /bin/ln "$@"
  : >"$MISE_TEST_LOCK_LINK_BLOCK_FILE"
  while [[ ! -e "$MISE_TEST_LOCK_LINK_RELEASE_FILE" ]]; do sleep 0.02; done
  exit 0
fi
exec /bin/ln "$@"
EOF
chmod +x "$BIN/ln"
cat >"$BIN/ps" <<'EOF'
#!/usr/bin/env bash
if [[ "${MISE_TEST_BLOCK_PGID_DISCOVERY:-false}" == true && "$*" == '-o pgid= -p '* ]]; then
  for target_pid in "$@"; do :; done
  printf '%s\n' "$target_pid" >"$MISE_TEST_PGID_PID_FILE"
  : >"$MISE_TEST_PGID_BLOCK_FILE"
  while [[ ! -e "$MISE_TEST_PGID_RELEASE_FILE" ]]; do sleep 0.02; done
fi
if [[ "${MISE_TEST_FAIL_PGID_DISCOVERY:-false}" == true && "$*" == '-o pgid= -p '* ]]; then
  exit 1
fi
exec /bin/ps "$@"
EOF
chmod +x "$BIN/ps"
cat >"$BIN/mkdir" <<'EOF'
#!/usr/bin/env bash
last=''
for arg in "$@"; do last="$arg"; done
if [[ "${MISE_TEST_MKDIR_SIGNAL_TARGET:-}" == capsule && "$last" == */.mise-operation-* ]] ||
   [[ "${MISE_TEST_MKDIR_SIGNAL_TARGET:-}" == staging && "$last" == */revisions/.staging-* ]]; then
  /bin/mkdir -m 0700 "$last"
  printf '%s\n' "$last" >"$MISE_TEST_MKDIR_PATH_FILE"
  kill -TERM "$PPID"
  exit 0
fi
if { [[ "${MISE_TEST_CAPSULE_MKDIR_RACE:-false}" == true && "$last" == */.mise-operation-* ]] ||
     [[ "${MISE_TEST_STAGING_MKDIR_RACE:-false}" == true && "$last" == */revisions/.staging-* ]]; }; then
  /bin/mkdir -m 0700 "$last"
  printf '%s\n' "$last" >"$MISE_TEST_MKDIR_PATH_FILE"
  printf '%s\n' 'other-owner-bytes' >"$last/other-owner"
  exit 1
fi
exec /bin/mkdir "$@"
EOF
chmod +x "$BIN/mkdir"
cat >"$BIN/rm" <<'EOF'
#!/usr/bin/env bash
last=''
for arg in "$@"; do last="$arg"; done
if [[ "${MISE_TEST_FAIL_LOCK_REMOVAL:-false}" == true && "$last" == */mise.lock ]]; then
  exit 73
fi
if [[ "${MISE_TEST_CLAIM_RECORD_RM_KILL:-false}" == true && "$last" == */lock-records/* ]]; then
  /bin/rm "$@"
  printf '%s\n' "$last" >"$MISE_TEST_CLAIM_RECORD_RM_PATH_FILE"
  kill -KILL "$PPID"
  exit 0
fi
if [[ "${MISE_TEST_STALE_LOCK_RM_KILL:-false}" == true && "$last" == */run-lock ]]; then
  /bin/rm "$@"
  printf '%s\n' "$last" >"$MISE_TEST_STALE_LOCK_RM_PATH_FILE"
  kill -KILL "$PPID"
  exit 0
fi
if [[ "${MISE_TEST_STALE_LOCK_RM_BLOCK:-false}" == true && "$last" == */run-lock ]]; then
  /bin/rm "$@"
  printf '%s\n' "$last" >"$MISE_TEST_STALE_LOCK_RM_PATH_FILE"
  while [[ ! -e "$MISE_TEST_STALE_LOCK_RM_RELEASE_FILE" ]]; do sleep 0.02; done
  exit 0
fi
if [[ "${MISE_TEST_STALE_LOCK_RM_SIGNAL:-false}" == true && "$last" == */run-lock ]]; then
  /bin/rm "$@"
  printf '%s\n' "$last" >"$MISE_TEST_STALE_LOCK_RM_PATH_FILE"
  kill -TERM "$PPID"
  exit 0
fi
exec /bin/rm "$@"
EOF
chmod +x "$BIN/rm"
mkdir -p "$TEST_ROOT/runtime"
cat >"$TEST_ROOT/runtime/npm" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == '--version' ]] || exit 97
awk -F '|' '$1 == "npm" { print $2; exit }' "$TOOLCHAIN_ORACLE"
EOF
chmod +x "$TEST_ROOT/runtime/npm"
CANONICAL_MISE_DATA="$(CDPATH='' cd -P "$HOME_ROOT" && pwd)/.local/share/mise"
CANONICAL_MISE_CUSTODY="$CANONICAL_MISE_DATA|$CANONICAL_MISE_DATA/installs|$CANONICAL_MISE_DATA/shims"
export TOOLCHAIN_MISE_LEDGER="$LEDGER" TOOLCHAIN_MISE_ENV_LEDGER="$MISE_ENV_LEDGER"
export TOOLCHAIN_MISE_CONTEXT_LEDGER="$MISE_CONTEXT_LEDGER"
export TOOLCHAIN_MISE_PYTHON_ATTESTATION_LEDGER="$MISE_PYTHON_ATTESTATION_LEDGER"
export TOOLCHAIN_FAKE_RUNTIME="$TEST_ROOT/runtime" TOOLCHAIN_ORACLE="$ORACLE"
export MISE_TEST_LOCK_OUTPUT_LEDGER="$LOCK_OUTPUT_LEDGER"
export MISE_DATA_DIR="$TEST_ROOT/hostile-mise-data"
export MISE_INSTALLS_DIR="$TEST_ROOT/hostile-mise-installs"
export MISE_SHIMS_DIR="$TEST_ROOT/hostile-mise-shims"
TOOLCHAIN_EXPECTED_STATE="${CANONICAL_MISE_DATA%/.local/share/mise}/.dotfiles_state/toolchain"
TOOLCHAIN_ADVERSARIAL_PROJECT="$TEST_ROOT/adversarial-project"
TOOLCHAIN_PROJECT_SIDE_EFFECT="$TEST_ROOT/project-config-ran"
TOOLCHAIN_STATE_SIDE_EFFECT="$TEST_ROOT/state-config-ran"
export TOOLCHAIN_EXPECTED_STATE TOOLCHAIN_ADVERSARIAL_PROJECT TOOLCHAIN_PROJECT_SIDE_EFFECT TOOLCHAIN_STATE_SIDE_EFFECT
mkdir -p "$TOOLCHAIN_ADVERSARIAL_PROJECT"
printf '%s\n' '[tools]' 'node = "0.0.1"' 'bun = "0.0.2"' 'python = "0.0.3"' \
  '[hooks]' 'enter = "touch project-config-ran"' >"$TOOLCHAIN_ADVERSARIAL_PROJECT/mise.toml"

verification_failure_marker="$TEST_ROOT/verification-failure.marker"
lock_mutation_marker="$TEST_ROOT/lock-mutation.marker"
export MISE_TEST_LOCK_MUTATION_MARKER="$lock_mutation_marker"

fixture_content_id() {
 local manifest="$1" config="$2" name file digest
 for name in contract.txt manifest.tsv config.toml mise.lock; do
  case "$name" in
   contract.txt) file="$CONTRACT_ORACLE" ;;
   manifest.tsv) file="$manifest" ;;
   config.toml) file="$config" ;;
   mise.lock) file="$LOCK_ORACLE" ;;
  esac
  digest="$(shasum -a 256 "$file" | awk '{print $1}')"
  printf '%s_sha256=%s\n' "$name" "$digest"
 done | shasum -a 256 | awk '{print $1}'
}

run_cli() {
 local out status
 set +e
 out="$(HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" "$CLI" "$@" 2>"$TEST_ROOT/stderr")"; status=$?
 set -e
 printf '%s\n%s\n' "$status" "$out"
}

run_cli_from() {
 local directory="$1" out status
 shift
 set +e
 out="$(cd "$directory" && HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" "$CLI" "$@" 2>"$TEST_ROOT/stderr")"; status=$?
 set -e
 printf '%s\n%s\n' "$status" "$out"
}

help="$($CLI --help)"
assert_equals '1' "$(grep -Fc 'toolchain update --apply [--retry] [--json]' <<<"$help")" 'help discovers explicit apply'
assert_equals '1' "$(grep -Fc 'toolchain recover --revision <content-id> [--json]' <<<"$help")" 'help discovers recovery'

: >"$LEDGER"
run_cli update --preview --json >/dev/null
assert_equals '0' "$(awk '$1 == "lock" || $1 == "install" { count++ } END { print count + 0 }' "$LEDGER")" 'preview does not call Mise lock or install'
assert_equals '0' "$(find "$HOME_ROOT" -mindepth 1 -print | wc -l | tr -d ' ')" 'preview does not create applied state'

: >"$MISE_CONTEXT_LEDGER"
mkdir -p "$TOOLCHAIN_EXPECTED_STATE"
printf '%s\n' '[tools]' 'node = "0.0.4"' '[hooks]' \
  'enter = "touch state-config-ran"' >"$TOOLCHAIN_EXPECTED_STATE/mise.toml"
export MISE_NODE_VERSION='0.0.5' MISE_BUN_VERSION='0.0.6' \
  MISE_PYTHON_VERSION='0.0.7' MISE_NPM_VERSION='0.0.8'
export MISE_CONFIG_FILE="$TOOLCHAIN_ADVERSARIAL_PROJECT/mise.toml"
export MISE_CONFIG_DIR="$TOOLCHAIN_ADVERSARIAL_PROJECT"
export MISE_DEFAULT_CONFIG_FILENAME='hostile.toml'
export MISE_PYTHON_GITHUB_ATTESTATIONS=true
export MISE_TEST_NOISY=true
export MISE_TEST_MUTATE_LOCK_ON_INSTALL=true
export MISE_TEST_VERIFY_FAILURE_MODE=once MISE_TEST_VERIFY_FAILURE_MARKER="$verification_failure_marker"
: >"$LOCK_OUTPUT_LEDGER"
first="$(run_cli_from "$TOOLCHAIN_ADVERSARIAL_PROJECT" update --apply --json)"
unset MISE_TEST_VERIFY_FAILURE_MODE MISE_TEST_VERIFY_FAILURE_MARKER
unset MISE_TEST_NOISY
first_status="$(sed -n '1p' <<<"$first")"
first_json="$(sed -n '2,$p' <<<"$first")"
[[ -n "$first_json" ]] || { cat "$TEST_ROOT/stderr" >&2; fail 'first apply returns structured JSON'; }
assert_equals '0' "$first_status" 'first apply succeeds despite unresolved Git ownership'
assert_equals 'state_write_and_tool_install' "$(jq -r '.side_effect' <<<"$first_json")" 'applied result truthfully reports state and install effects'
assert_equals '3' "$(grep -Ec '^fixture (lock|install) progress$' "$TEST_ROOT/stderr")" 'noisy Mise output stays on diagnostic stderr'
assert_equals '3' "$(awk -F '|' '$1 == "false" && ($2 == "lock --global" || $2 == "install") { count++ } END { print count + 0 }' "$MISE_PYTHON_ATTESTATION_LEDGER")" 'pinned Python lock and install calls receive the attestation exception'
assert_equals '0' "$(awk -F '|' '$2 == "lock --global" || $2 == "install" { if ($1 != "false") count++ } END { print count + 0 }' "$MISE_PYTHON_ATTESTATION_LEDGER")" 'no pinned Python lock or install call misses the attestation exception'
assert_equals '0' "$(awk -F '|' '$2 != "lock --global" && $2 != "install" && $1 != "unset" { count++ } END { print count + 0 }' "$MISE_PYTHON_ATTESTATION_LEDGER")" 'verification calls retain the default Python attestation policy'
revision="$(jq -r '.content_id' <<<"$first_json")"
assert_equals '0' "$(grep -Eq '^[0-9a-f]{64}$' <<<"$revision"; printf '%s' "$?")" 'published revision uses a lowercase SHA-256 identity'
state="$(CDPATH='' cd "$HOME_ROOT/.dotfiles_state/toolchain" && pwd -P)"
assert_file "$state/revisions/$revision/config.toml" 'apply publishes the staged config'
assert_file "$state/revisions/$revision/mise.lock" 'apply publishes a generated lock'
assert_file "$state/revisions/$revision/receipt.json" 'apply publishes a bounded receipt'
assert_file "$state/revisions/$revision/manifest.tsv" 'apply publishes the snapshotted manifest'
assert_file "$state/revisions/$revision/contract.txt" 'apply publishes the application contract'
assert_file "$lock_mutation_marker" 'first install mutates the generated lock'
expected_revision="$(fixture_content_id "$FIXTURE_REPO/config/toolchain/versions.tsv" "$FIXTURE_REPO/config/mise/source.toml")"
expected_lock_hash="$(shasum -a 256 "$LOCK_ORACLE" | awk '{print $1}')"
pre_lock_hash="$(shasum -a 256 "$LOCK_PRE_ORACLE" | awk '{print $1}')"
enriched_lock_hash="$(shasum -a 256 "$LOCK_ENRICHED_ORACLE" | awk '{print $1}')"
assert_equals "$expected_revision" "$revision" 'published content identity includes the post-install lock bytes'
assert_equals '2' "$(grep -Ec '^lock --global$' "$LEDGER")" 'first apply regenerates the lock after install'
assert_equals "$pre_lock_hash" "$(sed -n '1p' "$LOCK_OUTPUT_LEDGER")" 'first lock output is the pre-install bytes'
assert_equals "$enriched_lock_hash" "$(sed -n '2p' "$LOCK_OUTPUT_LEDGER")" 'install mutates the existing lock with extra aliases'
assert_equals "$expected_lock_hash" "$(sed -n '3p' "$LOCK_OUTPUT_LEDGER")" 'fresh post-install lock output is canonical'
assert_equals "$expected_lock_hash" "$(shasum -a 256 "$state/revisions/$revision/mise.lock" | awk '{print $1}')" 'published lock matches the independent final-lock oracle'
assert_equals "$revision" "$(jq -r '.content_id' "$state/revisions/$revision/receipt.json")" 'receipt content identity matches the published revision'
assert_equals "$expected_lock_hash" "$(jq -r '.lock_sha256' "$state/revisions/$revision/receipt.json")" 'receipt lock digest matches the published final lock'
assert_equals '555' "$(stat -f '%Lp' "$state/revisions/$revision")" 'published revision directory is read-only'
assert_equals '444' "$(stat -f '%Lp' "$state/revisions/$revision/config.toml")" 'published revision artifacts are read-only'
assert_equals "$state/revisions/$revision" "$(CDPATH='' cd "$(dirname "$state/current")/$(readlink "$state/current")" && pwd -P)" 'apply atomically selects the published revision'
assert_equals 'not_qualified' "$(jq -r '.exact_reconstruction' <<<"$first_json")" 'successful Mise subset still reports exact reconstruction unqualified'
assert_equals '1' "$(awk -v expected="$CANONICAL_MISE_CUSTODY" 'NF && $0 != expected { bad=1 } END { if (bad || NR == 0) print 0; else print 1 }' "$MISE_ENV_LEDGER")" 'apply replaces every hostile Mise directory override on every invocation'
assert_not_exists "$TOOLCHAIN_PROJECT_SIDE_EFFECT" 'project Mise config side effect does not run during apply'
assert_not_exists "$TOOLCHAIN_STATE_SIDE_EFFECT" 'state-directory Mise config side effect does not run during apply'
context_isolated="$(awk -F '|' -v state="$state" 'NF && ($1 !~ ("^" state "/\\.mise-operation-[^/]+$") || $2 != $1 || $3 !~ ("^" state "/revisions/(\\.staging-[^/]+|[0-9a-f]{64})/config.toml$") || $4 != "unset,unset,unset,unset,unset,unset,unset") { bad=1 } END { if (bad || NR == 0) print 0; else print 1 }' "$MISE_CONTEXT_LEDGER")"
[[ "$context_isolated" == 1 ]] || sed 's/^/# observed Mise context: /' "$MISE_CONTEXT_LEDGER" >&2
assert_equals '1' "$context_isolated" 'apply isolates every config-sensitive Mise process in a private capsule with selectors scrubbed'
assert_equals "$(shasum -a 256 "$FIXTURE_REPO/config/mise/source.toml" | awk '{print $1}')" "$(shasum -a 256 "$state/revisions/$revision/config.toml" | awk '{print $1}')" 'project config cannot alter the published global revision'
assert_equals '0' "$(find "$state" -maxdepth 1 -name '.mise-operation-*' -print | wc -l | tr -d ' ')" 'apply removes its private Mise process capsule'

# A later Python revision must return to Mise's default attestation policy.
# Fail installation after observing the process environment so this negative
# control cannot publish or select another revision.
cp "$FIXTURE_REPO/config/mise/source.toml" "$TEST_ROOT/source.before-future-python"
cp "$FIXTURE_REPO/config/toolchain/versions.tsv" "$TEST_ROOT/manifest.before-future-python"
sed 's/python = "3.11.9"/python = "3.12.0"/' "$TEST_ROOT/source.before-future-python" >"$FIXTURE_REPO/config/mise/source.toml"
sed 's/python|3.11.9|/python|3.12.0|/' "$TEST_ROOT/manifest.before-future-python" >"$FIXTURE_REPO/config/toolchain/versions.tsv"
: >"$MISE_PYTHON_ATTESTATION_LEDGER"
export MISE_TEST_FAIL_INSTALL=true
future_python="$(MISE_TEST_LOCK_OUTPUT_LEDGER= run_cli update --apply --json)"
unset MISE_TEST_FAIL_INSTALL
assert_equals '70' "$(sed -n '1p' <<<"$future_python")" 'future Python fixture reaches the bounded failed-install observation'
assert_equals '2' "$(awk -F '|' '$1 == "unset" && ($2 == "lock --global" || $2 == "install") { count++ } END { print count + 0 }' "$MISE_PYTHON_ATTESTATION_LEDGER")" 'future Python lock and install calls retain the default attestation policy'
assert_equals '0' "$(awk -F '|' '$2 == "lock --global" || $2 == "install" { if ($1 != "unset") count++ } END { print count + 0 }' "$MISE_PYTHON_ATTESTATION_LEDGER")" 'future Python revision does not inherit the pinned exception'
cp "$TEST_ROOT/source.before-future-python" "$FIXTURE_REPO/config/mise/source.toml"
cp "$TEST_ROOT/manifest.before-future-python" "$FIXTURE_REPO/config/toolchain/versions.tsv"

: >"$LEDGER"
second="$(run_cli_from "$TOOLCHAIN_ADVERSARIAL_PROJECT" update --apply --json)"
second_status="$(sed -n '1p' <<<"$second")"
second_json="$(sed -n '2,$p' <<<"$second")"
assert_equals '0' "$second_status" 'next apply succeeds after canonical lock regeneration'
assert_equals 'no_change' "$(jq -r '.status' <<<"$second_json")" 'next apply reuses the converged identity'
assert_equals 'state_write' "$(jq -r '.side_effect' <<<"$second_json")" 'converged apply reports snapshot and lock writes only'
assert_equals "$revision" "$(jq -r '.content_id' <<<"$second_json")" 'next apply keeps the first published content identity'
assert_equals '1' "$(grep -Ec '^lock --global$' "$LEDGER")" 'next apply generates one canonical identity lock'
assert_equals '0' "$(grep -Ec '^install$' "$LEDGER")" 'next apply does not reinstall tools'
assert_equals "$expected_lock_hash" "$(sed -n '4p' "$LOCK_OUTPUT_LEDGER")" 'next apply starts from the same canonical lock bytes'
assert_equals "$revision" "$(readlink "$state/current" | sed 's#^revisions/##')" 'next apply leaves the converged revision selected'
assert_equals '1' "$(find "$state/revisions" -mindepth 1 -maxdepth 1 -type d -print | wc -l | tr -d ' ')" 'next apply reuses the published revision without a duplicate'
unset MISE_TEST_MUTATE_LOCK_ON_INSTALL

# A verification predicate that is wrong once after install must be retried
# within the same apply. Repeated failure below proves the retry bound and
# keeps the failed predicate visible to the caller.
cp "$FIXTURE_REPO/config/mise/source.toml" "$TEST_ROOT/source.before-verification-retry"
cp "$FIXTURE_REPO/config/toolchain/versions.tsv" "$TEST_ROOT/manifest.before-verification-retry"
sed 's/node = "24.20.0"/node = "24.20.1"/' "$TEST_ROOT/source.before-verification-retry" >"$FIXTURE_REPO/config/mise/source.toml"
sed 's/node|24.20.0|/node|24.20.1|/' "$TEST_ROOT/manifest.before-verification-retry" >"$FIXTURE_REPO/config/toolchain/versions.tsv"
export MISE_TEST_FAIL_LOCK_REMOVAL=true
lock_removal_failure="$(run_cli update --apply --json)"
unset MISE_TEST_FAIL_LOCK_REMOVAL
assert_equals '73' "$(sed -n '1p' <<<"$lock_removal_failure")" 'staging lock removal failure returns a state failure'
assert_equals 'mise_lock_replace_failed' "$(jq -r '.error.code' <<<"$(sed -n '2,$p' <<<"$lock_removal_failure")")" 'staging lock removal failure has a structured replacement error'
assert_equals "$revision" "$(readlink "$state/current" | sed 's#^revisions/##')" 'staging lock removal failure preserves current selection'
assert_equals '0' "$(find "$state/revisions" -maxdepth 1 -name '.staging-*' -print | wc -l | tr -d ' ')" 'staging lock removal failure cleans its private staging directory'
export MISE_TEST_VERIFY_FAILURE_MODE=always
verification_exhausted="$(run_cli update --apply --retry --json)"
unset MISE_TEST_VERIFY_FAILURE_MODE
assert_equals '70' "$(sed -n '1p' <<<"$verification_exhausted")" 'exhausted verification retry returns its failure status'
assert_equals 'mise_verification_failed' "$(jq -r '.error.code' <<<"$(sed -n '2,$p' <<<"$verification_exhausted")")" 'exhausted verification retry keeps its structured error code'
assert_contains "$(jq -r '.error.message' <<<"$(sed -n '2,$p' <<<"$verification_exhausted")")" 'node_version_mismatch' 'exhausted verification retry preserves the failed predicate'
cp "$TEST_ROOT/source.before-verification-retry" "$FIXTURE_REPO/config/mise/source.toml"
cp "$TEST_ROOT/manifest.before-verification-retry" "$FIXTURE_REPO/config/toolchain/versions.tsv"

: >"$LEDGER"
same="$(run_cli_from "$TOOLCHAIN_ADVERSARIAL_PROJECT" update --apply --json)"
assert_equals 'no_change' "$(jq -r '.status' <<<"$(sed -n '2,$p' <<<"$same")")" 'same selected revision verifies as no change'
assert_equals 'state_write' "$(jq -r '.side_effect' <<<"$(sed -n '2,$p' <<<"$same")")" 'no-change result reports its lock and snapshot writes'
assert_equals '1' "$(grep -Ec '^lock' "$LEDGER" || true)" 'same revision regenerates one identity-bound lock'
assert_equals '0' "$(grep -Ec '^install' "$LEDGER" || true)" 'same revision does not reinstall tools'
assert_not_exists "$TOOLCHAIN_PROJECT_SIDE_EFFECT" 'project Mise config side effect does not run during no-change verification'
assert_not_exists "$TOOLCHAIN_STATE_SIDE_EFFECT" 'state-directory Mise config side effect does not run during no-change verification'
assert_equals '0' "$(find "$state" -maxdepth 1 -name '.mise-operation-*' -print | wc -l | tr -d ' ')" 'no-change verification removes its private Mise process capsule'

race_current="$(readlink "$state/current")"
race_path_file="$TEST_ROOT/capsule-race-path"
export MISE_TEST_CAPSULE_MKDIR_RACE=true MISE_TEST_MKDIR_PATH_FILE="$race_path_file"
capsule_race="$(run_cli update --apply --json)"
unset MISE_TEST_CAPSULE_MKDIR_RACE MISE_TEST_MKDIR_PATH_FILE
raced_capsule="$(<"$race_path_file")"
assert_equals '73' "$(sed -n '1p' <<<"$capsule_race")" 'losing the capsule mkdir race returns a state failure'
assert_equals 'capsule_create_failed' "$(jq -r '.error.code' <<<"$(sed -n '2,$p' <<<"$capsule_race")")" 'capsule mkdir race is a structured creation failure'
assert_file "$raced_capsule/other-owner" 'capsule mkdir race preserves the other owner directory'
assert_equals 'other-owner-bytes' "$(<"$raced_capsule/other-owner")" 'capsule mkdir race preserves the other owner bytes'
assert_equals "$race_current" "$(readlink "$state/current")" 'capsule mkdir race preserves current selection'
assert_equals '0' "$([[ -e "$state/run-lock" || -L "$state/run-lock" ]] && printf 1 || printf 0)" 'capsule mkdir race releases only the operation lock'
rm -rf "$raced_capsule"

staging_race_path_file="$TEST_ROOT/staging-race-path"
export MISE_TEST_STAGING_MKDIR_RACE=true MISE_TEST_MKDIR_PATH_FILE="$staging_race_path_file"
staging_race="$(run_cli update --apply --json)"
unset MISE_TEST_STAGING_MKDIR_RACE MISE_TEST_MKDIR_PATH_FILE
raced_staging="$(<"$staging_race_path_file")"
assert_equals '73' "$(sed -n '1p' <<<"$staging_race")" 'losing the staging mkdir race returns a state failure'
assert_equals 'staging_create_failed' "$(jq -r '.error.code' <<<"$(sed -n '2,$p' <<<"$staging_race")")" 'staging mkdir race is a structured creation failure'
assert_file "$raced_staging/other-owner" 'staging mkdir race preserves the other owner directory'
assert_equals 'other-owner-bytes' "$(<"$raced_staging/other-owner")" 'staging mkdir race preserves the other owner bytes'
assert_equals "$race_current" "$(readlink "$state/current")" 'staging mkdir race preserves current selection'
assert_equals '0' "$(find "$state" -maxdepth 1 -name '.mise-operation-*' -print | wc -l | tr -d ' ')" 'staging mkdir race cleans the owned process capsule only'
rm -rf "$raced_staging"

for signal_target in capsule staging; do
  signal_path_file="$TEST_ROOT/$signal_target-signal-path"
  export MISE_TEST_MKDIR_SIGNAL_TARGET="$signal_target" MISE_TEST_MKDIR_PATH_FILE="$signal_path_file"
  signaled_create="$(run_cli update --apply --json)"
  unset MISE_TEST_MKDIR_SIGNAL_TARGET MISE_TEST_MKDIR_PATH_FILE
  signal_path="$(<"$signal_path_file")"
  assert_equals '143' "$(sed -n '1p' <<<"$signaled_create")" "TERM during $signal_target create returns the conventional signal status"
  assert_not_exists "$signal_path" "TERM after successful $signal_target mkdir cleans the adopted path"
  assert_equals "$race_current" "$(readlink "$state/current")" "TERM during $signal_target ownership transition preserves current"
done

prior_target="$(readlink "$state/current")"
printf 'unrelated source state\n' >"$HOME_ROOT/unrelated"
before_unrelated="$(shasum "$HOME_ROOT/unrelated" | awk '{print $1}')"
cp "$FIXTURE_REPO/config/mise/source.toml" "$TEST_ROOT/source.original"
cp "$FIXTURE_REPO/config/toolchain/versions.tsv" "$TEST_ROOT/manifest.original"
printf 'npm = "11.19.0"\n' >>"$FIXTURE_REPO/config/mise/source.toml"
: >"$LEDGER"
standalone_npm="$(run_cli update --apply --json)"
assert_equals '65' "$(sed -n '1p' <<<"$standalone_npm")" 'standalone npm declaration is rejected before installation'
assert_equals 'snapshot_invalid' "$(jq -r '.error.code' <<<"$(sed -n '2,$p' <<<"$standalone_npm")")" 'standalone npm declaration names the inconsistent source model'
assert_equals '0' "$(grep -Ec '^(lock|install)' "$LEDGER" || true)" 'standalone npm declaration never reaches Mise lock or install'
cp "$TEST_ROOT/source.original" "$FIXTURE_REPO/config/mise/source.toml"
sed 's/node = "24.20.0"/node = "24.20.1"/' "$TEST_ROOT/source.original" >"$FIXTURE_REPO/config/mise/source.toml"
export MISE_TEST_ORACLE_COLUMN=3
declaration_only="$(run_cli update --apply --json)"
assert_equals '65' "$(sed -n '1p' <<<"$declaration_only")" 'declaration-only drift is rejected before installation'
assert_equals 'snapshot_invalid' "$(jq -r '.error.code' <<<"$(sed -n '2,$p' <<<"$declaration_only")")" 'declaration-only drift names the inconsistent snapshot'
sed 's/node|24.20.0|/node|24.20.1|/' "$FIXTURE_REPO/config/toolchain/versions.tsv" >"$TEST_ROOT/versions.next"
mv "$TEST_ROOT/versions.next" "$FIXTURE_REPO/config/toolchain/versions.tsv"
set +e
export MISE_TEST_FAIL_INSTALL=true
failed="$(run_cli update --apply --json)"
unset MISE_TEST_FAIL_INSTALL
set -e
assert_equals '70' "$(sed -n '1p' <<<"$failed")" 'failed install returns a structured failure status'
assert_equals 'state_write_and_tool_install' "$(jq -r '.side_effect' <<<"$(sed -n '2,$p' <<<"$failed")")" 'failed install reports possible tool and state effects'
assert_equals "$prior_target" "$(readlink "$state/current")" 'failed install preserves the prior current revision'
assert_equals "$before_unrelated" "$(shasum "$HOME_ROOT/unrelated" | awk '{print $1}')" 'apply preserves unrelated HOME state'

next_id="$(fixture_content_id "$FIXTURE_REPO/config/toolchain/versions.tsv" "$FIXTURE_REPO/config/mise/source.toml")"
mkdir "$state/revisions/$next_id"
printf 'pre-planted\n' >"$state/revisions/$next_id/untrusted"
preplant="$(run_cli update --apply --json)"
assert_equals '73' "$(sed -n '1p' <<<"$preplant")" 'pre-planted unverified revision is rejected'
assert_equals 'revision_conflict' "$(jq -r '.error.code' <<<"$(sed -n '2,$p' <<<"$preplant")")" 'pre-planted revision reports an identity conflict'
rm -rf "$state/revisions/$next_id"
second="$(run_cli update --apply --json)"
second_revision="$(jq -r '.content_id' <<<"$(sed -n '2,$p' <<<"$second")")"
assert_equals 'false' "$([[ "$revision" == "$second_revision" ]] && printf true || printf false)" 'changed canonical source produces another revision'
: >"$LEDGER"
export MISE_TEST_ORACLE_COLUMN=2
recovered="$(run_cli_from "$TOOLCHAIN_ADVERSARIAL_PROJECT" recover --revision "$revision" --json)"
assert_equals '0' "$(sed -n '1p' <<<"$recovered")" 'recovery selects a verified older revision'
assert_equals "$state/revisions/$revision" "$(CDPATH='' cd "$(dirname "$state/current")/$(readlink "$state/current")" && pwd -P)" 'recovery replaces current with requested revision'
assert_equals '0' "$(grep -Ec '^(lock|install)' "$LEDGER" || true)" 'recovery never installs or locks'
assert_not_exists "$TOOLCHAIN_PROJECT_SIDE_EFFECT" 'project Mise config side effect does not run during recovery verification'
assert_not_exists "$TOOLCHAIN_STATE_SIDE_EFFECT" 'state-directory Mise config side effect does not run during recovery verification'
assert_equals '0' "$(find "$state" -maxdepth 1 -name '.mise-operation-*' -print | wc -l | tr -d ' ')" 'recovery removes its private Mise process capsule'

current_race_path_file="$TEST_ROOT/current-race-path"
current_before_race="$(readlink "$state/current")"
export MISE_TEST_CURRENT_LINK_RACE=true MISE_TEST_CURRENT_PATH_FILE="$current_race_path_file"
current_race="$(run_cli recover --revision "$revision" --json)"
unset MISE_TEST_CURRENT_LINK_RACE MISE_TEST_CURRENT_PATH_FILE
raced_current_tmp="$(<"$current_race_path_file")"
assert_equals '73' "$(sed -n '1p' <<<"$current_race")" 'losing current-temp link race returns a state failure'
assert_equals 'selection_failed' "$(jq -r '.error.code' <<<"$(sed -n '2,$p' <<<"$current_race")")" 'current-temp link race is a structured selection failure'
assert_equals 'foreign-selection' "$(readlink "$raced_current_tmp")" 'current-temp link race preserves the foreign preplant'
assert_equals "$current_before_race" "$(readlink "$state/current")" 'current-temp link race preserves current selection'
rm -f "$raced_current_tmp"

current_signal_path_file="$TEST_ROOT/current-signal-path"
export MISE_TEST_CURRENT_LINK_SIGNAL=true MISE_TEST_CURRENT_PATH_FILE="$current_signal_path_file"
current_signal="$(run_cli recover --revision "$revision" --json)"
unset MISE_TEST_CURRENT_LINK_SIGNAL MISE_TEST_CURRENT_PATH_FILE
signaled_current_tmp="$(<"$current_signal_path_file")"
assert_equals '143' "$(sed -n '1p' <<<"$current_signal")" 'TERM after current-temp creation returns the conventional signal status'
assert_not_exists "$signaled_current_tmp" 'TERM after current-temp creation cleans the adopted link'
assert_equals "$current_before_race" "$(readlink "$state/current")" 'TERM during current selection transition preserves current'

export MISE_TEST_ORACLE_COLUMN=3
reused="$(run_cli update --apply --json)"
assert_equals '0' "$(sed -n '1p' <<<"$reused")" 'apply can reuse an existing verified revision'
assert_equals "$second_revision" "$(jq -r '.content_id' <<<"$(sed -n '2,$p' <<<"$reused")")" 'verified reuse retains the exact content identity'
assert_equals "revisions/$second_revision" "$(readlink "$state/current")" 'verified reuse selects the existing revision without nesting staging'
export MISE_TEST_ORACLE_COLUMN=2
run_cli recover --revision "$revision" --json >/dev/null
cp "$TEST_ROOT/source.original" "$FIXTURE_REPO/config/mise/source.toml"
cp "$TEST_ROOT/manifest.original" "$FIXTURE_REPO/config/toolchain/versions.tsv"

# Recovery rejects any change to the immutable revision evidence. Restore each
# artifact from a test-owned backup before exercising the next mutation.
cp "$state/revisions/$revision/config.toml" "$TEST_ROOT/published.config"
cp "$state/revisions/$revision/manifest.tsv" "$TEST_ROOT/published.manifest"
cp "$state/revisions/$revision/mise.lock" "$TEST_ROOT/published.lock"
cp "$state/revisions/$revision/receipt.json" "$TEST_ROOT/published.receipt"
chmod u+w "$state/revisions/$revision" "$state/revisions/$revision/config.toml"
printf '\n# tampered\n' >>"$state/revisions/$revision/config.toml"
tampered="$(run_cli recover --revision "$revision" --json)"
assert_equals '65' "$(sed -n '1p' <<<"$tampered")" 'recovery rejects a mutated config'
cp "$TEST_ROOT/published.config" "$state/revisions/$revision/config.toml"
chmod 0444 "$state/revisions/$revision/config.toml"
chmod u+w "$state/revisions/$revision/mise.lock"
printf '\n# tampered\n' >>"$state/revisions/$revision/mise.lock"
chmod u+w "$state/revisions/$revision/receipt.json"
tampered_lock_hash="$(shasum -a 256 "$state/revisions/$revision/mise.lock" | awk '{print $1}')"
jq -c --arg lock "$tampered_lock_hash" '.lock_sha256 = $lock' "$TEST_ROOT/published.receipt" >"$state/revisions/$revision/receipt.json"
chmod 0444 "$state/revisions/$revision/mise.lock"
chmod 0444 "$state/revisions/$revision/receipt.json"
tampered="$(run_cli recover --revision "$revision" --json)"
assert_equals '65' "$(sed -n '1p' <<<"$tampered")" 'recovery rejects a coherent lock and receipt rewrite'
chmod u+w "$state/revisions/$revision/mise.lock"
cp "$TEST_ROOT/published.lock" "$state/revisions/$revision/mise.lock"
chmod 0444 "$state/revisions/$revision/mise.lock"
chmod u+w "$state/revisions/$revision/receipt.json"
cp "$TEST_ROOT/published.receipt" "$state/revisions/$revision/receipt.json"
chmod 0444 "$state/revisions/$revision/receipt.json"
chmod u+w "$state/revisions/$revision/manifest.tsv"
printf '\n# tampered\n' >>"$state/revisions/$revision/manifest.tsv"
tampered="$(run_cli recover --revision "$revision" --json)"
assert_equals '65' "$(sed -n '1p' <<<"$tampered")" 'recovery rejects a mutated manifest'
cp "$TEST_ROOT/published.manifest" "$state/revisions/$revision/manifest.tsv"
chmod 0444 "$state/revisions/$revision/manifest.tsv"
chmod u+w "$state/revisions/$revision/receipt.json"
printf '\n' >>"$state/revisions/$revision/receipt.json"
tampered="$(run_cli recover --revision "$revision" --json)"
assert_equals '65' "$(sed -n '1p' <<<"$tampered")" 'recovery rejects a malformed receipt'
rm "$state/revisions/$revision/receipt.json"
ln -s "$TEST_ROOT/published.receipt" "$state/revisions/$revision/receipt.json"
tampered="$(run_cli recover --revision "$revision" --json)"
assert_equals '65' "$(sed -n '1p' <<<"$tampered")" 'recovery rejects a symlinked receipt'
rm "$state/revisions/$revision/receipt.json"
cp "$TEST_ROOT/published.receipt" "$state/revisions/$revision/receipt.json"
chmod 0444 "$state/revisions/$revision/receipt.json"
chmod 0555 "$state/revisions/$revision"

lock_link_block="$TEST_ROOT/lock-link-blocked"
lock_link_release="$TEST_ROOT/lock-link-release"
HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" MISE_TEST_BLOCK_LOCK_LINK=true MISE_TEST_LOCK_LINK_BLOCK_FILE="$lock_link_block" MISE_TEST_LOCK_LINK_RELEASE_FILE="$lock_link_release" "$CLI" update --apply --json >"$TEST_ROOT/lock-link.stdout" 2>"$TEST_ROOT/lock-link.stderr" &
lock_link_pid=$!
for _ in $(seq 1 100); do [[ -e "$lock_link_block" ]] && break; sleep 0.02; done
assert_file "$lock_link_block" 'lock-link lane publishes the complete canonical record before returning'
kill -TERM "$lock_link_pid"
: >"$lock_link_release"
set +e
wait "$lock_link_pid" 2>/dev/null
lock_link_status=$?
set -e
assert_equals '143' "$lock_link_status" 'signal during canonical link return terminates the owner'
assert_not_exists "$state/run-lock" 'signal during canonical link return cleans the canonical lock'
assert_equals '0' "$(find "$state/lock-records" -type f | wc -l | tr -d ' ')" 'signal during canonical link return cleans the private record'
post_link_signal="$(run_cli update --apply --json)"
assert_equals 'no_change' "$(jq -r '.status' <<<"$(sed -n '2,$p' <<<"$post_link_signal")")" 'next apply succeeds after the lock-link signal'

export MISE_TEST_FAIL_LOCK_LINK=true
lock_publish_failure="$(run_cli update --apply --json)"
unset MISE_TEST_FAIL_LOCK_LINK
assert_equals '73' "$(sed -n '1p' <<<"$lock_publish_failure")" 'failed atomic lock publication has a state-failure exit'
assert_equals 'lock_publish_failed' "$(jq -r '.error.code' <<<"$(sed -n '2,$p' <<<"$lock_publish_failure")")" 'failed lock publication is not mislabeled as contention'
assert_not_exists "$state/run-lock" 'failed lock publication leaves no canonical lock'
assert_equals '0' "$(find "$state/lock-records" -type f | wc -l | tr -d ' ')" 'failed lock publication cleans its private ownership record'
post_lock_failure="$(run_cli update --apply --json)"
assert_equals 'no_change' "$(jq -r '.status' <<<"$(sed -n '2,$p' <<<"$post_lock_failure")")" 'a later apply succeeds after lock publication failure'

# A real second process blocks inside the fake install. Killing its CLI leaves
# current untouched and a stale lock that only explicit retry may repair.
sed 's/node = "24.20.0"/node = "24.20.2"/' "$TEST_ROOT/source.original" >"$FIXTURE_REPO/config/mise/source.toml"
sed 's/node|24.20.0|/node|24.20.2|/' "$TEST_ROOT/manifest.original" >"$TEST_ROOT/manifest.blocked"
mv "$TEST_ROOT/manifest.blocked" "$FIXTURE_REPO/config/toolchain/versions.tsv"
export MISE_TEST_ORACLE_COLUMN=4
block_file="$TEST_ROOT/install-blocked"
release_file="$TEST_ROOT/install-release"
HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" MISE_TEST_BLOCK_FILE="$block_file" MISE_TEST_RELEASE_FILE="$release_file" "$CLI" update --apply --json >"$TEST_ROOT/blocked.stdout" 2>"$TEST_ROOT/blocked.stderr" &
blocked_pid=$!
for _ in $(seq 1 100); do
	[[ -e "$block_file" ]] && break
	sleep 0.05
done
assert_file "$block_file" 'fake Mise reaches the deterministic install barrier'
busy="$(run_cli update --apply --json)"
assert_equals '75' "$(sed -n '1p' <<<"$busy")" 'concurrent apply refuses while a live PID owns the lock'
assert_equals 'busy' "$(jq -r '.status' <<<"$(sed -n '2,$p' <<<"$busy")")" 'concurrent refusal remains structured JSON'
assert_equals "$state/revisions/$revision" "$(CDPATH='' cd "$(dirname "$state/current")/$(readlink "$state/current")" && pwd -P)" 'concurrent refusal preserves current'
kill -KILL "$blocked_pid"
set +e
wait "$blocked_pid" 2>/dev/null
killed_status=$?
set -e
assert_equals '137' "$killed_status" 'actual killed apply reports the signal exit'
assert_equals "$state/revisions/$revision" "$(CDPATH='' cd "$(dirname "$state/current")/$(readlink "$state/current")" && pwd -P)" 'killed apply leaves current unchanged'
: >"$release_file"
stale="$(run_cli update --apply --json)"
assert_equals '75' "$(sed -n '1p' <<<"$stale")" 'plain apply refuses a validated stale lock'
assert_file "$state/run-lock" 'plain stale refusal preserves lock evidence'
stale_token="$(cut -d '|' -f 1 "$state/run-lock")"
stale_record="$state/lock-records/$stale_token"
foreign_claim="$state/takeover-$stale_token"
mkdir "$foreign_claim"
printf '%s\n' 'foreign-claim-bytes' >"$foreign_claim/owner"
foreign_claim_retry="$(run_cli update --apply --retry --json)"
assert_equals '75' "$(sed -n '1p' <<<"$foreign_claim_retry")" 'malformed foreign takeover claim refuses bounded retry'
assert_equals 'foreign-claim-bytes' "$(<"$foreign_claim/owner")" 'malformed foreign takeover claim bytes are preserved'
assert_file "$state/run-lock" 'foreign takeover claim never removes the stale canonical lock'
/bin/rm -rf "$foreign_claim"

stale_rm_path_file="$TEST_ROOT/stale-lock-rm.path"
current_before_stale_signal="$(readlink "$state/current")"
stale_signal="$(MISE_TEST_STALE_LOCK_RM_SIGNAL=true MISE_TEST_STALE_LOCK_RM_PATH_FILE="$stale_rm_path_file" run_cli update --apply --retry --json)"
assert_equals '143' "$(sed -n '1p' <<<"$stale_signal")" 'TERM after stale canonical unlink retains the conventional status'
assert_file "$stale_rm_path_file" 'TERM lane crosses the stale canonical unlink seam'
assert_not_exists "$state/run-lock" 'TERM after stale canonical unlink leaves no canonical lock'
assert_not_exists "$stale_record" 'TERM after stale canonical unlink cleans the adopted private record'
assert_not_exists "$state/takeover-$stale_token" 'TERM after stale canonical unlink cleans its managed claim'
assert_equals "$current_before_stale_signal" "$(readlink "$state/current")" 'TERM after stale canonical unlink preserves current selection'

# Recreate a stale canonical owner, then kill a retry immediately after its
# self-identifying claim is atomically published. A later pair of retries must
# safely reclaim the dead claim and still elect exactly one owner.
claim_setup_block="$TEST_ROOT/claim-setup-blocked"
claim_setup_release="$TEST_ROOT/claim-setup-release"
HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" MISE_TEST_BLOCK_FILE="$claim_setup_block" MISE_TEST_RELEASE_FILE="$claim_setup_release" "$CLI" update --apply --json >"$TEST_ROOT/claim-setup.stdout" 2>"$TEST_ROOT/claim-setup.stderr" &
claim_setup_pid=$!
for _ in $(seq 1 100); do [[ -e "$claim_setup_block" ]] && break; sleep 0.05; done
assert_file "$claim_setup_block" 'claim-recovery fixture reaches the deterministic install barrier'
kill -KILL "$claim_setup_pid"
set +e
wait "$claim_setup_pid" 2>/dev/null
claim_setup_status=$?
set -e
assert_equals '137' "$claim_setup_status" 'claim-recovery fixture leaves one actual stale canonical owner'
: >"$claim_setup_release"
claim_stale_token="$(cut -d '|' -f 1 "$state/run-lock")"
dead_claim_path_file="$TEST_ROOT/dead-takeover-claim.path"
HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" MISE_TEST_TAKEOVER_CLAIM_KILL=true MISE_TEST_TAKEOVER_CLAIM_PATH_FILE="$dead_claim_path_file" "$CLI" update --apply --retry --json >"$TEST_ROOT/dead-claim.stdout" 2>"$TEST_ROOT/dead-claim.stderr" &
dead_claim_pid=$!
set +e
wait "$dead_claim_pid" 2>/dev/null
dead_claim_status=$?
set -e
assert_equals '137' "$dead_claim_status" 'SIGKILL immediately after claim publication kills the claimant'
assert_file "$dead_claim_path_file" 'SIGKILL lane records the published managed claim path'
dead_claim_path="$(<"$dead_claim_path_file")"
assert_file "$dead_claim_path" 'SIGKILL leaves self-identifying claim evidence for bounded recovery'
assert_equals "$state/takeover-$claim_stale_token" "$dead_claim_path" 'managed claim is bound to the exact stale canonical owner token'
dead_claim_token="$(cut -d '|' -f 1 "$dead_claim_path")"
dead_claim_owner_pid="$(cut -d '|' -f 2 "$dead_claim_path")"
assert_equals '1' "$([[ "$dead_claim_path" -ef "$state/lock-records/$dead_claim_token" ]] && printf 1 || printf 0)" 'managed claim is anchored to its sealed claimant record'
assert_equals '1' "$(! kill -0 "$dead_claim_owner_pid" 2>/dev/null && printf 1 || printf 0)" 'managed claim records a dead claimant before reclamation'
assert_file "$state/run-lock" 'killed claimant does not remove the stale canonical lock'
retry_block="$TEST_ROOT/retry-blocked"
retry_release="$TEST_ROOT/retry-release"
retry_a_pid=''
retry_b_pid=''
for contender in a b; do
 HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" MISE_TEST_BLOCK_FILE="$retry_block" MISE_TEST_RELEASE_FILE="$retry_release" "$CLI" update --apply --retry --json >"$TEST_ROOT/retry-$contender.stdout" 2>"$TEST_ROOT/retry-$contender.stderr" &
 case "$contender" in a) retry_a_pid=$! ;; b) retry_b_pid=$! ;; esac
done
for _ in $(seq 1 100); do [[ -e "$retry_block" ]] && break; sleep 0.05; done
assert_file "$retry_block" 'one simultaneous retry safely reclaims the killed claim and owns install'
assert_file "$state/run-lock" 'serialized takeover preserves the winning contender canonical lock'
takeover_live_pid="$(cut -d '|' -f 2 "$state/run-lock")"
assert_equals '0' "$(kill -0 "$takeover_live_pid" 2>/dev/null; printf '%s' "$?")" 'serialized takeover canonical lock names a live winning contender'
: >"$retry_release"
set +e
wait "$retry_a_pid"; retry_a_status=$?
wait "$retry_b_pid"; retry_b_status=$?
set -e
retry_statuses="$(printf '%s\n%s\n' "$retry_a_status" "$retry_b_status" | sort -n | tr '\n' ' ' | sed 's/ $//')"
assert_equals '0 75' "$retry_statuses" 'simultaneous stale retries produce one owner and one refusal'
retry_results="$(cat "$TEST_ROOT/retry-a.stdout" "$TEST_ROOT/retry-b.stdout")"
assert_equals '1' "$(grep -c '"status":"applied"' <<<"$retry_results")" 'exactly one retry publishes the revision'
assert_equals '1' "$(grep -c '"status":"busy"' <<<"$retry_results")" 'exactly one retry reports live-owner contention'
assert_not_exists "$state/run-lock" 'retry releases its repaired lock'
assert_not_exists "$dead_claim_path" 'bounded retry reclaims the dead managed claim'
assert_not_exists "$state/lock-records/$dead_claim_token" 'bounded retry cleans the dead claimant record'

# A takeover killed after canonical unlink leaves no run lock to route a normal
# entrant through --retry. Normal publication must therefore share the same
# serializer and drain only the fully validated dead managed evidence.
sed 's/node = "24.20.0"/node = "24.20.5"/' "$TEST_ROOT/source.original" >"$FIXTURE_REPO/config/mise/source.toml"
sed 's/node|24.20.0|/node|24.20.5|/' "$TEST_ROOT/manifest.original" >"$FIXTURE_REPO/config/toolchain/versions.tsv"
export MISE_TEST_ORACLE_COLUMN=7
orphan_setup_block="$TEST_ROOT/orphan-setup-blocked"
orphan_setup_release="$TEST_ROOT/orphan-setup-release"
HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" MISE_TEST_BLOCK_FILE="$orphan_setup_block" MISE_TEST_RELEASE_FILE="$orphan_setup_release" "$CLI" update --apply --json >"$TEST_ROOT/orphan-setup.stdout" 2>"$TEST_ROOT/orphan-setup.stderr" &
orphan_setup_pid=$!
for _ in $(seq 1 100); do [[ -e "$orphan_setup_block" ]] && break; sleep 0.05; done
assert_file "$orphan_setup_block" 'post-unlink SIGKILL fixture reaches the install barrier'
kill -KILL "$orphan_setup_pid"
set +e
wait "$orphan_setup_pid" 2>/dev/null
orphan_setup_status=$?
set -e
assert_equals '137' "$orphan_setup_status" 'post-unlink SIGKILL fixture leaves one stale canonical owner'
: >"$orphan_setup_release"
orphan_stale_token="$(cut -d '|' -f 1 "$state/run-lock")"
post_unlink_kill_path="$TEST_ROOT/post-unlink-kill.path"
HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" MISE_TEST_STALE_LOCK_RM_KILL=true MISE_TEST_STALE_LOCK_RM_PATH_FILE="$post_unlink_kill_path" "$CLI" update --apply --retry --json >"$TEST_ROOT/post-unlink-kill.stdout" 2>"$TEST_ROOT/post-unlink-kill.stderr" &
post_unlink_kill_pid=$!
set +e
wait "$post_unlink_kill_pid" 2>/dev/null
post_unlink_kill_status=$?
set -e
assert_equals '137' "$post_unlink_kill_status" 'SIGKILL immediately after stale canonical unlink kills the takeover owner'
assert_file "$post_unlink_kill_path" 'SIGKILL lane crosses the stale canonical unlink seam'
assert_not_exists "$state/run-lock" 'post-unlink SIGKILL leaves canonical publication absent'
orphan_claim="$(find "$state" -maxdepth 1 -type f -name 'takeover-*' -print)"
assert_file "$orphan_claim" 'post-unlink SIGKILL leaves one managed claimant hard link'
orphan_claim_token="$(cut -d '|' -f 1 "$orphan_claim")"
assert_file "$state/lock-records/$orphan_claim_token" 'post-unlink SIGKILL leaves the claimant sealed record'
assert_file "$state/lock-records/$orphan_stale_token" 'post-unlink SIGKILL leaves the retired canonical private record'
post_unlink_current="$(readlink "$state/current")"
claim_record_kill_path="$TEST_ROOT/claim-record-kill.path"
HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" MISE_TEST_CLAIM_RECORD_RM_KILL=true MISE_TEST_CLAIM_RECORD_RM_PATH_FILE="$claim_record_kill_path" "$CLI" update --apply --json >"$TEST_ROOT/claim-record-kill.stdout" 2>"$TEST_ROOT/claim-record-kill.stderr" &
claim_record_kill_pid=$!
set +e
wait "$claim_record_kill_pid" 2>/dev/null
claim_record_kill_status=$?
set -e
assert_equals '137' "$claim_record_kill_status" 'SIGKILL after claimant record removal kills the drain owner'
assert_file "$claim_record_kill_path" 'SIGKILL lane crosses the claimant-record removal seam'
assert_equals "$state/lock-records/$orphan_claim_token" "$(<"$claim_record_kill_path")" 'SIGKILL removes only the validated claimant record first'
assert_file "$orphan_claim" 'interrupted claim cleanup retains the sealed claim as recovery anchor'
assert_not_exists "$state/lock-records/$orphan_claim_token" 'interrupted claim cleanup leaves no unanchored claimant record'
assert_file "$state/lock-records/$orphan_stale_token" 'interrupted claim cleanup retains the separately identified retired record'
assert_equals '1' "$(find "$state/lock-records" -maxdepth 1 -type f -print | wc -l | tr -d ' ')" 'killed drain creates no unanchored record for its own operation'
assert_equals "$post_unlink_current" "$(readlink "$state/current")" 'SIGKILL during claim cleanup preserves current selection'
orphan_recovery="$(run_cli update --apply --json)"
assert_equals '0' "$(sed -n '1p' <<<"$orphan_recovery")" 'normal apply resumes sealed claim cleanup without requiring retry mode'
assert_equals 'applied' "$(jq -r '.status' <<<"$(sed -n '2,$p' <<<"$orphan_recovery")")" 'normal recovery publishes the requested revision'
assert_not_exists "$orphan_claim" 'normal publication drains the validated dead managed claim'
assert_not_exists "$state/lock-records/$orphan_claim_token" 'normal publication drains the dead claimant record'
assert_not_exists "$state/lock-records/$orphan_stale_token" 'normal publication drains the retired canonical record'
assert_equals '0' "$(find "$state/lock-records" -maxdepth 1 -type f -print | wc -l | tr -d ' ')" 'normal recovery leaves no stale or current private lock record'
assert_equals '1' "$([[ "$(readlink "$state/current")" != "$post_unlink_current" ]] && printf 1 || printf 0)" 'normal recovery advances selection only after managed orphan drain'

# Hold a live takeover after unlink to prove normal acquisition cannot bypass
# serializer custody or remove its live claim.
sed 's/node = "24.20.0"/node = "24.20.6"/' "$TEST_ROOT/source.original" >"$FIXTURE_REPO/config/mise/source.toml"
sed 's/node|24.20.0|/node|24.20.6|/' "$TEST_ROOT/manifest.original" >"$FIXTURE_REPO/config/toolchain/versions.tsv"
export MISE_TEST_ORACLE_COLUMN=8
serializer_setup_block="$TEST_ROOT/serializer-setup-blocked"
serializer_setup_release="$TEST_ROOT/serializer-setup-release"
HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" MISE_TEST_BLOCK_FILE="$serializer_setup_block" MISE_TEST_RELEASE_FILE="$serializer_setup_release" "$CLI" update --apply --json >"$TEST_ROOT/serializer-setup.stdout" 2>"$TEST_ROOT/serializer-setup.stderr" &
serializer_setup_pid=$!
for _ in $(seq 1 100); do [[ -e "$serializer_setup_block" ]] && break; sleep 0.05; done
assert_file "$serializer_setup_block" 'serializer-exclusion fixture reaches the install barrier'
kill -KILL "$serializer_setup_pid"
set +e
wait "$serializer_setup_pid" 2>/dev/null
serializer_setup_status=$?
set -e
assert_equals '137' "$serializer_setup_status" 'serializer-exclusion fixture leaves one stale canonical owner'
: >"$serializer_setup_release"
serializer_block="$TEST_ROOT/serializer-blocked"
serializer_release="$TEST_ROOT/serializer-release"
HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" MISE_TEST_STALE_LOCK_RM_BLOCK=true MISE_TEST_STALE_LOCK_RM_PATH_FILE="$serializer_block" MISE_TEST_STALE_LOCK_RM_RELEASE_FILE="$serializer_release" "$CLI" update --apply --retry --json >"$TEST_ROOT/serializer-owner.stdout" 2>"$TEST_ROOT/serializer-owner.stderr" &
serializer_owner_pid=$!
for _ in $(seq 1 100); do [[ -e "$serializer_block" ]] && break; sleep 0.05; done
assert_file "$serializer_block" 'live takeover holds serialization after canonical unlink'
live_claim="$(find "$state" -maxdepth 1 -type f -name 'takeover-*' -print)"
assert_file "$live_claim" 'live takeover publishes one self-identifying claim'
live_claim_hash="$(shasum -a 256 "$live_claim" | awk '{print $1}')"
serializer_refusal="$(run_cli update --apply --json)"
assert_equals '75' "$(sed -n '1p' <<<"$serializer_refusal")" 'normal acquisition refuses while takeover serialization is live'
assert_equals 'busy' "$(jq -r '.status' <<<"$(sed -n '2,$p' <<<"$serializer_refusal")")" 'serializer exclusion is a structured busy result'
assert_equals "$live_claim_hash" "$(shasum -a 256 "$live_claim" | awk '{print $1}')" 'serializer refusal preserves the live claim bytes and inode evidence'
assert_not_exists "$state/run-lock" 'serializer refusal does not publish around the in-flight takeover'
: >"$serializer_release"
set +e
wait "$serializer_owner_pid"
serializer_owner_status=$?
set -e
assert_equals '0' "$serializer_owner_status" 'serialized takeover completes after its retirement barrier releases'
assert_not_exists "$live_claim" 'completed takeover releases its managed claim'
assert_equals '0' "$(find "$state/lock-records" -maxdepth 1 -type f -print | wc -l | tr -d ' ')" 'completed serialized takeover leaves no private lock record'

foreign_orphan="$state/takeover-foreign-token"
mkdir "$foreign_orphan"
printf '%s\n' 'foreign-orphan-bytes' >"$foreign_orphan/owner"
foreign_orphan_current="$(readlink "$state/current")"
foreign_orphan_result="$(run_cli update --apply --json)"
assert_equals '73' "$(sed -n '1p' <<<"$foreign_orphan_result")" 'normal publication refuses malformed orphan takeover evidence'
assert_equals 'takeover_orphan_invalid' "$(jq -r '.error.code' <<<"$(sed -n '2,$p' <<<"$foreign_orphan_result")")" 'malformed orphan refusal is structurally distinct from contention'
assert_equals 'foreign-orphan-bytes' "$(<"$foreign_orphan/owner")" 'normal orphan drain preserves malformed foreign bytes'
assert_equals "$foreign_orphan_current" "$(readlink "$state/current")" 'malformed orphan refusal preserves current selection'
/bin/rm -rf "$foreign_orphan"

unsealed_claim_token='foreign-claimant-token'
unsealed_stale_token='foreign-stale-token'
unsealed_record="$state/lock-records/$unsealed_claim_token"
unsealed_claim="$state/takeover-$unsealed_stale_token"
printf '%s|%s|%s|apply\n' "$unsealed_claim_token" "$serializer_setup_pid" "$state/revisions/.staging-$unsealed_claim_token" >"$unsealed_record"
chmod 0644 "$unsealed_record"
ln "$unsealed_record" "$unsealed_claim"
unsealed_record_hash="$(shasum -a 256 "$unsealed_record" | awk '{print $1}')"
unsealed_result="$(run_cli update --apply --json)"
assert_equals '73' "$(sed -n '1p' <<<"$unsealed_result")" 'near-valid unsealed claimant record is refused'
assert_equals 'takeover_orphan_invalid' "$(jq -r '.error.code' <<<"$(sed -n '2,$p' <<<"$unsealed_result")")" 'unsealed managed-looking evidence is structurally foreign'
assert_equals '644' "$(stat -f '%Lp' "$unsealed_record")" 'unsealed claimant record mode is preserved'
assert_equals "$unsealed_record_hash" "$(shasum -a 256 "$unsealed_claim" | awk '{print $1}')" 'unsealed claim bytes and hard-link evidence are preserved'
assert_equals '1' "$([[ "$unsealed_record" -ef "$unsealed_claim" ]] && printf 1 || printf 0)" 'unsealed foreign claim path is preserved'
/bin/rm -f "$unsealed_claim" "$unsealed_record"
post_foreign_orphan="$(run_cli update --apply --json)"
assert_equals 'no_change' "$(jq -r '.status' <<<"$(sed -n '2,$p' <<<"$post_foreign_orphan")")" 'normal publication resumes after fixture-owned malformed evidence is removed'

# TERM must end the owner, release its tokened state, and never continue to
# publication or selection.
sed 's/node = "24.20.0"/node = "24.20.3"/' "$TEST_ROOT/source.original" >"$FIXTURE_REPO/config/mise/source.toml"
sed 's/node|24.20.0|/node|24.20.3|/' "$TEST_ROOT/manifest.original" >"$FIXTURE_REPO/config/toolchain/versions.tsv"
export MISE_TEST_ORACLE_COLUMN=5
term_block="$TEST_ROOT/term-blocked"
term_release="$TEST_ROOT/term-release"
term_grandchild_file="$TEST_ROOT/term-grandchild.pid"
term_prior="$(readlink "$state/current")"
HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" MISE_TEST_BLOCK_FILE="$term_block" MISE_TEST_RELEASE_FILE="$term_release" MISE_TEST_GRANDCHILD_PID_FILE="$term_grandchild_file" "$CLI" update --apply --json >"$TEST_ROOT/term.stdout" 2>"$TEST_ROOT/term.stderr" &
term_pid=$!
for _ in $(seq 1 100); do [[ -e "$term_block" ]] && break; sleep 0.05; done
assert_file "$term_block" 'TERM lane reaches the deterministic install barrier'
assert_file "$term_grandchild_file" 'TERM lane records a hostile descendant'
term_grandchild="$(<"$term_grandchild_file")"
kill -TERM "$term_pid"
set +e
wait "$term_pid" 2>/dev/null
term_status=$?
set -e
assert_equals '143' "$term_status" 'TERM ends the apply with the conventional status'
assert_process_gone "$term_grandchild" 'TERM retires the whole install process group'
assert_equals "$term_prior" "$(readlink "$state/current")" 'TERM preserves the selected revision'
assert_not_exists "$state/run-lock" 'TERM releases only the owned run lock'

int_block="$TEST_ROOT/int-blocked"
int_release="$TEST_ROOT/int-release"
int_grandchild_file="$TEST_ROOT/int-grandchild.pid"
set -m
HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" MISE_TEST_BLOCK_FILE="$int_block" MISE_TEST_RELEASE_FILE="$int_release" MISE_TEST_GRANDCHILD_PID_FILE="$int_grandchild_file" "$CLI" update --apply --json >"$TEST_ROOT/int.stdout" 2>"$TEST_ROOT/int.stderr" &
int_pid=$!
set +m
for _ in $(seq 1 100); do [[ -e "$int_block" ]] && break; sleep 0.05; done
assert_file "$int_block" 'INT lane reaches the deterministic install barrier'
assert_file "$int_grandchild_file" 'INT lane records a hostile descendant'
int_grandchild="$(<"$int_grandchild_file")"
kill -INT "$int_pid"
set +e
wait "$int_pid" 2>/dev/null
int_status=$?
set -e
assert_equals '130' "$int_status" 'INT ends the apply with the conventional status'
assert_process_gone "$int_grandchild" 'INT retires the whole install process group'
assert_equals "$term_prior" "$(readlink "$state/current")" 'INT preserves the selected revision'
assert_not_exists "$state/run-lock" 'INT releases only the owned run lock'

# Signals received while the child is still held behind the launch gate must
# be retained until its process group can be verified and retired. Mise itself
# must never start in this lane.
for launch_signal in TERM INT; do
	: >"$LEDGER"
	launch_block="$TEST_ROOT/launch-${launch_signal}-blocked"
	launch_release="$TEST_ROOT/launch-${launch_signal}-release"
	launch_child_file="$TEST_ROOT/launch-${launch_signal}-child.pid"
	launch_prior="$(readlink "$state/current")"
	set -m
	HOME="$HOME_ROOT" PATH="$BIN:/usr/bin:/bin" \
		MISE_TEST_BLOCK_PGID_DISCOVERY=true \
		MISE_TEST_PGID_BLOCK_FILE="$launch_block" \
		MISE_TEST_PGID_RELEASE_FILE="$launch_release" \
		MISE_TEST_PGID_PID_FILE="$launch_child_file" \
		"$CLI" update --apply --json >"$TEST_ROOT/launch-${launch_signal}.stdout" 2>"$TEST_ROOT/launch-${launch_signal}.stderr" &
	launch_pid=$!
	set +m
	for _ in $(seq 1 100); do [[ -e "$launch_block" ]] && break; sleep 0.02; done
	assert_file "$launch_block" "$launch_signal launch lane blocks before releasing the install gate"
	assert_file "$launch_child_file" "$launch_signal launch lane records the gated child process group"
	launch_child="$(<"$launch_child_file")"
	launch_token="$(cut -d '|' -f 1 "$state/run-lock")"
	kill -"$launch_signal" "$launch_pid"
	: >"$launch_release"
	set +e
	wait "$launch_pid" 2>/dev/null
	launch_status=$?
	set -e
	case "$launch_signal" in TERM) expected_launch_status=143 ;; INT) expected_launch_status=130 ;; esac
	assert_equals "$expected_launch_status" "$launch_status" "$launch_signal during launch preserves the conventional signal status"
	assert_equals '0' "$(grep -c '^install' "$LEDGER" || true)" "$launch_signal during launch never releases Mise past the gate"
	assert_process_gone "$launch_pid" "$launch_signal during launch retires the public CLI"
	assert_process_group_gone "$launch_child" "$launch_signal during launch retires the gated child process group"
	assert_not_exists "$state/run-lock" "$launch_signal during launch releases the owned run lock"
	assert_equals "$launch_prior" "$(readlink "$state/current")" "$launch_signal during launch preserves the selected revision"
	assert_not_exists "$state/.install-gate-$launch_token" "$launch_signal during launch removes its private gate"
done

: >"$LEDGER"
set +e
pgid_failure="$(MISE_TEST_FAIL_PGID_DISCOVERY=true run_cli update --apply --json)"
set -e
assert_equals '70' "$(sed -n '1p' <<<"$pgid_failure")" 'PGID discovery failure aborts installation'
assert_equals '0' "$(grep -c '^install' "$LEDGER" || true)" 'PGID discovery failure never releases Mise past the launch gate'
assert_not_exists "$state/run-lock" 'PGID discovery failure releases the owned run lock'
assert_equals "$term_prior" "$(readlink "$state/current")" 'PGID discovery failure preserves the selected revision'

# A source edit after the exclusive snapshot must not change the bytes or
# identity being installed and published in this run.
sed 's/node = "24.20.0"/node = "24.20.4"/' "$TEST_ROOT/source.original" >"$FIXTURE_REPO/config/mise/source.toml"
sed 's/node|24.20.0|/node|24.20.4|/' "$TEST_ROOT/manifest.original" >"$FIXTURE_REPO/config/toolchain/versions.tsv"
cp "$FIXTURE_REPO/config/mise/source.toml" "$TEST_ROOT/source.snapshot-expected"
cp "$FIXTURE_REPO/config/toolchain/versions.tsv" "$TEST_ROOT/manifest.snapshot-expected"
sed 's/node = "24.20.0"/node = "24.20.5"/' "$TEST_ROOT/source.original" >"$TEST_ROOT/source.concurrent"
sed 's/node|24.20.0|/node|24.20.5|/' "$TEST_ROOT/manifest.original" >"$TEST_ROOT/manifest.concurrent"
snapshot_id="$(fixture_content_id "$TEST_ROOT/manifest.snapshot-expected" "$TEST_ROOT/source.snapshot-expected")"
export MISE_TEST_ORACLE_COLUMN=6
snapshot_run="$(MISE_TEST_REPLACEMENT_CONFIG="$TEST_ROOT/source.concurrent" MISE_TEST_REPLACEMENT_MANIFEST="$TEST_ROOT/manifest.concurrent" MISE_TEST_CANONICAL_CONFIG="$FIXTURE_REPO/config/mise/source.toml" MISE_TEST_CANONICAL_MANIFEST="$FIXTURE_REPO/config/toolchain/versions.tsv" run_cli update --apply --json)"
assert_equals '0' "$(sed -n '1p' <<<"$snapshot_run")" 'concurrent source rewrite does not corrupt the snapshotted apply'
assert_equals "$snapshot_id" "$(jq -r '.content_id' <<<"$(sed -n '2,$p' <<<"$snapshot_run")")" 'content identity comes only from the exclusive snapshot'
assert_equals "$snapshot_id" "$(basename "$(CDPATH='' cd "$state/revisions/$snapshot_id" && pwd -P)")" 'published directory retains the snapshot identity'
assert_equals "$(shasum -a 256 "$TEST_ROOT/source.snapshot-expected" | awk '{print $1}')" "$(shasum -a 256 "$state/revisions/$snapshot_id/config.toml" | awk '{print $1}')" 'published config retains the snapshotted bytes'

symlink_home="$TEST_ROOT/symlink-home"
escaped_state="$TEST_ROOT/escaped-state"
mkdir -p "$symlink_home" "$escaped_state"
ln -s "$escaped_state" "$symlink_home/.dotfiles_state"
set +e
escaped_output="$(HOME="$symlink_home" PATH="$BIN:/usr/bin:/bin" "$CLI" update --apply --json 2>"$TEST_ROOT/escaped.stderr")"
escaped_status=$?
set -e
assert_equals '73' "$escaped_status" 'a symlinked state ancestor is rejected'
assert_equals 'state_unsafe' "$(jq -r '.error.code' <<<"$escaped_output")" 'state containment failure is structured'
assert_equals '0' "$(find "$escaped_state" -mindepth 1 -print | wc -l | tr -d ' ')" 'state containment refusal writes nothing outside HOME'

invalid="$(run_cli recover --revision not-a-content-id --json)"
assert_equals '65' "$(sed -n '1p' <<<"$invalid")" 'invalid revision refuses safely'
assert_equals '0' "$(find "$state" -maxdepth 1 -name '.mise-operation-*' -print | wc -l | tr -d ' ')" 'success failure signal and stale takeover paths leave no Mise process capsule'
artifact_residues="$({
  find "$state" -maxdepth 1 \( -name '.mise-operation-*' -o -name '.install-gate-*' -o -name 'takeover-*' \) -print
  find "$state/revisions" -maxdepth 1 -name '.staging-*' -print
  find "$state/lock-records" -maxdepth 1 -type f -print
})"
[[ -z "$artifact_residues" ]] || printf '# unexpected token artifacts:\n%s\n' "$artifact_residues" >&2
assert_equals '0' "$(grep -c . <<<"$artifact_residues" || true)" 'completed ownership scenarios leave no token-owned staging capsule gate claim or lock record'
assert_equals '1' "$(awk -v expected="$CANONICAL_MISE_CUSTODY" 'NF && $0 != expected { bad=1 } END { if (bad || NR == 0) print 0; else print 1 }' "$MISE_ENV_LEDGER")" 'lock install verify and recovery keep one canonical Mise directory layout'
printf '1..%d\n' "$assertion_count"
