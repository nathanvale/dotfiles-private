# Codex CLI self-evidence

Use this reference for Stage Manager startup step 2. These observations were
made in a Codex CLI 0.156.1 worker on 2026-09-25 and in Codex CLI
coordinator processes on 2026-09-30, including resumed sessions and sessions
with subagents. They are **observed, undocumented** behavior, not a Codex CLI
contract. Mark absent or conflicting values `unknown` (an absent cross-check
record is not an absent value); resolve the running
version only through the rules below. The
[OpenAI API prompt guide](https://developers.openai.com/api/docs/guides/prompt-engineering)
and [GPT-6 model guide](https://developers.openai.com/api/docs/guides/latest-model)
describe API use; neither documents Codex CLI self-evidence.

| Item | Evidence the running agent can read | Meaning and limit |
| --- | --- | --- |
| Harness | Own agent process argv0 is `codex`; `CODEX_VERSION` was present | **Observed, undocumented.** Together these identify a Codex CLI process. Environment alone may be inherited by a child. |
| Version | The coordinator's mapped executable, `CODEX_VERSION`, and own-session `session_meta.cli_version` reported 0.159.0 while `codex` on `PATH` reported 0.159.1. A `codex resume` process mapped a 0.159.2 executable while its session kept `cli_version` 0.159.1 | **Observed, undocumented.** `session_meta.cli_version` records the version that created the session, so it is current only for a session this process created. Agreeing `CODEX_VERSION` and current session version establish the running version; otherwise the mapped executable's direct `--version` must agree with the one current value. Disk and `PATH` differences are warnings. |
| Launch selection | Own process argv contained `codex --model gpt-6-sol` | **Observed, undocumented.** `--model <id>` or `-m <id>` names the launch request, not necessarily the serving model after a change or fallback. An omitted flag leaves launch selection unknown. |
| Serving model | `model` in the latest `turn_context` record of your own rollout (see [Turn context reading](#turn-context-reading)). On 2026-09-29 all 20 `turn_context` records of a coordinator launched with `--model gpt-6-sol` read `gpt-6-sol`. Codex 0.158.0 put no model statement in the session context | **Observed, undocumented.** It is the model the client applied to the turn, not a server attestation; it follows `/model` switches. Record `unknown` when the rollout selection yields no single non-subagent `CODEX_SESSION_ID` match, when `model` is null or missing, when a `model_reroute` event follows that `turn_context`, or when a `thread_settings_applied` record exists and the latest one's `model` differs. No `thread_settings_applied` record: skip the comparison; the latest `turn_context` alone decides. A generic `GPT-6` value does not establish `gpt-6-sol`, `gpt-6-luna`, or `gpt-6-astra`. Neither argv nor a model list proves current serving identity. |
| Effort | `effort` in the same latest `turn_context` record | **Observed, undocumented.** Record `unknown` when the rollout selection yields no single non-subagent `CODEX_SESSION_ID` match, when `effort` is null or missing, when a `model_reroute` event follows that `turn_context`, or when a `thread_settings_applied` record exists and the latest one's `reasoning_effort` differs. No `thread_settings_applied` record: skip the comparison; the latest `turn_context` alone decides. A CLI flag or config describes a requested value; do not infer a default. |
| Native session | `CODEX_SESSION_ID` and `CODEX_THREAD_ID` were present in this worker | **Observed, undocumented.** Useful for authorship and receipts, not proof of model, effort, or coordinator role. |

To inspect argv, walk the parent chain from the shell's `$PPID` using
`ps -o pid=,ppid=,command= -p <pid>` until the nearest `codex` agent process.
Compare it with the pane's foreground agent from `herdr pane process-info`
before claiming coordinator identity. Inspect only named environment variables;
do not dump credentials. A worker's inherited `HERDR_PANE_ID` does not grant the
Stage Manager role.

For that agent PID, compare `CODEX_VERSION` from the current agent's
environment with the current session version from its own rollout JSONL.
Read `CODEX_SESSION_ID` and `CODEX_VERSION` in your own command shell; the
agent process's launch environment lacks them.

Find its own rollout among the `rollout-*.jsonl` files that `lsof -p <pid>`
shows open, rather than choosing the newest file by timestamp. One PID also
holds its subagents' rollouts, whose `session_meta.source` is an object with a
`subagent` key. Select the one rollout whose `session_meta.id` equals
`CODEX_SESSION_ID`. Without `CODEX_SESSION_ID`, use a rollout only when it is
the sole one open. No match, several matches, or a subagent match makes the
session version unavailable.

Its `session_meta.cli_version` is current only when this process created the
session: argv has no `resume` or `fork` subcommand, and `session_meta.timestamp`
(UTC) is not earlier than the process start from `ps -o lstart= -p <pid>`
(local time). Otherwise it is the creation version; record it as context and
treat the session version as unavailable. A session resumed after an ordinary
update then resolves through the mapped executable below.

When `CODEX_VERSION` and the current session version are both available and
agree, record that version. If they disagree, record `unknown` and refuse at
step 2. When only one is available, use `lsof -a -p <pid> -d txt` to select
the mapped Codex executable entry, not a library or Node entry, and run that
absolute path with `--version`. An ambiguous executable entry makes this
direct source unavailable. Record the version only if the direct result
agrees. With neither current value, or without the required agreement, record
`unknown`.

Check the mapped executable's direct version when possible even if both
current values agree. Its path may have been deleted or replaced after the
agent started; a missing or different direct result then warns of on-disk
uncertainty without changing the running version. Run `codex --version`
through `PATH` only to check for drift. A different `PATH` result is a warning,
not a running-process conflict.

| `CODEX_VERSION` | Current session | Mapped direct | `PATH` | Step 2 version |
| --- | --- | --- | --- | --- |
| 0.159.0 | 0.159.0 | unavailable or 0.159.1 | 0.159.2 | 0.159.0; warn on disk and `PATH` |
| 0.159.0 | 0.159.1 | 0.159.0 | 0.159.2 | `unknown`; refuse |
| 0.159.1 | unavailable | 0.159.0 | 0.159.2 | `unknown`; refuse |
| 0.159.2 | unavailable: resumed, created by 0.159.1 | 0.159.2 | 0.159.2 | 0.159.2 |
| 0.159.2 | unavailable: resumed, created by 0.159.1 | unavailable | 0.159.2 | `unknown`; refuse |
| 0.159.0 | unavailable: no `CODEX_SESSION_ID` match | 0.159.0 | 0.159.2 | 0.159.0; warn on `PATH` |
| 0.159.0 | unavailable | unavailable or 0.159.1 | 0.159.2 | `unknown`; refuse |

Sandbox: under Codex's `read-only` seatbelt sandbox, `ps` failed with
`operation not permitted` (observed 2026-09-30, Codex CLI 0.159.0 `exec`).
Record the agent pid, version, serving model and effort `unknown` when
process inspection is denied, and name the repair: Nathan relaunches the
coordinator with a sandbox that allows `ps` and `lsof`. The coordinator whose
pid matched on 2026-09-29 ran with its sandbox disabled; `workspace-write` was
not observed.

If the exact serving model or version remains unknown, startup refuses at
step 2. If the guide exists but its independent review record does not,
startup refuses at step 4.

## Turn context reading

Read serving model and effort from the rollout selected above whose
`session_meta.id` equals `CODEX_SESSION_ID`. The sole-open fallback does not
count here: it leaves both values `unknown`. The `cli_version` currency rule
covers the version only; a resumed session keeps appending `turn_context`
records to its original rollout (observed 2026-09-30 on a Codex 0.158.0
`resume` process).

```bash
r=<selected rollout path>
jq -c 'select(.type == "turn_context"
    or (.type == "event_msg" and (.payload.type == "thread_settings_applied"
      or .payload.type == "model_reroute")))
  | [.type, (.payload.type // ""),
     (.payload.model // .payload.thread_settings.model // ""),
     (.payload.effort // .payload.thread_settings.reasoning_effort // "")]' "$r"
```

Read the lines in file order:

1. Any non-zero `jq` exit: record model and effort `unknown`.
2. Take the last `turn_context` line. An empty model or effort cell means the
   value is null or missing: record that value `unknown`.
3. A `model_reroute` line after it: record `unknown`.
4. Compare it with the last `thread_settings_applied` line when one exists; a
   differing model or effort is `unknown`. No `thread_settings_applied`
   record: skip the comparison; the latest `turn_context` alone decides.
