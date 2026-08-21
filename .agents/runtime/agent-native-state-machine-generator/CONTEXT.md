# Agent-Native State Machine Generator

This context defines product language for a compiler and scaffolder that derives
agent-facing state-machine, CLI, and proof contracts from one admitted product
specification. It does not describe a workflow runtime or infer product policy.

## Language

### Specification authority

**Specification Candidate**:
A proposed state-machine specification with no semantic authority until it
passes validation and receives explicit product-owner admission.
_Avoid_: Draft authority, inferred policy, accepted specification

**Admitted State-Machine Specification**:
The sole design-time semantic authority for one product after machine
validation and explicit product-owner admission.
_Avoid_: Workflow definition, prose specification, prompt, generated source of truth

**Specification Admission**:
The explicit product-owner act that gives a validated Specification Candidate
semantic authority. Parsing, validation, compilation, and generation do not
admit a candidate by themselves.
_Avoid_: Validation, compilation, automatic approval

**Generated Artifact Set**:
The complete disposable output derived from one Admitted State-Machine
Specification and replaced as one unit.
_Avoid_: Generated policy, generated projection, second source of truth

**Generated Artifact Drift**:
A mismatch between the declared Generated Artifact Set and an isolated
regeneration from its admitted inputs.
_Avoid_: Action freshness failure, handwritten change, accepted divergence

### Extension seam

**Extension Point**:
A stable specification-owned identity and typed seam for named product-specific
behavior or proof that the specification cannot derive mechanically.
_Avoid_: Hook, escape hatch, arbitrary callback, custom branch

**Handwritten Extension**:
Product-specific code that fulfils one declared Extension Point without adding
or ranking state-machine meanings.
_Avoid_: Handwritten policy, handwritten fact, generated patch, policy override

**Extension Registry**:
The exhaustive binding from each declared Extension Point to exactly one
Handwritten Extension.
_Avoid_: Plugin list, optional registry, fallback lookup

**Observed Fact**:
Evidence collected from the real product and supplied without selecting its
state-machine interpretation.
_Avoid_: Handwritten fact, log inference, implementation detail

**Fact Provider**:
A Handwritten Extension that obtains the value of a declared Observed Fact. It
does not select state, Authority, retry posture, or continuation.
_Avoid_: Policy evaluator, state resolver, fact author

### Runtime interpretation

**State Projection**:
The complete machine-readable interpretation of the product's current observed
condition, including exactly one Next Safe Action.
_Avoid_: Status blob, partial snapshot, generated artifact, recommendation list

**Projection Composer**:
The sole product-local interpreter that selects the public State Projection and
Next Safe Action without rewriting Observed Facts.
_Avoid_: Action provider, recommendation merger, second action owner

**Transition**:
An authoritative observed state change. An invocation, intent, or successful
process exit is not itself a Transition.
_Avoid_: Command, request, attempted change, process exit

**Authority**:
Current product-owned permission to perform a declared action under the
observed facts and freshness conditions.
_Avoid_: Owner, capability, availability, heartbeat, successful exit

**Declared Side Effect**:
The externally meaningful effect an action may attempt according to the
Admitted State-Machine Specification.
_Avoid_: Observed Side Effect, successful result, assumed mutation

**Observed Side Effect**:
Authoritative evidence of what externally meaningful effect actually occurred.
_Avoid_: Declared Side Effect, command success, acknowledgement, intended effect

**Exact Same-Input Retry Safety**:
The evidence-backed posture for repeating the same logical work with identical
normalized input.
_Avoid_: Retryable, probably safe, idempotent by assumption

**Projection Completeness**:
Whether every required observation and meaning is present and current enough
to emit a safe State Projection.
_Avoid_: Best effort, partial success, default continuation

**Next Safe Action**:
The sole current directive selected from `invoke`, `wait`, `needs_input`,
`needs_human`, or `none`.
_Avoid_: Suggestion, action list, runtime actions, Repair Hint

**Stop Scope**:
The meaning carried by `none`: either the product is terminal or only the
current agent must stop.
_Avoid_: Done, terminal without qualification, stopped

### Durable work

**Logical Operation**:
One stable identity for an intended effectful outcome across execution,
reconciliation, and retry.
_Avoid_: Attempt, process ID, request ID, Run Correlation ID

**Attempt**:
One execution try belonging to a Logical Operation.
_Avoid_: Logical Operation, new operation, retry identity

**Acknowledgement**:
Durable knowledge that a Logical Operation was rejected, accepted, completed,
or remains unknown.
_Avoid_: Exit status, response received, success boolean

**Gate Availability**:
Whether the product surface can currently accept work. It says nothing about
the progress of work already accepted.
_Avoid_: Gate, Operation Progress, worker health, completion

**Operation Progress**:
Authoritative evidence that accepted logical work is advancing.
_Avoid_: Gate Availability, heartbeat alone, process existence

**Progress Owner**:
The party that authoritative evidence says is advancing accepted logical work.
A `wait` names it so a caller knows who to observe rather than busy-polling.
_Avoid_: Gate Availability, heartbeat alone, assignee

**Cancellation**:
A product-conditional lifecycle from request through delivery, effectiveness,
cleanup, and terminal outcome, or an explicit declaration that cancellation is
not supported.
_Avoid_: Cancel flag, cancelled boolean, cancellation request equals completion

### Public contracts and proof

**Command Surface Contract**:
The single generated static owner of one product's public CLI meaning.
_Avoid_: Handwritten command list, help source, parser allowlist

**Command Surface Alignment Proof**:
Real-process evidence that discovery, help, parsing, runtime binding, results,
streams, exits, and Branch Stations describe the same command surface.
_Avoid_: Help snapshot, parser-only test, schema-only check

**Branch Station**:
One stable, reachable public-process branch with an exact trigger and expected
result.
_Avoid_: Branch, example, arbitrary test case, Cartesian scenario

**Declared Branch Coverage**:
The claim that every required Branch Station is present in the generated
catalog.
_Avoid_: Product proof, observed behavior, tests passed

**Observed Branch Coverage**:
The claim that every required Branch Station crossed the real public-process
seam and matched its expected result.
_Avoid_: Catalog completeness, unit coverage, synthetic coverage

**Repair Hint**:
Non-executable explanation that helps interpret or investigate a result without
introducing or contradicting the Next Safe Action.
_Avoid_: Recovery action, command directive, continuation, Repair Path
