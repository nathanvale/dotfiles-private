---
name: delivery-slice
description: Turn an accepted Wayfinder branch outcome into a reviewable spec draft and dependency-linked vertical-slice ticket drafts using to-spec and to-tickets. Use after a bounded outcome is agreed; unresolved planning belongs with Wayfinder.
---

# Delivery slice

Produce a draft spec before proposing delivery tickets. An accepted behavioral
outcome, an accepted spec, publication and execution authority are separate facts.
Default to review in the conversation. Save drafts only to the requested owner;
the starting code repository does not acquire the project's planning or privacy
ownership. Keep the canonical Wayfinder branch and its history intact.

## Resolve the outcome

Read the supplied branch, outcome, relevant comments and accepted-decision
sources through existing connected read tools. Resolve the actual project's
planning entry, glossary and delivery owner. For ecosystem work, follow the
configured vault's live Linear planning pointer; GitHub owns the code PR and
Shepherdr retains adopted execution, review and recovery. This workflow creates
no task synchronizer. Intake remains with `linear-intake`.

Record the source revision or observation time, exact agreed outcome, requested
scope and acceptance source. Distinguish source facts, accepted decisions,
proposals, assumptions and unknowns. Supplied offline records can support a
draft; identify them as supplied evidence, with live currency unverified.
If required sources cannot be read, hand back the missing source and repair
route rather than claiming acceptance from a title or cached summary.

Settle only choices that affect this slice's scope, access, behavior or acceptance.
A closed decision issue or proposed roadmap row alone supplies neither an accepted
answer nor build approval. Keep unrelated fog open. For a material unanswered
choice, identify the owning question, consequence and next human decision; mark
the affected draft blocked. Draft independently settled portions when useful,
without silently narrowing the requested outcome or inventing its answer.

## Compose the spec draft with to-spec

Load the installed `to-spec` skill through the Harness's skill/read mechanism.
If absent, stop composition and name the missing dependency and its installer
owner. Read its template and use its synthesis and testing-seam reasoning.
This wrapper overrides its immediate publication and `ready-for-agent` defaults.
Draft-only scope also overrides its requirement for an extensive user-story list:
keep stories proportional to the actual outcome. Reuse agreed answers without
re-interviewing. Keep any new material seam proposed for user review.

Give the draft an alias and revision, such as `SPEC-DRAFT r1`. Include its source
links, bounded problem and user-visible result, relevant accepted decisions,
proposed implementation and highest practical test seams, exclusions and
unsupported assumptions. Preserve the template's distinction between implementation
and testing decisions. Number observable acceptance criteria with stable IDs
(`AC-01`, `AC-02`); retain IDs across revisions and mark retired criteria rather
than recycling them. Identify criteria blocked by an unresolved choice.
Label the spec draft even when its source outcome is accepted. Show the spec
before the ticket breakdown; spec drafting does not accept its new proposals.

## Compose ticket drafts with to-tickets

Load the installed `to-tickets` skill; if absent, return the spec with an explicit
ticket-stage dependency gap. Use its tracer-bullet method and ticket template
against the named spec revision. Its publishing, readiness and working-the-frontier
defaults remain outside draft scope. Ask for breakdown review without publishing
or executing it. A ticket with no blockers is parallelizable in the proposal,
not authorized to start.

Use numbered draft aliases, never invented live issue keys. For each ticket give:

- The spec revision, criterion IDs and any decision-source link it consumes.
- Its independently demoable or verifiable user result, scope and exclusions.
- Its work kind. Mark research/manual prerequisites honestly; horizontal setup
  alone is not a complete product slice.
- Actual prerequisite aliases and a reason each must complete first.
- Observable checks, required evidence and the stop condition.

Preserve dependency reasons instead of mechanically chaining the list. Show
parallel work. Check existing supplied or readable delivery records for overlap,
including completed and canceled items; state the limit if live deduplication
is unavailable. Inspect the proposed graph for duplicate outcomes, missing or
retired criterion references, uncovered criteria, unnecessary edges and cycles.
Repair proposal errors before presenting; preserve the reason for each repair.
A parent-child link expresses grouping, not a prerequisite.

Return the spec, numbered tickets, dependency sketch, acceptance-coverage table
and unresolved decisions together. Every criterion needs ticket/check coverage or
an explicit blocked/uncovered finding. Keep proposals distinct from facts. End
with the next review decision and the draft-only stop condition. Ticket creation
is planning, not execution; leave the production pilot, credentials, runtime
ownership and current holds with their existing owners.

## Later publication

Read [the publication boundary](references/publication.md) only when the user
explicitly requests publication of reviewed drafts. Draft approval alone is not
publication, readiness, dispatch or implementation authority.
