---
title: "What is lost when the codex plugin goes"
labels: [wayfinder:research]
parent: skill-corpus-addressing
blocked_by: []
status: closed
---

## Question

The marketplace ruling removes `openai-codex`, which backs the `/codex:*` route
and the `codex-rescue` subagent. What capability is actually lost, and does
anything need replacing before the switch flips?

## Resolution — 2026-08-19

**Nothing load-bearing is lost. No replacement needed.**

Verified 2026-08-19:

- **The `codex` CLI is a Homebrew binary** at `/opt/homebrew/bin/codex`,
  installed independently of the plugin. Removing the marketplace does not
  remove Codex itself. Any workflow that shells out to `codex` keeps working.
- **The plugin's three skills are internal plumbing, not user surface.** Each
  description begins "Internal helper contract" or "Internal guidance":
  `codex-cli-runtime` (43 lines), `codex-result-handling` (21),
  `gpt-5-4-prompting` (54). They exist to serve the plugin's own
  `codex-rescue` subagent, not to be invoked directly.
- **Listing cost is 88t** across the three — the cheapest enabled plugin by a
  wide margin, so removal is not motivated by budget either.
- **No global rule references them.** A scan of
  `dotfiles/config/agents/claude/rules/` found no mention of codex, unlike
  `ce-code-review`, which two rule files name explicitly.

### What does change

The `/codex:rescue` and `/codex:setup` slash commands and the `codex-rescue`
subagent disappear with the plugin. That is a convenience wrapper around a CLI
that remains installed, not a capability with no other route.

Nathan's global rules already prefer delegating to Codex through explicit CLI
invocation rather than the plugin surface, so the loss is bounded.

### Consequence for the marketplace ticket

Both dependency clauses are now cleared: `compound-engineering` has a named
replacement (Matt Pocock's `code-review`), and `codex` needs none. The
marketplace removal has no remaining blockers of this kind.
