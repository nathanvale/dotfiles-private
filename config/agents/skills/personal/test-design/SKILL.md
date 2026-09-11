---
name: test-design
description: "Design or change tests, fixtures, mocks, snapshots, helpers, or harnesses; audit test-writing anti-patterns; select a proportional brief or read-only verdict."
---

# Test Design

Use before creating or changing any repository-test artifact, or when explicitly
asked to audit test design, test-writing anti-patterns, or testing standards.
Reading or running tests without an audit request does not trigger this skill.

## Route

1. Keep the active workflow as driver.
2. Inspect the intended repository-test artifact change, approved seam, proof
   claim, existing regression, and focused command.
3. Select one route:
   - `audit`: explicit read-only review of existing tests, fixtures, plans, or
     testing standards. Emit no brief and change no repository-test artifact.
   - `no-new-brief`: no repository-test artifact changes and the active workflow
     owns the existing regression proof. Return immediately.
   - `lightweight`: the edit preserves the repository-approved seam, oracle
     contract, fixture meaning, harness behaviour, and claimed proof boundary,
     and reuses an existing focused regression.
   - `full`: any seam, oracle, fixture, harness, claim, CLI contract, or test
     contract is new, changed, disputed, or unclear.
4. Fail upward to `full` when a write route is unclear.

## Audit route

1. Read `references/pattern-library.md` completely.
2. Select every relevant profile, then read only the selected profile references
   completely.
3. Inspect the production consumer or workflow, claimed proof boundary, existing
   tests, fixtures, doubles, helpers, harnesses, and testing guidance.
4. Detect anti-patterns by testing the inverse of every applicable core pattern
   and selected profile rule. Do not invent a parallel checklist.
5. Return this read-only report:

```text
Test Design Audit
Verdict: sound | fix-first | rethink
Scope:
Production consumer and claimed proof:
Anti-pattern findings:
Proof gaps:
Smallest correction direction:
Still unproved:
```

- `sound`: no blocking anti-pattern is supported by the inspected evidence.
- `fix-first`: the seam and proof layer remain valid, but local corrections are
  required before relying on the tests.
- `rethink`: the seam, oracle, fixture, harness, or claim cannot support the
  promised behaviour and needs a new design decision.
- Name exact paths and lines when available. Separate observed evidence from
  inference and state when evidence is missing.
- During an audit, never edit tests or other repository-test artifacts. If the
  user later requests corrections, re-enter `lightweight` or `full` before the
  first mutation.

## Evidence gates

- Use an executable focused command from a named working directory. Name the
  intended selector and expected non-zero test count. If no owner provides one,
  record that gap in a `full` brief.
- Treat an observed failing regression as RED evidence. Otherwise name a
  disposable perturbation that the selected test must catch, then return to the
  driver to restore GREEN in the same harness.

## Lightweight brief

Write this brief in the active conversation before editing:

```text
Lightweight Test Design Brief
Behaviour being corrected:
Existing test and focused command:
How the existing test goes RED:
Still unproved:
```

Then return to the current workflow. Escalate to `full` if implementation
reveals a changed seam, oracle, fixture, harness, or claim.

## Full brief

1. Read `references/pattern-library.md` completely.
2. Select every relevant profile, then read only the selected profile references completely.
3. Inspect the public behaviour, repository test conventions, and focused command.
4. Write this complete brief in the active conversation before editing:

```text
Test Design Brief
Behaviour:
Seam and proof layer:
Independent result:
How it goes RED:
Relevant profiles and gotchas:
Focused command:
Still unproved:
```

5. For an existing repository-approved or user-selected seam, return to the current workflow.
6. For a new, changed, or disputed seam, stop before mutation and ask the user to approve the seam.

Do not accept a brief whose expected result restates the implementation. Do not claim a broader boundary than the selected proof layer reaches.

## Driver handbacks

- `tdd`: brief before the first test edit; return for RED to GREEN.
- `diagnosing-bugs`: brief after reproduction and isolation; return before the regression-test edit.
- `ci-testbed`: use only when mismatch repair changes a repository-test artifact; return to its repair owner.
- `cli-design`: brief after contract and seam selection; return before test implementation.
- `test-runner`: use only when repair changes a repository-test artifact; return to repair mode.
## Done

- `no-new-brief` returned without emitting a brief only when no test artifact
  changes and the active workflow owns the existing regression proof.
- Selected brief visible and complete before the first repository-test artifact edit.
- A lightweight brief preserves its seam, oracle, fixture, harness, and claim.
- An audit returns one exact verdict, anti-pattern findings, proof gaps, and the
  smallest correction direction without changing repository-test artifacts.
- Seam already approved, already selected, or awaiting explicit approval.
- Handback to the active workflow explicit.
- Remaining unproved boundary stated without hiding skips, disabled cases, or environmental gaps.

Next safe action: return the audit report or completed brief to the current
workflow.
