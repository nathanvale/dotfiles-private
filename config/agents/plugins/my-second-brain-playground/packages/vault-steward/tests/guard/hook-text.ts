// The Unit 1 reference-transaction hook text, embedded so plugin tests run from a clean plugin checkout without the
// vault (OPEN-DECISIONS D5). hook-text.test.ts pins its sha256 to the accepted digest; Unit 1's own tests pin the same
// digest against scripts/git-hooks/reference-transaction in the vault, so drift fails on whichever side changes.
export const HOOK_TEXT = String.raw`#!/bin/sh
# reference-transaction: vault main-only gate (Unit 0 final: fail-open guards added)
state=$1
[ "$state" = prepared ] || exit 0
if ! command -v git >/dev/null 2>&1; then
  printf 'VAULT_GUARD_FAIL_OPEN git not found on PATH; gate skipped\n' >&2
  exit 0
fi
zero=0000000000000000000000000000000000000000
while read -r old new ref; do
  case "$ref" in
    refs/heads/main) ;;
    refs/heads/*)
      [ "$new" = "$zero" ] && continue
      git rev-parse --verify -q "$ref" >/dev/null 2>&1
      case $? in
        0) ;;
        1)
          printf 'VAULT_GUARD_BRANCH_CREATE_DENIED %s\n' "$ref" >&2
          printf 'This vault is main-only. Commit notes with: vault-note-commits begin --path <file> --json\n' >&2
          printf 'Owner: docs/agents/git-guardrails.md\n' >&2
          exit 1 ;;
        *)
          printf 'VAULT_GUARD_FAIL_OPEN git rev-parse failed for %s; gate skipped\n' "$ref" >&2
          exit 0 ;;
      esac ;;
  esac
done
exit 0
`
