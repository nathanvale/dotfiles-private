# Codex CLI self-evidence

Use this reference for Stage Manager startup step 2. These observations were
made in a Codex CLI 0.156.1 worker on 2026-09-25. The version, serving
model and effort rows, the rollout reading and the sandbox note were
rechecked with Codex CLI 0.158.0 and 0.159.0 on 2026-09-30. They are
**observed, undocumented** behavior, not a Codex CLI contract. Record an
identity value `unknown` when it is missing or its readings conflict; an
absent cross-check record is not a missing value. The [OpenAI API prompt guide](https://developers.openai.com/api/docs/guides/prompt-engineering)
and [GPT-6 model guide](https://developers.openai.com/api/docs/guides/latest-model)
describe API use; neither documents Codex CLI self-evidence.

| Item | Evidence the running agent can read | Meaning and limit |
| --- | --- | --- |
| Harness | Own agent process argv0 is `codex`; `CODEX_VERSION` was present | **Observed, undocumented.** Together these identify a Codex CLI process. Environment alone may be inherited by a child. |
| Version | `CODEX_VERSION` in your own shell, checked against your agent pid's executable: `lsof -a -p <pid> -d txt -Fn`, first `n` line, then that exact path with `--version`. On 2026-09-30 a 0.158.0 session read `CODEX_VERSION=0.158.0` and `releases/0.158.0-aarch64-apple-darwin/bin/codex` reported `codex-cli 0.158.0`, while `codex --version` on `PATH` returned `codex-cli 0.159.0` | **Observed, undocumented.** The running binary sets `CODEX_VERSION` for its command shells; the agent's launch environment lacks it. Record the version when both readings agree; record `unknown` when either is missing or they differ. `codex --version` reports the `PATH` binary, which standalone auto-update moves ahead of a running session, so it is context, not a conflict. A rollout's `session_meta.cli_version` names the version that created the session and stays stale after `resume`. |
| Launch selection | Own process argv contained `codex --model gpt-6-sol` | **Observed, undocumented.** `--model <id>` or `-m <id>` names the launch request, not necessarily the serving model after a change or fallback. An omitted flag leaves launch selection unknown. |
| Serving model | `model` in the latest `turn_context` record of your own rollout (see [Rollout reading](#rollout-reading)). On 2026-09-29 all 20 `turn_context` records of a coordinator launched with `--model gpt-6-sol` read `gpt-6-sol`. Codex 0.158.0 put no model statement in the session context | **Observed, undocumented.** It is the model the client applied to the turn, not a server attestation; it follows `/model` switches. Record `unknown` when the rollout or `CODEX_THREAD_ID` is missing, when `model` is null or missing, when a `model_reroute` event follows that `turn_context`, or when a `thread_settings_applied` record exists and the latest one's `model` differs. No `thread_settings_applied` record: skip the comparison; the latest `turn_context` alone decides. A generic `GPT-6` value does not establish `gpt-6-sol`, `gpt-6-luna`, or `gpt-6-astra`. Neither argv nor a model list proves current serving identity. |
| Effort | `effort` in the same latest `turn_context` record | **Observed, undocumented.** Record `unknown` when the rollout or `CODEX_THREAD_ID` is missing, when `effort` is null or missing, when a `model_reroute` event follows that `turn_context`, or when a `thread_settings_applied` record exists and the latest one's `reasoning_effort` differs. No `thread_settings_applied` record: skip the comparison; the latest `turn_context` alone decides. A CLI flag or config describes a requested value; do not infer a default. |
| Native session | `CODEX_SESSION_ID` and `CODEX_THREAD_ID` were present in this worker | **Observed, undocumented.** Useful for authorship and receipts, not proof of model, effort, or coordinator role. |

If the exact serving model or version remains unknown, startup refuses at
step 2. If the guide exists but its independent review record does not,
startup refuses at step 4.

## Rollout reading

Your rollout is the one file named for your thread, filed under the date the
session was created, so a resumed session's file sits in an older folder:

```bash
r=$(find "${CODEX_HOME:-$HOME/.codex}/sessions" -name "rollout-*-$CODEX_THREAD_ID.jsonl")
jq -c 'select(.type == "turn_context"
    or (.type == "event_msg" and (.payload.type == "thread_settings_applied"
      or .payload.type == "model_reroute")))
  | [.type, (.payload.type // ""),
     (.payload.model // .payload.thread_settings.model // ""),
     (.payload.effort // .payload.thread_settings.reasoning_effort // "")]' "$r"
```

Read the lines in file order:

1. Zero or several files for the thread ID: record `unknown`.
2. Take the last `turn_context` line. An empty model or effort cell means the
   value is null or missing: record that value `unknown`.
3. A `model_reroute` line after it: record `unknown`.
4. Compare it with the last `thread_settings_applied` line when one exists; a
   differing model or effort is `unknown`. No `thread_settings_applied`
   record: skip the comparison; the latest `turn_context` alone decides.

## Process checks

To inspect argv, walk the parent chain from the shell's `$PPID` using
`ps -o pid=,ppid=,command= -p <pid>` until the nearest `codex` agent process.
Compare it with the pane's foreground agent from `herdr pane process-info`
before claiming coordinator identity. Inspect only named environment variables;
do not dump credentials. A worker's inherited `HERDR_PANE_ID` does not grant the
Stage Manager role.

Sandbox: under Codex's `read-only` seatbelt sandbox, `ps` failed with
`operation not permitted` (observed 2026-09-30, Codex CLI 0.159.0 `exec`).
Record the agent pid and version `unknown` when process inspection is denied,
and name the repair: Nathan relaunches the coordinator with a sandbox that
allows `ps` and `lsof`. The coordinator whose pid matched on 2026-09-29 ran
with its sandbox disabled; `workspace-write` was not observed.
