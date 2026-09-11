# Complex profile

Use this layout when behaviour crosses the complex profile thresholds.

```
src/cli.ts
src/command-contract.ts
src/model.ts
src/engine.ts
src/runtime.ts
src/branch-station-catalog.ts  # when the station threshold is met
src/diagnostics.ts             # when the LogTape threshold is met
tests/unit/
tests/integration/
tests/catalog/
```

| Owner | Responsibility |
| --- | --- |
| Contract | command identities, argv shapes, cause codes, and exit mapping |
| Model | types and transaction states |
| Engine | pure policy and state transitions |
| Runtime | file, process, and clock effects |
| CLI | parsing, rendering, dispatch, and exit |
| Catalog | Branch Stations with outcome identity, cause, effect, transaction, retry, next paths, and handoff; every mutating command reaches the catalog |
| Diagnostics | LogTape configuration and redaction |

## Preview and apply

Preview records expected effect identities and the observed resource revision while the target remains unchanged. Apply requires a matching unconsumed preview. A stale preview returns `DOMAIN_PREVIEW_STALE` before any effect; an effect identity is applied at most once; a repeated apply against a consumed preview returns a domain refusal.

## Partial and unknown outcomes

Report completed and unresolved effects separately. Set `transactionState` to `partially-completed` or `unknown` and `retryable` to false. Set `nextAction` to an inspect command or a `handoff` with prerequisites. Inspection or handoff resolves state before a retry becomes eligible.

## Branch Station catalog

Each station declares identity, trigger, outcome, causeCode, effectClass, transactionState, retryable, and either nextAction or availablePaths, plus handoff. The catalog test marks a declared station covered after it is reached through the public command surface with a real process; every unobserved declaration fails its row.

## Diagnostics

Use LogTape `@logtape/logtape` version `2.3.1` with `@logtape/redaction`. Send sinks to stderr or to a file under the CLI's own state. Each record carries `runIdentity`; secret-bearing fields are redacted at the sink.

## Tests

Run unit tests for engine and contract, integration tests through the public command surface with real processes and a reset fixture between scenarios, and catalog tests for station reachability. Also run the checker.

## Facade-backed

When a repository already uses `@side-quest/cli-command-facade`, that runtime's own documentation owns contract definition and alignment proof, while this profile still owns thresholds and transaction rules.
