#!/usr/bin/env bash

# Claude user-settings policy contract.
#
# The production consumers are `./setup.sh symlinks` and `verify_install.sh`,
# which run bin/dotfiles/claude-settings.py against the real HOME, and Claude
# Code itself, which rewrites ~/.claude/settings.json on every supported
# settings operation. Each row copies the public script and a policy into a
# disposable Git checkout, runs it under an empty environment with a temporary
# HOME, and observes exit status, streams, file type, bytes and Git status.
# Real-Claude rows drive the installed `claude` binary against a local
# marketplace; they skip with a recorded rationale when no binary exists.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
trap 'rm -rf "$TEST_ROOT"' EXIT

CLAUDE_BIN="${CLAUDE_SETTINGS_TEST_CLAUDE:-$(command -v claude || true)}"
TRACKED="config/agents/claude/settings.json"

assertion_count=0
RUN_STATUS=0
RUN_STDOUT="$TEST_ROOT/stdout"
RUN_STDERR="$TEST_ROOT/stderr"

pass() {
  assertion_count=$((assertion_count + 1))
  printf 'ok %d - %s\n' "$assertion_count" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  [[ -f "$RUN_STDOUT" ]] && sed 's/^/  stdout: /' "$RUN_STDOUT" >&2
  [[ -f "$RUN_STDERR" ]] && sed 's/^/  stderr: /' "$RUN_STDERR" >&2
  exit 1
}

assert_equals() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] ||
    fail "$label (expected [$expected], got [$actual])"
  pass "$label"
}

assert_contains() {
  local file="$1" text="$2" label="$3"
  grep -Fq -- "$text" "$file" || fail "$label (missing [$text])"
  pass "$label"
}

assert_not_contains() {
  local file="$1" text="$2" label="$3"
  if grep -Fq -- "$text" "$file"; then
    fail "$label (unexpected [$text])"
  fi
  pass "$label"
}

# Canonical JSON for comparisons: sorted keys, no whitespace differences.
canonical() {
  /usr/bin/python3 -c 'import json,sys;print(json.dumps(json.load(open(sys.argv[1])),sort_keys=True))' "$1"
}

canonical_text() {
  /usr/bin/python3 -c 'import json,sys;print(json.dumps(json.loads(sys.argv[1]),sort_keys=True))' "$1"
}

json_field() {
  /usr/bin/python3 -c 'import json,sys
value=json.load(open(sys.argv[1]))
for part in sys.argv[2].split("."):
    value=value[part]
print(json.dumps(value,sort_keys=True))' "$1" "$2"
}

object_type() {
  if [[ -L "$1" ]]; then echo symlink
  elif [[ -f "$1" ]]; then echo file
  elif [[ -e "$1" ]]; then echo other
  else echo absent
  fi
}

# A disposable checkout holding the public script and a committed policy.
prepare_checkout() {
  local policy_source="$1"
  CHECKOUT="$TEST_ROOT/checkout-$assertion_count"
  FAKE_HOME="$TEST_ROOT/home-$assertion_count"
  mkdir -p "$CHECKOUT/bin/dotfiles" "$CHECKOUT/$(dirname "$TRACKED")" "$FAKE_HOME/.claude"
  cp "$REPO_ROOT/bin/dotfiles/claude-settings.py" "$CHECKOUT/bin/dotfiles/claude-settings.py"
  cp "$policy_source" "$CHECKOUT/$TRACKED"
  git -C "$CHECKOUT" init -q -b main
  git_c add bin "$TRACKED"
  git_c commit -qm base
  MACHINE="$FAKE_HOME/.claude/settings.json"
}

git_c() {
  git -C "$CHECKOUT" -c user.name=test -c user.email=test@invalid -c commit.gpgsign=false "$@"
}

checkout_status() {
  git_c status --porcelain
}

run_policy() {
  RUN_STATUS=0
  env -i HOME="$FAKE_HOME" PATH=/usr/bin:/bin ${EXTRA_ENV:+"$EXTRA_ENV"} \
    /usr/bin/python3 "$CHECKOUT/bin/dotfiles/claude-settings.py" "$@" \
    >"$RUN_STDOUT" 2>"$RUN_STDERR" || RUN_STATUS=$?
}

POLICY_FIXTURE="$TEST_ROOT/policy.json"
cat >"$POLICY_FIXTURE" <<'JSON'
{
  "permissions": {"deny": ["AskUserQuestion"], "defaultMode": "bypassPermissions"},
  "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "gate.sh"}]}]},
  "disableAllHooks": false,
  "model": "opus",
  "effortLevel": "high",
  "modelSettings": {"claude-opus-5-5": {"effortLevel": "high"}},
  "theme": "dark",
  "enabledPlugins": {"proof@personal": true},
  "extraKnownMarketplaces": {"personal": {"source": {"source": "directory", "path": "/p"}}},
  "skillOverrides": {"gog": "off"}
}
JSON

# --- Fresh install, idempotence and check -----------------------------------

prepare_checkout "$POLICY_FIXTURE"
run_policy
assert_equals "$RUN_STATUS" 0 'fresh install succeeds'
assert_equals "$(object_type "$MACHINE")" file 'fresh install writes a regular machine-owned file'
assert_equals "$(stat -f '%Lp' "$MACHINE")" 600 'fresh install writes the machine file owner-only'
assert_equals "$(canonical "$MACHINE")" "$(canonical "$POLICY_FIXTURE")" 'fresh install seeds the whole policy'
assert_equals "$(checkout_status)" '' 'fresh install leaves the checkout clean'

cp "$MACHINE" "$TEST_ROOT/first-install"
run_policy
assert_equals "$RUN_STATUS" 0 'repeat install succeeds'
cmp -s "$TEST_ROOT/first-install" "$MACHINE" || fail 'repeat install changed machine bytes'
pass 'repeat install preserves machine bytes'
assert_contains "$RUN_STDOUT" 'already applied' 'repeat install reports no change'

run_policy --check
assert_equals "$RUN_STATUS" 0 'check passes after install'
cmp -s "$TEST_ROOT/first-install" "$MACHINE" || fail 'check changed machine bytes'
pass 'check leaves machine bytes unchanged'

# --- Machine choices survive; policy drift is reported and repaired ---------

cat >"$MACHINE" <<'JSON'
{
  "permissions": {"deny": [], "defaultMode": "default"},
  "hooks": {},
  "disableAllHooks": true,
  "model": "sonnet",
  "effortLevel": "xhigh",
  "modelSettings": {"claude-opus-5-5": {"effortLevel": "max"}, "claude-sonnet-5-5": {"effortLevel": "xhigh"}},
  "theme": "light",
  "enabledPlugins": {"proof@personal": false, "pstack@cursor-plugins": true},
  "extraKnownMarketplaces": {"cursor-plugins": {"source": {"source": "github", "repo": "cursor/plugins"}}},
  "feedbackSurveyState": {"lastShownTime": 1}
}
JSON
cp "$MACHINE" "$TEST_ROOT/drifted"
run_policy --check
assert_equals "$RUN_STATUS" 1 'check fails on policy drift'
for key in permissions hooks disableAllHooks skillOverrides; do
  assert_contains "$RUN_STDERR" "$key" "check names drifted policy key $key"
done
for key in model effortLevel modelSettings theme pstack feedbackSurveyState; do
  assert_not_contains "$RUN_STDERR" "$key" "check treats $key as a machine choice"
done
cmp -s "$TEST_ROOT/drifted" "$MACHINE" || fail 'failing check changed machine bytes'
pass 'failing check leaves machine bytes unchanged'

run_policy
assert_equals "$RUN_STATUS" 0 'install repairs drift'
# Independent oracle: the merged result, written out by hand.
assert_equals "$(canonical "$MACHINE")" "$(canonical_text '{
  "permissions": {"deny": ["AskUserQuestion"], "defaultMode": "default"},
  "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "gate.sh"}]}]},
  "disableAllHooks": false,
  "model": "sonnet",
  "effortLevel": "xhigh",
  "modelSettings": {"claude-opus-5-5": {"effortLevel": "max"}, "claude-sonnet-5-5": {"effortLevel": "xhigh"}},
  "theme": "light",
  "enabledPlugins": {"proof@personal": false, "pstack@cursor-plugins": true},
  "extraKnownMarketplaces": {"cursor-plugins": {"source": {"source": "github", "repo": "cursor/plugins"}}, "personal": {"source": {"source": "directory", "path": "/p"}}},
  "skillOverrides": {"gog": "off"},
  "feedbackSurveyState": {"lastShownTime": 1}
}')" 'install restores policy and preserves machine choices'
run_policy --check
assert_equals "$RUN_STATUS" 0 'check passes after repair'

# Claude records the default model by deleting `model`; the machine owns that.
/usr/bin/python3 - "$MACHINE" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
for key in ("model", "effortLevel", "modelSettings", "theme"):
    del data[key]
json.dump(data, open(path, "w"), indent=2)
PY
run_policy --check
assert_equals "$RUN_STATUS" 0 'check accepts machine choices removed by Claude'
run_policy
assert_equals "$RUN_STATUS" 0 'install succeeds without machine choices'
assert_equals "$(/usr/bin/python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(sorted(set(d)&{"model","effortLevel","modelSettings","theme"}))' "$MACHINE")" '[]' 'install leaves removed machine choices absent'

# --- Policy edits and retirements reach hosts; host changes survive --------

edit_policy() {
  /usr/bin/python3 - "$CHECKOUT/$TRACKED" "$1" <<'PY'
import json, sys
path, change = sys.argv[1:]
data = json.load(open(path))
exec(change)
json.dump(data, open(path, "w"), indent=2)
PY
  git_c commit -qam 'policy change'
}

prepare_checkout "$POLICY_FIXTURE"
run_policy
edit_policy 'data["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"] = 30
data["permissions"]["deny"] = ["Read(~/.ssh/**)"]
data["permissions"]["defaultMode"] = "default"'
run_policy --check
assert_equals "$RUN_STATUS" 1 'check fails until a policy edit is applied'
assert_contains "$RUN_STDERR" 'hooks' 'check names the edited policy hooks'
assert_contains "$RUN_STDERR" 'permissions' 'check names the edited policy permissions'
run_policy
assert_equals "$RUN_STATUS" 0 'install applies a policy edit'
assert_equals "$(json_field "$MACHINE" 'hooks.PreToolUse')" '[{"hooks": [{"command": "gate.sh", "timeout": 30, "type": "command"}], "matcher": "Bash"}]' 'an edited policy hook replaces the old one'
assert_equals "$(json_field "$MACHINE" 'permissions')" '{"defaultMode": "default", "deny": ["Read(~/.ssh/**)"]}' 'policy rule retirement and defaultMode change reach the host'

/usr/bin/python3 - "$MACHINE" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["permissions"]["defaultMode"] = "plan"
data["permissions"]["deny"].append("Read(~/private/**)")
json.dump(data, open(path, "w"), indent=2)
PY
edit_policy 'data["permissions"]["deny"].append("WebFetch")'
run_policy
assert_equals "$RUN_STATUS" 0 'install merges a policy update with host changes'
assert_equals "$(json_field "$MACHINE" 'permissions')" '{"defaultMode": "plan", "deny": ["Read(~/.ssh/**)", "Read(~/private/**)", "WebFetch"]}' 'host defaultMode and rule survive a later policy update'
run_policy --check
assert_equals "$RUN_STATUS" 0 'check passes with a host-owned defaultMode'
assert_contains "$RUN_STDOUT" 'Host keeps permissions.defaultMode="plan" (policy "default")' 'check names the host value that differs from policy'
run_policy --check --strict
assert_equals "$RUN_STATUS" 1 'strict check fails while the host keeps a differing value'
assert_contains "$RUN_STDERR" 'host security values differ' 'strict check explains the host difference'
assert_contains "$RUN_STDOUT" 'permissions.deny entry "Read(~/private/**)" (host only)' 'check names a host-only rule'

edit_policy 'del data["permissions"]'
run_policy
assert_equals "$RUN_STATUS" 0 'install retires a removed policy key'
assert_equals "$(json_field "$MACHINE" 'permissions')" '{"defaultMode": "plan", "deny": ["Read(~/private/**)"]}' 'retiring a policy key keeps only host-own entries'
run_policy --check --strict
assert_equals "$RUN_STATUS" 0 'strict check passes once nothing differs'

prepare_checkout "$POLICY_FIXTURE"
run_policy
edit_policy 'del data["permissions"]'
run_policy --check
assert_equals "$RUN_STATUS" 1 'check fails until a removed policy key is retired'
run_policy
assert_equals "$(json_field "$MACHINE" 'permissions' 2>/dev/null || echo absent)" absent 'install removes a policy-only key retired from policy'

prepare_checkout "$POLICY_FIXTURE"
run_policy
/usr/bin/python3 - "$MACHINE" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["hooks"]["PreToolUse"] = {}
data["permissions"]["deny"] = ""
json.dump(data, open(path, "w"), indent=2)
PY
run_policy --check
assert_equals "$RUN_STATUS" 1 'check fails when a security value has the wrong shape'
run_policy
assert_equals "$(json_field "$MACHINE" 'hooks.PreToolUse')" "$(json_field "$POLICY_FIXTURE" 'hooks.PreToolUse')" 'install restores a mis-shaped policy hook list'
assert_equals "$(json_field "$MACHINE" 'permissions.deny')" '["AskUserQuestion"]' 'install restores a mis-shaped policy rule list'

# --- Host-correct paths survive; later policy changes still land -----------

prepare_checkout "$REPO_ROOT/$TRACKED"
run_policy
/usr/bin/python3 - "$MACHINE" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["statusLine"]["command"] = "bash /Users/server/.claude/statusline-command.sh"
data["extraKnownMarketplaces"]["personal"]["source"]["path"] = "/Users/server/code/dotfiles/config/agents/plugins"
json.dump(data, open(path, "w"), indent=2)
PY
run_policy
assert_equals "$(json_field "$MACHINE" 'statusLine.command')" '"bash /Users/server/.claude/statusline-command.sh"' 'install keeps a host-correct status line'
assert_equals "$(json_field "$MACHINE" 'extraKnownMarketplaces.personal.source.path')" '"/Users/server/code/dotfiles/config/agents/plugins"' 'install keeps a host-correct marketplace path'
run_policy --check
assert_equals "$RUN_STATUS" 0 'check accepts host-correct paths'
edit_policy 'data["statusLine"]["padding"] = 1'
run_policy
assert_equals "$(json_field "$MACHINE" 'statusLine')" '{"command": "bash /Users/server/.claude/statusline-command.sh", "padding": 1, "type": "command"}' 'a later policy change lands beside the host-correct path'

# --- Host security controls survive; only missing policy entries are added --

prepare_checkout "$REPO_ROOT/$TRACKED"
/usr/bin/python3 - "$CHECKOUT/$TRACKED" "$MACHINE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
data["hooks"].setdefault("PreToolUse", []).append(
    {"matcher": "Bash", "hooks": [{"type": "command", "command": "host-security-gate.sh"}]})
data["permissions"]["deny"].append("Read(~/private/**)")
data["permissions"]["ask"].append("Bash(git push:*)")
data["permissions"]["defaultMode"] = "auto"
json.dump(data, open(sys.argv[2], "w"), indent=2)
PY
cp "$MACHINE" "$TEST_ROOT/host-controls"
run_policy --check
assert_equals "$RUN_STATUS" 0 'check accepts host-only security controls'
run_policy
assert_equals "$RUN_STATUS" 0 'install succeeds with host-only security controls'
cmp -s "$TEST_ROOT/host-controls" "$MACHINE" || fail 'install changed host security controls'
pass 'install keeps the host gate, deny and ask rules and defaultMode'

/usr/bin/python3 - "$MACHINE" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["permissions"]["deny"].remove("AskUserQuestion")
data["hooks"].pop("SessionStart")
json.dump(data, open(path, "w"), indent=2)
PY
run_policy --check
assert_equals "$RUN_STATUS" 1 'check fails when a policy rule or hook is missing'
assert_contains "$RUN_STDERR" 'hooks' 'check names missing policy hooks'
assert_contains "$RUN_STDERR" 'permissions' 'check names a missing policy rule'
run_policy
assert_equals "$RUN_STATUS" 0 'install adds the missing policy entries'
assert_equals "$(json_field "$MACHINE" 'hooks.SessionStart')" "$(json_field "$CHECKOUT/$TRACKED" 'hooks.SessionStart')" 'install restores the missing policy hook'
assert_equals "$(/usr/bin/python3 -c 'import json,sys;p=json.load(open(sys.argv[1]))["permissions"];print(sorted(p["deny"]), p["ask"], p["defaultMode"])' "$MACHINE")" "['AskUserQuestion', 'Read(~/private/**)'] ['Bash(git push:*)'] auto" 'install restores the policy deny rule and keeps host rules'
assert_equals "$(/usr/bin/python3 -c 'import json,sys;print(sum(1 for g in json.load(open(sys.argv[1]))["hooks"]["PreToolUse"] for h in g["hooks"] if h["command"]=="host-security-gate.sh"))' "$MACHINE")" 1 'install keeps exactly one host security gate'
run_policy --check
assert_equals "$RUN_STATUS" 0 'check passes after missing entries are added'

# --- Legacy symlink layout is converted without touching the checkout -------

prepare_checkout "$POLICY_FIXTURE"
ln -s "$CHECKOUT/$TRACKED" "$MACHINE"
/usr/bin/python3 - "$MACHINE" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["enabledPlugins"]["pstack@cursor-plugins"] = True
json.dump(data, open(path, "w"), indent=2)
PY
assert_equals "$(checkout_status)" " M $TRACKED" 'legacy symlink carries a machine write into the checkout'
cp "$CHECKOUT/$TRACKED" "$TEST_ROOT/dirty-tracked"
run_policy --check
assert_equals "$RUN_STATUS" 1 'check rejects the legacy symlink'
assert_contains "$RUN_STDERR" 'symlink' 'legacy check names the symlink'
run_policy
assert_equals "$RUN_STATUS" 0 'install converts the legacy symlink'
assert_equals "$(object_type "$MACHINE")" file 'legacy link becomes a regular file'
assert_equals "$(json_field "$MACHINE" 'enabledPlugins.pstack@cursor-plugins')" true 'conversion keeps the machine write'
cmp -s "$TEST_ROOT/dirty-tracked" "$CHECKOUT/$TRACKED" || fail 'conversion changed the tracked file'
pass 'conversion leaves the tracked bytes for the owner to resolve'

# Host-own controls written through a legacy link survive the owner restoring
# the tracked file: conversion must not record the dirty file as policy.
prepare_checkout "$POLICY_FIXTURE"
ln -s "$CHECKOUT/$TRACKED" "$MACHINE"
/usr/bin/python3 - "$MACHINE" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["permissions"]["deny"].append("Read(~/.ssh/**)")
data["hooks"]["PreToolUse"].append({"matcher": "Bash", "hooks": [{"type": "command", "command": "host-gate.sh"}]})
json.dump(data, open(path, "w"), indent=2)
PY
run_policy
assert_equals "$RUN_STATUS" 0 'install converts a legacy link carrying host controls'
run_policy
assert_equals "$RUN_STATUS" 0 'repeat install before the owner cleans the tracked file'
assert_contains "$RUN_STDOUT" 'uncommitted' 'install says it does not record an uncommitted policy'
git_c checkout -q -- "$TRACKED"
run_policy
assert_equals "$RUN_STATUS" 0 'install succeeds after the owner restores the tracked file'
assert_equals "$(json_field "$MACHINE" 'permissions.deny')" '["AskUserQuestion", "Read(~/.ssh/**)"]' 'host deny rule written through the legacy link survives'
assert_equals "$(/usr/bin/python3 -c 'import json,sys;print(sum(1 for g in json.load(open(sys.argv[1]))["hooks"]["PreToolUse"] for h in g["hooks"] if h["command"]=="host-gate.sh"))' "$MACHINE")" 1 'host hook written through the legacy link survives'
run_policy
assert_equals "$(json_field "$MACHINE" 'permissions.deny')" '["AskUserQuestion", "Read(~/.ssh/**)"]' 'host deny rule survives a later setup with a committed record'
run_policy --check --strict
assert_equals "$RUN_STATUS" 1 'strict check reports the host-only controls'
assert_contains "$RUN_STDOUT" 'Read(~/.ssh/**)' 'strict check names the host-only deny rule'

prepare_checkout "$POLICY_FIXTURE"
printf '%s\n' '{"sentinel":"foreign"}' >"$TEST_ROOT/foreign.json"
ln -s "$TEST_ROOT/foreign.json" "$MACHINE"
run_policy
assert_ne_status() { [[ "$RUN_STATUS" -ne 0 ]] || fail "$1"; pass "$1"; }
assert_ne_status 'install refuses a symlink to a foreign file'
assert_equals "$(readlink "$MACHINE")" "$TEST_ROOT/foreign.json" 'foreign symlink remains'
assert_equals "$(cat "$TEST_ROOT/foreign.json")" '{"sentinel":"foreign"}' 'foreign file bytes remain'

prepare_checkout "$POLICY_FIXTURE"
rmdir "$FAKE_HOME/.claude"
mkdir -p "$TEST_ROOT/foreign-dir"
ln -s "$TEST_ROOT/foreign-dir" "$FAKE_HOME/.claude"
run_policy
assert_ne_status 'install refuses a redirected Claude directory'
assert_equals "$(object_type "$TEST_ROOT/foreign-dir/settings.json")" absent 'redirected directory stays untouched'

prepare_checkout "$POLICY_FIXTURE"
mkdir -p "$TEST_ROOT/foreign-ancestor"
ln -s "$TEST_ROOT/foreign-ancestor" "$TEST_ROOT/linked-ancestor"
EXTRA_ENV="CLAUDE_CONFIG_DIR=$TEST_ROOT/linked-ancestor/cfg" run_policy
assert_ne_status 'install refuses a redirected ancestor directory'
assert_equals "$(object_type "$TEST_ROOT/foreign-ancestor/cfg")" absent 'redirected ancestor stays untouched'

# --- Invalid machine files are preserved ------------------------------------

for content in '{malformed' '{"x": NaN}' '[]'; do
  prepare_checkout "$POLICY_FIXTURE"
  printf '%s\n' "$content" >"$MACHINE"
  cp "$MACHINE" "$TEST_ROOT/invalid-before"
  run_policy
  assert_ne_status "install refuses machine content $content"
  cmp -s "$TEST_ROOT/invalid-before" "$MACHINE" || fail "machine content $content was rewritten"
  pass "machine content $content stays unchanged"
done

# --- CLAUDE_CONFIG_DIR selects the user settings location -------------------

prepare_checkout "$POLICY_FIXTURE"
EXTRA_ENV="CLAUDE_CONFIG_DIR=$TEST_ROOT/config-dir" run_policy
assert_equals "$RUN_STATUS" 0 'install honours CLAUDE_CONFIG_DIR'
assert_equals "$(object_type "$TEST_ROOT/config-dir/settings.json")" file 'policy lands in CLAUDE_CONFIG_DIR'
assert_equals "$(object_type "$MACHINE")" absent 'default location stays untouched under CLAUDE_CONFIG_DIR'

# --- Intentional shared edits stay in Git and merge from a clean checkout ---

prepare_checkout "$POLICY_FIXTURE"
run_policy
git_c checkout -qb policy-edit
/usr/bin/python3 - "$CHECKOUT/$TRACKED" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["permissions"]["deny"].append("Bash(rm -rf /)")
json.dump(data, open(path, "w"), indent=2)
PY
assert_equals "$(checkout_status)" " M $TRACKED" 'intentional policy edit is visible to Git'
git_c commit -qam 'policy edit'
git_c checkout -q main
assert_equals "$(checkout_status)" '' 'integration checkout is clean before merge'
git_c merge -q --no-ff -m 'merge policy edit' policy-edit || fail 'merge from clean checkout failed'
pass 'merge succeeds from the clean integration checkout'
run_policy
assert_equals "$(json_field "$MACHINE" 'permissions.deny')" '["AskUserQuestion", "Bash(rm -rf /)"]' 'merged policy reaches the machine file'
assert_equals "$(checkout_status)" '' 'applying merged policy leaves the checkout clean'

# --- Real Claude settings operations ----------------------------------------

real_rows_expected=2
real_rows_covered=0
real_rows_skipped=0

run_claude() {
  (cd "$TEST_ROOT" && env -i HOME="$FAKE_HOME" PATH="/usr/bin:/bin:$(dirname "$CLAUDE_BIN")" \
    TMPDIR="$TEST_ROOT" USER="${USER:-test}" GIT_TERMINAL_PROMPT=0 \
    "$CLAUDE_BIN" "$@" </dev/null >>"$TEST_ROOT/claude.log" 2>&1)
}

prepare_market() {
  MARKET="$TEST_ROOT/market"
  mkdir -p "$MARKET/.claude-plugin" "$MARKET/plugins/canary/.claude-plugin"
  printf '%s\n' '{"name":"test-local","owner":{"name":"test"},"plugins":[{"name":"canary","source":"./plugins/canary","description":"canary"}]}' \
    >"$MARKET/.claude-plugin/marketplace.json"
  printf '%s\n' '{"name":"canary","version":"0.0.1","description":"canary"}' \
    >"$MARKET/plugins/canary/.claude-plugin/plugin.json"
}

settings_round() {
  run_claude plugin marketplace add "$MARKET" --scope user
  run_claude plugin install canary@test-local --scope user
  run_claude plugin disable canary@test-local --scope user
  run_claude plugin enable canary@test-local --scope user
}

if [[ -x "$CLAUDE_BIN" ]]; then
  prepare_market

  # Negative control: the legacy symlink layout dirties a clean checkout.
  prepare_checkout "$REPO_ROOT/$TRACKED"
  ln -s "$CHECKOUT/$TRACKED" "$MACHINE"
  assert_equals "$(checkout_status)" '' 'legacy layout starts from a clean checkout'
  run_claude plugin marketplace add "$MARKET" --scope user
  assert_equals "$(checkout_status)" " M $TRACKED" 'legacy layout: one supported Claude write dirties the checkout'
  real_rows_covered=$((real_rows_covered + 1))

  # Fixed layout: repeated supported writes stay out of the checkout.
  prepare_checkout "$REPO_ROOT/$TRACKED"
  tracked_before="$(shasum -a 256 "$CHECKOUT/$TRACKED")"
  run_policy
  settings_round
  # A fresh HOME lets Claude run its one-time settings migrations; setup
  # reasserts policy afterwards, as on a new machine.
  run_policy
  settings_round
  settings_round
  assert_equals "$(checkout_status)" '' 'fixed layout: repeated Claude writes leave the checkout clean'
  assert_equals "$(shasum -a 256 "$CHECKOUT/$TRACKED")" "$tracked_before" 'fixed layout: tracked bytes unchanged'
  assert_equals "$(object_type "$MACHINE")" file 'Claude keeps the machine file regular'
  assert_equals "$(json_field "$MACHINE" 'enabledPlugins.canary@test-local')" true 'Claude wrote the plugin choice to the machine file'
  for key in hooks permissions skillOverrides; do
    assert_equals "$(json_field "$MACHINE" "$key")" "$(json_field "$CHECKOUT/$TRACKED" "$key")" "machine $key equal the tracked policy after Claude writes"
  done
  run_policy --check
  assert_equals "$RUN_STATUS" 0 'check passes after Claude plugin choices'
  real_rows_covered=$((real_rows_covered + 1))
else
  printf '# skip real-Claude rows: no claude executable on PATH (set CLAUDE_SETTINGS_TEST_CLAUDE)\n'
  real_rows_skipped=$real_rows_expected
fi

assert_equals "$((real_rows_covered + real_rows_skipped))" "$real_rows_expected" 'real-Claude rows are all accounted for'
printf '# real-Claude rows: covered=%d skipped=%d\n' "$real_rows_covered" "$real_rows_skipped"
printf '1..%d\n' "$assertion_count"
