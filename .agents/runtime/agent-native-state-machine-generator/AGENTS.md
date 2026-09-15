# Agent-Native State Machine Generator: Package Map

Read [`CONTEXT.md`](CONTEXT.md) first: exact terms are mandatory in names,
types, diagnostics, and comments, and its Avoid terms are refusals.

## Authority

- Product and proof spec: dotfiles issue 55; accepted rulings live in
  its single plan comment. Fetch:
  `ghh exec --account nathanvale -- issue view 55 --repo nathanvale/dotfiles-private --json body,comments`
- The fixture candidates and the pilot candidate are unadmitted drafts.
  Compiling proves nothing about authority; Specification Admission is an
  explicit product-owner act. The pilot is learning-only: its green gates
  are never qualification evidence.
- One candidate is on Input Schema v1 (fallow) and one on v2 (vault-git,
  unadmitted, its digest pinned nowhere until its own Specification
  Admission). `fixtures/spike-candidates/vault-git.v1-frozen.state-machine.jsonc`
  is owned history: the vault-git bytes from before that re-authoring, frozen
  as the subject for every v1 claim and holding the pinned `f22e836b..`
  identity. Never refresh it to track the live candidate.

## Map

| Path | Owns |
|---|---|
| `src/index.ts` | The one front door. Callers never import internals. |
| `src/jsonc.ts` | Data-only JSONC reader with source locations. |
| `src/schema.ts` | Current Input Schema shapes (v2) and sealed vocabularies. |
| `src/input-schema-v1.ts` | The superseded v1 surface, frozen verbatim for its Registered Reader. |
| `src/registered-readers.ts` | The sole compile route for superseded Input Schema Versions; a version with no reader fails closed. |
| `src/frozen-canonical-v1.ts` | v1's canonicalization and digest envelope, frozen so the reader owns the bytes it hashes. |
| `src/schema-difference.ts` | Structural difference between Input Schema Versions, computed from the shapes themselves. |
| `src/structural.ts` → `src/semantic.ts` | Located structural walk, then named semantic checks. |
| `src/ir.ts`, `src/build-ir.ts` | Canonical typed IR and its construction. |
| `src/canonical.ts` | Canonical form and the specification digest envelope. |
| `src/diagnostics.ts` | Sealed `DIAGNOSTIC_CAUSES`; adding a cause is a reviewed contract change. |
| `src/refusal.ts` | Sealed `ARTIFACT_REFUSAL_CAUSES` and the refusal idiom (sealed cause, named subject, prose message) the other refusal types converge on. |
| `src/artifact-set.ts` | `ArtifactEmitter` seam, provenance manifest, and the registry generation renders through. |
| `src/generate.ts` | The three verbs (generate, verify, regenerate) and sealed drift causes. |
| `src/artifact-derivation.ts` | `deriveArtifactSet`: one compiled specification in, the complete Generated Artifact Set or refusals out. |
| `src/branch-stations.ts` | Branch Station derivation, the id grammar, and their canonical order. |
| `src/command-surface-contract.ts` | Command Surface Contract records and the emitted-contract baseline-exit check (`semantic.ts` validates the same sealed list at compile). |
| `src/expectations.ts` | The semantic expectation table joined to stations by `expectedActionId`. |
| `src/extension-registry.ts` | Extension Registry reconciliation; a separate seam, needing bindings a candidate does not carry. |
| `src/render.ts` | Derived values to TypeScript source text. Returns strings, never writes files. |
| `src/derivation-facts.ts` | Per-branch facts, result-contract binding, and retry-posture resolution shared across derivations. |
| `src/contextual-renderings.ts` | Contextual Rendering derivation: the published resolution table; compile (`semantic.ts`) owns target-against-catalog validation for both declared forms. |
| `src/observation-budgets.ts` | Observation Expiry meaning: per-Attempt bound; polling and heartbeats never renew one. |
| `fixtures/spike-candidates/` | The spike candidates and the frozen Input Schema v1 exemplar. v1 is the union of the two original candidates, nothing more; the live vault-git candidate has since been re-authored against v2, so the exemplar carries v1's half. |
| `fixtures/negative/`, `fixtures/permuted/` | One fixture per rejection cause; digest-permutation proof. |
| `fixtures/v2/`, `fixtures/draft-candidates/` | The v2 declared-surface exemplar with its refusal fixtures; the third-product draft candidate. |
| `tests/` | Compiler-boundary tests only: inputs → diagnostics / IR / digest / artifacts. |
| `pilot/` | The Vault Git Reimagined learning pilot: unadmitted candidate, generation lane (`pilot/generate.ts`, `pilot/generation/`), generator-owned Generated Artifact Set at `pilot/generated/`, Handwritten Extensions beside it at `pilot/extensions/`, the facade-composed CLI `pilot/cli.ts`, and the emission and real-process smoke proofs. |

## Invariants

- Fail closed by type: failure variants carry no `ir`, `digest`, or artifacts.
  Never add a partial-output field.
- Emitters are pure. A clock, random value, or absolute path breaks
  regeneration-and-compare, the only drift oracle (per-file hashes are banned
  by ruling).
- Surface gaps as sealed refusals for the product owner; never invent schema
  surface, execution modes, or policy the candidates do not declare.
- `cli-command-facade` is read-only until stage 5; its exported types judge
  emitted catalogs.
- Name files, types, functions, and sealed vocabularies in CONTEXT.md terms:
  grepping a contract term must land in its owning file. A name needing a
  term CONTEXT.md lacks: add the term to CONTEXT.md first, then use it.
- No new third-party dependencies.

Code idioms reviews enforce: [`CODING_STANDARDS.md`](CODING_STANDARDS.md).

## Checks

- `bun run test` (covers `./tests` and `./pilot`) and `bun run typecheck`
  from this package.
- `bunx biome check .agents/runtime/agent-native-state-machine-generator`
  from the worktree root.
- `bun pilot/generate.ts verify` from this package proves the pilot's
  Generated Artifact Set is drift-free.
