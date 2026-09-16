# Contract Core 2.0.0

Keep the executable command-contract module as the owner of exact types, causes,
route declarations, and schemas. This reference carries the portable invariants.

## Exit meanings

| Exit | Failure class | Meaning |
| --- | --- | --- |
| 0 | `null` | success |
| 1 | `internal` | internal failure |
| 2 | `usage` | invocation refusal |
| 3 | `domain` | precondition, authority, deadline, or recovery result |
| 4 | `schema` | invalid or unsupported format |
| 75 | `transient` | safe bounded retry may succeed |

SIGINT exits 130 and SIGTERM exits 143 after the bounded shutdown policy. Keep
these signal exits outside the normal result-to-exit mapping.

## Machine envelope

The top-level envelope is strict:

```text
envelopeVersion: 2
contractVersion: "2.0.0"
message: non-empty string
availablePaths: sorted unique canonical command identities
result: ContractResult
diagnostics?: Diagnostics
```

Every `ContractResult` includes:

```text
runId, commandIdentity, outcome, effectClass, transactionState,
causeCode, failureClass, exitCode, data, retryable, repairAction,
effects, and exactly one of nextAction or handoff
```

`idempotencyKey`, `attemptedEffect`, and `retryDelayMilliseconds` appear only in
the result arms that admit them. Omit inapplicable optional keys instead of
serializing them as null.

## Correlated result arms

- Outcomes are `success`, `refused`, or `failed`.
- Transaction states are `unchanged`, `completed`, `partially-completed`, or
  `unknown`.
- `unknown` is a transaction state only.
- Success uses `SUCCESS_UNCHANGED` or `SUCCESS_COMPLETED`, exit 0, null
  `failureClass`, JSON-valued data including null, null `repairAction`, and
  `retryable: false`.
- Refused means no change was attempted and uses `transactionState: unchanged`.
- Failed means work was attempted. State and effect evidence distinguish
  unchanged, completed, partial, and unknown results.
- Partial and unknown effects are nonretryable. Inspect or hand off before any
  later attempt.
- A retryable transient row includes a positive bounded delay and is limited to
  confirmed not-started or unchanged facts.
- A nonretryable row omits `retryDelayMilliseconds`.
- Failure data is null and carries a useful `repairAction`.

Cause codes are a closed typed vocabulary. Their prefix and row agree with the
failure class, outcome, state, exit, retry policy, and guidance arm. Do not derive
expected tests from the production cause table.

## Effects

Every result has:

```text
effects.completed: sorted unique effect identities
effects.remaining: sorted unique effect identities
effects.uncertain: sorted unique effect identities
effects.inventoryComplete: boolean
```

The collections are disjoint. An inspect result has an empty complete inventory.
Unchanged has no completed or uncertain effects. Completed has at least one
completed effect and no remaining or uncertain effect. Partially completed has
completed and remaining effects with a complete inventory. Unknown has an
uncertain effect or an incomplete inventory. An `attemptedEffect`, when present,
appears in this inventory.

Never replay a completed or uncertain effect to repair reporting. Recovery reads
journal and actual resource evidence, then reports what is confirmed.

## Help and discovery

Human help names public commands, options, and examples. Machine mode applies
when `--json` is present, including usage failures. Except for SIGINT and
SIGTERM, machine mode emits exactly one validated 2.0 envelope on stdout with
empty stderr. Before output, SIGINT and SIGTERM exit 130 and 143, respectively,
after the bounded diagnostics flush with no envelope and empty stdout and
stderr. After output starts, a signal may leave a partial stdout stream; once
the stream is fully drained, the complete stdout envelope may remain. Keep
stderr empty and preserve the observed stream without emitting a replacement
envelope.

`--discover --json` reports contract and generation version, profile, commands,
exit meanings, signal exits, and explicit effect exclusions.

`--discover-command COMMAND_IDENTITY --json` reports possible stations for one
selected command from the same typed catalogue used by tests. It does not report
live state, grant approval, or authorize replay. Unknown selectors return a
focused usage or domain refusal with repair guidance.

## Input, authority, and recovery

Parse argv strictly. Validate files, JSON, environment, network, and persisted
state from `unknown`. Keep preview and apply separate for state-changing work.
Bind an apply to its unconsumed preview, resource revision, authority, and effect
identities.

Use durable intent and completion evidence before downstream recovery depends on
it. Two processes attempting one approved change produce exactly one effect; the
other safely refuses. Interrupted or unconfirmed writes remain failed with
unknown effects until read-only recovery resolves them.

## Diagnostics and output

Primary results go to stdout. Diagnostics never change the domain result, exit,
or recovery safety. Keep diagnostics custody separate from the recovery journal.
Disclose unavailable, dropped, truncated, or unflushed diagnostics truthfully.
Redact secret-bearing values before any public output, including `message`,
`data`, stdout, and stderr, and again at the diagnostics sink.

Validate the complete serialized value immediately before output. If the result
cannot be serialized safely, emit the bounded internal fallback that preserves
trusted effect facts. A failed fallback exits without replay.
