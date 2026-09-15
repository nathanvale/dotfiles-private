#!/usr/bin/env bash
#
# Work-profile slug grammar parity.
#
# THREE owners carry this grammar, and .zshrc is the canonical one:
#
#   .zshrc                  the selector the shell actually loads (canonical)
#   work-profile-init.sh    the scaffold generator's argument guard
#   setup.sh                the migration that seeds a selection on upgrade
#
# The generator validates its argument, creates ~/code/<slug>-dotfiles, then
# tells the operator to select that value; the migration writes a selection
# directly. So the promise this file proves is:
#
#   every value a writer accepts, the canonical selector also accepts.
#
# The failure this closes is silent. A writer that accepted `acme-` produced a
# real repository or a real selection, and the selector then refused the value
# at every startup, so the work profile never loaded and nothing said why.
#
# Every grammar is EXTRACTED from its owner rather than restated here. A copy in
# this file would drift and would prove only that the copies agree. Each
# extraction is asserted non-empty, because an extraction that silently found
# nothing would make the rows below pass against an empty pattern.

set -euo pipefail

REPO_ROOT="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
GENERATOR="$REPO_ROOT/.claude/skills/dotfiles/scripts/work-profile-init.sh"
SETUP="$REPO_ROOT/setup.sh"
ZSHRC="$REPO_ROOT/.zshrc"

pass_count=0

pass() {
  pass_count=$((pass_count + 1))
  printf 'ok %d - %s\n' "$pass_count" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_equals() {
  [[ "$1" == "$2" ]] || fail "$3 (expected '$2', got '$1')"
  pass "$3"
}

# --- Extract the generator's guard -----------------------------------------
#
# The bracket expression is lifted verbatim from the `if [[ ! "$EMPLOYER" =~ ]]`
# line. Extraction is asserted non-empty: an extraction that silently found
# nothing would make every parity row below pass against an empty pattern.
generator_pattern="$(
  sed -n 's/.*"\$EMPLOYER" =~ \(\^[^ ]*\$\).*/\1/p' "$GENERATOR"
)"
[[ -n "$generator_pattern" ]] ||
  fail 'could not extract the slug pattern from the generator'
pass 'the generator slug pattern is extracted from work-profile-init.sh'

# The pattern bounds repetitions, not characters, so each owner carries a
# separate total-length check. It is extracted the same way: a copy here would
# drift, and an empty extraction would let the length rows pass vacuously.
generator_limit="$(
  sed -n 's/.*\${#EMPLOYER} > \([0-9][0-9]*\).*/\1/p' "$GENERATOR"
)"
[[ -n "$generator_limit" ]] ||
  fail 'could not extract the slug length limit from the generator'
pass 'the generator slug length limit is extracted from work-profile-init.sh'

# --- Extract the migration's guard -----------------------------------------
#
# setup.sh seeds a selection when upgrading a machine that already had a work
# profile. It writes ~/.dotfiles_state/work-profile directly, with no operator
# in the loop, so a loose grammar here is the least visible of the three: the
# machine comes back with a selection the shell refuses and nothing was typed
# to blame. The `$slug` anchor is load-bearing in this expression; setup.sh
# carries unrelated `$REPLY` prompts that also use `=~`.
setup_pattern="$(
  sed -n 's/.*"\$slug" =~ \(\^[^ ]*\$\).*/\1/p' "$SETUP"
)"
[[ -n "$setup_pattern" ]] ||
  fail 'could not extract the slug pattern from setup.sh'
pass 'the migration slug pattern is extracted from setup.sh'

setup_limit="$(
  sed -n 's/.*\${#slug} > \([0-9][0-9]*\).*/\1/p' "$SETUP"
)"
[[ -n "$setup_limit" ]] ||
  fail 'could not extract the slug length limit from setup.sh'
pass 'the migration slug length limit is extracted from setup.sh'

# --- Extract the canonical selector ----------------------------------------
#
# The selector function is taken whole from .zshrc, exactly as
# zsh-work-profile-boundary-test.sh does, so this file cannot drift from the
# shipped shell code.
adapter="$(mktemp)"
probe_home=""
trap 'rm -f "$adapter"; [[ -n "$probe_home" ]] && rm -rf "$probe_home"' EXIT
sed -n '/^dotfiles-work-profile-slug()/,/^}/p' "$ZSHRC" >"$adapter"
[[ -s "$adapter" ]] ||
  fail 'could not extract dotfiles-work-profile-slug from .zshrc'
grep -q 'print -r -- "\$slug"' "$adapter" ||
  fail 'extracted selector does not reach its accept path'
pass 'the canonical selector is extracted from .zshrc'

# --- The three oracles -----------------------------------------------------

# Runs the generator's own extracted pattern and length limit in bash, the
# engine the generator uses. Reports accept/reject only.
generator_accepts() {
  [[ "$1" =~ $generator_pattern ]] && (( ${#1} <= generator_limit ))
}

# Runs the migration's own extracted pattern and length limit in bash, the
# engine setup.sh uses.
setup_accepts() {
  [[ "$1" =~ $setup_pattern ]] && (( ${#1} <= setup_limit ))
}

# Runs the canonical selector in zsh against a real state file under a hermetic
# HOME, so this crosses the same public boundary the shell does at startup: the
# value is read from disk as data, not passed as an argument.
#
# EXTENDED_GLOB is set locally by the extracted function itself. Without it the
# `(#c0,31)` operator is inert text and every value would be refused, so the
# accept rows below are what prove the option is genuinely in effect.
selector_accepts() {
  local home
  home="$(mktemp -d)"
  mkdir -p "$home/.dotfiles_state"
  printf '%s\n' "$1" >"$home/.dotfiles_state/work-profile"
  # The adapter path travels as a positional argument, evaluated by the child
  # only as data, so a path carrying a quote or space cannot rewrite the fixed
  # program text.
  local out
  out="$(
    HOME="$home" zsh -f -c '
      source "$1"
      dotfiles-work-profile-slug >/dev/null 2>&1 && print -r -- accept || print -r -- reject
    ' _ "$adapter" 2>/dev/null
  )"
  rm -rf "$home"
  [[ "$out" == 'accept' ]]
}

verdict() {
  local value="$1" gen setup sel
  generator_accepts "$value" && gen=accept || gen=reject
  setup_accepts "$value" && setup=accept || setup=reject
  selector_accepts "$value" && sel=accept || sel=reject
  printf '%s/%s/%s' "$gen" "$setup" "$sel"
}

# --- Named cases -----------------------------------------------------------
#
# Each expected verdict is written by hand from the grammar's prose contract in
# .zshrc, not by running any of the three expressions, so the oracle stays
# independent of every implementation. Format is generator/setup/selector, and
# every row names all three owners, so a drift in any one of them fails here.

# Ordinary slugs every owner must accept.
for good in acme a-b-c a ab12 7eleven "$(printf 'a%.0s' {1..32})"; do
  assert_equals "$(verdict "$good")" 'accept/accept/accept' \
    "every owner accepts a conservative slug: ${good:0:12}"
done

# The reported defect: shapes a writer must not admit, because the selector
# refuses them. A writer that accepts any of these produces a dead profile.
assert_equals "$(verdict 'acme-')" 'reject/reject/reject' \
  'a trailing hyphen is refused by every owner'
assert_equals "$(verdict '-acme')" 'reject/reject/reject' \
  'a leading hyphen is refused by every owner'
assert_equals "$(verdict 'a--b')" 'reject/reject/reject' \
  'a doubled interior hyphen is refused by every owner'
assert_equals "$(verdict 'ac--')" 'reject/reject/reject' \
  'a trailing doubled hyphen is refused by every owner'
assert_equals "$(verdict "$(printf 'a%.0s' {1..33})")" 'reject/reject/reject' \
  'a 33-character value is refused by every owner'

# The length boundary is exact: {0,31} after one leading character means 32.
assert_equals "$(verdict "$(printf 'a%.0s' {1..32})")" 'accept/accept/accept' \
  'the 32-character boundary value is accepted by every owner'

# The pattern bounds REPETITIONS, and a `-x` repetition is two characters, so a
# hyphenated value can pass the pattern while exceeding the documented
# 32-character total. The separate length check in every owner is what refuses
# it; this pair proves the check counts characters without over-tightening.
over_limit_mixed="a$(printf '%.0s-b' {1..16})"   # 33 characters, 16 repetitions
boundary_mixed="ab$(printf '%.0s-c' {1..15})"    # 32 characters, 16 repetitions
assert_equals "$(verdict "$over_limit_mixed")" 'reject/reject/reject' \
  'a 33-character hyphenated value inside the repetition bound is refused'
assert_equals "$(verdict "$boundary_mixed")" 'accept/accept/accept' \
  'a 32-character hyphenated boundary value is accepted by every owner'

# Shapes that must be unrepresentable, not merely filtered.
for bad in 'ACME' 'ac me' 'a.b' '../evil' 'a/b' 'a;id' '$(cmd)' 'a_b' ''; do
  assert_equals "$(verdict "$bad")" 'reject/reject/reject' \
    "an unsafe or malformed value is refused by every owner: ${bad:-<empty>}"
done

# --- The parity property ---------------------------------------------------
#
# The rows above name specific shapes. These rows assert the promise itself over
# every case in the file, once per writer, so a future widening that no named row
# happens to cover still fails here. The direction matters: a writer must not be
# WIDER than the selector. A writer narrower than the selector refuses a value
# the shell would have loaded, which is safe and is not asserted against.
parity_candidates=(
  acme a-b-c a ab12 7eleven acme- -acme a--b ac-- 'ACME' 'ac me' 'a.b'
  '../evil' 'a/b' 'a;id' '$(cmd)' 'a_b' ''
  "$(printf 'a%.0s' {1..32})" "$(printf 'a%.0s' {1..33})"
  "$over_limit_mixed" "$boundary_mixed"
)

for candidate in "${parity_candidates[@]}"; do
  if generator_accepts "$candidate"; then
    selector_accepts "$candidate" ||
      fail "the generator accepts a value the selector refuses: '$candidate'"
  fi
done
pass 'every generator-accepted value is accepted by the canonical selector'

for candidate in "${parity_candidates[@]}"; do
  if setup_accepts "$candidate"; then
    selector_accepts "$candidate" ||
      fail "setup.sh accepts a value the selector refuses: '$candidate'"
  fi
done
pass 'every setup.sh-accepted value is accepted by the canonical selector'

# --- Public executable behaviour -------------------------------------------
#
# The rows above exercise the extracted pattern. This one runs the real script,
# so the claim covers argument parsing and exit status rather than the regex
# alone. A rejected slug must fail before any scaffolding happens: HOME is a
# throwaway directory and is asserted to stay empty.
probe_home="$(mktemp -d)"
set +e
HOME="$probe_home" bash "$GENERATOR" 'acme-' >"$probe_home/out" 2>"$probe_home/err"
reject_status=$?
set -e
[[ $reject_status -ne 0 ]] ||
  fail 'the generator exited zero for a slug the selector refuses'
pass 'the generator exits non-zero for a slug the selector refuses'

grep -q 'Invalid slug' "$probe_home/err" ||
  fail 'the rejection reason is not reported on stderr'
pass 'the generator reports its rejection on stderr'

[[ ! -e "$probe_home/code" ]] ||
  fail 'the generator scaffolded a directory for a refused slug'
pass 'the generator creates nothing for a refused slug'

printf '1..%d\n' "$pass_count"
