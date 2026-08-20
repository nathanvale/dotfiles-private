---
title: "What the session listing actually costs"
labels: [wayfinder:research]
parent: skill-corpus-addressing
blocked_by: []
status: closed
assignee: claude-session-99350c2b
---

## Question

What is the real per-source token cost of one session's skill listing, and by
what mechanism does Claude Code degrade when it is exceeded?

The 2026-08-19 figures are unreliable in two ways. Plugin costs were measured by
globbing `~/.claude/plugins/**/SKILL.md`, which double-counts across cache
versions and counts disabled plugins. And the 2,000 budget is asserted without a
known enforcement mechanism — the doctor run reported truncation and degraded
routing, but the actual cutoff, and whether it is per-source or global, is not
established.

Resolve with:
- A clean measurement of what one live session loads: global skills, enabled
  plugin skills, project-scope skills. Deduplicated, disabled plugins excluded.
- The mechanism behind the 2,000 figure — where it comes from, what it truncates
  first, and whether disabling a plugin removes its cost.

This gates every disposition decision: without it the spec optimises a number
nobody has verified.

## Resolution — 2026-08-19

### Disabled plugins cost nothing

Settled by direct observation of a live session listing. `theme-factory`,
`doc-coauthoring`, `xlsx` and `pdf` exist on disk under the **disabled**
`anthropic-agent-skills` plugins and appear **nowhere** in the session's skill
listing.

The earlier "~21,400t of cached-but-disabled plugins" figure is **phantom** and
is struck from the map. Disabling a plugin removes its listing cost in full;
purging its cache is a disk-space concern, not a budget one.

### The real numbers

The earlier ~16,900t enabled-plugin figure was inflated roughly 6x by globbing
every cached version of each plugin. Deduplicated to the newest version per
plugin, and cross-checked against the skills actually visible in this session:

| Source | Entries | ~tokens |
| --- | --- | --- |
| `~/.claude/skills` first-party | 49 | 1,959 |
| `~/.claude/skills` third-party | 68 | 2,121 |
| `compound-engineering` | 32 | 2,200 |
| `harness-native-plugin-prototype` | 5 | 177 |
| `bitbucket-pr` | 2 | 112 |
| `codex` | 3 | 92 |
| `frontend-design` | 1 | 59 |
| **Total** | **160** | **~6,721** |

**3.4x over the 2,000 budget**, not the 2x the global-corpus-only view showed.

### What this means for the plan

- **`compound-engineering` is the single largest removable item at 2,200t** —
  more than the entire 49-skill first-party corpus. Turning it off is worth more
  than every other curation decision combined, and its one load-bearing
  dependency already has a replacement.
- **The four other enabled plugins total 440t.** Removing them is near-free in
  budget terms; the case for removing them is the one-route principle, not cost.
- **Curating the global corpus alone cannot reach 2,000.** Even a perfect
  first-party corpus (1,959t) consumes the entire budget before third-party or
  any plugin is counted. The destination requires cuts across every source.

### Unexpected finding: my-second-brain loads outside enabledPlugins

Nine `my-second-brain:*` skills appear in the live listing, but the plugin is
**not** in `settings.json` `enabledPlugins`. It loads through the development
marketplace/plugin-cache route that `result.md` documented when the settings.json
link was repointed ("Claude Code re-registered it through its plugin cache
rather than the settings file").

This is load-bearing for the plan: the target address for all personal skills is
reached by a mechanism that is not declared in settings, and a marketplace purge
could silently remove it. **Graduated to its own ticket.**

### Not established

The mechanism enforcing the 2,000 budget remains unverified — where the number
originates, what truncates first, and whether it is per-source or global. The
doctor run observed silent truncation and degraded routing, which is sufficient
motivation to cut, but the exact cutoff is still unmeasured. Filed as remaining
fog rather than blocking the disposition work.
