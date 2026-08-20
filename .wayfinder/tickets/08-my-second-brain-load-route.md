---
title: "How my-second-brain reaches the session"
labels: [wayfinder:research]
parent: skill-corpus-addressing
blocked_by: []
status: open
---

## Question

Nine `my-second-brain:*` skills appear in the live session listing, but the
plugin is **not** present in `settings.json` `enabledPlugins`. By what mechanism
does it load, and does that mechanism survive removing every non-personal
marketplace?

Discovered 2026-08-19 while measuring the true listing cost.

`result.md` in `user-scope-config-consolidation` documents the likely cause: when
the `settings.json` Tracking Link was repointed, the development entries
`my-second-brain@my-second-brain-dev` and its `directory`-source marketplace were
removed to make the file byte-identical to the staged copy. The plugin survived
anyway — "Claude Code re-registered it through its plugin cache rather than the
settings file."

This is load-bearing. The whole plan routes personal skills into this plugin, so
its load path must be understood and deliberate rather than incidental.

Resolve with:
- The actual mechanism: plugin cache, `directory`-source marketplace, the
  `.dev/` projection, or the repo's own `dev:claude` script.
- Whether a marketplace purge removes it, and whether the `directory` source
  type (marked machine-bound in `result.md`) is what makes it exempt from the
  "personal marketplaces only" rule or what disqualifies it.
- How it should be declared once the corpus lives there — a stable, intentional
  route rather than a cache artifact.
