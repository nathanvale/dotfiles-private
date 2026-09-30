# Codex CLI self-evidence

Use this reference for Stage Manager startup step 2. These observations were
made in a Codex CLI 0.156.1 worker on 2026-09-25 and a 0.159.0 coordinator
process on 2026-09-30. They are **observed, undocumented** behavior, not a
Codex CLI contract. Mark unresolved running-process versions `unknown`. The
[OpenAI API prompt guide](https://developers.openai.com/api/docs/guides/prompt-engineering)
and [GPT-6 model guide](https://developers.openai.com/api/docs/guides/latest-model)
describe API use; neither documents Codex CLI self-evidence.

| Item | Evidence the running agent can read | Meaning and limit |
| --- | --- | --- |
| Harness | Own agent process argv0 is `codex`; `CODEX_VERSION` was present | **Observed, undocumented.** Together these identify a Codex CLI process. Environment alone may be inherited by a child. |
| Version | The coordinator's mapped executable, `CODEX_VERSION`, and exact session `session_meta.cli_version` reported 0.159.0 while `codex` on `PATH` reported 0.159.1 | **Observed, undocumented.** Agreeing current environment and exact-session metadata establish the running version. Use the mapped executable's direct `--version` as corroboration when only one is available. Disk and `PATH` differences are warnings when the two current sources agree. |
| Launch selection | Own process argv contained `codex --model gpt-6-sol` | **Observed, undocumented.** `--model <id>` or `-m <id>` names the launch request, not necessarily the serving model after a change or fallback. An omitted flag leaves launch selection unknown. |
| Serving model | An exact, current model statement in the agent's session context, when present | **Session claim, undocumented.** Record its wording and source. A generic `GPT-6` statement does not establish `gpt-6-sol`, `gpt-6-luna`, or `gpt-6-astra`. If a model switch or fallback is reported, obtain fresh current evidence or mark unknown. Neither argv nor a model list proves current serving identity. |
| Effort | An explicit current session-context statement, when present | **Session claim, undocumented.** A CLI flag or config describes a requested value. If current effort cannot be read, record `unknown`; do not infer a default. |
| Native session | `CODEX_SESSION_ID` and `CODEX_THREAD_ID` were present in this worker | **Observed, undocumented.** Useful for authorship and receipts, not proof of model, effort, or coordinator role. |

To inspect argv, walk the parent chain from the shell's `$PPID` using
`ps -o pid=,ppid=,command= -p <pid>` until the nearest `codex` agent process.
Compare it with the pane's foreground agent from `herdr pane process-info`
before claiming coordinator identity. Inspect only named environment variables;
do not dump credentials. A worker's inherited `HERDR_PANE_ID` does not grant the
Stage Manager role.

For that agent PID, compare `CODEX_VERSION` from the current agent's
environment with `session_meta.cli_version` from the exact current session.
When both are available and agree, record that version. If they disagree,
record `unknown` and refuse at step 2. When only one is available, use
`lsof -a -p <pid> -d txt` to find the mapped Codex executable and run that
absolute path with `--version`; record the version only if the direct result
agrees. With neither current value, or without the required agreement, record
`unknown`.

Check the mapped executable's direct version when possible even if both
current values agree. Its path may have been deleted or replaced after the
agent started; a missing or different direct result then warns of on-disk
uncertainty without changing the running version. Run `codex --version`
through `PATH` only to check for drift. A different `PATH` result is a warning,
not a running-process conflict.

| `CODEX_VERSION` | Exact session | Mapped direct | `PATH` | Step 2 version |
| --- | --- | --- | --- | --- |
| 0.159.0 | 0.159.0 | unavailable or 0.159.1 | 0.159.2 | 0.159.0; warn on disk and `PATH` |
| 0.159.0 | 0.159.1 | 0.159.0 | 0.159.2 | `unknown`; refuse |
| 0.159.0 | unavailable | 0.159.0 | 0.159.2 | 0.159.0; warn on `PATH` |
| 0.159.0 | unavailable | unavailable or 0.159.1 | 0.159.2 | `unknown`; refuse |

If the exact serving model or version remains unknown, startup refuses at
step 2. If the guide exists but its independent review record does not,
startup refuses at step 4.
