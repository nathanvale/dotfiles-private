# Agent hook timing for code-quality tools

Date: 2026-09-12 (Australia/Melbourne)

Status: research complete; no hook or settings change performed.

## Question

Where should Biome, the Fallow changed-code audit and the TypeScript
typecheck run inside Claude Code and Codex agent loops: on every file edit
(`PostToolUse` on `Write|Edit`), at the end of a turn (`Stop`), before
`git commit` or `git push` (`PreToolUse` on `Bash`), or a combination? Which
events should block with exit 2 and which should only inform?

## Summary recommendation

Use three layers with distinct jobs. `PostToolUse` on `Write|Edit` runs Biome
on the edited files only and informs; it cannot block anyway because the write
already happened, so its value is fast, cheap feedback. `Stop` runs the delta
gates (Biome on changed files, `tsc` when TypeScript files changed) and blocks
with exit 2, guarded by `stop_hook_active` and a fail-open timeout, because
Stop is the one event where a blocking result makes the agent finish its own
work before handing back. `PreToolUse` on `Bash` matching `git commit` or
`git push` runs `fallow audit` and blocks only on a `fail` verdict, which is
the official Fallow pattern and the only layer an agent cannot route around.
Do not run Fallow per edit: it audits a change set against a base, so a
half-finished edit produces noise rather than signal. Do not register
`SubagentStop` gates. For Codex, port the same three command hooks to
`.codex/hooks.json` (same events and exit-2 semantics) and keep the managed
`AGENTS.md` block as the fallback for hosts without hooks.

## Findings

### 1. Claude Code hooks (official reference)

Source: [Hooks reference](https://code.claude.com/docs/en/hooks) and
[Hooks guide](https://code.claude.com/docs/en/hooks-guide); the old
`docs.anthropic.com/en/docs/claude-code/hooks` URL now redirects there.

- Events relevant here: `PreToolUse` (before a tool call; can block),
  `PostToolUse` (after a tool call succeeds), `Stop` (main agent finished
  responding; does not fire on user interrupt or API error), `SubagentStop`,
  `UserPromptSubmit`, `SessionStart`, and the newer `PostToolBatch` (after a
  batch of parallel tool calls, before the next model call).
- Exit 0: stdout goes to the debug log only, except `UserPromptSubmit` and
  `SessionStart`, where plain stdout becomes context. JSON on stdout is
  parsed for structured control.
- Exit 2: blocks on `PreToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`
  (and a few lifecycle events). It overrides any JSON allow. The blocking
  message is the JSON reason if present, otherwise stderr. On `PostToolUse`
  exit 2 "cannot block the action since the tool has already executed"; it
  surfaces stderr to Claude as an error notice
  ([context window doc](https://code.claude.com/docs/en/context-window)).
- Other non-zero: non-blocking; the first stderr line shows in the
  transcript as `<hook name> hook error`.
- JSON fields: `continue: false` plus `stopReason` halts Claude entirely;
  `suppressOutput` hides hook stdout; `systemMessage` is shown to the user;
  `hookSpecificOutput.additionalContext` enters Claude's context. `Stop`
  blocks with `decision: "block"` and a required `reason`. `PreToolUse`
  uses `permissionDecision: allow | deny | ask | defer`.
- Loop guard: `stop_hook_active` is `true` when Claude is already continuing
  because of a Stop hook; the guide says exit 0 when it is true. Claude Code
  force-ends the turn after 8 consecutive blocks; the cap is set by
  `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (0 disables it)
  ([env vars](https://code.claude.com/docs/en/env-vars)).
- Timeouts: command hooks default to 600 s; per-hook `timeout` in seconds;
  `SessionEnd` shares a 1.5 s budget.
- Matchers: an exact-match set when the string contains only letters,
  digits, `_ - , |` and spaces (`Edit|Write`), otherwise a regex
  (`mcp__.*__write.*`).
- Plugin hooks live in `hooks/hooks.json` with a top-level `description`
  and `${CLAUDE_PLUGIN_ROOT}` for bundled scripts; they merge with user and
  project hooks.
- Official examples: `PostToolUse` on `Write|Edit` for a style checker
  (feedback via `systemMessage`, verbose output hidden with
  `suppressOutput`); `Stop` for a type checker that can force a retry;
  `PreToolUse` with exit 2 to block dangerous commands.

### 2. Fallow (official docs)

Source: [integrations/claude-hooks.mdx](https://github.com/fallow-rs/docs/blob/main/integrations/claude-hooks.mdx),
[cli/audit.mdx](https://github.com/fallow-rs/docs/blob/main/cli/audit.mdx),
[integrations/mcp.mdx](https://github.com/fallow-rs/docs/blob/main/integrations/mcp.mdx).

- The official `fallow-gate.sh` is a `PreToolUse` hook on the `Bash`
  matcher that fires when Claude runs `git commit` or `git push`, "not a Git
  hook". It runs
  `fallow audit --format json --quiet --explain --gate-marker agent`.
- `pass` and `warn` are allowed; `fail` is blocked and the JSON findings go
  back to Claude on stderr with exit 2 so it can fix and retry. Runtime
  errors (`{"error": true, ...}`) are non-blocking so empty or new
  repositories are not stuck.
- Rationale given: PreToolUse runs before the command, so the gate cannot be
  bypassed by `--no-verify`; PostToolUse would only inspect results after.
- `--gate-marker agent` (v2.85.0, enforced by `FALLOW_GATE_MIN_VERSION`)
  lets Impact record blocked-then-cleared events.
- `fallow hooks install --target agent` writes `.claude/settings.json` and
  the script, and when `AGENTS.md` or `.codex/` exists it adds a managed
  Codex fallback block between `<!-- fallow:setup-hooks:start -->` and
  `<!-- fallow:setup-hooks:end -->` telling the agent to run the same audit
  before any commit or push and fix `fail` findings first.
- Agent guidance elsewhere: `--changed-since main` is "great for agent PR
  workflows"; `FALLOW_AUDIT_BASE` pins the base "handy for forks and the
  agent gate"; `--gate all` also fails on inherited findings (strict mode).
  No Fallow doc recommends running the audit per edit.

### 3. Biome (official docs)

Source: [reference/cli.mdx](https://github.com/biomejs/website/blob/main/src/content/docs/en/reference/cli.mdx),
[recipes/git-hooks.mdx](https://github.com/biomejs/website/blob/main/src/content/docs/en/recipes/git-hooks.mdx),
[editors/introduction.mdx](https://github.com/biomejs/website/blob/main/src/content/docs/en/editors/introduction.mdx).

- Incremental scope is built in: `biome check --changed --since=main`,
  `biome check --staged .`, with `vcs.enabled`, `clientKind: git` and
  `defaultBranch` in `biome.json`.
- The pre-commit recipe scopes to staged files and adds
  `--files-ignore-unknown=true --no-errors-on-unmatched` so non-Biome files
  and empty matches never fail the hook.
- Editor integration is per file and on save: `lsp-proxy` for LSP clients,
  or stdin with `--stdin-file-path` and `--use-server` to reuse the daemon.
  This is the same shape as a per-edit agent hook.

### 4. Codex CLI hooks (official docs)

Source: [Codex hooks reference](https://developers.openai.com/codex/hooks)
(currently served from `learn.chatgpt.com/docs/hooks`).

- Codex now has lifecycle hooks, enabled by default, with the same event
  names: `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`,
  `PermissionRequest`, `UserPromptSubmit`, `Stop`, `Interrupt`,
  `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`.
- Config lives in `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, or
  inline `[hooks]` tables in `config.toml`; plugins may bundle
  `hooks/hooks.json`.
- Exit 2 writes the blocking reason (PreToolUse) or feedback reason
  (PostToolUse, Stop, UserPromptSubmit) from stderr; other non-zero codes
  are reported as hook failures. Default timeout 600 s.
- `Stop` "expects JSON on stdout when it exits 0. Plain text output is
  invalid for this event", and its input carries `stop_hook_active`.
- Matcher is a regex string (`Edit|Write`, `^apply_patch$`).
- The docs make no compatibility claim about Claude Code's format, so the
  Fallow managed `AGENTS.md` block remains the portable fallback for Codex
  versions or hosts where hooks are absent or disabled.

### 5. Local context (this repository)

- `config/agents/claude/hooks/biome/biome-ci.ts` (Stop): exits 0 on
  `stop_hook_active`, resolves the repo and its local Biome, lints only
  staged, unstaged and untracked files, writes a JSON summary to stderr and
  exits 2 on errors; a 96 s self-destruct exits 0 (fails open).
- `config/agents/claude/hooks/biome/biome-check.ts` (PostToolUse): lints the
  edited files, and on errors prints `decision: "block"` with `reason` and
  `additionalContext` on stdout and exits 0; 24 s self-destruct. Per the
  reference this cannot undo the write; it feeds the reason to Claude.
- Measured costs: Fallow changed-code audit 0.2 to 1.3 s warm, 1.2 s cold;
  typecheck 0.5 s; Biome per file well under 1 s. Every candidate gate is
  far below the 600 s default and the local self-destruct budgets.

## Community signal (last 7 days)

Secondary, practitioner reports; treat as signal, not authority.

- [harnessrouter.ai, 2026-09-05](https://harnessrouter.ai/blog/claude-code-hooks):
  "scope `PostToolUse` to a targeted test, a file-level type check, or a
  formatter"; the hook "cannot undo the edit; it can only surface a failure".
- [aicoding-guide.com, 2026-09-09](https://aicoding-guide.com/en/posts/claude-code-hooks-lint-format/):
  "A project-wide lint (`eslint .`) can take tens of seconds every time.
  Always restrict the hook to the edited file."
- [Han Altena on X, 2026-09-07](https://x.com/HanAltena/status/2096703284803219581):
  PostToolUse runs `eslint --fix` on that file, "not `npm run lint` on 800
  files"; a Stop hook "prevents half-finished work".
- [GitHub Agentic Workflows blog, 2026-09-07](https://github.github.com/gh-aw/blog/2026-09-07-agent-of-the-day/):
  a scheduled agent runs Go `deadcode` and opens PRs, skipping ambiguous
  cases; dead-code tooling as an out-of-loop agent job rather than a gate.
- [Medium hook census, 2026-09-08](https://21zerixpm.medium.com/i-cloned-the-247k-star-claude-code-setup-and-counted-whats-actually-in-it-0030439b6f72)
  (search snippet only; page returned 403): a popular setup ships 23 hook
  entries, 7 on `Stop` and 2 on `PostToolUse`, with build, lint and test on
  Stop.
- [pydevtools handbook, undated, surfaced this week](https://pydevtools.com/handbook/how-to/how-to-write-claude-code-hooks-for-python-projects/):
  auto-format on `PostToolUse`, then a Stop hook `uv run ty check >&2 || exit 2`
  with `timeout: 30` for type errors.

Older but load-bearing context: the
[impeccable #400 issue (2026-07-22)](https://github.com/pbakaus/impeccable/issues/400)
shows a Stop hook that ignored `stop_hook_active` re-blocking about 20 times
until the safety cap ended the turn;
[subaud.io (2026-05-18)](https://www.subaud.io/fallow-skylos-ai-code-gates/)
runs Fallow at pre-commit with `gate: new-only` and found agents added 275+
`fallow-ignore-next-line` suppressions until a prompt rule capped them;
[dev.to (2026-07-13)](https://dev.to/paulhorn/designing-an-agent-loop-for-coding-1fmg)
proposes a no-progress rule that trips when two attempts fail the same check
for the same reason.

## Decision table

| Tool | Event | Scope | Behaviour | Reason |
| --- | --- | --- | --- | --- |
| Biome | `PostToolUse` `Edit\|Write` | edited files only | inform (`additionalContext`, exit 0) | write already happened; per-file cost is sub-second; official example uses this event for style feedback |
| Biome | `Stop` | changed files in working tree | block, exit 2, `stop_hook_active` guard | pre-existing errors excluded by delta scope; matches current `biome-ci.ts` |
| Fallow | `PreToolUse` `Bash` on `git commit`, `git push` | change set vs base | block only on `fail`; `warn` and runtime errors pass | official fallow-gate pattern; cannot be bypassed; audit needs a coherent change set |
| Fallow | `Stop` | optional | inform only (exit 0, `additionalContext` with `warn` summary) | 1.3 s is cheap, but Stop fires on non-code turns and pre-existing `warn` would loop |
| TypeScript | `Stop` | run when changed files include `.ts`/`.tsx` and a `tsconfig` exists | block, exit 2, guard, fail-open timeout | whole-program check; mid-edit states across multi-file edits give false errors on `PostToolUse` |
| TypeScript | `PreToolUse` commit/push | optional | none by default | Stop already covers it; the repo `bun run check` gate owns the commit proof |
| Any | `SubagentStop` | none | do not register | read-only subagents have no diff; blocks count toward the same cap |
| Codex | `.codex/hooks.json` | same three scripts | same semantics; Stop must emit JSON on exit 0 | events and exit-2 contract match; `AGENTS.md` block is the no-hooks fallback |

## Risks

- Loops: a Stop gate that blocks on something the agent cannot fix (a
  pre-existing error, a false positive) re-blocks until the cap of 8; the
  guard must be the first statement, and the scope must be delta only.
- Latency compounding: per-edit hooks run on every `Write|Edit`, including
  bursts of parallel edits; anything project-wide there is the failure mode
  practitioners report. Keep `PostToolUse` per file and sub-second.
- Blocking on pre-existing errors: `tsc` is whole-program, so a repo with
  inherited type errors makes the Stop gate unsatisfiable. Gate on "no new
  errors in changed files" or on a clean baseline only.
- Fail-open timeouts: both local hooks exit 0 on self-destruct, so a hung
  Biome silently passes; log the timeout to stderr so it is visible.
- `PostToolUse` cannot block; a hook that prints `decision: "block"` there
  only prompts Claude. Treat it as advice, not enforcement.
- Suppression drift: agents will add ignore comments to clear a gate; pair
  Fallow gates with an instruction limiting new suppressions.
- Codex Stop hooks reject plain text on exit 0; the ported script must print
  JSON or nothing.
- Stop fires at the end of every turn, including question-only turns; the
  gate must short-circuit when the working tree has no relevant changes.

## Open questions

- Confirm on the installed Claude Code version whether `PostToolUse`
  `decision: "block"` still prompts Claude with `reason`, or whether only
  `additionalContext` reaches the model.
- Whether `PostToolBatch` (one run per batch, before the next model call)
  should replace per-edit `PostToolUse` for Biome to cut hook count.
- Whether Fallow `warn` verdicts are worth surfacing at Stop, or only in the
  commit gate.
- Whether the repo's `bun run check` should also be a `PreToolUse` commit
  gate, or remain an `AGENTS.md` proof obligation.
- Whether `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` should be lowered for these
  gates, given two identical failures is the practitioner no-progress rule.
