# Codex CLI self-evidence

Use this reference for Stage Manager startup step 2. These observations were
made in a Codex CLI 0.156.1 worker on 2026-09-25. They are **observed,
undocumented** behavior, not a Codex CLI contract. Mark absent or conflicting
values `unknown`. The [OpenAI API prompt guide](https://developers.openai.com/api/docs/guides/prompt-engineering)
and [GPT-6 model guide](https://developers.openai.com/api/docs/guides/latest-model)
describe API use; neither documents Codex CLI self-evidence.

| Item | Evidence the running agent can read | Meaning and limit |
| --- | --- | --- |
| Harness | Own agent process argv0 is `codex`; `CODEX_VERSION` was present | **Observed, undocumented.** Together these identify a Codex CLI process. Environment alone may be inherited by a child. |
| Version | `CODEX_VERSION=0.156.1` in this worker; `codex --version` returned `codex-cli 0.156.1` | **Observed, undocumented.** Prefer the current process environment. A separate executable on `PATH` may differ from the running binary. If they conflict, record `unknown`. |
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

If the exact serving model or version remains unknown, startup refuses at
step 2. If the guide exists but its independent review record does not,
startup refuses at step 4.
