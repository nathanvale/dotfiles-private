# Coding Standards: Agent-Native State Machine Generator

Idioms this package's reviews enforce. Naming and operating invariants live in
[`AGENTS.md`](AGENTS.md); vocabulary in [`CONTEXT.md`](CONTEXT.md). Biome and
tsc own format and lint; nothing here restates them. Cross-package rules live
in the repository's global standards document
([`docs/agents/coding-standards.md`](../../../docs/agents/coding-standards.md));
this file holds package-specific idioms only and points rather than restates.

## Results and refusals

- Public functions return discriminated unions. The failure variant carries no
  partial output: no `ir`, `digest`, or artifact field exists on it.
- Refusal and diagnostic causes come from an exported sealed const (`as
  const`), with the type derived from it. Each sealed list carries a custody
  comment: adding a member is a Generator Contract change.
- `cause` is the branchable API. `message` explains for humans and never
  carries meaning a caller must parse.
- Spec-fixed cause tokens (`generated_drift`, `incompatible_run_version`,
  `command_surface_drift`) keep their spec spelling; note the CONTEXT.md
  concept name in a comment where they are declared.
- Diagnostics carry a JSON path and a source location.

## Types

- No `any`. Prove totality with types (`unknown` plus narrowing, or types
  derived from the schema), not casts. A cast defeating the checker is a
  defect, not a convenience.
- Seal closed meanings as literal unions, never bare `string`, so tsc owns
  exhaustiveness (the `BranchKind` lesson). One owner per sealed vocabulary
  is a global rule; the global standards document owns it.

## Control flow

- No guard for a structurally impossible state. Delete it with a custody note
  naming why it cannot fire; keep the cause in the sealed list only if
  another producer can genuinely deliver it.
- Derive meaning from declared candidate surface. Where the schema cannot
  express a required meaning, refuse with a sealed cause; never substitute a
  hardcoded default that masquerades as derivation.

## Text

- ASCII punctuation in source, comments, and all rendered or generated text
  (generated consumer files inherit every byte).
- Comments state constraints the code cannot show. No narration, no
  provenance, no restating the next line.

## Tests

- Test at the package boundary: inputs to diagnostics, IR, digest, artifacts.
  Helper-only proof does not count.
- One focused fixture per refusal cause, asserting the cause, that it is the
  only cause, a source location, and the absence of output.
- Prove a claim RED before trusting it: perturb the source, watch exactly the
  guarding test fail, revert, re-run GREEN in the same harness.
- Per-branch fixture reachability is the evidence for a sealed-vocabulary
  rule; a coverage percentage is not.
