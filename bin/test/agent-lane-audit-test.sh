#!/usr/bin/env bash
#
# Agent lane audit contract.
#
# `bin/agent-lane-receipt` proves one lane against itself. It cannot see the
# other lanes, because each receipt is written by a separate process. Two
# failures therefore survive a set of individually passing receipts:
#
#   reuse    two lanes that were meant to be separate product launches carry
#            one snapshot, so a single launch is standing in for two lanes
#   silence  a lane produced no receipt at all, and an audit that reads only
#            the files present would never mention it
#
# `bin/agent-lane-audit` is the supervision seam for both, and this file proves
# the properties that make its verdict worth acting on:
#
#   inventory     lanes come from the launcher, so a lane added there cannot be
#                 quietly dropped from the audit
#   distinctness  reuse is refused exactly where the launcher launches a lane
#                 separately, and NOT where a lane shares a session by contract
#   gaps          an unproved lane is reported as a named GAP, never omitted and
#                 never counted as a pass
#   status        only an all-PASS set exits zero, so a gap cannot be mistaken
#                 for proof by a supervisor reading the status alone
#   disclosure    no snapshot is opened and no full content hash is republished
#
# Every fixture receipt here is synthetic, written into a temporary directory.
# This suite never reads and never writes the operator's real receipt directory.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"

REAL_AUDIT="$REPO_ROOT/bin/agent-lane-audit"
AUDIT="${AGENT_LANE_AUDIT_UNDER_TEST:-$REAL_AUDIT}"
LAUNCHER="$REPO_ROOT/bin/agent-lane-launch"
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

[[ -f "$AUDIT" ]] || fail 'bin/agent-lane-audit does not exist'
pass 'the audit tool exists'
[[ -x "$AUDIT" ]] || fail 'bin/agent-lane-audit is not executable'
pass 'the audit tool is executable'

# --- Fixture receipts -------------------------------------------------------
#
# A receipt is metadata, so a fixture is just the fields the audit reads. The
# SHA values are synthetic and distinct by construction, which makes the
# distinctness rows a measurement: the test decides which lanes share a capture,
# and the audit must report what the test set up rather than the reverse.
receipt_dir="$TEST_ROOT/receipts"
mkdir -p "$receipt_dir"

# The freshness triple every sound receipt carries. The audit re-derives the
# ordering from these three fields, so the default fixture satisfies it and the
# rows below vary one field at a time to prove each comparison independently.
FIXTURE_MTIME=1787241494
FIXTURE_TASK_START=1787240000
FIXTURE_BOUNDARY=1787236121

write_receipt() {
  local lane="$1" sha="$2" binding="$3" verdict="$4"
  # Optional overrides let a freshness row move one epoch without disturbing the
  # distinctness and binding rows, which must keep passing for their own reasons.
  local task_start="${5-$FIXTURE_TASK_START}"
  local boundary="${6-$FIXTURE_BOUNDARY}"
  local mtime="${7-$FIXTURE_MTIME}"
  {
    printf 'lane=%s\n' "$lane"
    printf 'product=test\n'
    printf 'profile_binding=%s\n' "$binding"
    printf 'snapshot_sha256=%s\n' "$sha"
    printf 'task_start_epoch=%s\n' "$task_start"
    printf 'boundary_epoch=%s\n' "$boundary"
    printf 'snapshot_mtime=%s\n' "$mtime"
    printf 'verdict=%s\n' "$verdict"
  } >"$receipt_dir/${lane}.receipt"
  chmod 600 "$receipt_dir/${lane}.receipt"
}

# Write a receipt with one freshness field removed entirely.
write_receipt_without() {
  local lane="$1" missing="$2"
  write_receipt "$lane" "$SHA_FRESH" 'worktree' 'PASS'
  grep -v "^${missing}=" "$receipt_dir/${lane}.receipt" >"$receipt_dir/${lane}.tmp"
  mv "$receipt_dir/${lane}.tmp" "$receipt_dir/${lane}.receipt"
  chmod 600 "$receipt_dir/${lane}.receipt"
}

SHA_A='aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111'
SHA_B='bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222'
SHA_C='cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333'
SHA_D='dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444'
SHA_FRESH='eeee5555eeee5555eeee5555eeee5555eeee5555eeee5555eeee5555eeee5555'

# Run the audit as a real child process. Sets audit_out, audit_err, audit_status.
run_audit() {
  local err_file="$TEST_ROOT/stderr.run"
  : >"$err_file"
  set +e
  audit_out="$("$AUDIT" --receipt-dir "$receipt_dir" "$@" 2>"$err_file")"
  audit_status=$?
  set -e
  audit_err="$(<"$err_file")"
}

# The reported state for one lane, read from the emitted rows.
#
# The state field is read as the fixed second field rather than by a pattern
# that could match later text. A note may legitimately quote an operator's
# words, and a greedy match once picked up a `state=PASS` from inside a note and
# reported it as the row's verdict, which is the reverse of what this helper is
# for.
state_of() {
  local lane="$1"
  awk -v want="lane=$lane" '$1 == want { sub(/^state=/, "", $2); print $2; exit }' \
    <<<"$audit_out"
}

# --- Inventory: lanes come from the launcher --------------------------------
#
# The audit must not carry its own copy of the lane list. If it did, a lane
# added to the launcher would be silently unaudited, which is the same silence
# this tool exists to break.
if [[ -x "$LAUNCHER" ]]; then
  launcher_lanes="$("$LAUNCHER" | sed -n 's/^# ---- lane: \(.*\) ----$/\1/p')"
  [[ -n "$launcher_lanes" ]] || fail 'the launcher offered no lanes to audit'

  # Every lane exists but none has a receipt, so every row is a GAP. That is the
  # cleanest way to see the inventory itself.
  rm -f "$receipt_dir"/*.receipt
  run_audit
  while IFS= read -r lane_name; do
    [[ -n "$lane_name" ]] || continue
    assert_contains "$audit_out" "lane=${lane_name} " \
      "the audit reports the ${lane_name} lane the launcher offers"
  done <<<"$launcher_lanes"
else
  skip 'launcher inventory (launcher unavailable)'
fi

# --- Silence: a lane with no receipt is a GAP, never an omission ------------
rm -f "$receipt_dir"/*.receipt
run_audit --lanes codex-command,claude-terminal
assert_equals "$(state_of codex-command)" 'GAP' \
  'a lane with no receipt is reported as a GAP'
assert_contains "$audit_out" 'unproved' \
  'an undeclared gap says the lane is unproved'
[[ "$audit_status" -ne 0 ]] || fail 'a set containing a GAP must not exit zero'
pass 'a set containing a GAP does not exit zero'

# --- Capability gap: an unavailable lane is NAMED, not fabricated -----------
#
# This is the claude-terminal case. The installed Claude build exposes no
# distinct integrated terminal, so no honest receipt for that lane can exist.
# The audit must let a supervisor record WHY without inventing a passing
# receipt, and the recorded reason must survive into the output.
GAP_REASON='Claude 2.1.237 exposes no distinct integrated terminal'
run_audit --lanes claude-terminal --gap "claude-terminal=$GAP_REASON"
assert_equals "$(state_of claude-terminal)" 'GAP' \
  'a declared unavailable lane is reported as a GAP'
assert_contains "$audit_out" "$GAP_REASON" \
  'the declared gap carries its stated reason'
[[ "$audit_status" -ne 0 ]] || fail 'a declared GAP must not exit zero'
pass 'a declared GAP does not exit zero'

# A gap must never be able to launder a real failure. If the lane DID produce a
# receipt, the receipt is the evidence and a stale declaration cannot suppress
# it.
write_receipt claude-terminal "$SHA_A" 'worktree' 'FAIL'
run_audit --lanes claude-terminal --gap "claude-terminal=$GAP_REASON"
assert_equals "$(state_of claude-terminal)" 'FAIL' \
  'a declared gap does not suppress a failing receipt that exists'
rm -f "$receipt_dir/claude-terminal.receipt"

# --- A gap declared over a lane that HAS a receipt is itself a finding -------
#
# The two declarations contradict each other. The gap says this lane could not
# produce evidence; the receipt is that evidence. Exactly one of them is wrong,
# and which one is a question only the operator can answer: the gap may be a
# stale line in a runbook, or the receipt may belong to a lane that no longer
# exists in this environment.
#
# The receipt still decides the verdict, because evidence outranks a
# declaration about the absence of evidence. But the audit must SAY the
# contradiction exists. A row reporting only the receipt verdict silently
# discards an operator statement that has stopped being true, and the stale
# declaration then survives into the next run unnoticed.
#
# Both directions are proved, because a note attached only to the failing side
# would leave the more dangerous case invisible: a stale gap sitting over a
# lane that now passes is the one an operator has no other reason to revisit.
rm -f "$receipt_dir"/*.receipt
write_receipt claude-terminal "$SHA_A" 'worktree' 'PASS'
run_audit --lanes claude-terminal --gap "claude-terminal=$GAP_REASON"
assert_equals "$(state_of claude-terminal)" 'PASS' \
  'a passing receipt under a declared gap is still evaluated and still passes'
assert_contains "$audit_out" 'a gap was declared for a lane that produced a receipt' \
  'a gap contradicted by a passing receipt is surfaced in the row'
assert_contains "$audit_out" 'receipt passes, is bound to the worktree' \
  'the ordinary passing diagnostic survives beside the contradiction note'
assert_equals "$audit_status" '0' \
  'a contradicted gap does not change the exit status of a passing lane'

write_receipt claude-terminal "$SHA_A" 'worktree' 'FAIL'
run_audit --lanes claude-terminal --gap "claude-terminal=$GAP_REASON"
assert_equals "$(state_of claude-terminal)" 'FAIL' \
  'a failing receipt under a declared gap is still evaluated and still fails'
assert_contains "$audit_out" 'a gap was declared for a lane that produced a receipt' \
  'a gap contradicted by a failing receipt is surfaced in the row'
assert_contains "$audit_out" 'receipt verdict is FAIL' \
  'the ordinary failing diagnostic survives beside the contradiction note'
[[ "$audit_status" -ne 0 ]] ||
  fail 'a contradicted gap must not clear a failing lane exit status'
pass 'a contradicted gap does not clear a failing lane exit status'

# The contradiction note is reported only where the contradiction exists. A note
# attached to every receipt-bearing lane would be noise rather than a finding.
rm -f "$receipt_dir"/*.receipt
write_receipt codex-command "$SHA_A" 'worktree' 'PASS'
run_audit --lanes codex-command
case "$audit_out" in
  *'a gap was declared'*)
    fail 'the contradiction note appeared for a lane with no declared gap' ;;
  *)
    pass 'a lane with no declared gap carries no contradiction note' ;;
esac
rm -f "$receipt_dir"/*.receipt

# A gap declaration without a reason is refused. An unexplained gap is
# indistinguishable from a lane someone forgot to run.
run_audit --lanes claude-terminal --gap 'claude-terminal='
[[ "$audit_status" -ne 0 ]] || fail 'a reasonless gap declaration must be refused'
assert_contains "$audit_err" 'reason' 'a reasonless gap declaration names the problem'

# --- Distinctness: one launch cannot prove two separately launched lanes ----
#
# codex-command and codex-terminal are each emitted with their own launch line,
# so they are separate product processes and must hold separate captures.
rm -f "$receipt_dir"/*.receipt
write_receipt codex-command "$SHA_A" 'worktree' 'PASS'
write_receipt codex-terminal "$SHA_A" 'worktree' 'PASS'
run_audit --lanes codex-command,codex-terminal
assert_equals "$(state_of codex-command)" 'REUSE' \
  'a separately launched lane sharing a snapshot is reported as REUSE'
assert_equals "$(state_of codex-terminal)" 'REUSE' \
  'both sides of a shared snapshot are reported, not just one'
assert_contains "$audit_out" 'one launch cannot prove two lanes' \
  'the reuse note explains why the evidence does not count'
[[ "$audit_status" -ne 0 ]] || fail 'a set containing REUSE must not exit zero'
pass 'a set containing REUSE does not exit zero'

# A lane reclassified as REUSE keeps the note the first pass gave it.
#
# The second pass can turn a PASS into a REUSE, and it writes the reuse
# diagnostic into the same row note the first pass already used. Overwriting it
# loses whatever was recorded there, and a contradicted gap declaration is the
# case where that costs most: the lane has just stopped being proved, so an
# operator is about to ask why, and a stale gap sitting over it is one of the
# two facts they need. The reuse verdict is what the audit concluded; the
# contradiction is what the operator declared. Neither answers the other, so the
# row must carry both.
#
# This row sits after the plain REUSE rows deliberately. Those establish that
# the reclassification happens at all, so a failure here is about the note
# rather than about the verdict underneath it.
rm -f "$receipt_dir"/*.receipt
write_receipt codex-command "$SHA_A" 'worktree' 'PASS'
write_receipt codex-terminal "$SHA_A" 'worktree' 'PASS'
run_audit --lanes codex-command,codex-terminal --gap "codex-command=$GAP_REASON"
assert_equals "$(state_of codex-command)" 'REUSE' \
  'a contradicted gap does not change a reclassified lane verdict'
assert_contains "$audit_out" 'one launch cannot prove two lanes' \
  'a reclassified lane keeps its reuse diagnostic'
assert_contains "$audit_out" 'a gap was declared for a lane that produced a receipt' \
  'a lane reclassified as REUSE keeps its contradiction note'
[[ "$audit_status" -ne 0 ]] ||
  fail 'a contradicted gap must not clear a REUSE exit status'
pass 'a contradicted gap does not clear a REUSE exit status'

# The same two lanes with distinct captures are exactly what issue 54 asks for.
# This is the row that stops the one above from being satisfied by a tool that
# simply calls every pair reuse.
write_receipt codex-terminal "$SHA_B" 'worktree' 'PASS'
run_audit --lanes codex-command,codex-terminal
assert_equals "$(state_of codex-command)" 'PASS' \
  'separately launched lanes with distinct snapshots pass'
assert_equals "$(state_of codex-terminal)" 'PASS' \
  'the second separately launched lane passes on its own capture'
assert_equals "$audit_status" '0' 'an all-PASS set exits zero'

# --- Distinctness does not over-reach: a shared session is not reuse --------
#
# claude-subagent runs INSIDE the bound claude-bash session and the launcher
# emits no separate launch for it, so it shares that session's snapshot by
# contract. Calling that reuse would demand evidence the lane cannot produce and
# would make the audit wrong in the opposite direction.
rm -f "$receipt_dir"/*.receipt
write_receipt claude-bash "$SHA_C" 'worktree' 'PASS'
write_receipt claude-subagent "$SHA_C" 'worktree' 'PASS'
run_audit --lanes claude-bash,claude-subagent
assert_equals "$(state_of claude-bash)" 'PASS' \
  'a lane whose session a subagent shares still passes'
assert_equals "$(state_of claude-subagent)" 'PASS' \
  'a lane that shares its session by contract is not reported as reuse'
assert_equals "$audit_status" '0' 'a contract-shared snapshot pair exits zero'

# --- Receipt quality: a passing verdict is not enough -----------------------
#
# An unbound receipt is a real observation of that lane but is not evidence
# about the repaired profile, so it must not be reported as PASS.
rm -f "$receipt_dir"/*.receipt
write_receipt codex-command "$SHA_A" 'unbound' 'PASS'
run_audit --lanes codex-command
assert_equals "$(state_of codex-command)" 'FAIL' \
  'a passing but unbound receipt is not counted as proof of the repaired profile'
assert_contains "$audit_out" 'profile_binding is unbound' \
  'the unbound refusal names the binding it found'

write_receipt codex-command "$SHA_A" 'worktree' 'FAIL'
run_audit --lanes codex-command
assert_equals "$(state_of codex-command)" 'FAIL' \
  'a failing receipt is reported as FAIL'

# --- A lane cannot opt out of distinctness by carrying no hash --------------
#
# The snapshot hash is what makes cross-lane comparison possible, so a lane
# without a usable one is not comparable and must not be counted as proved.
#
# The dangerous direction is the absent field. Distinctness only compares lanes
# that HAVE a hash, so an empty one silently skipped the comparison: two
# separately launched lanes with the field stripped BOTH reported PASS and the
# whole audit exited zero. Deleting one line from two receipts forged a fully
# proved matrix, which is the opposite of what this tool is for.
for bad_sha in '' 'zzzz' 'b5f52a48a3cb' \
  "${SHA_A}extra" 'B5F52A48A3CB38E40878D2DE018A55738B61A1774200D9A875F8C1B126B15837'; do
  rm -f "$receipt_dir"/*.receipt
  write_receipt codex-command "$bad_sha" 'worktree' 'PASS'
  run_audit --lanes codex-command
  assert_equals "$(state_of codex-command)" 'FAIL' \
    "a receipt whose snapshot_sha256 is not a SHA-256 fails: [${bad_sha:-absent}]"
done
assert_contains "$audit_out" 'cannot be compared' \
  'the unusable-hash refusal says the lane cannot be compared'

# The pair that motivated the check: two separately launched lanes, both with
# the hash stripped. Neither may pass, and the run must not exit zero.
rm -f "$receipt_dir"/*.receipt
write_receipt codex-command '' 'worktree' 'PASS'
write_receipt codex-terminal '' 'worktree' 'PASS'
run_audit --lanes codex-command,codex-terminal
assert_equals "$(state_of codex-command)" 'FAIL' \
  'a hashless lane cannot skip distinctness and pass'
assert_equals "$(state_of codex-terminal)" 'FAIL' \
  'the second hashless lane cannot skip distinctness and pass'
[[ "$audit_status" -ne 0 ]] ||
  fail 'two hashless separately launched lanes must not exit zero'
pass 'two hashless separately launched lanes do not exit zero'

# A well-formed hash is still accepted, so the check is not refusing everything.
rm -f "$receipt_dir"/*.receipt
write_receipt codex-command "$SHA_A" 'worktree' 'PASS'
run_audit --lanes codex-command
assert_equals "$(state_of codex-command)" 'PASS' \
  'a well-formed SHA-256 is still accepted'

# --- A receipt must belong to the lane whose filename it carries ------------
#
# A receipt is identified by its filename AND its own lane field, and the two
# must agree. Copying or renaming a real receipt is the cheapest way to
# manufacture evidence for a lane that never ran: a passing codex-command
# receipt renamed to claude-terminal.receipt carries a genuinely distinct
# snapshot, so distinctness never fires and the lane reported PASS with the run
# exiting zero. That is the fabricated pass a named GAP exists to prevent.
rm -f "$receipt_dir"/*.receipt
write_receipt codex-command "$SHA_A" 'worktree' 'PASS'
mv "$receipt_dir/codex-command.receipt" "$receipt_dir/claude-terminal.receipt"
run_audit --lanes claude-terminal
assert_equals "$(state_of claude-terminal)" 'FAIL' \
  'a receipt renamed to another lane does not stand in for that lane'
assert_contains "$audit_out" 'does not belong to this lane' \
  'the mislabelled-receipt refusal says the file does not belong to the lane'
[[ "$audit_status" -ne 0 ]] || fail 'a mislabelled receipt must not exit zero'
pass 'a mislabelled receipt does not exit zero'

# A receipt whose lane field is absent is equally unattributable.
rm -f "$receipt_dir"/*.receipt
{
  printf 'product=test\n'
  printf 'profile_binding=worktree\n'
  printf 'snapshot_sha256=%s\n' "$SHA_A"
  printf 'verdict=PASS\n'
} >"$receipt_dir/codex-command.receipt"
run_audit --lanes codex-command
assert_equals "$(state_of codex-command)" 'FAIL' \
  'a receipt carrying no lane field is not attributed to the requested lane'

# The matching case still passes, so the check is a comparison rather than a
# blanket refusal.
rm -f "$receipt_dir"/*.receipt
write_receipt codex-command "$SHA_A" 'worktree' 'PASS'
run_audit --lanes codex-command
assert_equals "$(state_of codex-command)" 'PASS' \
  'a receipt whose lane field matches its filename still passes'

# --- Summary: the three outcomes are distinguishable ------------------------
#
# The whole point of the tool. A final audit must be able to separate a proved
# lane from an unproved one from an invalid one, in a single machine-readable
# line.
rm -f "$receipt_dir"/*.receipt
write_receipt codex-command "$SHA_A" 'worktree' 'PASS'
write_receipt codex-terminal "$SHA_A" 'worktree' 'PASS'
write_receipt claude-bash "$SHA_D" 'worktree' 'PASS'
run_audit --lanes codex-command,codex-terminal,claude-bash,claude-terminal \
  --gap "claude-terminal=$GAP_REASON"
assert_contains "$audit_out" 'audited=4' 'the summary counts every audited lane'
assert_contains "$audit_out" 'pass=1' 'the summary counts the proved lanes'
assert_contains "$audit_out" 'gap=1' 'the summary counts the named gaps'
assert_contains "$audit_out" 'problem=2' 'the summary counts the invalid lanes'
[[ "$audit_status" -ne 0 ]] || fail 'a mixed set must not exit zero'
pass 'a mixed set does not exit zero'

# --- Disclosure: no snapshot is opened, no full hash republished ------------
#
# The audit reads receipts only. A short prefix is enough to see that two lanes
# carry one capture; a full hash is content it has no reason to reproduce.
case "$audit_out" in
  *"$SHA_A"*) fail 'the audit republished a full snapshot hash' ;;
  *) pass 'the audit does not republish a full snapshot hash' ;;
esac
assert_contains "$audit_out" "${SHA_A:0:12}" \
  'the audit prints a short hash prefix so shared captures stay visible'

# --- Refusals ---------------------------------------------------------------
set +e
"$AUDIT" --receipt-dir "$TEST_ROOT/no-such-dir" >/dev/null 2>&1
missing_dir_status=$?
set -e
[[ "$missing_dir_status" -ne 0 ]] || fail 'a missing receipt directory must be refused'
pass 'a missing receipt directory is refused'

# The audit takes value-taking flags too, and must refuse a trailing one rather
# than exiting silently on a failed `shift 2` under bash 3.2.
for flag in --receipt-dir --lanes --gap; do
  set +e
  flag_err="$("$AUDIT" "$flag" 2>&1 >/dev/null)"
  flag_status=$?
  set -e
  [[ "$flag_status" -ne 0 ]] || fail "trailing ${flag}: the audit must exit non-zero"
  assert_contains "$flag_err" "$flag" \
    "trailing ${flag}: the refusal names the flag whose value is missing"
done

# --- Lane names compose paths, so they obey a safe grammar ------------------
#
# A lane name is joined to the receipt directory. An unvalidated name reaches
# outside it, and a name the receipt tool would refuse to WRITE must not be a
# name this tool will READ: the two must agree on what a lane may be called.
for bad_lane in '../../../etc/hosts' 'lane/../escape' 'lane with space' '.hidden' \
  'lane,,other' '-dashfirst'; do
  run_audit --lanes "$bad_lane"
  [[ "$audit_status" -ne 0 ]] ||
    fail "--lanes must refuse an unsafe lane name (accepted [$bad_lane])"
  assert_contains "$audit_err" 'lane name' \
    "--lanes refuses an unsafe lane name and says so: [$bad_lane]"
done

# An empty list is refused rather than silently widened to every lane. An
# operator who narrowed the run must not get a full audit instead.
run_audit --lanes ''
[[ "$audit_status" -ne 0 ]] || fail '--lanes must refuse an empty lane list'
assert_contains "$audit_err" 'names no lane' \
  '--lanes refuses an empty lane list rather than auditing everything'

# The same grammar governs a gap declaration, which composes the same path.
run_audit --lanes codex-command --gap '../../../etc/hosts=some reason'
[[ "$audit_status" -ne 0 ]] || fail '--gap must refuse an unsafe lane name'
assert_contains "$audit_err" 'lane name' '--gap refuses an unsafe lane name'

# A legitimate name is still accepted, so the grammar is not simply refusing
# everything.
run_audit --lanes codex-command
assert_contains "$audit_out" 'lane=codex-command ' \
  'a lane name matching the grammar is still audited'

# --- A gap reason cannot forge an output row --------------------------------
#
# The reason is the one field an operator supplies freely, and it is printed
# into a machine-readable row. A newline inside it ends that row and starts a
# new one the reader parses as another lane, so a reason carrying a complete
# `lane=... state=PASS ...` line would forge a PASSING row for a lane that was
# just declared unproved. That is precisely the fabricated pass a named gap
# exists to prevent, so it is refused rather than escaped.
forged_row='lane=claude-terminal state=PASS snapshot=deadbeefcafe note=forged'
for break_char in $'\n' $'\r'; do
  run_audit --lanes codex-command \
    --gap "codex-command=benign${break_char}${forged_row}"
  [[ "$audit_status" -ne 0 ]] ||
    fail 'a gap reason containing a line break must be refused'
  assert_contains "$audit_err" 'single line' \
    'a gap reason containing a line break is refused, and the refusal says why'
done

# Without a line break the same text is inert: it stays inside the note of a
# single GAP row rather than becoming a row of its own. The oracle is therefore
# the number of emitted lane ROWS, not the presence of the substring, which
# appears legitimately inside the note either way.
# The lane must have no receipt, so the declared gap is what produces the row.
rm -f "$receipt_dir"/*.receipt
run_audit --lanes codex-command --gap "codex-command=benign ${forged_row}"
assert_equals "$(grep -c '^lane=' <<<"$audit_out")" '1' \
  'a gap reason without a line break stays inside one row'
assert_equals "$(state_of codex-command)" 'GAP' \
  'a gap reason carrying row-shaped text does not change the lane state'

# --- The launcher is authoritative and cannot be redirected -----------------
#
# The launcher supplies BOTH the lane inventory and the distinctness rule, so an
# environment variable that replaced it would be a hole straight through this
# tool: a substituted launcher emitting no `env ...` launch line for any lane
# makes every lane look session-shared, and every REUSE silently becomes a PASS.
#
# The fixture launcher below is exactly that hostile substitute. It names the
# same two lanes but emits no launch line for either, so if the audit could be
# redirected to it, the shared-snapshot pair underneath would be reported PASS.
# The row asserts REUSE survives, which is only true when the ambient variable
# is ignored.
decoy_launcher="$TEST_ROOT/decoy-launcher"
{
  printf '#!/bin/sh\n'
  printf 'printf "%%s\\n" "# ---- lane: codex-command ----"\n'
  printf 'printf "%%s\\n" "# ---- lane: codex-terminal ----"\n'
} >"$decoy_launcher"
chmod +x "$decoy_launcher"

rm -f "$receipt_dir"/*.receipt
write_receipt codex-command "$SHA_A" 'worktree' 'PASS'
write_receipt codex-terminal "$SHA_A" 'worktree' 'PASS'

set +e
ambient_out="$(
  AGENT_LANE_AUDIT_LAUNCHER="$decoy_launcher" \
    "$AUDIT" --receipt-dir "$receipt_dir" --lanes codex-command,codex-terminal 2>/dev/null
)"
ambient_status=$?
set -e
case "$ambient_out" in
  *'state=REUSE'*)
    pass 'an ambient launcher override cannot turn REUSE into PASS' ;;
  *)
    fail 'an ambient launcher override replaced the distinctness oracle' ;;
esac
[[ "$ambient_status" -ne 0 ]] ||
  fail 'an ambient launcher override cleared a failing exit status'
pass 'an ambient launcher override cannot clear the exit status'

# --- Hostile regressions: the rows above must be sensitive ------------------
#
# The rows above are all satisfiable by a tool that is wrong in a specific way.
# These break the audit on purpose, on a disposable copy, and require this suite
# to notice. The real tool is never modified.
# The perturbed copy lives in a REPO-SHAPED directory: `<root>/bin/` holding
# both the audit copy and a copy of the launcher beside it.
#
# The audit resolves its launcher relative to its own location and accepts no
# environment override, because an override would let an ambient variable
# replace the inventory and distinctness oracle. So the harness gives the copy a
# real neighbourhood instead of redirecting it: ordinary relative resolution is
# then exactly what these rows exercise, and the shape the perturbations run
# under is the shape production uses.
#
# The launcher is COPIED rather than symlinked so this stays hermetic: the
# fixture cannot be affected by, and cannot affect, the repository's own file.
hostile_root="$TEST_ROOT/hostile-repo"
hostile_bin="$hostile_root/bin"
mkdir -p "$hostile_bin"
hostile_copy="$hostile_bin/agent-lane-audit"

# The launcher now fails closed unless its own repository can produce a
# positive commit epoch. Give this isolated hostile fixture one empty commit so
# the nested mutation checks reach the audit behavior they are meant to test,
# without borrowing history or configuration from the checkout under test.
git -C "$hostile_root" init -q || fail 'could not initialize the hostile audit fixture repository'
git -C "$hostile_root" \
  -c user.name='Agent lane fixture' \
  -c user.email='agent-lane-fixture@example.invalid' \
  commit --allow-empty -qm 'Initialize hostile audit fixture' ||
  fail 'could not create the hostile audit fixture boundary commit'

if [[ -x "$LAUNCHER" ]]; then
  cp "$LAUNCHER" "$hostile_bin/agent-lane-launch"
  chmod +x "$hostile_bin/agent-lane-launch"
fi

perturb() {
  local expression="$1" label="$2"
  sed "$expression" "$REAL_AUDIT" >"$hostile_copy"
  chmod +x "$hostile_copy"
  if cmp -s "$hostile_copy" "$REAL_AUDIT"; then
    fail "$label (the perturbation matched nothing; the regression is vacuous)"
  fi
}

assert_perturbation_is_caught() {
  local label="$1" expected_row="$2"
  local nested_out="$TEST_ROOT/nested.out"
  set +e
  AGENT_LANE_AUDIT_UNDER_TEST="$hostile_copy" "$0" >"$nested_out" 2>&1
  local nested_status=$?
  set -e
  if [[ "$nested_status" -eq 0 ]]; then
    fail "$label (the suite passed against a deliberately broken audit)"
  fi
  # Matched as a FIXED STRING via awk's index(), not a regex.
  #
  # A row label may contain `[` or `]` (several name the rejected input in
  # brackets), and as a regex those become a character class, so a `grep`
  # pattern fails to match even when the intended row is the one that fired.
  # index() == 1 keeps the line-start anchor that a fixed-string match gives up.
  if ! awk -v want="not ok - ${expected_row}" \
    'index($0, want) == 1 { found = 1 } END { exit found ? 0 : 1 }' "$nested_out"; then
    fail "$label (broken audit was caught, but not by the expected row)"
  fi
  pass "$label"
}

# --- Freshness is revalidated here, not taken on trust -----------------------
#
# The receipt tool already enforces both admission gates. These rows are not a
# second opinion about that run; they are the only check a supervisor can make
# WITHOUT the snapshot, which by audit time may be rotated, deleted, or owned by
# another user.
#
# `verdict=PASS` is the receipt's own claim about itself. A receipt written by an
# older build, edited by hand, or produced by a tool whose gate was disabled
# carries exactly the same PASS line as a sound one. The recorded epochs are what
# make the claim checkable, so each row below leaves `verdict=PASS` in place and
# moves only an epoch: a row that goes FAIL therefore proves the AUDIT caught it,
# because nothing else in the receipt changed.
rm -f "$receipt_dir"/*.receipt

write_receipt codex-command "$SHA_FRESH" 'worktree' 'PASS'
run_audit --lanes codex-command
assert_equals "$(state_of codex-command)" 'PASS' \
  'freshness: a receipt whose snapshot postdates both epochs passes'

# Not newer than the lane start: the snapshot cannot be this lane's evidence.
write_receipt codex-command "$SHA_FRESH" 'worktree' 'PASS' \
  "$((FIXTURE_MTIME + 60))" "$FIXTURE_BOUNDARY" "$FIXTURE_MTIME"
run_audit --lanes codex-command
assert_equals "$(state_of codex-command)" 'FAIL' \
  'freshness: a snapshot older than task_start_epoch fails despite verdict=PASS'

# Equality fails, matching the strict inequality the generator enforces. If the
# two tools disagreed on this boundary a receipt would pass one and fail the
# other, and neither verdict would mean anything.
write_receipt codex-command "$SHA_FRESH" 'worktree' 'PASS' \
  "$FIXTURE_MTIME" "$FIXTURE_BOUNDARY" "$FIXTURE_MTIME"
run_audit --lanes codex-command
assert_equals "$(state_of codex-command)" 'FAIL' \
  'freshness: a snapshot equal to task_start_epoch fails'

# Not newer than the repair boundary: the receipt rests on pre-repair evidence.
write_receipt codex-command "$SHA_FRESH" 'worktree' 'PASS' \
  "$FIXTURE_TASK_START" "$((FIXTURE_MTIME + 60))" "$FIXTURE_MTIME"
run_audit --lanes codex-command
assert_equals "$(state_of codex-command)" 'FAIL' \
  'freshness: a snapshot older than boundary_epoch fails despite verdict=PASS'

write_receipt codex-command "$SHA_FRESH" 'worktree' 'PASS' \
  "$FIXTURE_TASK_START" "$FIXTURE_MTIME" "$FIXTURE_MTIME"
run_audit --lanes codex-command
assert_equals "$(state_of codex-command)" 'FAIL' \
  'freshness: a snapshot equal to boundary_epoch fails'

# ABSENCE IS A FAILURE, NOT A SKIP.
#
# Treating a missing field as "not applicable" would make deleting one line the
# cheapest way to buy an unchecked pass -- the same hole the snapshot_sha256
# rows close. Each field is dropped separately so a regression names which one
# stopped being required.
for field in task_start_epoch boundary_epoch snapshot_mtime; do
  write_receipt_without codex-command "$field"
  run_audit --lanes codex-command
  assert_equals "$(state_of codex-command)" 'FAIL' \
    "freshness: a receipt missing ${field} cannot be revalidated and fails"
done

# A DIGIT STRING IS NOT A TIME. `0` beats no real mtime under `-gt`, so a zeroed
# epoch would clear the gate while looking enforced.
for bad in 0 00 -1 'abc' '12.5' ''; do
  write_receipt codex-command "$SHA_FRESH" 'worktree' 'PASS' \
    "$bad" "$FIXTURE_BOUNDARY" "$FIXTURE_MTIME"
  run_audit --lanes codex-command
  assert_equals "$(state_of codex-command)" 'FAIL' \
    "freshness: a task_start_epoch of [$bad] is refused as a positive integer"
done

rm -f "$receipt_dir"/*.receipt


if [[ -z "${AGENT_LANE_AUDIT_UNDER_TEST:-}" ]]; then

  # 1. Cross-lane distinctness dropped: two lanes are never seen to share.
  #
  # The snapshot comparison itself is neutered rather than the surrounding
  # structure, so the tool stays otherwise intact and the failure lands on the
  # reuse rows rather than on an unrelated collapse.
  perturb 's/        \[\[ "${lane_shas\[\$other\]}" == "${lane_shas\[\$index\]}" \]\] &&/        false \&\&/' \
    'distinctness perturbation'
  assert_perturbation_is_caught \
    'an audit blind to cross-lane snapshot reuse is caught' \
    'a separately launched lane sharing a snapshot is reported as REUSE'

  # 2. A GAP allowed to clear the exit status.
  #
  # The most dangerous single regression: every row still reads GAP, the output
  # still looks truthful, and a supervisor checking only the status concludes
  # the matrix is proved.
  perturb 's/if \[\[ "\$gap_count" -gt 0 || "\$problem_count" -gt 0 \]\]; then/if [[ "$problem_count" -gt 0 ]]; then/' \
    'gap exit status perturbation'
  assert_perturbation_is_caught \
    'an audit letting a GAP exit zero is caught' \
    'a set containing a GAP must not exit zero'

  # 3. Distinctness over-reaching to lanes that share a session by contract.
  perturb 's/^    lane_is_separately_launched "\$lane"; then/    true; then/' \
    'over-reaching distinctness perturbation'
  assert_perturbation_is_caught \
    'an audit calling a contract-shared session reuse is caught' \
    'a lane that shares its session by contract is not reported as reuse'

  # 4. An unbound receipt accepted as proof.
  perturb 's/      elif \[\[ "\$binding" != .worktree. \]\]; then/      elif false; then/' \
    'unbound acceptance perturbation'
  assert_perturbation_is_caught \
    'an audit accepting an unbound receipt as proof is caught' \
    'a passing but unbound receipt is not counted as proof of the repaired profile'

  # 5. Lane-name grammar widened to accept anything, so a name composes any path
  #    it likes.
  #
  # The PATTERN is widened rather than the check removed. Deleting the check
  # makes require_lane_name reject every name, which breaks the launcher
  # inventory first and would report sensitivity this row does not demonstrate.
  perturb 's/\^\[A-Za-z0-9\]\[A-Za-z0-9._-\]\*\$/.*/' \
    'lane name grammar perturbation'
  assert_perturbation_is_caught \
    'an audit composing a path from an unsafe lane name is caught' \
    '--lanes refuses an unsafe lane name and says so: [../../../etc/hosts]'

  # 6. Line-break refusal dropped, so a gap reason can forge an output row.
  perturb "s/    \*\\\$'\\\\n'\* | \*\\\$'\\\\r'\*)/    'never-matches-this')/" \
    'gap reason line break perturbation'
  assert_perturbation_is_caught \
    'an audit letting a gap reason forge an output row is caught' \
    'a gap reason containing a line break must be refused'

  # 7. Snapshot-hash validation dropped, so a lane with no usable hash silently
  #    skips distinctness and passes.
  perturb 's/\^\[0-9a-f\]{64}\$/.*/' \
    'snapshot hash validation perturbation'
  assert_perturbation_is_caught \
    'an audit passing a lane with no usable snapshot hash is caught' \
    'a receipt whose snapshot_sha256 is not a SHA-256 fails: [absent]'

  # 8. Lane attribution dropped, so a renamed receipt stands in for a lane that
  #    never ran.
  perturb 's/      elif \[\[ "\$claimed_lane" != "\$lane" \]\]; then/      elif false; then/' \
    'lane attribution perturbation'
  assert_perturbation_is_caught \
    'an audit accepting a receipt renamed to another lane is caught' \
    'a receipt renamed to another lane does not stand in for that lane'

  # 9. Freshness revalidation dropped, so a receipt's own PASS is taken on trust.
  #
  # This is the regression the freshness rows exist for: with the comparison
  # gone, a receipt whose recorded epochs show a pre-repair snapshot still
  # reports PASS, and the audit stops being an independent check.
  perturb 's/        elif \[\[ "\$lane_mtime" -le "\$lane_task_start" \]\]; then/        elif false; then/' \
    'freshness revalidation perturbation'
  assert_perturbation_is_caught \
    'an audit trusting a stale receipt verdict is caught' \
    'freshness: a snapshot older than task_start_epoch fails despite verdict=PASS'

  # 10. The positive-integer requirement relaxed to a digit string.
  #
  # `0` clears every `-gt` comparison, so a zeroed epoch passes a gate that still
  # looks enforced. Only a row rejecting zero specifically can see this.
  perturb 's/\[\[ "\$value" =~ \^\[1-9\]\[0-9\]\*\$ \]\] || return 1/[[ "$value" =~ ^[0-9]+$ ]] || return 1/' \
    'zero-epoch metadata perturbation'
  assert_perturbation_is_caught \
    'an audit accepting a zero freshness epoch is caught' \
    'freshness: a task_start_epoch of [0] is refused as a positive integer'

  # 11. The contradiction note dropped, so a stale gap declaration sitting over a
  #     real receipt is never mentioned.
  #
  # The note is emptied rather than the branch removed, so the receipt is still
  # evaluated exactly as before and the failure lands on the visibility rows
  # rather than on a verdict changing underneath them.
  perturb 's/^      contradiction_note=/      : /' \
    'gap contradiction note perturbation'
  assert_perturbation_is_caught \
    'an audit discarding a contradicted gap declaration is caught' \
    'a gap contradicted by a passing receipt is surfaced in the row'

  # 12. The reuse note written over the row instead of composed with it, so a
  #     lane reclassified as REUSE loses whatever the first pass recorded.
  #
  # This is the same loss as 11 but on the second-pass path, and it survives
  # that row: the contradiction is still recorded, still composed at emit, and
  # then overwritten when the verdict changes. Only a row that declares a gap
  # over a lane that ALSO reuses a snapshot can see it.
  perturb 's/^          lane_notes\[\$index\]="${lane_notes\[\$index\]}; ${reuse_note}"$/          lane_notes[$index]="$reuse_note"/' \
    'reuse note composition perturbation'
  assert_perturbation_is_caught \
    'an audit overwriting a reclassified row note is caught' \
    'a lane reclassified as REUSE keeps its contradiction note'
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
  skip 'hostile regressions (nested run)'
fi

printf '1..%d\n' "$assertion_count"
if [[ "$skip_count" -gt 0 ]]; then
  printf '# skipped %d\n' "$skip_count"
fi
