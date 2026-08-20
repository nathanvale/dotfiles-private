---
title: "Swapping the main-direct review gate"
labels: [wayfinder:grilling]
parent: skill-corpus-addressing
blocked_by: []
status: closed
---

## Question

`git-workflow.md` names `compound-engineering:ce-code-review` as the gate
complex commits must pass on the main-direct repos (claude-code-config,
dotfiles). Turning off the compound-engineering plugin removes that gate. What
replaces it?

## Resolution — 2026-08-19

**Matt Pocock's `code-review` replaces it.** Nathan ruled the gate swaps to the
already-installed `code-review` skill, which is materially thinner.

Verified 2026-08-19:
- Installed at `~/.agents/skills/code-review`, reachable at
  `~/.claude/skills/code-review`. Survives the marketplace removal because it
  arrives by the third-party route, not a plugin.
- 87 lines. Two axes — Standards (repo's documented coding standards) and Spec
  (matches the originating issue) — run as parallel sub-agents, reported side
  by side.
- Costs 108t in the listing, the second-largest single third-party entry.
- Requires `docs/agents/issue-tracker.md` per repo. **Present in all three**
  relevant repos (dotfiles, claude-code-config, my-second-brain-plugin), so
  there is no setup gap.

### Follow-on edit required

`dotfiles/config/agents/claude/rules/git-workflow.md` line 12 names
`compound-engineering:ce-code-review` and must be rewritten to `code-review`.
`worktree-isolation.md` carries the same reference. Both are startup-instruction
edits, so `instruction-maintenance.md` governs the change.

This unblocks the compound-engineering clause of the marketplace ticket: the one
accepted working practice depending on that plugin now has a named replacement.
