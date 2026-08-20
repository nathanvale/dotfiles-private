---
title: "Moving personal skills into my-second-brain"
labels: [wayfinder:grilling]
parent: skill-corpus-addressing
blocked_by: [01-true-listing-measurement]
status: open
---

## Question

Nathan ruled that all personal skills move into the my-second-brain plugin as
the single management point. What is the shape of that, given the plugin's
accepted architecture?

ADR-0007 separates authoring (Bun workspace members) from distribution
(per-skill bundles, dependencies inlined, never `node_modules`). It names
browser-use as its model. That contract covers the 19 code-bearing skills
cleanly.

Decide:
- How the 30 prose-only skills are represented. They have no `main` entry and
  nothing to bundle.
- Whether `dotfiles/.agents/skills/` remains the committed source, becomes a
  build output, or is retired. Two repos currently claim ownership.
- What happens to `.agents/runtime/` — 7 vendored `@side-quest` packages added
  without a decision on 2026-08-19. ADR-0007's bundling likely replaces it
  entirely.
- Whether moving skills into a plugin reintroduces the marketplace mechanism
  ruled against in the marketplace ticket, and how a personal plugin is exempt.
