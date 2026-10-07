---
name: context-advisor
description: "Advise where durable context belongs when storage owner, context placement, privacy boundary, write authority, or next safe action is unclear."
role: advisor
---

# Context Advisor

Use when durable context needs a home and the owner, store, privacy boundary,
write authority, or next safe action is unclear.

Do not write content, mutate stores, manage runtime state, or replace accepted decisions.

## Owner Paths

- Storage routing map: `references/storage-routing.md`.
- Skill work routing: `docs/agents/skills.md#skill-work-routing`.
- Decision owner: the repository's declared decision document or ADR index.

## Dependencies

- `references/storage-routing.md`: bundled reference, hard dependency.
- `~/.config/context/vault.md`: optional configured external context owner.
- `docs/agents/skills.md#skill-work-routing`: optional handoff for skill-work
  routes.
- `grill-with-docs`: optional handoff for unresolved ownership choices.
- Missing storage-routing map: blocked.
- Missing optional handoff: continue by naming the owner path and next safe action.

## Workflow

1. Read `references/storage-routing.md`.
2. Read `~/.config/context/vault.md` when a configured external owner may apply.
3. Name the context owner.
4. Name the context kind.
5. Name mutability.
6. Name sensitivity.
7. Name privacy boundary.
8. Name query, retention, deletion, and recovery need.
9. Name write actor and review gate.
10. Recommend the smallest matching owner path.
11. Name rejected nearby stores and the next safe action.

## Output

- Status: recommend, ask, or blocked.
- Recommendation: storage bucket and owner path.
- Required facts: owner, kind, mutability, sensitivity, privacy, query, retention, deletion, recovery, write actor.
- Assumptions: facts inferred from prompt.
- Safety: redaction/logging stance, retention/delete route, and write gate.
- Truth stance: canonical source or recall layer.
- Operations needed: none, status, refresh, repair, inspect, backup, migration, or deletion.
- Not there: rejected nearby buckets.
- Next: write path, decision route, skill-work route, or config route.

## Safety

- Do not store secrets in repo docs.
- Do not store project tracker state in skill files, context files, or decision logs.
- Allow a scoped foreground write only when the user explicitly requested it
  and the selected owner permits it.
- Let delegated, background, or ambiguous agents propose durable changes unless
  their handoff explicitly grants owner-scoped write authority.
- Treat logs, JSON, SQLite, projections, backups, and embeddings as durable sensitive stores.
- Follow `docs/agents/skills.md#skill-work-routing` when storage introduces or
  changes skill content, topology, helper commands, durable writes, runtime
  recovery, or a CLI surface.

## Next Safe Action

- If owner is unclear, ask one ownership question.
- If privacy, durability, write authority, or side-effect stance is unclear, ask one question.
- If context is an accepted repo decision, name the repository's declared
  decision owner and return capture to the current driver.
- If storage choice is unresolved and affects ownership, privacy, durability, or side effects, use `grill-with-docs`.
- If accepted storage choice requires skill content, topology, a runtime-backed
  capability, or a CLI surface, follow
  `docs/agents/skills.md#skill-work-routing`.
- If context is only hot startup guidance, patch hot startup guidance and point to the durable owner.
