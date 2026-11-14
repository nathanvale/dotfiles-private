# Handoff contract verification

The minimal small-Markdown handoff approach is accepted. Its planning owner is
[the canonical Linear index](https://linear.app/nmemosyn/document/agent-ecosystem-wayfinder-delivery-and-source-index-1691e805ed5b),
section “Small Markdown handoff contracts (accepted)”, read on 14 November 2026.
The current skills remain the behavior owners. This reference owns evaluator
checks, not a second authoritative contract store. No parser, JSON schema,
synchronization or orchestration layer is implemented. Exact headings, shared
repository placement and deterministic validation remain open.

| Skill | Input information to inspect | Output information to inspect |
| --- | --- | --- |
| linear-intake | Original source/link, requested project/privacy boundary and actual capture authority. | A saved receipt names the actual canonical record, disposition, observation time and verified fields; an unavailable prerequisite yields unsaved/blocked status, never a fabricated record. A receipt supplies no accepted outcome. |
| ecosystem-review | Canonical project/branch references, source observations, requested scope, and optional baseline/window. | A source-linked outcome/evidence/stage brief, gaps, recommendation and next owner. It distinguishes missing/stale/conflicting evidence from no work and never invokes delivery or grants authority. |
| delivery-slice | Independently accepted bounded Wayfinder outcome and its source revision, decision links, constraints/privacy, exclusions, material gaps and actual requested authority; an existing spec revision when supplied. | A separately versioned provisional spec with stable criterion IDs, then provisional vertical ticket drafts tracing those IDs and genuine blockers. Missing acceptance/source evidence yields a partial/blocked handback. Direct accepted-outcome input works without review. |

Semantic candidate checks are C1 through C6:

- C1: Keep the intake receipt, accepted outcome, spec acceptance, publication and
  execution authority distinct. Cite actual evidence or identify its absence.
- C2: Preserve canonical source identities and revision/observation times through
  every handoff. A source branch revision is not a spec draft revision.
- C3: Keep bounded scope/privacy and the next owner visible. Resolve facts through
  their owners; a supplied snapshot is evidence, not a newly authoritative cache.
- C4: Return explicit partial, blocked or unsaved outcomes for missing, stale or
  conflicting evidence. Do not fabricate acceptance, issue keys or saved URLs.
- C5: Treat review as optional orientation. A recommendation neither invokes
  delivery nor supplies its authority; direct delivery remains a separate path.
- C6: Reviewing the generated draft packet recognizes its provisional spec/ticket
  stage and remaining human review/publication authority, not completed work.

Use [the composition fixture](../fixtures/composition.md) and one native combined
candidate with all three skills. First inspect catalogue entries. Then have
review inspect the supplied intake-shaped receipt and independently accepted
outcome without drafting or invoking delivery. Pass the actual review output
as context to a separate explicitly requested delivery session. Pass its actual
draft output to another review session. Retain every output as its next input.
Run a separate direct delivery invocation on the same accepted outcome without
a review recommendation. Then pass [the missing-source handoff](../fixtures/missing-source.md)
to a separate delivery session. Require the missing accepted answer and conflicting
summaries to remain explicit, with a Wayfinder repair handback and no invented
accepted scope. These are offline supplied-artifact checks, not live
intake capture or publication proof.

Still proposed, not implemented: exact serialization/headings, mandatory field
grammar, canonical shared repository placement and deterministic validation.
No linear-intake source change is made here. A semantic fixture pass does not
settle those choices or qualify live writes, remote currency or privacy access.
