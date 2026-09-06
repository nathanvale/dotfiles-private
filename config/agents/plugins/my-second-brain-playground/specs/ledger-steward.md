# Ledger Steward specification

## Outcome

Keep adopted Ledger tasks aligned with accepted work and independent completion
evidence. Seven finished or partially finished playground tasks remained ready
until a manual reconciliation. The slice workflow needs a closeout owner.

## Scope and owners

- Add `msb_ledger_steward`, a Codex native agent, initially Terra high.
- Extend `playground-slice/references/tasks-first.md` as the single tracking
  workflow owner. The declaration names its role and routes there.
- Coordinator chooses scope, priorities and intended work. Evaluator establishes
  acceptance. Steward records and verifies authorized coordination changes.
- Keep simple updates in the caller session. Delegate bounded batches, ambiguous
  reconciliation, or parallel-worker closeout when the handoff saves work.
- Preserve readable knowledge, existing project packets and source contracts.
  The Register owns task state; no new database, tracking file or background hook.
- Support only discovered public commands. Removal means an authorized supported
  cancellation or supersession, when available; no direct event deletion.

## Workflow integration

Before delegation, resolve the accepted task and supplied execution owner. Start
only when that owner is actually beginning authorized work. After the independent
acceptance verdict, record supported completion with its matching run identity
and generation. At closeout, reconcile the explicit task set and return actual
states, unresolved gaps and the next available work. The caller does not claim
Ledger synchronization until those results are verified.

The handoff supplies the exact executable, Register, program, task identities
or bounded creation requests, requested transitions, evidence paths and write
scope. It names whether the Steward may mutate or only advise, and supplies the
active execution identity and generation when applicable. The Steward never
uses a worker's checkpoint or invents another worker's run identity.

A historical reconciliation may start its own explicitly identified verification
run after examining finished work. This is a current reconciliation, never a
backdated claim that it ran the original implementation.

## Acceptance and proportional proof

1. Source and installed declarations select Terra high and resolve the shared
   tracking workflow; existing vault roles remain unchanged.
2. Slice entry routes task preparation and closeout to that owner. Valid routine
   single-task work needs neither a new agent nor a full slice evaluation.
3. One fresh native role trial reconciles a bounded pair of tasks in a disposable
   Register: supplied acceptance evidence supports one completion, while the
   other has incomplete evidence. Existing IDs and unrelated records survive.
4. Verify actual runtime role/model, public process effects, final committed
   states, and scope after exit. Retain the ordinary prompt and original output.
5. Inspect unavailable removal and uncertain/concurrent transition guidance
   statically. Do not claim those branches have been exercised by the trial.
6. Keep cost, latency and cross-harness availability as explicit limits. Claude
   receives shared skill guidance; this slice declares a Codex native role only.

## Delivery and stop

Install the updated local plugin through its existing managers. Install the new
Codex user-scope role from that payload and compare exact bytes. Record the
specification, implementation and trial result here. Stop after the bounded
handoff and checks; no topology migration, commits, remote writes or generalized
reliability claim. Existing uncommitted goals remain recoverable in place.

## Coordination

Task: `implement-and-qualify-the-playground-ledger-steward-a04fbda490eb`.
Register: `/Users/nathanvale/.local/share/my-second-brain-playground/registers/playground.sqlite3`.
Private execution evidence: `/Users/nathanvale/.local/state/my-second-brain-playground/ledger-steward-20260905`.

## Implemented result

Installed shared workflow: 0.10.0 for Codex and Claude. The native role is installed
at `~/.codex/agents/msb-ledger-steward.toml`; runtime proof is Codex only. Earlier
role declarations remain unchanged and match their user-scope copies. Role and
workflow bytes match both installed payloads. TOML, relative pointers and Claude
manifest validation pass. The Python plugin validator remains unavailable without
PyYAML; available checks are explicitly reported instead.

One fresh native `msb_ledger_steward`, observed `gpt-5.6-terra` at high effort,
reconciled two synthetic Tasks through the public process. Only the Task with
sufficient acceptance evidence received start and completion events. The other
Task stayed ready; the unrelated Task and all three original events were preserved.
The source artifact hash stayed unchanged. No duplicate Task was created.

Independent instruction inspection passed after preserving the Stage Manager
boundary. Coordinator inspection after exit verified actual runtime identity and
committed effects. The launcher and worker together took 133.321 seconds. This
supports batch delegation as the initial use, not a cost optimum or a comparison
against direct updates. Trial permissions bypassed the sandbox; authorized
behavior was observed, not enforced isolation. Removal, retry and concurrent
ownership paths received instruction checks only. No runtime code changed;
no broad regression suite or repeated trial was needed.
