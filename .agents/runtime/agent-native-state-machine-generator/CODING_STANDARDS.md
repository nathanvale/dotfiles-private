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
- A supported historical input compiles through its registered reader in
  `registered-readers.ts`, which owns that version's frozen bytes and pinned
  digest identity. When a change cannot reproduce that evidence, escalate to
  the product owner with the observed digests; a pinned identity is evidence
  about admitted history, so it stays fixed while the explanation moves.
- Diagnostics carry a JSON path and a source location.
- Diagnostic and refusal messages read as one voice: begin with a capital,
  end with a full stop, name the construct and the sealed rule it broke, and
  carry no absolute path (`message` is the human half of a contract, so a
  reader must not be able to tell which file raised it).

## Types

- No `any`. Prove totality with types (`unknown` plus narrowing, or types
  derived from the schema), not casts. A cast defeating the checker is a
  defect, not a convenience.
- Seal closed meanings as literal unions, never bare `string`, so tsc owns
  exhaustiveness (the `BranchKind` lesson). One owner per sealed vocabulary
  is a global rule; the global standards document owns it.
- Runtime-specific APIs (`Bun.*`, `bun:*`) live only in the module that owns
  filesystem effects. Every other module is portable TypeScript (emitters are
  pure by invariant; a runtime call in a rendering path is how that
  invariant gets lost).

## Control flow

- No guard for a structurally impossible state. Delete it with a custody note
  naming why it cannot fire; keep the cause in the sealed list only if
  another producer can genuinely deliver it.
- Derive meaning from declared candidate surface. Where the schema cannot
  express a required meaning, refuse with a sealed cause; never substitute a
  hardcoded default that masquerades as derivation.
- A forbidden public transition refuses unconditionally, with the privilege
  living in the seam rather than in an argument a caller chooses. Give a test
  needing pre-existing privileged state a committed fixture or an unexported
  helper under `tests/support/`, so production keeps one answer.
- A switch over a sealed union ends in an explicit exhaustiveness check
  (`const _: never = value`), never a catch-all `default`. A non-optional
  return type is not the proof: `walk` returns `void`, so a new `Shape`
  variant compiles clean and validates nothing.
- Generation sweeps stale `.asmg-staging-*` siblings from the output
  directory's parent before staging a new set. An abnormal exit between
  staging and cleanup strands one inside the consumer's tree and
  survivors accumulate (witnessed three of three SIGKILL probe runs at
  stage 4). The sweep deletes only names carrying the staging prefix,
  under the package's single-writer contract.

## Text

- ASCII punctuation in source, comments, and all rendered or generated text
  (generated consumer files inherit every byte).
- Comments state constraints the code cannot show. No narration, no
  provenance, no restating the next line.
- Order by codepoint in every comparator whose result reaches emitted bytes,
  a digest input, or a caller-visible list: plain `<` on strings, or
  `Array.prototype.sort()` with no comparator. No `localeCompare`, no `Intl`
  (collation is host ICU data, so the same specification would regenerate to
  different bytes on a different machine and regeneration-and-compare would
  report drift that is not drift).
- Normalize every string reaching the digest to NFC with LF line endings
  before hashing (the canonical form claims cosmetic differences hash
  identically; unnormalized text breaks that claim for two candidates a
  reviewer cannot tell apart).

## Tests

- Test at the package boundary: inputs to diagnostics, IR, digest, artifacts.
  Helper-only proof does not count.
- One focused fixture per refusal cause, asserting the cause, that it is the
  only cause, a source location, and the absence of output.
- Prove a claim RED before trusting it: perturb the source, watch exactly the
  guarding test fail, revert, re-run GREEN in the same harness.
- Per-branch fixture reachability is the evidence for a sealed-vocabulary
  rule; a coverage percentage is not.
- A test iterates each sealed cause list and fails on any member no fixture
  reaches. The per-cause fixture rule is checked by the suite, not by a
  reviewer's memory (four causes with live producers reached the
  consolidation merge with no fixture).
- An assertion that a token is absent from generated text is paired with a
  positive control: some declared input under which that exact token appears.
  Without it the guard passes because no emitter ever produced the token,
  not because the emitter stopped (the eleven-token stateless sweep lesson).
- A loop over cases asserts the case list is non-empty before the loop, and
  each assertion names its row: pass a label to `expect`, or compare a
  labelled object. A filter matching nothing must fail, and a failure must
  say which row broke.
- A refusal whose contract is "before writing" is proven by reading the
  output directory back and asserting it is unchanged, not by the returned
  cause alone (the returned value is silent about what the filesystem
  already saw).
- A test whose name quantifies over a sealed vocabulary iterates that
  vocabulary's exported constant. Naming the set and asserting one member is
  a claim the suite does not hold.
- A fixture or sweep that deletes filesystem entries proves its own
  boundary: one test plants both what must be deleted and what must
  survive, and asserts both outcomes. A sweep that deletes siblings can
  over-delete, and only a planted survivor holds that line.
