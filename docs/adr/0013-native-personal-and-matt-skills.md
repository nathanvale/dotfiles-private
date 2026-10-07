---
status: proposed
---

# Use native owners for personal and Matt Pocock skills

## Context and Problem

[ADR-0003](0003-agent-skills-topology.md) introduced transitional personal
sources and reviewed third-party copies. Personal changes and Matt installation
now require several declarations, locks, and link checks. Nathan requested a
simpler structure on 7 October 2026 and one draft PR combining three revisions.

## Decision Drivers

- Give personal skills one plugin owner and Matt skills one installer owner.
- Preserve authored files, modes, runnable commands, and per-Harness visibility.
- Reduce routine commands and repeated declarations.
- Preserve unrelated vendors, plugins, project skills, and machine configuration.

## Considered Options

| Revision | Mechanism | Preservation | Routine complexity | Scope |
| --- | --- | --- | --- | --- |
| A, minimal | Move personal sources, retain residual topology and fixed machine baselines; generate a Codex selection directory if needed. | Requires packaging and visibility proof. | Removes personal links but can duplicate selected payloads. | Narrow Matt migration; other vendors remain reviewed. |
| B, moderate | Native personal manifests, `library/` and `optional/`; adopt existing Matt bytes into native installer ownership. | Retains exact bytes and visibility without a generated selection map. | Removes personal/Matt topology and manual workspace links. | Preserves the remaining 32 vendor skills. |
| C, ambitious | B's native ownership plus complete runtime bundles, state-path repair, and operation snapshots. | Copied payloads must execute without checkout dependencies. | Removes permanent machine-cache baseline maintenance. | Full personal source and runtime relocation. |

## Decision

Recommend B's ownership structure with C's runtime packaging and operation
snapshots. An independent reviewer supported this synthesis after inspecting
repository sources and official Harness documentation. All three candidate
authors and the reviewer used fresh contexts on the current model family;
this was not cross-model evidence.

Store 39 personal skills in `config/agents/plugins/personal/library/` and the
Codex-disabled `fix-microphone` in `optional/`. Codex selects the library.
Claude explicitly selects its 26 enabled directories, preserving nine disabled
and five absent legacy skills. Remove the default `skills/` directory because
Claude scans it in addition to manifest paths. Plugin skills do not obey
Claude's `skillOverrides`.

Adopt the 35 existing Matt payloads and their complete machine-lock records
without an upstream fetch. Subsequent changes use ordinary named global
`npx skills` commands. Remove Matt vendoring and duplicate topology declarations.
Keep the 32 unrelated reviewed vendors and their source checks.

Bundle personal executable dependencies for copied installations. Keep sources,
tests, assets, licenses, and modes. Let frozen Bun workspaces own dependency
links. Record operation-scoped protected-state snapshots rather than fixed cache
counts and hashes in Git.

## Consequences

- Positive: personal editing has one owner; Matt installation has one ordinary CLI.
- Positive: native manifests replace the personal activation registry.
- Negative: personal executable changes require regenerated runtime bundles.
- Negative: future Matt updates are machine operations rather than vendored Git diffs.
- Neutral: unrelated reviewed vendors retain their current owner and restoration route.

A generated selection directory duplicates manifest membership and is unnecessary
with this layout. Migrating every vendor or deleting the entire inventory would
expand the request and discard unrelated restoration guarantees.

## Confirmation

Compare all 40 personal source trees and modes with the task-base archive;
verify the 39 Codex and 26 Claude selections; execute all 13 bundled TypeScript
entrypoints and the runner preflight outside the checkout; preserve unrelated
vendor bytes and lock records; pass the repository quality gates.

Live activation is separate. Before merging source deletions, install and prove
the replacement owners, then remove only identified obsolete source links.
The pre-change inventory has 19 existing issues, including dangling links and
protected-cache drift. Preserve that evidence and report it separately.

Nathan is the decision authority. This draft proposes replacement of the personal
and Matt portions of ADR-0003; its accepted historical record remains unchanged
until this proposal is accepted. Other portions remain in force.

## References

- [Personal plugin and cutover](../../config/agents/plugins/personal/README.md).
- [Skill ownership](../agents/skills.md).
- [Claude plugin paths](https://code.claude.com/docs/en/plugins-reference).
- [Claude skill visibility](https://code.claude.com/docs/en/skills).
- [Skills CLI](https://github.com/vercel-labs/skills).
