# Proof

Proof is a private dotfiles plugin that ships three self-gating, dependency-free
quality hooks for Claude Code and Codex: `biome-ci`, `fallow-ci`, and
`typecheck-ci`. Each hook fires only in a repository that already carries the
matching tool locally, so the plugin can be enabled globally without breaking
a repository that has no Biome, Fallow, or TypeScript installed.

The package identity is `proof` at version `0.2.3`. Keep that identity and
version aligned across `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
`package.json`, and the `personal` marketplace entries in
`config/agents/plugins/.claude-plugin/marketplace.json` and
`config/agents/plugins/.agents/plugins/marketplace.json`; a version bump
touches all five.

## Live proof

On 2026-09-12, fresh sessions proved the plugin live in both harnesses:
Claude Code with Sonnet 5 via Foundry and Codex with gpt-6-astra. Adding an
unused export blocked `Stop` with the plugin's `fallow-ci` envelope. The
plugin's `biome-ci` fired alongside the old repository Biome hook before those
hooks were removed. Codex recorded five trusted hook entries,
`proof@personal:hooks.json:*`, in `~/.codex/config.toml`. That release removed
the superseded repository Biome hooks.

## Plugin root

Run source commands from the plugin root: the directory containing this
`README.md`, `.claude-plugin/`, `.codex-plugin/`, and `hooks/`. In this
checkout, that is `config/agents/plugins/proof/`.

## What each hook does

- `biome-ci`: `PostToolUse` on `Write|Edit|MultiEdit` lints the files an agent
  just edited and only informs (the write already happened, so it cannot
  block). `Stop` lints the full changed-file delta and blocks with exit 2.
- `fallow-ci`: `PreToolUse` on `Bash` runs `fallow audit` before a `git commit`
  or `git push` and blocks on a `fail` verdict for introduced findings,
  the official Fallow gate pattern. The [persisted content guard](#persisted-content-guard)
  also blocks mismatched Git content and unsupported commands. `Stop` audits committed branch changes
  plus staged, unstaged, and untracked changes, including source deletions.
  A `pass` or `warn` verdict means the change introduced no gating finding;
  it never means the repository's inherited backlog is clean.
- `typecheck-ci`: `Stop` only. `tsc` is whole-program, so gating it on every
  edit would produce false errors from mid-edit, multi-file states. Blocks
  only on diagnostics inside the changed-file set; an error in an untouched
  file surfaces as `suppressedCount` context, never a block, unless it is a
  global (file-less) error and a `tsconfig*.json` itself changed.

### Comparison base and the new-only ratchet

The hook always passes `--gate new-only`. It does not require inherited findings
at the comparison baseline to be cleaned up. It resolves an immutable local Git
merge-base for both `PreToolUse` and `Stop`, in this order:

1. `FALLOW_AUDIT_BASE`, when explicitly set to a local commit or ref.
2. `git config workflow.baseBranch`, preferring that branch's upstream, then
   `origin/<declared-name>`, then the declared local ref.
3. The locally recorded `origin/HEAD` remote-default ref.

For example, a repository integrating into `staging` can declare
`git config workflow.baseBranch staging`; a fork can use
`FALLOW_AUDIT_BASE=upstream/develop`. These are Git references, with no GitHub,
Bitbucket, API, authentication, or network dependency. References must already
exist locally. The hook never fetches. The current feature branch's upstream is
not an implicit baseline: after pushing, it could equal `HEAD` and erase the
branch delta. A clean working tree therefore does not erase committed findings.

Without any declared or remote-default base, an existing repository retains the
working-tree comparison against `HEAD`. It emits a `branch-base-unavailable`
skip diagnostic to state that committed branch changes remain unqualified.
An invalid explicit/declared ref, unrelated history, or repository without an
initial commit emits an operational skip. None of these is a passing branch
qualification. Configure the intended base rather than treating that skip as
proof. All Git paths reach the delta check. Native Fallow owns supported file
formats, so Proof does not maintain a separate suffix filter.

### Persisted content guard

Fallow analyzes files in the working tree. A commit writes the staged index,
and a push publishes committed content. Before a literal commit, Proof blocks
when any tracked or untracked file differs from the index.
Before a push, it requires that content to match HEAD. At Stop, if committed
branch changes differ from the working tree, Proof first audits an existing
clean Git worktree at the same HEAD with its installed local Fallow binary.
It verifies both HEAD identities and snapshot cleanliness before and after
that audit, then audits the session working tree separately. An unstaged
revert therefore cannot conceal committed findings, and unrelated runtime
files need not be staged or removed.

Without a clean initialized checkout at the same HEAD, Stop retains the
conservative `snapshot-mismatch` block. Keep the task worktree clean after
committing, or align the session files with HEAD before retrying. Proof never
creates checkouts or changes Git content. A checkout that changes during the
audit blocks with `snapshot-changed`. Commit and push checks still block
partial staging and unrelated untracked content because those commands must
publish the exact audited files.

The publication gate supports a single direct `git commit` with message/amend
flags, and `git push` for the current HEAD. Both forms accept one absolute
`git -C <directory>` prefix and audit that repository rather than the session
checkout. Relative or repeated `-C`, other Git prefix options, compound shell
commands, alternate commit content modes such as `-a` or `--only`,
and pushes selecting another ref with `reason: unsupported-command`. Run staging
in a separate tool call, then use a supported publication command. Configured
multi-ref push selection requires an explicit `HEAD:<branch>` refspec.

### Known limits

- Codex's `apply_patch` tool input carries no `file_path`, so `biome-ci`'s
  `PostToolUse` finds no edited file to lint there and is a silent no-op on
  Codex; only its `Stop` path lints Codex-driven edits.
- Live firing, cache refresh, and per-hook trust approval require a fresh
  harness canary. Historical trust records do not prove today's activation.

Codex's hook `cwd` names the session directory. For a command in another
worktree, use `git -C /absolute/worktree commit ...` or the equivalent push
form so the command itself identifies the audited repository. Per-call shell
working directories are not available in the normalized hook payload.

The pre-command matcher recognizes literal shell `git commit` and `git push`
commands, including the supported absolute `-C` prefix. It cannot inspect an
opaque Python driver, nested process or shell alias. The configured branch-delta Stop
check is the backstop for this session repository, not subprocess introspection.
Both current [Codex hook docs](https://developers.openai.com/codex/hooks) and
[Claude hook docs](https://code.claude.com/docs/en/hooks) document normalized
`Bash` payloads with `tool_input.command`. That documentation and source tests do
not prove a live session fired the installed hook. Keep the `Bash` matcher until
an actual payload supports a routing change.

Fallow operational failures remain fail-open. Unparseable output, an unknown
verdict, a nonzero exit without a qualified verdict, or a runner that cannot
start now emits a `status: skipped` diagnostic. A parsed `fail` verdict on exit
0 or 1 blocks; `pass` and `warn` never gate inherited debt. The existing 24-second
PreToolUse and 48-second Stop budgets are unchanged. A timeout emits an explicit
unqualified `timeout` diagnostic and exits 0; Codex Stop also receives `{}`.
Timeout is not audit acceptance. On POSIX, cancellation sends SIGTERM to owned
command groups and allows a bounded drain before forced termination. Fallow
3.34.1 relies on its native SIGTERM shutdown to stop the detached type-aware
helper and its children. Process-level controls qualify that lifecycle; Windows
and arbitrary detached daemons without that shutdown protocol remain outside
the qualified scope.

### Self-disable marker

Every hook resolves the repository root. Biome and TypeScript require both a
repo-local `node_modules/.bin/<tool>` binary and a working-tree marker config
file (`biome.json` or `biome.jsonc` for Biome, `tsconfig.json` for TypeScript).
Fallow checks for `.fallowrc.json` in the working tree, staged index and HEAD,
so deleting only its working copy cannot bypass the persisted content guard.
When its marker is absent from all three states, Fallow exits 0 silently.
Biome and TypeScript exit 0 silently when their working-tree marker is absent.
These skips produce no error, block or stderr, allowing the plugin to stay
enabled across repositories.

Fallow has one more runner. When `.fallowrc.json` exists but
`node_modules/.bin/fallow` does not, `fallow-ci` reuses the repository's own
`.mcp.json` Fallow server when it pins an exact `fallow@x.y.z` through
`pnpm`, `npx`, or `bunx`, swapping the `fallow-mcp` bin for `fallow`. For
example, `pnpm dlx --package fallow@2.102.0 fallow-mcp` becomes
`pnpm dlx --package fallow@2.102.0 fallow audit ...`. A floating version or
another launcher is not a runner. With the marker but no runner, the hook
still exits 0 but writes a `status: skipped`, `reason: no-runner` envelope to
stderr, so an inactive gate is visible rather than silent. A pinned Fallow
older than type-aware analysis rejects `--type-aware`; the audit then retries
once without the type-aware flags.

### Dependency-free constraint

The plugin's `package.json` carries no `dependencies` key, and its hook
sources import only `node:*` modules and Bun globals. Claude Code and Codex
run plugin hook sources with `bun run "<script>"` directly from the installed
plugin cache, which has no `node_modules` of its own. A hook that needed a
real dependency would need a build step (bundling it in, or vendoring), which
is why the constraint is enforced by a test, not just a convention.

## Source checks

From the plugin root:

```sh
bun run lint
bun run test
bun run typecheck
jq empty .claude-plugin/plugin.json .codex-plugin/plugin.json \
  ../.claude-plugin/marketplace.json
claude plugin validate --strict .
```

## Install from the inline marketplace

Set the paths to the reviewed dotfiles checkout. On a normal dotfiles
install, the marketplace root is `~/.config/agents/plugins`:

```sh
DOTFILES_ROOT="${DOTFILES_ROOT:-$HOME/code/dotfiles}"
MARKETPLACE_ROOT="$DOTFILES_ROOT/config/agents/plugins"
PLUGIN_ROOT="$MARKETPLACE_ROOT/proof"
```

Claude Code, user scope:

```sh
claude plugin validate --strict "$PLUGIN_ROOT"
claude plugin marketplace list --json
# Add only when `personal` is absent:
claude plugin marketplace add "$MARKETPLACE_ROOT"
claude plugin install proof@personal --scope user
claude plugin list --json
claude plugin details proof@personal
```

When `personal` is already registered to this checkout, skip `marketplace
add`. Refresh it with `claude plugin marketplace update personal` before
installing or updating `proof`. Restart Claude Code before the new hooks take
effect after an install or update.

Codex, user scope:

```sh
codex plugin add proof@personal --json
```

To refresh the installed source after a hook edit, remove and re-add rather
than relying on an upgrade command that does not refresh a local marketplace
source:

```sh
codex plugin remove proof@personal --json
codex plugin add proof@personal --json
```

### Codex `trusted_hash` caveat

Codex hashes each configured hook command and stores the result as a
`trusted_hash` in `[hooks.state.*]` in `config.toml`. Editing any hook
source changes that hash, so the hook becomes `Modified` and stops running
silently until it is trusted again. There is no equivalent gate in Claude
Code: a hook edit takes effect there immediately. Every source edit to this
plugin's hooks needs a Codex re-approval step, or the affected hook silently
stops firing on Codex while continuing to run on Claude Code.

## Rollback

This is the rollback for the first Proof release, when no earlier dotfiles
revision contains a Proof package. Remove only the installed `proof` plugin,
and leave the inline `personal` marketplace registration in place for other
plugins:

```sh
# Claude Code
claude plugin uninstall proof@personal --scope user -y

# Codex
codex plugin remove proof@personal --json
```

Run each command only when that harness lists `proof` as installed. If the
plugin was never installed, there is nothing to remove. These commands do not
remove the marketplace or any other installed plugin. Use `claude plugin
disable proof@personal` when the package should remain installed but inactive.
