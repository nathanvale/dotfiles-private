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
- Changed hook declarations can become `Modified` and stop running until
  approved again. Inspect `/hooks` after a release; a source file edit alone
  does not prove trust changed or the hook ran.
- An unapproved hook is `Untrusted` and does not run. Silence is the failure
  mode, not an error.
- Claude Code has no equivalent trust gate. Verify the effective installed
  source and a fresh-session canary in each harness.

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

- One `settings.json` key trades every hook for its tokens: every configured
  hook event, plus the custom status line and any custom file-suggestion
  command.
- Nothing reports the loss. Silence is the failure mode here too.
- Trim hooks one declaration at a time.

## Owner

- Existing non-plugin hook scripts: `config/agents/claude/hooks/`.
- Hook declarations: Claude gates live in `config/agents/claude/settings.json`, which setup merges into the machine-owned `~/.claude/settings.json`; reserve `config/agents/claude/hooks.json` for `InstructionsLoaded`; Codex uses `config/agents/codex/hooks.json`.
- Biome and TypeScript quality gates come from
  `config/agents/plugins/proof/hooks/`, with separate Claude and Codex declarations.
  Refresh the native plugin after a source release and verify it in a fresh session.
- Fallow owns its native PreToolUse hooks. Install through the pinned Fallow CLI's
  `hooks install --target agent --agent claude --user` and equivalent `codex`
  command. Preview with `--dry-run`; preserve unrelated hook declarations.
  Dotfiles maps both native script paths to the unchanged shared generated source.
  Run `./setup.sh symlinks` after updating it. A Claude `--user` install writes
  only the machine file: copy its `hooks` change into the tracked settings, or
  `verify_install.sh` reports `hooks` drift and the next setup reverts it.
  Follow repository policy for the comparison base. Native warnings remain advisory. Native runtime/setup errors
  print a notice and allow the command; CI remains the required quality gate.
- Codex hook installation does not prove trust or activation. Review the hook in
  `/hooks` and verify a fresh-session canary before claiming it is active.

## Codex directory limit and Git enforcement

Codex's Bash hook input omits a shell call's separate `workdir`; its `cwd`
identifies the session. The native agent gate can therefore audit the session
checkout instead of the checkout receiving a commit. See
[the upstream report](https://github.com/openai/codex/issues/33986).
Use an explicit `git -C /absolute/worktree ...` command for cross-worktree
publication so the native script can see its target.

Keep native Fallow auditing in each repository's Git hook and CI. Dotfiles runs
its pinned local audit after lint-staged in `.husky/pre-commit`, using
`origin/main`. The SDK uses its own pinned audit with `origin/staging` and the
PR's recorded destination commit in Bitbucket CI. Git runs its hook in the
actual checkout, independently of the agent session. Agent hooks remain a
feedback layer; they do not replace these enforcement points.

Native audits read working-tree content; they do not snapshot the Git index.
A partially staged commit can therefore differ from the local audit. CI audits
its checked-out committed candidate against the recorded destination commit and
is the authoritative committed-code gate. Keep this boundary explicit instead
of adding a custom index-snapshot wrapper.
