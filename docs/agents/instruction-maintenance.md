# Instruction Maintenance

- Invoke `writing-for-agents` before changing `AGENTS.md`, `CLAUDE.md`, or a
  `SKILL.md`, or a document reached by their pointer.
- Write compactly: cut filler, not reasons. Keep the reason beside any
  constraint whose purpose is not obvious.
- One idea per bullet.
- Imperative voice.
- Use Markdown structure. Reserve XML tags for machine-parsed boundaries.
- Direct: lead with the action, boundary, owner, or check.
- Critical language: use `must`/`never` only for enforceable invariants; name
  the consequence or check.
- Keep the closest applicable instruction file as a trigger-bearing map. Put
  branch-only guidance in an owned `docs/agents/` file.
- Register each `docs/agents/` file with a task trigger in
  `docs/agents/README.md`. Reach that index from the personal instruction
  source or `AGENTS.md`; add direct pointers only when a branch needs them.
- Preserve one source of truth. Point to it instead of copying its contract.
- Before editing, inspect the current owner and check for duplicate,
  contradictory, stale, or broader guidance.
- Before writing, show the exact path-limited change, startup-context delta,
  proof, and rollback. Ask for approval when Nathan did not explicitly request
  the change.
- Verify every changed pointer.

## Verification

- Check the exact candidate files with `git diff --check`. Run the repository's
  installed formatter in check mode where it supports the changed format;
  record unsupported formats separately. Inspect every changed local pointer and
  heading anchor against that candidate. Record the checked paths and outcomes;
  formatting alone does not prove pointer validity.
- For installed startup links, run
  `bin/dotfiles/symlinks/symlinks_manage.sh --status --machine` from Dotfiles.
  Inspect the instruction rows' stored targets and status, not only the exit code.
  A correct link does not prove that a running Harness loaded its content.
- For native instruction-loading proof, follow
  [Agent Instructions Evaluation](../../config/agents/evaluation/README.md).
  Its deterministic grader tests qualify the grader, not a native run. Execute a
  bounded native canary only within its separate authority; retain unrun loading
  proof as incomplete.
- Resolve a scheduled check's live identity before relying on it. An absent
  automation or retired skill is not an executable check. Keep file verification,
  installed-link readback and native loading as separate results.
