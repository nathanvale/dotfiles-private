# Architecture Decisions

Record one implementation-binding, costly-to-reverse decision when it changes
system structure, quality attributes, dependencies, interfaces, or construction
techniques.

## Route

1. Read the repository instructions and every existing ADR that touches the
   decision.
2. Use the ADR location declared by repository instructions or existing ADRs.
3. When no location exists, create `docs/adr/NNNN-short-decision-title.md`;
   increment the highest number and never reuse a number.
4. For lifecycle, frontmatter, and template, use the repository's declaration;
   otherwise use the invoked workflow's contract; otherwise use the defaults
   below.
5. Resolve the repository's named decision authority before any lifecycle
   transition.
6. Set a new record to `proposed`. Change an existing status only after that
   authority explicitly approves the target status; if authority or approval
   is absent, stop and ask.
7. Test every option against every named decision driver. Record the material
   positive, negative, and neutral consequences.
8. For a proposed or accepted decision, name the test, review, metric, or
   observable evidence that will confirm implementation.

## Completion

- Proposed: one significant decision; solution-neutral context; every option
  tested against every driver; recommendation, tradeoffs, authority, and
  planned confirmation named.
- Accepted: chosen option, rationale, consequences, authority, and confirmation
  evidence named.
- Rejected: rejection authority and rationale named; no implementation
  confirmation required.
- Deprecated: transition authority, reason, and revisit guidance named.
- Superseded: body preserved; transition authority named; reciprocal exact
  filename links point to an accepted replacement.

## Lifecycle

- New decision: `proposed`.
- Approved decision: `accepted`.
- Declined proposal: `rejected`.
- Discouraged but unreplaced decision: `deprecated`.
- Proposed replacement: keep the prior accepted ADR unchanged.
- Accepted replacement: add `supersedes`; in the same change, preserve the
  replaced ADR's body, set `status: superseded`, and add `superseded_by`.

Use exact ADR filenames for `supersedes` and `superseded_by`. Let Git own
chronology unless the repository's frontmatter contract requires a date. Verify
that both supersession links are reciprocal.

## Template

```md
---
status: proposed
---

# Short decision title

## Context and Problem

State the relevant facts, forces, constraints, and decision question. Keep the
context solution-neutral.

## Decision Drivers

- Driver or requirement.
- Driver or requirement.

## Considered Options

- Option A.
- Option B.

## Decision

We will choose Option A because it best satisfies [named drivers].

## Consequences

- Positive: ...
- Negative: ...
- Neutral: ...

## Options and Tradeoffs

### Option A

- Good: ...
- Bad: ...

### Option B

- Good: ...
- Bad: ...

## Confirmation

For a proposed or accepted decision, name the test, review, metric, or observable
evidence that will confirm implementation. Name any revisit trigger.

## References

- Issue, specification, experiment, or related ADR.
```

For an accepted replacement, preserve every unrelated frontmatter key and add:

```yaml
---
status: accepted
supersedes: NNNN-prior-decision.md
---
```

In the same change, preserve every unrelated frontmatter key in the replaced
record. Change only `status` and add `superseded_by`:

```yaml
---
status: superseded
superseded_by: NNNN-replacement-decision.md
---
```

## Sources

- [AD Practices](https://adr.github.io/ad-practices/)
- [ADR Templates](https://adr.github.io/adr-templates/)
- [MADR full template](https://github.com/adr/madr/blob/4.0.0/template/adr-template.md)
- [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
