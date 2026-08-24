---
name: pattern-referee
description: "Referee a claimed software or AI-agent pattern name: pattern-fit dispute, proposed pattern label, or catalog identity check after architecture pressure exists."
role: advisor
---

# Pattern Referee

Judge pattern names that someone already proposed. Architecture pressure
arrives as evidence; this skill decides whether a name is earned.

## Boundary

- Referee proposed names. Architecture discovery stays with its owner.
- Treat a pattern name as translation after evidence.
- Preserve `No pressure -> no pattern`.
- Return a Missing-Pressure Handoff when pressure evidence is absent.
- Explain a catalog entry only to justify one verdict.

## Owner Map

- Pattern library: [`references/pattern-index.md`](references/pattern-index.md).
- Architecture pressure workflow: external `improve-codebase-architecture` skill.
- Design vocabulary: external `codebase-design` skill.
- Pressure-gate semantics: `config/agents/claude/context/code-style.md`.
- Skill work routing: `docs/agents/skills.md#skill-work-routing`.
- Project state and accepted decisions: vault project `pattern-referee-skill`.

## Three Gates

Every kept verdict passes all three gates in order. A failed gate names the
missing evidence and stops.

### 1. Pressure Gate

Read the Pressure Artifact and confirm each field:

- Pressure source.
- Seam.
- Owner of that seam.
- Useful consequence.

Accepted artifacts: architecture report, seam-swarm synthesis, plan pressure
section, prototype verdict, decision log.

Consume the artifact as given. Rerun discovery only when the artifact is
stale, self-contradictory, or silent on a gate field.

When a field is absent, return a **Missing-Pressure Handoff**: name the absent
fields, name the next evidence owner, and return control to the active
workflow. For existing code, the handoff may recommend an explicit
architecture run. For planned work, return the missing questions.

### 2. Identity Gate

Route the candidate name to its family through
[`references/pattern-index.md`](references/pattern-index.md), then confirm the
library entry supplies:

- Intent.
- Applicability.
- Participants and collaboration.
- Consequences.
- Nearest alternative.
- Authoritative source.

Compare the candidate against its nearest alternative. Structural resemblance
alone leaves the name unearned; the distinguishing field decides it.

### 3. Liveness Gate

Confirm the named seam and its owning decision remain active. Check the entry
owner status and `last_verified`. A `superseded` entry produces a rejected
verdict that names its successor.

## Verdicts

- **Kept**: three gates pass and the entry is `admitted`.
- **Rejected**: pressure is absent, the seam is vague, plain design vocabulary
  already describes it, the entry is `rejected-as-pattern`, or the entry is
  `superseded`.
- **Deferred**: pressure exists and identity fits, and implementation proof,
  a second adapter, or a second use case has not arrived. A `reference-only`
  entry reaches deferred at best.

A **Local Label** is an accurate project-specific name offered as a more
precise alternative. Return it as a verdict; it stays out of the library.

## Local Heuristics

Apply each where it bears on the candidate:

- Deletion test: when the claim rests on a module earning its keep.
- Module and interface pressure: when the claim rests on concentrated
  complexity behind one seam.
- Second adapter: when the claim rests on a variation point.

## Output Shape

Return:

- Kept names, each with its library entry and passing evidence.
- Rejected names, each with the failing gate.
- Deferred names, each with the arriving proof that would keep it.
- Seam owner.
- Pressure proof.
- Next safe action.

## Next Safe Action

- Pressure present: return the kept, rejected, and deferred verdicts.
- Pressure absent: return the Missing-Pressure Handoff.
