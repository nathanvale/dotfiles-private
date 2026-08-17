#!/usr/bin/env bash
# Fixture proof for bin/cloudflare-access-headers.
#
# A fake wrapper stands in for with-one-password-token, so no real credential,
# 1Password call, or network access is involved.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
HELPER="$REPO_ROOT/bin/cloudflare-access-headers"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

pass_count=0

pass() {
  pass_count=$((pass_count + 1))
  printf 'ok %d - %s\n' "$pass_count" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

# Writes a fake wrapper that prints $1 on stdout and exits with $2.
make_wrapper() {
  local body="$1"
  local exit_code="${2:-0}"
  local path="$TEST_ROOT/wrapper"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'printf %%s %q\n' "$body"
    printf 'exit %s\n' "$exit_code"
  } >"$path"
  chmod +x "$path"
  printf '%s' "$path"
}

run_helper() {
  CLOUDFLARE_ACCESS_HEADERS_WRAPPER="$1" "$HELPER" 2>"$TEST_ROOT/stderr"
}

# --- happy path -------------------------------------------------------------

wrapper="$(make_wrapper '[{"label":"client_id","value":"abc.access"},{"label":"client_secret","value":"s3cr3t"}]')"
output="$(run_helper "$wrapper")" || fail 'helper exited non-zero on a complete item'

printf '%s' "$output" | /usr/bin/python3 -c '
import json, sys
h = json.load(sys.stdin)
assert h["CF-Access-Client-Id"] == "abc.access", h
assert h["CF-Access-Client-Secret"] == "s3cr3t", h
assert len(h) == 2, h
' || fail 'helper did not emit exactly the two expected headers'
pass 'emits both Cloudflare Access headers as JSON'

[[ "$(printf '%s' "$output" | head -c 1)" == '{' ]] || fail 'output is not a JSON object'
pass 'output is a single JSON object on stdout'

# --- failure paths ----------------------------------------------------------

wrapper="$(make_wrapper '' 4)"
if run_helper "$wrapper" >"$TEST_ROOT/out"; then
  fail 'helper succeeded when the wrapper failed'
fi
[[ ! -s "$TEST_ROOT/out" ]] || fail 'helper wrote output when the wrapper failed'
rg -q 'credential-unavailable' "$TEST_ROOT/stderr" || fail 'missing credential-unavailable code'
pass 'fails closed and silently when the credential is unavailable'

wrapper="$(make_wrapper '[{"label":"client_id","value":"abc.access"}]')"
if run_helper "$wrapper" >"$TEST_ROOT/out"; then
  fail 'helper succeeded with only a client_id'
fi
[[ ! -s "$TEST_ROOT/out" ]] || fail 'helper emitted a partial credential'
rg -q 'credential-incomplete' "$TEST_ROOT/stderr" || fail 'missing credential-incomplete code'
pass 'never emits a partial header pair'

wrapper="$(make_wrapper 'not json at all')"
if run_helper "$wrapper" >"$TEST_ROOT/out"; then
  fail 'helper succeeded on unparsable wrapper output'
fi
[[ ! -s "$TEST_ROOT/out" ]] || fail 'helper wrote output on unparsable input'
pass 'fails closed on unparsable credential output'

wrapper="$(make_wrapper '[{"label":"client_id","value":"abc.access"},{"label":"client_secret","value":"s3cr3t"}]')"
if CLOUDFLARE_ACCESS_HEADERS_WRAPPER="$wrapper" "$HELPER" extra-argument >"$TEST_ROOT/out" 2>"$TEST_ROOT/stderr"; then
  fail 'helper accepted an unexpected argument'
fi
rg -q 'usage-invalid' "$TEST_ROOT/stderr" || fail 'missing usage-invalid code'
pass 'rejects unexpected arguments'

if CLOUDFLARE_ACCESS_HEADERS_WRAPPER="$TEST_ROOT/absent" "$HELPER" >"$TEST_ROOT/out" 2>"$TEST_ROOT/stderr"; then
  fail 'helper succeeded without its credential wrapper'
fi
rg -q 'wrapper-missing' "$TEST_ROOT/stderr" || fail 'missing wrapper-missing code'
pass 'fails closed when the governed launcher is absent'

# --- containment ------------------------------------------------------------

rg -q 'op item get' "$HELPER" || fail 'helper no longer reads through an op item get'
rg -q 'with-one-password-token' "$HELPER" || fail 'helper does not default to the governed launcher'
pass 'reads only through the governed launcher'

if rg -q 'CF-Access-Client-Secret=|--header' "$HELPER"; then
  fail 'helper places a credential on a command line'
fi
pass 'no credential reaches argv'

printf '1..%d\n' "$pass_count"
