# Hooks

Deterministic gates on agent actions. Prefer a hook over a prose rule when the
rule must fire whether or not the agent recalls it.

- Both harnesses support `PreToolUse` with the same `hooks.json` shape and the
  same blocking contract: exit 2 blocks, and stderr carries the reason.
- One script can serve both. Confirm that before assuming it, because the
  surrounding mechanics differ.

## Codex requires per-hook trust

- Codex hashes each hook command and stores a `trusted_hash` in
  `[hooks.state.*]` in `config.toml`.
- Change the script and the hash changes. The hook becomes `Modified` and stops
  running until approved again.
- An unapproved hook is `Untrusted` and does not run. Silence is the failure
  mode, not an error.
- Claude Code has no equivalent gate. A hook edited in dotfiles takes effect
  immediately there, and silently stops on Codex.

This asymmetry decides how a shared hook is deployed. Treat a hook edit as a
Codex re-approval step, not a file change.

## Before adding a hook

- Name what it blocks and what a legitimate blocked case looks like. A gate
  that interrupts a one-word fix trains people to route around it.
- Decide how the hook knows its condition is satisfied. A heuristic that is
  wrong in either direction is worse than no hook.
- Prove it fires and blocks in both harnesses. A hook proven only in Claude
  Code is a hook proven nowhere for Codex, because trust silently withholds it.

## `disableAllHooks` retires the whole surface

- One `settings.json` key trades every hook for its tokens: all six configured
  events, including the `Stop` and `PreCompact` chains, plus the custom status
  line and any custom file-suggestion command.
- Nothing reports the loss. Silence is the failure mode here too.
- Trim hooks one declaration at a time.

## Owner

- Existing hook scripts: `config/agents/claude/hooks/`.
- Hook declarations: `config/agents/claude/hooks.json` and
  `config/agents/codex/hooks.json`.
