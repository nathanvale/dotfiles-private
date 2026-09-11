# Contract Core 1.0.0

## Exit meanings

| Exit code | Meaning |
| --- | --- |
| 0 | success |
| 1 | internal |
| 2 | usage |
| 3 | domain, including input, precondition, and effect refusal |
| 4 | schema |
| 75 | unavailable |

Keep `failureClass` and exit code aligned: usage maps to 2, domain to 3, schema to 4, internal to 1, unavailable to 75, and a null failureClass to 0. This exit set is closed, fixed, finite, and documented.

## Machine envelope

```
envelopeVersion: 1
contractVersion: "1.0.0"
commandIdentity: string            // "<cli-name>.<command>"
runIdentity: string                // unique per process, e.g. "run-<uuid>"
outcome: "success" | "refused" | "failed" | "unknown"
failureClass: null | "usage" | "domain" | "schema" | "internal" | "unavailable"
causeCode: null | string
message: string
effectClass: "inspect" | "repository-local" | "external"
transactionState: "unchanged" | "completed" | "partially-completed" | "rolled-back" | "unknown"
retryable: boolean
retryDelayMilliseconds: null | number
nextAction: null | string
availablePaths: string[]
repairAction: null | string
handoff: null | { reason: string, prerequisites: string[] }
result: null | object
```

Identity fields establish the command and process run. Outcome fields record the result, failure class, cause, and public message. Effect and transaction fields describe side-effect class and transaction state. Retry and next-action fields describe safe repetition, delay, repair, paths, and handoff. The result field carries the primary command result when one exists.

## Human mode

Human mode keeps help and results easy to scan. Help prints a usage line and one example. A refusal or failure writes exactly one line to stderr naming the cause and repair, keeps stdout empty, and uses the mapped exit code. The primary result goes to stdout; diagnostics go to stderr.

Machine mode applies whenever `--json` appears anywhere in argv, including with an unknown option or no arguments. Every outcome in machine mode, usage errors included, prints exactly one envelope on stdout and nothing on stderr, and uses the same mapped exit code as human mode.

## Help and discovery

`--help` prints a usage line and one example, then exits 0. `--discover --json` prints the discovery envelope whose `result` has `name`, `contractVersion`, `generationConventionVersion`, a `commands` array of `{identity, argv, effectClass, description}`, `exitMeanings` keyed `"0"`, `"1"`, `"2"`, `"3"`, `"4"`, `"75"`, `machineMode: "--json"`, and a boolean `logtape`.

## No arguments and non-interactive

A stateless CLI invoked with no arguments exits 2, with stdout empty and stderr exactly one line naming `--help`; a CLI that owns state may instead print a bounded read-only dashboard and exit 0. stdin that is not a TTY never triggers a prompt; a prompt never substitutes for mutation authority.

## Effects and transactions

Use effectClass values `inspect`, `repository-local`, and `external`. Use transactionState values `unchanged`, `completed`, `partially-completed`, `rolled-back`, and `unknown`. For anything beyond inspection, preview expected effect identities and the observed resource revision, then apply only a matching unconsumed preview. Apply each effect identity at most once. Report completed and unresolved effects separately for partial or unknown outcomes, and route retry through inspection or handoff first.

## Retry and next action

Set `retryable` true when a same-input retry is safe and may succeed without further inspection. Include `retryDelayMilliseconds` when the delay is known. When `outcome` is `refused`, `failed`, or `unknown`, exactly one of `nextAction` or `handoff` is non-null; `availablePaths` is always an array and may accompany either; when `outcome` is `success`, both `nextAction` and `handoff` may be null.

## Redaction

Apply the key regex `/(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i` and render matching values as `[REDACTED]` on every stream. Treat every input string as data and keep command execution explicit.

## Cause codes

Use uppercase cause codes matching `[A-Z][A-Z0-9_]*` and prefix each non-null code with its failure class: `USAGE_`, `DOMAIN_`, `SCHEMA_`, `INTERNAL_`, or `UNAVAILABLE_`. A null failureClass uses a null causeCode. Examples: `USAGE_UNKNOWN_OPTION`, `DOMAIN_INPUT_MISSING`, `DOMAIN_INPUT_MALFORMED`, `DOMAIN_PATH_ESCAPE`, `DOMAIN_EFFECT_NOT_AVAILABLE`, `DOMAIN_PREVIEW_STALE`, `UNAVAILABLE_STORAGE_BUSY`.

## Provenance

The vocabulary reuses Agent Ledger's `envelopeVersion`, `commandIdentity`, `runIdentity`, `transactionState`, `failureClass`, `retryable`, `message`, `repairAction`, and `retryDelayMilliseconds`. The remaining fields come from the accepted pre-design analysis; the whole spelling is provisional until a Toolkit owner exists.
