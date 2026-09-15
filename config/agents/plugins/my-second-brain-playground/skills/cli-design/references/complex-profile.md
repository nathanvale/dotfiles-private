# Complex profile

Use complex when any command changes user data or configuration, or when
identity, authentication, approval, handoff, ordered effects, recovery, partial
state, unknown state, or durable diagnostics applies. The canonical starter
lives in `bun-typescript-template/starters/complex`; consume it through the
public bootstrap or preservation-safe composer.

## Layout

```text
src/cli.ts
src/command-contract.ts
src/model.ts
src/engine.ts
src/runtime.ts
src/branch-station-catalog.ts
src/journal.ts
src/process-lifecycle.ts
src/diagnostics.ts                 # only when diagnostics triggers apply
tests/unit/
tests/integration/
tests/catalog/
```

| Owner | Responsibility |
| --- | --- |
| command contract | command identities, routes, causes, exits, result correlations, schema |
| model | domain types and sealed vocabularies |
| engine | policy and state transitions without I/O |
| runtime | file, process, clock, journal, and resource evidence |
| CLI | parsing, dispatch, human rendering, validated machine output |
| station catalogue | possible outcomes, recovery guidance, reachability |
| process lifecycle | stdout drain, EPIPE, signals, deadlines, crash boundary |
| diagnostics | bounded private diagnostics and redaction |

Split only when a concern earns an independent seam. Add one command module when
its body has its own contract. Add a front door only for a distinct CLI domain.

## Preview, apply, and recovery

Preview records the intended effect identities and observed resource revision
without performing the domain change. Apply requires a matching unconsumed
preview and authority. Record durable intent before the effect and completion
after verified read-back.

Recovery reads journal and actual resource state. It never replays automatically.
Confirmed completed effects require inspection and reporting. Unknown effects
remain nonretryable and hand off when read-only recovery cannot resolve them.
Two concurrent processes attempting one approved change produce one effect; the
other safely refuses.

## Branch Station catalogue

Each station declares:

- command identity, trigger, reachability, outcome, and cause;
- effect class, transaction state, and effect evidence;
- retry policy and bounded delay policy; and
- next action or structured handoff with repair guidance.

Derive selected-command discovery from this catalogue. Keep scenario and station
identities distinct. Strict new-project qualification reaches every required
station and rejects every observed undeclared station. Gradual existing-project
adoption freezes old gaps; new or changed stations remain strict.

When adding a command or behavior branch, update code, catalogue, discovery, and
public process expectations in the same change.

## Diagnostics

Add LogTape `2.3.1` only for multi-step or asynchronous ordering, partial or
unknown history, structured secret redaction, or material cross-step correlation.
Keep the journal separate.

Private per-run diagnostics use the CLI's XDG state directory, disclose the path,
and remain bounded by the accepted per-run, aggregate, record, retention, and
flush limits. Diagnostic loss never changes the domain result or causes replay.
First SIGINT or SIGTERM stops new work and allows the bounded flush; repeated
termination exits immediately. Recovery uses journal and effect evidence after
crash or forced termination.

## Tests

Run:

- unit tests for contract, engine, and state transitions;
- integration tests through public processes with reset fixtures;
- catalogue reachability and semantic-oracle tests;
- concurrent journal ownership and recovery tests;
- held-open and closed stdin tests;
- stdout drain, EPIPE, signal, crash, and deadline tests; and
- every applicable strict checker row.

Use literal expected results independent of the production catalogue. Preserve
one defect at a time in negative controls, prove its exact finding, then restore
the same harness to green. Run the complete repository and generated CI sequence
from a clean checkout. For a new repository, qualify its static policy through
the skill's `admit:static` route; a changed-files Fallow audit does not replace
the complete whole-project and production-dependency passes. In an existing
project, preserve the host policy and use the skill's complete-evidence new-only
adoption review.

The local `packages/cli-design-exemplar` is the qualified complex reference. A
repository using `@side-quest/cli-command-facade` keeps that runtime as its
contract-definition owner while this profile still owns thresholds, effects,
recovery, and qualification.
