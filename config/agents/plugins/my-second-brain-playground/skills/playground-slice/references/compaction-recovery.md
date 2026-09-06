# Compaction recovery

Use this branch to implement or qualify recovery after context compaction.
Follow the configured playground's recovery and storage rules. Resolve the
installed plugin root from its metadata. Inspect its accepted checkpoint
contract with `${PLUGIN_ROOT}/hooks/recovery-checkpoint schema`; keep field
names, size limits, and validation with that executable owner. If the installed
command is unavailable, report the delivery gap before claiming checkpoint proof.

## Save a bounded checkpoint

Bind the selected goal once through the installed executable:

```sh
"${PLUGIN_ROOT}/hooks/recovery-checkpoint" bind projects/<project>/GOAL.md --agent-ledger /absolute/path/to/agent-ledger
```

The command derives the existing Task, Register, Program, project routes, scope,
and timestamp; validates them; writes private session state; and returns the
control panel. Codex uses `CODEX_SESSION_ID`. Claude supplies `--session` with
its startup hook identity. Use `--evidence` only for a nonstandard evidence file.
Use `--help` for the exact contract. The lower-level `schema` and stdin `write`
remain available for custom bindings.

For missing, stale, uncertain, or refused recovery context, follow the configured
vault's `docs/agents/recovery.md`. The executable's `--help`
owns command syntax; its returned panel owns the next action. Refresh the
binding when its owners change or before a planned recovery trial.

Use the active session identity supplied by the Harness. Codex callers pass the
exact `CODEX_SESSION_ID` value. Claude callers use the exact session identity
delivered by the plugin's startup or resume SessionStart context. Include that
value as `sessionIdentity`; the writer stores one private checkpoint per session
and returns the resolved session identity and path. Never substitute another
thread or a remembered prior value.

Bind the checkpoint to:

- the resolved configured playground vault and selected project map;
- the active readable goal and its accepted Agent Ledger Register and Task identity;
- the canonical absolute Agent Ledger executable that owns command discovery;
- the current Harness session identity;
- the evidence route, relevant artifact versions, and observation time;
- the narrow pending scope, outstanding criterion, and next safe action;
- any uncertain operation whose actual outcome needs inspection before retry.

Keep validated owner pointers and concise observations. The hook derives the
control-panel commands from these fields; adding a command does not add
checkpoint fields unless it needs a new authority owner. Never use raw
transcripts as recovery context. Preserve raw receipts under their private
evidence owner. If a Task has not been adopted, name the declared fallback and
missing identity explicitly; checkpoint creation cannot create a Task or
transfer coordination ownership.

## Recover authority

Treat the delivered commands as the recovery control panel. Its successful
validation confirms the accepted Task identity at delivery time, not current
lifecycle status. Read the goal for the next action. Discover Ledger commands
when coordination reads or mutations are needed; prefer advertised public
commands. Use the labeled diagnostic only while a public Task read is absent.
Open Git history only when earlier revisions answer the current question.

Match the checkpoint's vault, project, goal, Register, and Task against their
current owners before using its recovered hints. Refresh supported live state
and inspect the affected artifact after an uncertain operation. Treat stale,
mismatched, missing, or unavailable context as a recovery gap; continue bounded
read-only discovery until the next write's authority is established.

Read only the checkpoint whose session identity matches the compact event. A
missing session checkpoint is a recovery gap. Never fall back to `current.json`
or another session's checkpoint.

Preserve Task identity across continuation. Keep the README a stable map and
changing task state with its adopted owner. A checkpoint supplies commands and
hints, not authorization or a second tracker. The hook renders commands but
never executes them.

## Inspect recovery traces

Use the installed plugin command for bounded operational evidence about bind,
recover, and hook invocations:

```sh
"${PLUGIN_ROOT}/bin/recovery-traces" --help
"${PLUGIN_ROOT}/bin/recovery-traces" view --journey <id>
"${PLUGIN_ROOT}/bin/recovery-traces" view --invocation <id>
"${PLUGIN_ROOT}/bin/recovery-traces" view --worker <id>
"${PLUGIN_ROOT}/bin/recovery-traces" view --task <ledger-task-id>
```

The read-only `view` returns admitted records and visible capture anomalies.
Combine filters when the investigation has more than one known identity.
Preserve producer sequence and explicit parent links; timestamps do not prove
global ordering across processes.

Traces live under
`$XDG_STATE_HOME/my-second-brain-playground/recovery-traces`, falling back to
`$HOME/.local/state/my-second-brain-playground/recovery-traces`. Directories are
private mode `0700`; files are private mode `0600`. Each invocation owns one
JSONL file and each serialized record is limited to 4 KiB. Automatic retention
removes records after 30 days or when aggregate trace storage exceeds 20 MiB,
whichever removes them sooner.

Nathan owns review and deletion. Run the scoped cleanup owner when earlier
deletion is required:

```sh
"${PLUGIN_ROOT}/bin/recovery-traces" cleanup
```

Cleanup is limited to the resolved recovery trace root. It does not own
checkpoints or unrelated XDG state.

Treat traces as private operational evidence. Keep project knowledge, task
state, decisions, and completion proof with their existing owners. Logging
status cannot create, start, reconcile, or complete a Ledger Task. Records
exclude note bodies, checkpoint payloads, prompts, transcripts, arbitrary
exception strings, environment dumps, authentication material, and absolute
personal paths.

Report timeout, cancellation, or signal only when a supervisor observation
records that outcome. A missing terminal record, partial final line, or sequence
gap leaves the terminal outcome `unknown`; it does not prove that the process
timed out, was cancelled, or received a signal.

## Qualify each delivery boundary

Use evaluate-slice with separate criteria and evidence for:

| Boundary | Required observation |
| --- | --- |
| Source behavior | Exercise the checkpoint contract and exact control-panel output, including shell quoting, invalid executable paths, stale or mismatched context, two-session isolation, and interrupted-operation recovery. |
| Installed bytes | Identify the delivered artifact and compare its relevant bytes with the tested source build. |
| Codex trust and activation | Inspect the actual hook registration and current trust state for the delivered command; observe activation rather than infer it from installation. |
| Harness compaction delivery | Trigger real Codex and Claude compaction events where available. Observe the actual SessionStart compact event and recovery context delivery before the next operation. |
| Fresh continuation | Give a fresh agent the ordinary task and entry without the original conversation or expected answer. Observe use of the delivered control panel to recover the same goal, Register, Task, scope, evidence, and next safe action. |

Exercise manual and automatic compaction where the harness exposes them. Record
each harness and trigger separately; mark unavailable events as proof gaps.
Synthetic hook input proves source handling only. Fresh-session discovery and
a successful handoff do not establish real compact-event delivery.

Keep private receipts for the event, delivered context, and next actual operation.
Compare README body and accepted Task identities before and after continuation.
Include stale checkpoint, unavailable Ledger, and interrupted-write trials.
Report each criterion as proved, not-proved, or unknown; these instructions
establish no implementation, installation, activation, or qualification claim.
