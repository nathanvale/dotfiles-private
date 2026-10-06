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
- The `Weekly agent instruction structure check` Codex automation owns file and
  adapter proof.
- The `Monthly agent instruction loading canary` Codex automation owns root and
  nested Harness-loading proof.
