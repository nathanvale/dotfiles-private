---
title: "Skill Corpus Addressing"
labels: [wayfinder:map]
status: open
created: 2026-08-19
updated: 2026-08-19
---

# Skill Corpus Addressing

## Destination

A ruled decision on where every skill lives — plugin, hand-picked third-party,
or not a skill at all — **plus an executable spec**: per-entry disposition, the
target address for each class, and the order of operations. The next agent
should be able to build from the spec without reopening a decision.

The measured gate: one session's skill listing sums under **2,000 estimated
tokens**, by the name-plus-description sum the 2026-08-19 doctor run used.

## Notes

**Budget is hard.** 2,000 for one listing, ruled 2026-08-19.

**The measurement that reframed this effort.** Curating `~/.claude/skills`
alone cannot reach 2,000: the 49 first-party skills consume 1,959t on their own,
the entire budget, before third-party or any plugin is counted. Cuts are needed
across every source.

Measured and cross-checked against a live session listing, 2026-08-19:

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

**3.4x over budget.** `compound-engineering` alone (2,200t) exceeds the entire
first-party corpus, making it the single highest-value removal.

**Disabled plugins cost nothing** — proven by observation, so cache purging is a
disk concern, not a budget one.

**Cost is concentrated, not spread.** Within the global corpus, 20 skills carry
1,230t while the 30-strong `gog-*` family carries only 434t. Entry count and
token cost are not proportional.

**Owners to consult before deciding:**
- Vault `user-scope-config-consolidation` — D4, D11, D13, D14, D17.
- Vault `harness-scoped-skills` — the deferred representation question.
- `my-second-brain-plugin` ADR-0007 (workspace authoring, bundled
  dependency-free distribution; names browser-use as its model) and ADR-0005
  (shared runtime custody).
- `dotfiles/CONTEXT.md` — Harness Neutrality glossary.

**Standing preference:** planning only. Produce decisions and the spec; do not
execute the migration inside this map.

**Already committed and working** (do not re-litigate): 49 first-party skills in
`dotfiles/.agents/skills/`, 26 retired, `skill-feedback-runtime.ts` fixed with a
dynamic import. Commits `e72e947`, `dc1ca93`, `a960044`.

## Decisions so far

- **Direction, ruled by Nathan 2026-08-19** (recorded here because it was
  settled in conversation, not by a ticket — each clause still needs its own
  ticket to become executable):
  - One way of bringing skills in. No second route.
  - Remove all marketplaces. The only marketplaces ever allowed are personal
    ones, such as my-second-brain.
  - Turn off the compound-engineering plugin.
  - Hand-pick third-party skills using the existing `npx skills` method.
  - Move all personal skills into the my-second-brain plugin — one place to
    manage them.
  - Retire the `gog-*` family from the global corpus.
- [Retiring the gog family from the global corpus](tickets/04-gog-family-disposition.md)
  — hand-pick them through the third-party `npx skills` route instead of
  removing wholesale; the `gog` router survives.
- [Swapping the main-direct review gate](tickets/06-code-review-gate-swap.md) —
  Matt Pocock's `code-review` (87 lines, two axes, already installed) replaces
  `compound-engineering:ce-code-review`. Two rule files need the rename.
- [What is lost when the codex plugin goes](tickets/07-codex-plugin-dependency.md)
  — nothing load-bearing. The `codex` CLI is a Homebrew binary independent of
  the plugin; its 3 skills are internal plumbing (88t) that no global rule
  references. No replacement needed.
- [What the session listing actually costs](tickets/01-true-listing-measurement.md)
  — real total is **6,721t across 160 entries, 3.4x over budget**. Disabled
  plugins cost zero; the earlier 21,400t figure was phantom and the 16,900t
  enabled figure was 6x inflated by version double-counting.

## Not yet specified

- **Where prose-only skills live inside the plugin.** 30 of the 49 first-party
  skills carry no runtime, so ADR-0007's bundling contract does not obviously
  apply to them. The plugin ships skills, not only bundles — needs confirming.
- **What `~/.claude/skills` is for afterwards.** If personal skills move to the
  plugin and third-party is hand-picked, the global address may hold very
  little, or nothing.
- **The fate of `dotfiles/.agents/skills/`** as the committed source, if the
  plugin becomes the management point. These are two different repos claiming
  the same ownership.
- **What replaces `skills-sync`**, retired in the current goal.
- **Whether description rewriting is a lever.** Sharpens once the degradation
  mechanism is known. Still unmeasured: what enforces the 2,000, what truncates
  first, and whether it is per-source or global.
- **Codex's view of all this.** The plugin is harness-native; `~/.agents/skills`
  is the Codex address and is out of scope here, but the two must not diverge
  silently.

## Out of scope

- `~/.agents/skills` and the 15 path-keyed exclusions in `~/.codex/config.toml`.
  Cutover step 5, its own authority.
- Archiving `claude-code-config`. Cutover step 9.
- Executing any migration. This map produces the decision and the spec.
