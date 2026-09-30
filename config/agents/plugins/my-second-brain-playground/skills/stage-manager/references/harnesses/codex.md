# Codex CLI self-evidence

Use this reference for Stage Manager startup step 2. These observations were
made in a Codex CLI 0.156.1 worker on 2026-09-25 and a 0.159.0 coordinator
process on 2026-09-30. They are **observed, undocumented** behavior, not a
Codex CLI contract. Mark absent or conflicting
running-process values `unknown`. The [OpenAI API prompt guide](https://developers.openai.com/api/docs/guides/prompt-engineering)
and [GPT-6 model guide](https://developers.openai.com/api/docs/guides/latest-model)
describe API use; neither documents Codex CLI self-evidence.

| Item | Evidence the running agent can read | Meaning and limit |
| --- | --- | --- |
| Harness | Own agent process argv0 is `codex`; `CODEX_VERSION` was present | **Observed, undocumented.** Together these identify a Codex CLI process. Environment alone may be inherited by a child. |
| Version | The coordinator's mapped executable, `CODEX_VERSION`, and exact session `session_meta.cli_version` reported 0.159.0 while `codex` on `PATH` reported 0.159.1 | **Observed, undocumented.** Resolve the executable mapped to the agent process, run that exact executable with `--version`, and corroborate it with current process or exact session evidence as described below. A different `codex` on `PATH` is drift, not a running-process conflict. |
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

For that agent PID, use `lsof -a -p <pid> -d txt` to find its mapped Codex
executable, then run that absolute path with `--version`. Compare the result
with `CODEX_VERSION` from the current agent's environment and
`session_meta.cli_version` from the exact current session, when available.
Record the version only when the mapped executable reports it, at least one
current process or session value corroborates it, and every available value
from those sources agrees. An ambiguous mapping, failed direct version check,
missing corroboration, or disagreement among those sources makes the version
`unknown`. Run `codex --version` through `PATH` only to check for drift; record
a different result as a warning, not as a reason to refuse casting.

If the exact serving model or version remains unknown, startup refuses at
step 2. If the guide exists but its independent review record does not,
startup refuses at step 4.
