# Archived Rule Files

Nothing here is loaded. The Harness discovers `rules/` by convention; it has
no convention for this directory, and no file names it. Context Load is zero.

Every file is tracked. To reinstate one:

    git mv config/agents/claude/rules-archived/<name>.md config/agents/claude/rules/

## Audit notes

Moved wholesale on 2026-08-20 for review, one day after `8409132` cut startup
Context Load from 13.8k to 9.9k bytes.

`security-boundaries.md` carries the credential prohibition. Reinstate it
first unless the audit moves those Clauses into the Instruction Core.

`git-workflow.md` lines 23-31 hold eight Pointers to `docs/git/workflows.md`
and `docs/git/worktree.md`. Neither file exists in this repository; both
survive only in `~/code/.archive/claude-code-config-20260819/docs/git/`.
Reinstating the file without restoring those targets restores eight dead
Pointers.

`file-hygiene.md` is the only file carrying a Scope Trigger. The other
fourteen loaded unconditionally.
