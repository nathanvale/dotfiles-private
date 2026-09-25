#!/usr/bin/env bash
#
# Agent lane receipt contract.
#
# `bin/agent-lane-receipt` is run BY an agent, INSIDE that agent's own real
# command lane, and emits one metadata-only receipt describing what that lane's
# effective shell state actually is after the harness replayed its snapshot.
#
# The receipt is the unit of evidence for issue 54. It is what lets a supervisor
# say "the Claude Bash lane passed" without ever seeing a snapshot's contents.
# So this file proves the properties that make a receipt worth trusting:
#
#   admission    only a snapshot created after the repair boundary is admitted,
#                so a receipt can never be satisfied by pre-repair evidence
#   binding      the receipt names the ZDOTDIR whose startup files the lane
#                actually captured, so a lane that captured the installed
#                profile can never be reported as proof of the repaired one
#   attribution  the receipt names the product, version, shell, lane, task start,
#                snapshot path, file mode, and SHA-256 that produced it
#   redaction    neither stream nor the stored receipt carries snapshot contents
#                or an environment value
#   verdict      the probe rows report what the lane's state IS, not what the
#                startup files say, and go RED against a hostile snapshot
#   custody      the raw receipt lands in private XDG state with private mode,
#                and one lane's receipt never overwrites another's
#
# The shell-semantics contract itself is NOT restated here. The generator
# delegates it to bin/test/zsh-effective-behavior-test.sh through that file's
# existing ZSH_CONTRACT_SNAPSHOT replay lane, and this file proves the
# delegation happened and its verdict was carried faithfully.
#
# Every fixture is synthetic. No fixture carries a credential, and no assertion
# prints a snapshot body or an environment value.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"

# The generator this run exercises.
#
# REAL_GENERATOR is always the committed tool. GENERATOR is what the rows below
# actually invoke, and the hostile-regression section at the end re-enters this
# suite with it pointed at a deliberately broken COPY. That indirection is what
# lets the suite prove its own sensitivity without ever editing the real file.
REAL_GENERATOR="$REPO_ROOT/bin/agent-lane-receipt"
GENERATOR="${AGENT_LANE_RECEIPT_UNDER_TEST:-$REAL_GENERATOR}"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

assertion_count=0
skip_count=0

pass() {
  assertion_count=$((assertion_count + 1))
  printf 'ok %d - %s\n' "$assertion_count" "$1"
}

skip() {
  assertion_count=$((assertion_count + 1))
  skip_count=$((skip_count + 1))
  printf 'ok %d - # SKIP %s\n' "$assertion_count" "$1"
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

# A value planted inside every fixture snapshot body. It stands for whatever a
# real snapshot carries that must not be republished: an exported value, a
# token-shaped string, a private path. The receipt must never echo it.
#
# It is planted as two active `print` statements rather than inert text, so a
# replayed fixture genuinely pushes it at both stdout and stderr. A generator
# that forgets to redirect its replay fails the redaction rows rather than
# passing because nothing was ever emitted.
SNAPSHOT_BODY_MARKER='agent-lane-receipt-snapshot-body-marker-do-not-print'

# A value handed to the generator through the environment. A receipt that
# projected its own environment would republish it.
ENV_VALUE_MARKER='agent-lane-receipt-env-value-marker-do-not-print'

# Silent disclosure predicate. Returns 0 when the text is clean, 1 when it
# carries a protected value. Prints nothing either way, so proving that it
# rejects a marker never reproduces the marker.
stream_is_clean() {
  local stream="$1"
  local marker
  for marker in "$SNAPSHOT_BODY_MARKER" "$ENV_VALUE_MARKER"; do
    [[ "$stream" != *"$marker"* ]] || return 1
  done
  return 0
}

# Negative control for the predicate above.
#
# Without this, a predicate that silently matched nothing would report every
# stream clean and every redaction row below would be vacuous. Only the exit
# status is read, so a protected value is never printed to prove it is caught.
assert_detector_rejects() {
  local stream="$1" label="$2"
  if stream_is_clean "$stream"; then
    fail "$label (detector accepted a stream carrying a protected value)"
  fi
  pass "$label"
}

assert_detector_rejects \
  "receipt noise ${SNAPSHOT_BODY_MARKER} more noise" \
  'disclosure detector rejects a planted snapshot body'

assert_detector_rejects \
  "receipt noise ${ENV_VALUE_MARKER} more noise" \
  'disclosure detector rejects a planted environment value'

if stream_is_clean 'lane=claude-bash probe_glob=PASS'; then
  pass 'disclosure detector accepts a clean receipt line'
else
  fail 'disclosure detector rejected a clean receipt line'
fi

# --- Fixture snapshots ------------------------------------------------------
#
# Two snapshot bodies that differ in exactly one way: the hostile one re-enables
# a hazard the repair removed. That difference is what makes the probe rows a
# measurement. Against a single safe fixture, a generator that hardcoded PASS
# would satisfy every probe row in this file.
snapshot_dir="$TEST_ROOT/snapshots"
mkdir -p "$snapshot_dir"

write_snapshot() {
  local path="$1" hostile="$2"
  {
    printf 'print -r -- %s\n' "$SNAPSHOT_BODY_MARKER"
    printf 'print -r -- %s >&2\n' "$SNAPSHOT_BODY_MARKER"
    if [[ "$hostile" == 'hostile' ]]; then
      # The exact hazards issue 48 removed, restored the way a real captured
      # interactive snapshot would restore them.
      printf 'setopt nullglob\n'
      printf 'setopt extendedglob\n'
      printf 'setopt globdots\n'
    fi
  } >"$path"
  chmod 600 "$path"
}

safe_snapshot="$snapshot_dir/snapshot-zsh-safe.sh"
hostile_snapshot="$snapshot_dir/snapshot-zsh-hostile.sh"
stale_snapshot="$snapshot_dir/snapshot-zsh-stale.sh"
write_snapshot "$safe_snapshot" 'safe'
write_snapshot "$hostile_snapshot" 'hostile'
write_snapshot "$stale_snapshot" 'safe'

# The repair boundary this test hands the generator. Fresh fixtures are stamped
# after it; the stale fixture is stamped before it. The oracle is a filesystem
# fact the test sets, not a value read back from the generator.
BOUNDARY_EPOCH=1787236121
touch -t 202608210040.00 "$safe_snapshot"
touch -t 202608210040.00 "$hostile_snapshot"
touch -t 202608200900.00 "$stale_snapshot"

# The fresh fixtures' mtime, read back from the filesystem rather than converted
# by hand from the touch stamp above, so the lane-start rows compare against the
# same value the generator sees.
snapshot_epoch="$(stat -f '%m' "$safe_snapshot")"

# Private state root the generator must write into. Kept inside the test root so
# the operator's real receipts are never touched by a test run.
state_root="$TEST_ROOT/state"

# --task-start is mandatory, so a row that is not ABOUT lane-start ordering
# still has to supply one. Rather than repeat the flag at every call site, the
# runners below add a satisfying default when the row did not name one itself.
#
# The default is one hour before the fixtures' mtime, so it clears the ordering
# gate for the fresh fixtures and leaves each row testing what it says it tests.
# A row that DOES pass --task-start keeps its own value: the helper only fills a
# gap, so the lane-start rows still control the comparison they exist to make.
#
# Detection is over the argument list rather than a flag, because a helper that
# had to be told would be one more thing each row could forget.
DEFAULT_TASK_START="$((snapshot_epoch - 3600))"

with_default_task_start() {
  local arg
  for arg in "$@"; do
    if [[ "$arg" == '--task-start' ]]; then
      printf '%s\0' "$@"
      return 0
    fi
  done
  printf '%s\0' "$@" '--task-start' "$DEFAULT_TASK_START"
}

# Run the generator as a real child process.
# Sets gen_out, gen_err, gen_status.
run_generator() {
  local err_file="$TEST_ROOT/stderr.run"
  : >"$err_file" || fail 'could not create stderr receipt'
  local -a call=()
  while IFS= read -r -d '' arg; do
    call+=("$arg")
  done < <(with_default_task_start "$@")
  set +e
  gen_out="$(
    env \
      XDG_STATE_HOME="$state_root" \
      AGENT_LANE_RECEIPT_BOUNDARY_EPOCH="$BOUNDARY_EPOCH" \
      AGENT_LANE_RECEIPT_SECRET="$ENV_VALUE_MARKER" \
      "$GENERATOR" "${call[@]}" 2>"$err_file"
  )"
  gen_status=$?
  set -e
  gen_err="$(<"$err_file")"
}

# As above, but places a real ZDOTDIR in the child's environment.
#
# The binding rows need to vary the claim and the reality independently, because
# `--zdotdir` is only a measurement if the two can disagree. This wrapper is what
# lets a row assert that they must agree.
run_generator_with_zdotdir() {
  local real_zdotdir="$1"; shift
  local err_file="$TEST_ROOT/stderr.zrun"
  : >"$err_file"
  local -a call=()
  while IFS= read -r -d '' arg; do
    call+=("$arg")
  done < <(with_default_task_start "$@")
  set +e
  gen_out="$(
    env \
      XDG_STATE_HOME="$state_root" \
      AGENT_LANE_RECEIPT_BOUNDARY_EPOCH="$BOUNDARY_EPOCH" \
      AGENT_LANE_RECEIPT_SECRET="$ENV_VALUE_MARKER" \
      ZDOTDIR="$real_zdotdir" \
      "$GENERATOR" "${call[@]}" 2>"$err_file"
  )"
  gen_status=$?
  set -e
  gen_err="$(<"$err_file")"
}

# --- The generator exists and is executable ---------------------------------
[[ -f "$GENERATOR" ]] || fail 'bin/agent-lane-receipt does not exist'
pass 'the generator exists'
[[ -x "$GENERATOR" ]] || fail 'bin/agent-lane-receipt is not executable'
pass 'the generator is executable'

# --- Admission: a fresh snapshot is admitted --------------------------------
run_generator --lane test-fresh --snapshot "$safe_snapshot" --product-version 'test 1.0'
assert_equals "$gen_status" '0' 'fresh snapshot: generator exits zero'

# --- Attribution: every required field is present ---------------------------
#
# Each field is named separately so a missing one reports which part of the
# receipt's provenance was lost, rather than only that the receipt was wrong.
# `snapshot_path` is checked against the STORED receipt rather than this list,
# because it is the one required field withheld from stdout. See the disclosure
# rows below for both halves of that split.
fresh_receipt="$state_root/agent-lane-receipts/test-fresh.receipt"
[[ -f "$fresh_receipt" ]] || fail 'no receipt was written for the fresh lane'

for field in product product_version shell task_start lane \
  snapshot_mode snapshot_sha256; do
  if ! grep -q "^${field}=" <<<"$gen_out"; then
    fail "receipt is missing the ${field} field"
  fi
  pass "receipt records ${field}"
done

if ! grep -q '^snapshot_path=' "$fresh_receipt"; then
  fail 'the stored receipt is missing the snapshot_path field'
fi
pass 'the stored receipt records snapshot_path'

# The recorded hash must equal an independently computed one. Comparing against
# the generator's own computation would be tautological.
expected_sha="$(shasum -a 256 "$safe_snapshot" | awk '{print $1}')"
assert_equals "$(grep '^snapshot_sha256=' <<<"$gen_out" | sed 's/^snapshot_sha256=//')" \
  "$expected_sha" 'receipt hash matches an independently computed SHA-256'

expected_mode="$(stat -f '%Lp' "$safe_snapshot")"
assert_equals "$(grep '^snapshot_mode=' <<<"$gen_out" | sed 's/^snapshot_mode=//')" \
  "$expected_mode" 'receipt mode matches the snapshot file mode'

assert_equals "$(grep '^lane=' <<<"$gen_out" | sed 's/^lane=//')" \
  'test-fresh' 'receipt names the lane it was asked for'

assert_equals "$(sed -n 's/^snapshot_path=//p' "$fresh_receipt" | head -1)" \
  "$safe_snapshot" 'the stored receipt names the snapshot path it inspected'

# The shell row must name the interpreter that actually ran the probes, not a
# configured preference. A receipt naming a shell the probes never used would
# misattribute every verdict below it.
assert_contains "$(grep '^shell=' <<<"$gen_out")" 'zsh' 'receipt names a zsh shell'

# --- Redaction: neither stream carries a protected value --------------------
stream_is_clean "$gen_out" || fail 'fresh snapshot: stdout disclosed a protected value'
pass 'fresh snapshot: stdout discloses no protected value'
stream_is_clean "$gen_err" || fail 'fresh snapshot: stderr disclosed a protected value'
pass 'fresh snapshot: stderr discloses no protected value'

# --- Custody: the raw receipt is durable, private, and independently read ----
#
# Read back through the filesystem rather than trusting stdout, so the durable
# artefact is proved by an independent reader.
receipt_path="$(grep '^receipt_path=' <<<"$gen_out" | sed 's/^receipt_path=//')"
[[ -n "$receipt_path" ]] || fail 'receipt does not name its own stored path'
pass 'receipt names its stored path'

[[ -f "$receipt_path" ]] || fail 'the stored receipt file does not exist'
pass 'the stored receipt exists on disk'

case "$receipt_path" in
  "$state_root"/*) pass 'the stored receipt lives under private XDG state' ;;
  *) fail 'the stored receipt escaped the private XDG state root' ;;
esac

case "$receipt_path" in
  "$REPO_ROOT"/*) fail 'the stored receipt was written inside the repository' ;;
  *) pass 'the stored receipt is outside the repository' ;;
esac

assert_equals "$(stat -f '%Lp' "$receipt_path")" '600' \
  'the stored receipt has private file mode'

stored="$(<"$receipt_path")"
stream_is_clean "$stored" || fail 'the stored receipt disclosed a protected value'
pass 'the stored receipt discloses no protected value'

assert_contains "$stored" 'lane=test-fresh' 'the stored receipt carries its lane'
assert_contains "$stored" "snapshot_sha256=$expected_sha" \
  'the stored receipt carries the snapshot hash'

# --- Verdict: the safe fixture passes every probe ---------------------------
#
# The six probe classes issue 54 requires. Each is named so a failure reports
# which semantic guarantee the lane lost.
for probe in argument glob navigation command_resolution output_noise repeated_call; do
  verdict="$(grep "^probe_${probe}=" <<<"$gen_out" | sed "s/^probe_${probe}=//")"
  assert_equals "$verdict" 'PASS' "safe snapshot: ${probe} probe passes"
done

assert_equals "$(grep '^verdict=' <<<"$gen_out" | sed 's/^verdict=//')" 'PASS' \
  'safe snapshot: overall verdict is PASS'

# --- Verdict sensitivity: the hostile fixture must fail ---------------------
#
# This is the load-bearing pair in this file. Every probe row above is satisfied
# by a generator that hardcodes PASS; only a fixture that genuinely reopens a
# hazard can tell a real measurement from a claim.
run_generator --lane test-hostile --snapshot "$hostile_snapshot" --product-version 'test 1.0'
[[ "$gen_status" -ne 0 ]] || fail 'hostile snapshot: generator must exit non-zero'
pass 'hostile snapshot: generator exits non-zero'

assert_equals "$(grep '^probe_glob=' <<<"$gen_out" | sed 's/^probe_glob=//')" 'FAIL' \
  'hostile snapshot: glob probe reports FAIL'
assert_equals "$(grep '^probe_argument=' <<<"$gen_out" | sed 's/^probe_argument=//')" 'FAIL' \
  'hostile snapshot: argument probe reports FAIL'
assert_equals "$(grep '^verdict=' <<<"$gen_out" | sed 's/^verdict=//')" 'FAIL' \
  'hostile snapshot: overall verdict is FAIL'

# A failing lane must still redact. A diagnostic is the most likely place for a
# snapshot body to leak, so the claim is asserted on the failure path too.
stream_is_clean "$gen_out" || fail 'hostile snapshot: stdout disclosed a protected value'
pass 'hostile snapshot: stdout discloses no protected value'
stream_is_clean "$gen_err" || fail 'hostile snapshot: stderr disclosed a protected value'
pass 'hostile snapshot: stderr discloses no protected value'

# --- Custody: one lane never overwrites another -----------------------------
#
# Lane identity is the receipt's idempotency key. Two lanes proved in one
# session must leave two receipts, or the second silently destroys the first
# lane's evidence.
hostile_receipt="$(grep '^receipt_path=' <<<"$gen_out" | sed 's/^receipt_path=//')"
[[ "$hostile_receipt" != "$receipt_path" ]] ||
  fail 'a second lane overwrote the first lane receipt'
pass 'a second lane writes its own receipt'
[[ -f "$receipt_path" ]] || fail 'the first lane receipt was destroyed'
pass 'the first lane receipt survives a second lane'

# --- Admission: a pre-repair snapshot is refused ----------------------------
#
# The stale fixture is byte-identical to the safe one and differs only in mtime,
# so this row cannot pass because the file was malformed. It passes only if
# admission is genuinely a freshness decision.
run_generator --lane test-stale --snapshot "$stale_snapshot" --product-version 'test 1.0'
[[ "$gen_status" -ne 0 ]] || fail 'stale snapshot: generator must refuse a pre-repair snapshot'
pass 'stale snapshot: generator refuses a pre-repair snapshot'
assert_contains "$gen_err" 'pre-repair' 'stale snapshot: refusal names the reason'

# A refused lane must not leave a receipt that could later be counted as proof.
stale_receipt="$state_root/agent-lane-receipts/test-stale.receipt"
[[ ! -f "$stale_receipt" ]] || fail 'a refused lane left a receipt behind'
pass 'a refused lane leaves no receipt'

# --- Admission: a missing snapshot is refused, not invented -----------------
run_generator --lane test-missing --snapshot "$snapshot_dir/no-such-snapshot.sh" \
  --product-version 'test 1.0'
[[ "$gen_status" -ne 0 ]] || fail 'missing snapshot: generator must exit non-zero'
pass 'missing snapshot: generator exits non-zero'

# --- Argument parsing: a flag with no value is refused, not silent ----------
#
# `shift 2` with one argument left does not shift and does not continue. Under
# macOS's bash 3.2 the shift fails, `set -e` takes it, and the process exits 1
# having printed nothing at all. That is indistinguishable from a refused
# admission, so an operator whose pasted command was truncated would re-run it
# rather than repair it.
#
# STATUS ALONE CANNOT SEE THIS. The exit status is 1 both before and after the
# repair, so these rows read the DIAGNOSTIC: the refusal must name the specific
# flag whose value is missing. A generator that regressed to a bare `shift 2`
# fails here on an empty stderr while still exiting non-zero.
# These rows call the generator DIRECTLY rather than through run_generator.
# That helper appends a default --task-start when a row did not name one, which
# would hand `--task-start` the very value this row exists to withhold and would
# quietly turn the truncated command into a well-formed one.
run_generator_raw() {
  local err_file="$TEST_ROOT/stderr.raw"
  : >"$err_file"
  set +e
  gen_out="$(
    env \
      XDG_STATE_HOME="$state_root" \
      AGENT_LANE_RECEIPT_BOUNDARY_EPOCH="$BOUNDARY_EPOCH" \
      AGENT_LANE_RECEIPT_SECRET="$ENV_VALUE_MARKER" \
      "$GENERATOR" "$@" 2>"$err_file"
  )"
  gen_status=$?
  set -e
  gen_err="$(<"$err_file")"
}

for flag in --lane --snapshot --product --product-version --zdotdir \
  --task-start --boundary-epoch; do
  run_generator_raw "$flag"
  [[ "$gen_status" -ne 0 ]] ||
    fail "trailing ${flag}: generator must exit non-zero"
  assert_contains "$gen_err" "$flag" \
    "trailing ${flag}: the refusal names the flag whose value is missing"
done

# --- Freshness arguments are mandatory --------------------------------------
#
# Both epochs carry the entire admission decision, so a run allowed to omit one
# emits `verdict=PASS` with no gate having run. That was the cheapest way to
# manufacture a passing receipt: leave the flag off.
#
# The rows read the DIAGNOSTIC, not just the status. A generator that refused
# every incomplete command for some unrelated reason would satisfy a status-only
# assertion while leaving the actual requirement unstated to the operator.
run_generator_raw --lane test-no-start --snapshot "$safe_snapshot" \
  --boundary-epoch "$BOUNDARY_EPOCH"
[[ "$gen_status" -ne 0 ]] || fail 'a run without --task-start must be refused'
assert_contains "$gen_err" '--task-start' \
  'mandatory epochs: a run without --task-start is refused by name'

# The boundary epoch has an environment default, so this row must withhold BOTH
# the flag and AGENT_LANE_RECEIPT_BOUNDARY_EPOCH. Dropping only the flag would
# leave the default supplying a valid value, and the row would pass while
# proving nothing about the requirement.
no_boundary_err="$TEST_ROOT/stderr.noboundary"
: >"$no_boundary_err"
set +e
env -u AGENT_LANE_RECEIPT_BOUNDARY_EPOCH \
  XDG_STATE_HOME="$state_root" \
  AGENT_LANE_RECEIPT_SECRET="$ENV_VALUE_MARKER" \
  "$GENERATOR" --lane test-no-boundary --snapshot "$safe_snapshot" \
  --task-start "$DEFAULT_TASK_START" >/dev/null 2>"$no_boundary_err"
gen_status=$?
set -e
gen_err="$(<"$no_boundary_err")"
[[ "$gen_status" -ne 0 ]] || fail 'a run without --boundary-epoch must be refused'
assert_contains "$gen_err" '--boundary-epoch' \
  'mandatory epochs: a run without --boundary-epoch is refused by name'

# The complement: the environment default IS still honoured when present, so the
# requirement above did not quietly remove a supported way to supply the value.
run_generator_raw --lane test-env-boundary --snapshot "$safe_snapshot" \
  --product-version 'test 1.0' --task-start "$DEFAULT_TASK_START"
assert_equals "$gen_status" '0' \
  'mandatory epochs: the boundary environment default still satisfies the requirement'

[[ ! -f "$state_root/agent-lane-receipts/test-no-start.receipt" ]] ||
  fail 'a run refused for a missing epoch left a receipt behind'
pass 'mandatory epochs: a refused run leaves no receipt'

# A DIGIT STRING IS NOT A TIME.
#
# `^[0-9]+$` accepts `0`, and every real snapshot mtime is greater than zero, so
# a zero epoch satisfies both `-le` comparisons for every possible input. The
# gate stays present and keeps reporting success while admitting everything,
# which reads as enforcement and is not. These rows are why the validation is a
# positive-integer check rather than a numeric one.
for bad_epoch in 0 00 -1 '' 'abc' '12.5' ' 12'; do
  run_generator_raw --lane test-bad-epoch --snapshot "$safe_snapshot" \
    --task-start "$bad_epoch" --boundary-epoch "$BOUNDARY_EPOCH"
  [[ "$gen_status" -ne 0 ]] ||
    fail "a --task-start of [$bad_epoch] must be refused"
  pass "mandatory epochs: --task-start rejects [$bad_epoch]"
done

# The complement. Without it every row above is satisfied by a generator that
# refuses every epoch it is given, which would refuse all real lanes too.
run_generator_raw --lane test-good-epoch --snapshot "$safe_snapshot" \
  --product-version 'test 1.0' \
  --task-start "$DEFAULT_TASK_START" --boundary-epoch "$BOUNDARY_EPOCH"
assert_equals "$gen_status" '0' 'mandatory epochs: a positive integer epoch is accepted'

# The receipt records the epochs it was ACTUALLY admitted against, because the
# audit re-derives the ordering from these fields without seeing the snapshot.
assert_equals "$(grep '^task_start_epoch=' <<<"$gen_out" | sed 's/^task_start_epoch=//')" \
  "$DEFAULT_TASK_START" 'receipt records the task-start epoch that was enforced'
assert_equals "$(grep '^boundary_epoch=' <<<"$gen_out" | sed 's/^boundary_epoch=//')" \
  "$BOUNDARY_EPOCH" 'receipt records the boundary epoch that was enforced'

# The refusal is about a MISSING value, not an empty one. An explicitly empty
# value is consumed as a value and reaches the field's own validation, so this
# gate cannot be satisfied by refusing every falsy argument.
run_generator --lane ''
[[ "$gen_status" -ne 0 ]] || fail 'an empty lane name must still be refused'
assert_contains "$gen_err" 'a --lane name is required' \
  'an explicitly empty value reaches its own validation, not the missing-value refusal'

# --- Binding: the receipt names the profile the lane actually captured ------
#
# This is the row that closes the failure the supervisor caught by hand. The
# installed ~/.zshrc is a symlink into the CANONICAL checkout, so an ordinary
# agent session captures the canonical startup files, not this worktree's
# repaired ones. Such a session's snapshot still carries the removed hazards,
# and reporting it as a #54 receipt would claim the repair was proved by a lane
# that never read the repaired files.
#
# A receipt must therefore name the ZDOTDIR it was bound to, and must refuse to
# claim repaired-profile proof when that binding is absent. "Which files did
# this lane actually read" is the receipt's load-bearing provenance, not a
# convenience field.
run_generator_with_zdotdir "$REPO_ROOT" --lane test-bound --snapshot "$safe_snapshot" \
  --product-version 'test 1.0' --zdotdir "$REPO_ROOT"
assert_equals "$gen_status" '0' 'bound lane: generator exits zero'
assert_equals "$(grep '^zdotdir=' <<<"$gen_out" | sed 's/^zdotdir=//')" \
  "$(CDPATH='' cd "$REPO_ROOT" && pwd -P)" 'bound lane: receipt names the ZDOTDIR it was bound to'
assert_equals "$(grep '^profile_binding=' <<<"$gen_out" | sed 's/^profile_binding=//')" \
  'worktree' 'bound lane: receipt reports a worktree profile binding'

# Unbound is not an error, but it must be reported as unbound rather than
# silently presented as repaired-profile proof.
run_generator --lane test-unbound --snapshot "$safe_snapshot" --product-version 'test 1.0'
assert_equals "$(grep '^profile_binding=' <<<"$gen_out" | sed 's/^profile_binding=//')" \
  'unbound' 'unbound lane: receipt reports an unbound profile binding'

# A binding that points somewhere without the startup owners is a mistake the
# receipt must catch, not record. Otherwise a typo in the launch command would
# produce a confident receipt attributing the verdict to files never read.
#
# A real ZDOTDIR is placed in the environment and the claim points at the same
# directory, so the only thing wrong is that the directory holds no startup
# owners. Without that, the row would pass because the binding was absent and
# would prove nothing about owner validation.
owner_less="$TEST_ROOT/nowhere"
mkdir -p "$owner_less"
run_generator_with_zdotdir "$owner_less" --lane test-badbind --snapshot "$safe_snapshot" \
  --product-version 'test 1.0' --zdotdir "$owner_less"
[[ "$gen_status" -ne 0 ]] || fail 'bad binding: generator must refuse a ZDOTDIR with no startup owners'
pass 'bad binding: generator refuses a ZDOTDIR with no startup owners'
assert_contains "$gen_err" 'startup owners' 'bad binding: refusal names the missing owners'

# --- Admission: the snapshot must belong to THIS lane -----------------------
#
# Clearing the repair boundary is not enough. A snapshot captured by an EARLIER
# post-repair session also clears it, so without this gate one lane's launch
# could be reported as another lane's evidence.
#
# The fixture is the safe snapshot, unchanged. Only the claimed start time moves,
# so a row that passes here cannot be passing because the file was different.
run_generator --lane test-lane-start --snapshot "$safe_snapshot" \
  --product-version 'test 1.0' --task-start "$((snapshot_epoch - 60))"
assert_equals "$gen_status" '0' 'lane start: a snapshot newer than lane start is admitted'

run_generator --lane test-preceding --snapshot "$safe_snapshot" \
  --product-version 'test 1.0' --task-start "$((snapshot_epoch + 60))"
[[ "$gen_status" -ne 0 ]] || fail 'lane start: a snapshot older than lane start must be refused'
pass 'lane start: a snapshot older than lane start is refused'

# Equality is refused rather than rounded down. A snapshot stamped the same
# second as the launch cannot be shown to have been caused by it.
run_generator --lane test-sametime --snapshot "$safe_snapshot" \
  --product-version 'test 1.0' --task-start "$snapshot_epoch"
[[ "$gen_status" -ne 0 ]] || fail 'lane start: a snapshot equal to lane start must be refused'
pass 'lane start: a snapshot equal to lane start is refused'

[[ ! -f "$state_root/agent-lane-receipts/test-preceding.receipt" ]] ||
  fail 'a lane refused for ordering left a receipt behind'
pass 'a lane refused for ordering leaves no receipt'

# --- Binding: the claim is checked against the real environment -------------
#
# `--zdotdir` must be a measurement, not a label. These rows run the generator
# with a real ZDOTDIR in the environment and vary whether it agrees with the
# claim, so a generator that merely echoed the flag fails them. The matching
# case itself is already proved above ("bound lane: receipt reports a worktree
# profile binding"), so only the mismatch and absent cases need their own rows
# here.

# The claim names the repository; the process actually ran somewhere else.
# A label-only implementation reports `worktree` here and is wrong.
decoy_zdotdir="$TEST_ROOT/decoy"
mkdir -p "$decoy_zdotdir"
: >"$decoy_zdotdir/.zshenv"
: >"$decoy_zdotdir/.zshrc"
run_generator_with_zdotdir "$decoy_zdotdir" --lane test-bind-mismatch \
  --snapshot "$safe_snapshot" --product-version 'test 1.0' --zdotdir "$REPO_ROOT"
[[ "$gen_status" -ne 0 ]] || fail 'binding: a claim contradicting the real ZDOTDIR must be refused'
pass 'binding: a claim contradicting the real ZDOTDIR is refused'
[[ ! -f "$state_root/agent-lane-receipts/test-bind-mismatch.receipt" ]] ||
  fail 'a lane refused for a binding mismatch left a receipt behind'
pass 'a lane refused for a binding mismatch leaves no receipt'

# Claiming a binding while the process has none is the failure this whole gate
# exists to catch: it is what an ordinary unbound session would do if it simply
# passed the flag.
run_generator --lane test-bind-absent --snapshot "$safe_snapshot" \
  --product-version 'test 1.0' --zdotdir "$REPO_ROOT"
[[ "$gen_status" -ne 0 ]] || fail 'binding: claiming a binding with no real ZDOTDIR must be refused'
pass 'binding: claiming a binding with no real ZDOTDIR is refused'

# The row above is satisfied by the WRONG mechanism, which is why this one
# exists.
#
# Two separate guards refuse this same fixture. The explicit one names the
# absent binding and tells the operator to launch with a process-scoped
# ZDOTDIR. Downstream, canonical_dir also fails on the empty value and reports
# that the ZDOTDIR "does not resolve to a directory". Deleting the explicit
# guard therefore leaves the run still exiting non-zero, so a status-only row
# cannot tell the two apart and the explicit guard is not independently held.
#
# This row reads the guard's OWN diagnostic. The distinction matters to the
# operator, not just to the suite: "no ZDOTDIR, launch the lane bound" is an
# instruction they can act on, while "does not resolve to a directory" describes
# an empty string as though it were a bad path.
assert_contains "$gen_err" 'no ZDOTDIR' \
  'binding: the absent-binding refusal names the absent binding'
assert_contains "$gen_err" 'process-scoped ZDOTDIR' \
  'binding: the absent-binding refusal tells the operator how to launch bound'
case "$gen_err" in
  *'does not resolve to a directory'*)
    fail 'binding: the absent-binding case fell through to the downstream resolver diagnostic' ;;
  *) pass 'binding: the absent-binding case is caught by its own guard, not the resolver' ;;
esac

# Canonically equal paths must not read as a mismatch.
run_generator_with_zdotdir "$REPO_ROOT/" --lane test-bind-canon \
  --snapshot "$safe_snapshot" --product-version 'test 1.0' --zdotdir "$REPO_ROOT"
assert_equals "$gen_status" '0' 'binding: a trailing slash is not a mismatch'

# --- Containment: a bound run deposits nothing in the repository ------------
#
# Closes a leak found during implementation. The probe child was given the
# ZDOTDIR as its HOME, so fnm and atuin initialised under it and wrote
# `.config/` and `.local/` straight into the worktree. The binding must decide
# which startup files are READ without deciding where tool state is WRITTEN.
#
# The oracle is the repository's own untracked-file list before and after a
# bound run, so it catches any deposit rather than only the two paths already
# seen.
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  untracked_before="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all | sort)"
  run_generator_with_zdotdir "$REPO_ROOT" --lane test-contain --snapshot "$safe_snapshot" \
    --product-version 'test 1.0' --zdotdir "$REPO_ROOT"
  untracked_after="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all | sort)"
  assert_equals "$untracked_after" "$untracked_before" \
    'a bound run deposits no new file in the repository'
else
  skip 'repository containment (git unavailable)'
fi

# --- Delegation: the shell contract is reused, not duplicated ---------------
#
# Issue 54 requires the shell contract to be reused rather than restated. The
# receipt must name the sibling harness it delegated to and carry that harness's
# own plan and skip counts, so a supervisor can tell a delegated verdict from a
# reimplemented one.
#
# The sibling harness ships in this repository, so a non-zero exit here is a
# delegation or contract failure, never an unavailable environment. A nested
# hostile-regression run drives a perturbed copy from outside the repository,
# and the generator finds the sibling from its own path, so delegation cannot
# run there; the top-level run owns these rows.
if [[ -n "${AGENT_LANE_RECEIPT_UNDER_TEST:-}" ]]; then
  skip 'delegated shell contract (nested run)'
  skip 'delegated contract assertion count (nested run)'
  skip 'delegated contract verdict (nested run)'
  skip 'delegated run disclosure (nested run)'
else
  run_generator --lane test-delegate --snapshot "$safe_snapshot" \
    --product-version 'test 1.0' --replay-contract
  [[ "$gen_status" -eq 0 ]] ||
    fail "delegated run: generator exited $gen_status; the delegated shell contract failed or could not run"
  assert_contains "$gen_out" 'contract=bin/test/zsh-effective-behavior-test.sh' \
    'delegated run names the reused shell contract'
  contract_plan="$(grep '^contract_assertions=' <<<"$gen_out" | sed 's/^contract_assertions=//')"
  [[ "$contract_plan" =~ ^[0-9]+$ ]] || fail 'delegated run did not record an assertion count'
  [[ "$contract_plan" -gt 0 ]] || fail 'delegated run recorded a zero assertion count'
  pass 'delegated run records a non-zero contract assertion count'
  assert_equals "$(grep '^contract_verdict=' <<<"$gen_out" | sed 's/^contract_verdict=//')" \
    'PASS' 'delegated run carries the contract verdict'
  stream_is_clean "$gen_out" || fail 'delegated run: stdout disclosed a protected value'
  pass 'delegated run: stdout discloses no protected value'
fi

# --- Hostile regressions: the rows above must be sensitive ------------------
#
# Every row so far is satisfiable by a generator that is wrong in a specific
# way, and a passing suite cannot by itself tell a real measurement from a
# confident claim. These rows close that gap by BREAKING the generator on
# purpose and requiring this suite to notice.
#
# Each perturbation edits a disposable COPY. The real generator is never
# modified, so a failure here cannot leave the repository altered, and the rows
# run on every invocation rather than once by hand at authoring time.
#
# Each case names the row it must break, so a perturbation that fails for an
# unrelated reason is not silently accepted as sensitivity.
hostile_copy="$TEST_ROOT/hostile-generator"

# Build a perturbed copy and require the edit to have actually landed.
#
# This guard is the difference between a sensitivity proof and a decorative one.
# Each perturbation is a `sed` pattern matched against the generator's source; if
# a later refactor reworded the matched line, the pattern would quietly match
# nothing, the copy would be byte-identical to the working generator, the nested
# suite would pass, and the row would report a caught regression that was never
# introduced. Comparing the copy against the original turns that silent decay
# into a failure.
perturb() {
  local expression="$1" label="$2"
  sed "$expression" "$REAL_GENERATOR" >"$hostile_copy"
  chmod +x "$hostile_copy"
  if cmp -s "$hostile_copy" "$REAL_GENERATOR"; then
    fail "$label (the perturbation matched nothing; the regression is vacuous)"
  fi
}

# Run this whole suite against a perturbed generator and require it to fail.
# The suite is re-entered with GENERATOR pointed at the copy; the nested run's
# own output is discarded, and only its exit status is read.
assert_perturbation_is_caught() {
  local label="$1" expected_row="$2"
  local nested_out="$TEST_ROOT/nested.out"
  set +e
  AGENT_LANE_RECEIPT_UNDER_TEST="$hostile_copy" "$0" >"$nested_out" 2>&1
  local nested_status=$?
  set -e
  if [[ "$nested_status" -eq 0 ]]; then
    fail "$label (the suite passed against a deliberately broken generator)"
  fi
  # Naming the row makes this a claim about WHAT was caught, not merely that
  # something failed. A perturbation caught by an unrelated row would otherwise
  # count as sensitivity it does not actually demonstrate.
  # Matched as a FIXED STRING via awk's index(), not a regex. A row label may
  # contain `[` or `]`, which a regex would read as a character class and fail
  # to match even when the intended row is the one that fired. index() == 1
  # keeps the line-start anchor a fixed-string match gives up.
  if ! awk -v want="not ok - ${expected_row}" \
    'index($0, want) == 1 { found = 1 } END { exit found ? 0 : 1 }' "$nested_out"; then
    fail "$label (broken generator was caught, but not by the expected row)"
  fi
  pass "$label"
}

# --- Custody: the receipt is private at birth, not shortly afterwards -------
#
# `mkdir` then `chmod` leaves a window in which the directory carries the
# caller's ambient umask. This row runs the generator under a deliberately
# hostile umask and reads the modes off the filesystem afterwards.
#
# THE MODE CHECK ALONE CANNOT SEE THE WINDOW. A generator that creates
# world-readable and then corrects to 0600 ends in exactly the state a correct
# one ends in, so a post-hoc `stat` passes either way. Racing the window would
# be the direct observation and is deliberately not attempted: it needs a
# concurrent reader spinning on a path inside the operator's state directory,
# it is timing-dependent, and a flaky row here would be read as a custody
# failure. The row instead asserts the OBSERVABLE CONSEQUENCE of setting umask
# first -- a fresh directory tree created under umask 022 comes out 0700/0600
# rather than 0755/0644 -- and the matching perturbation deletes the `umask 077`
# line to prove the row is what holds it in place.
#
# The state root is unique to this row, so nothing another row created under a
# tighter umask can satisfy it, and no parallel row can observe an intermediate
# mode of a path this row owns.
hostile_umask_root="$TEST_ROOT/state-hostile-umask"
(
  umask 022
  env \
    XDG_STATE_HOME="$hostile_umask_root" \
    AGENT_LANE_RECEIPT_BOUNDARY_EPOCH="$BOUNDARY_EPOCH" \
    AGENT_LANE_RECEIPT_SECRET="$ENV_VALUE_MARKER" \
    "$GENERATOR" --lane test-umask --snapshot "$safe_snapshot" \
    --product-version 'test 1.0' \
    --task-start "$DEFAULT_TASK_START" --boundary-epoch "$BOUNDARY_EPOCH" \
    >/dev/null 2>&1
) || fail 'umask: the generator did not complete under a hostile umask'

umask_receipt="$hostile_umask_root/agent-lane-receipts/test-umask.receipt"
[[ -f "$umask_receipt" ]] || fail 'umask: no receipt was written under a hostile umask'
assert_equals "$(stat -f '%Lp' "$hostile_umask_root/agent-lane-receipts")" '700' \
  'umask: the receipt directory is private despite a permissive ambient umask'
assert_equals "$(stat -f '%Lp' "$umask_receipt")" '600' \
  'umask: the receipt file is private despite a permissive ambient umask'

# The intermediate directory the generator created on the way down. It is never
# chmod-ed by the generator, so its mode is decided ONLY by the umask in force
# at creation. That makes it the row that actually distinguishes "umask was set
# first" from "chmod cleaned up afterwards": under umask 022 with no `umask 077`
# it would be 0755.
assert_equals "$(stat -f '%Lp' "$hostile_umask_root")" '700' \
  'umask: an intermediate state directory is created private, with no chmod to repair it'

# --- Command resolution: an empty PATH is a failure, not a silent pass ------
#
# Every assertion in the command-resolution probe is a REFUSAL, so a lane whose
# `$path` is empty satisfied all of them by having no entry to reject: no entry
# was empty, none was `.`, none was a writable temp dir, and the probe returned
# PASS for a lane whose command resolution was completely broken.
#
# The fixture empties `$path` at the end of the snapshot, which is exactly how a
# real startup file would break it. The oracle is the verdict the spec requires
# -- FAIL -- derived from the contract rather than read back from the probe.
empty_path_snapshot="$snapshot_dir/snapshot-zsh-emptypath.sh"
{
  printf 'print -r -- %s\n' "$SNAPSHOT_BODY_MARKER"
  printf 'print -r -- %s >&2\n' "$SNAPSHOT_BODY_MARKER"
  printf 'path=()\n'
} >"$empty_path_snapshot"
chmod 600 "$empty_path_snapshot"
touch -t 202608210040.00 "$empty_path_snapshot"

# NO PERTURBATION ROW ACCOMPANIES THIS ONE, and the reason is a property of
# zsh rather than an omission.
#
# The zero-row guard in the probe is defense in depth. Isolating it would need a
# lane where the identity lookups succeed AND the `$path` loop emits nothing,
# and that state is unreachable in a real child: emptying `$path` before the
# lookups makes them report `none`, and emptying it partway through makes every
# remaining lookup report `none` too. Either way the identity assertions fail
# first, so removing the guard does not change any observable verdict here.
#
# The guard stays because the probe must not depend on that coincidence -- a
# future reordering that collected `$path` before the identity rows would make
# the vacuous pass reachable again. The row below proves the REJECTION, which is
# the behaviour the contract owes; the guard's own sensitivity is left as an
# unproved boundary rather than claimed by a row that cannot fail.
run_generator --lane test-emptypath --snapshot "$empty_path_snapshot" \
  --product-version 'test 1.0'
[[ "$gen_status" -ne 0 ]] ||
  fail 'empty PATH: generator must exit non-zero for a lane with no search path'
pass 'empty PATH: generator exits non-zero'
assert_equals "$(grep '^probe_command_resolution=' <<<"$gen_out" | sed 's/^probe_command_resolution=//')" \
  'FAIL' 'empty PATH: the command-resolution probe reports FAIL rather than a vacuous PASS'

# --- Disclosure: snapshot_path is stored but never emitted -------------------
#
# Issue 54 requires the receipt to carry path, mode, and hash, so the field stays
# in the mode-0600 file. stdout is a different audience: a lane's transcript is
# pasted into issues and read by whoever is watching, so a snapshot path printed
# there republishes a private location naming the operator's home directory.
#
# Both halves are asserted. Testing only the streams would be satisfied by a
# generator that stopped recording the path at all, which would break the issue's
# metadata requirement while looking like better hygiene.
run_generator --lane test-path-disclosure --snapshot "$safe_snapshot" \
  --product-version 'test 1.0'
assert_equals "$gen_status" '0' 'snapshot path: the generator completes'

disclosure_receipt="$state_root/agent-lane-receipts/test-path-disclosure.receipt"
[[ -f "$disclosure_receipt" ]] || fail 'snapshot path: no receipt was written'
assert_equals "$(sed -n 's/^snapshot_path=//p' "$disclosure_receipt" | head -1)" \
  "$safe_snapshot" 'snapshot path: the private receipt retains the snapshot path'

[[ "$gen_out" != *"$safe_snapshot"* ]] ||
  fail 'snapshot path: stdout carried the full private snapshot path'
pass 'snapshot path: stdout does not carry the private snapshot path'
[[ "$gen_err" != *"$safe_snapshot"* ]] ||
  fail 'snapshot path: stderr carried the full private snapshot path'
pass 'snapshot path: stderr does not carry the private snapshot path'

# The supervisor still receives the rest of the provenance, so withholding the
# path did not cost the fields the issue asks a reader to see.
assert_contains "$gen_out" 'snapshot_sha256=' 'snapshot path: stdout still carries the snapshot hash'
assert_contains "$gen_out" 'snapshot_mode=' 'snapshot path: stdout still carries the snapshot mode'
assert_contains "$gen_out" 'receipt_path=' 'snapshot path: stdout still names where the private receipt lives'

# Only the outermost invocation runs the perturbations. Without this guard the
# nested runs would recurse.
if [[ -z "${AGENT_LANE_RECEIPT_UNDER_TEST:-}" ]]; then

  # 1. Admission widened to accept pre-repair evidence.
  perturb 's/^if \[\[ "\$snapshot_mtime" -le "\$boundary_epoch" \]\]; then/if false; then/' \
    'pre-repair admission perturbation'
  # The DIAGNOSTIC row is named, not the status row. The stale fixture is older
  # than the default lane start these rows supply, so with the boundary gate
  # disabled the lane-start gate still refuses it and the status stays non-zero.
  # Only the row reading WHY it was refused can tell the two gates apart, which
  # is what makes this perturbation a claim about the boundary specifically.
  assert_perturbation_is_caught \
    'a generator admitting pre-repair snapshots is caught' \
    'stale snapshot: refusal names the reason'

  # 2. Snapshot body echoed into the receipt stream.
  # The leak is ADDED alongside the normal emission rather than replacing it.
  # Replacing the emit line would strip every receipt field and trip the
  # attribution rows first, which would report a caught leak that was really a
  # caught empty receipt.
  perturb 's|^grep -v .\^snapshot_path=. -- "\$receipt_path" .. true|head -1 -- "$snapshot"\n&|' \
    'snapshot leak perturbation'
  assert_perturbation_is_caught \
    'a generator leaking snapshot contents is caught' \
    'fresh snapshot: stdout disclosed a protected value'

  # 3. Probe verdicts claimed without being measured.
  perturb 's/  if "probe_\${probe}"; then/  if true; then/' \
    'hardcoded probe verdict perturbation'
  assert_perturbation_is_caught \
    'a generator hardcoding probe PASS is caught' \
    'hostile snapshot: generator must exit non-zero'

  # 4. Binding reduced to a label rather than a measurement.
  perturb 's/  if \[\[ "\$claimed_canonical" != "\$actual_canonical" \]\]; then/  if false; then/' \
    'unverified binding perturbation'
  assert_perturbation_is_caught \
    'a generator trusting an unverified binding claim is caught' \
    'binding: a claim contradicting the real ZDOTDIR must be refused'

  # 5. Lane-start ordering dropped.
  perturb 's/^if \[\[ "\$snapshot_mtime" -le "\$task_start_epoch" \]\]; then/if false; then/' \
    'lane-start ordering perturbation'
  assert_perturbation_is_caught \
    'a generator ignoring lane-start ordering is caught' \
    'lane start: a snapshot older than lane start must be refused'

  # 6. Value-taking flags returned to a bare `shift 2`.
  #
  # This is the exact bash 3.2 defect: the shift fails, `set -e` takes it, and
  # the process exits 1 with an empty stderr. The status stays non-zero, so only
  # a row reading the diagnostic can catch it.
  perturb 's/^    --lane) require_value "\$1" \$#; lane="\$2"; shift 2 ;;/    --lane) lane="${2:-}"; shift 2 ;;/' \
    'missing flag value perturbation'
  assert_perturbation_is_caught \
    'a generator exiting silently on a valueless flag is caught' \
    'trailing --lane: the refusal names the flag whose value is missing'

  # 7. The explicit no-ZDOTDIR guard removed.
  #
  # The run still fails, because canonical_dir refuses the same fixture
  # downstream. Only the row that reads the guard's own diagnostic can tell that
  # the explicit guard is gone, which is what makes that row load-bearing rather
  # than a second opinion about an already-caught case.
  perturb 's/  if \[\[ -z "\${ZDOTDIR:-}" \]\]; then/  if false; then/' \
    'absent-binding guard perturbation'
  # The named row is the FIRST of the three absent-binding diagnostic rows,
  # because the suite exits on its first failure. All three fail under this
  # perturbation; naming the one that fires keeps the claim exact.
  assert_perturbation_is_caught \
    'a generator losing the explicit absent-binding guard is caught' \
    'binding: the absent-binding refusal names the absent binding'

  # 8. The mandatory-epoch requirement made optional again.
  #
  # This is the regression the freshness rows exist for: with the requirement
  # relaxed, a caller who simply omits the flags gets a PASS receipt whose gates
  # never ran.
  perturb 's/^  \[\[ -n "\$value" \]\] ||$/  [[ -z "$value" ]] \&\& return 0\n  [[ -n "$value" ]] ||/' \
    'optional epoch perturbation'
  # The row named is the `fail` message that fires first, not the assertion
  # label that follows it: with the requirement relaxed the run exits zero, so
  # the status check ahead of the diagnostic check is what catches it.
  assert_perturbation_is_caught \
    'a generator treating the freshness epochs as optional is caught' \
    'a run without --task-start must be refused'

  # 9. Positive-integer validation relaxed to a digit string.
  #
  # `0` passes `^[0-9]+$` and beats every real mtime under `-le`, so the gate
  # keeps reporting success while admitting every snapshot. Only a row that
  # rejects zero specifically can see this.
  perturb 's/\[\[ "\$value" =~ \^\[1-9\]\[0-9\]\*\$ \]\] ||/[[ "$value" =~ ^[0-9]+$ ]] ||/' \
    'zero-epoch perturbation'
  assert_perturbation_is_caught \
    'a generator accepting a zero epoch is caught' \
    'a --task-start of [0] must be refused'

  # 10. The umask removed, leaving mkdir/chmod to race.
  perturb 's/^umask 077$/: umask left at the ambient value/' \
    'ambient umask perturbation'
  assert_perturbation_is_caught \
    'a generator creating state under an ambient umask is caught' \
    'umask: an intermediate state directory is created private, with no chmod to repair it'

  # 12. The private snapshot path republished on stdout.
  perturb 's|^grep -v .\^snapshot_path=. -- "\$receipt_path" .. true|cat -- "$receipt_path"|' \
    'snapshot path disclosure perturbation'
  assert_perturbation_is_caught \
    'a generator printing the private snapshot path is caught' \
    'snapshot path: stdout carried the full private snapshot path'
else
  skip 'hostile regressions (nested run)'
  skip 'hostile regressions (nested run)'
  skip 'hostile regressions (nested run)'
  skip 'hostile regressions (nested run)'
  skip 'hostile regressions (nested run)'
  skip 'hostile regressions (nested run)'
  skip 'hostile regressions (nested run)'
  skip 'hostile regressions (nested run)'
  skip 'hostile regressions (nested run)'
  skip 'hostile regressions (nested run)'
  skip 'hostile regressions (nested run)'
fi

# Receipts name behavior only. No snapshot body or environment value is printed.
printf '1..%d\n' "$assertion_count"
if [[ "$skip_count" -gt 0 ]]; then
  printf '# skipped %d\n' "$skip_count"
fi
