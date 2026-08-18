# Instruction Maintenance

- Invoke `writing-for-agents` before changing `AGENTS.md`, `CLAUDE.md`, or a
  `SKILL.md`, or a document reached by their pointer.
- Telegraph; noun-phrases ok; drop grammar; min tokens.
- One idea per bullet.
- Imperative voice.
- Use Markdown structure. Reserve XML tags for machine-parsed boundaries.
- Direct: lead with the action, boundary, owner, or check.
- Critical language: use `must`/`never` only for enforceable invariants; name
  the consequence or check.
- Keep the closest applicable instruction file as a trigger-bearing map. Put
  branch-only guidance in an owned `docs/agents/` file.
- Admit a `docs/agents/` file only with its pointer in the personal
  instruction source or `AGENTS.md`. Add the file to
  `docs/agents/README.md`.
- Preserve one source of truth. Point to it instead of copying its contract.
- Before editing, inspect the current owner and check for duplicate,
  contradictory, stale, or broader guidance.
- Show the exact path-limited change, startup-context delta, proof, and
  rollback. Ask for approval before writing.
- After approval, verify every changed pointer.
- The `Weekly agent instruction structure check` Codex automation owns file and
  adapter proof.
- The `Monthly agent instruction loading canary` Codex automation owns root and
  nested Harness-loading proof.
