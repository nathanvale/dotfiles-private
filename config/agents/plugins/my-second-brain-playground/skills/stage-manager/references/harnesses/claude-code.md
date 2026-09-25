# Claude Code self-evidence

What a running Claude Code agent can read about itself during startup step 2.
Each item is Claude Code behavior observed on 2026-09-25 in v2.1.282, not a
documented contract, so mark a missing value `unknown`.

- **Harness:** launch argv0 `claude`, plus `CLAUDECODE=1` and
  `CLAUDE_CODE_ENTRYPOINT` in your environment.
- **Version:** the version segment of `CLAUDE_CODE_EXECPATH`, such as
  `.../claude/versions/2.1.282`. `claude --version` reports the binary on
  `PATH`, which can differ from the running session after an update.
- **Model:** the system context's statement of the exact model ID, such as
  "The exact model ID is claude-opus-5-5". A launch `--model` value is exact
  only when it is a full model ID. `opus`, `sonnet`, `haiku`, `fable`, `best`
  and their `[1m]` forms are aliases that resolve per provider
  ([model-config](https://code.claude.com/docs/en/model-config)), so they
  stay claims.
- **Effort:** `CLAUDE_EFFORT` when set.
- **Session:** the native session ID in `herdr pane get "$HERDR_PANE_ID"`
  under `agent_session`.
- **Human-supplied:** `/status` and a configured status line show the model
  (model-config). You cannot run them yourself; use them only when Nathan
  reports what they show.
