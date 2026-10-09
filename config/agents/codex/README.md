# Shared Codex CLI setup

`shared.toml` owns the exact standalone CLI release, portable defaults,
marketplace sources and personal plugin selection for desktop and server.
Setup applies it in Phase 6 after Bun is available. Installation verification
checks the same declaration.

```sh
./setup.sh codex --preview --json
./setup.sh codex --apply --json
./setup.sh codex --check --json
```

Run apply from the canonical checkout after accepting the source change.
Preview and check work from a task worktree. Preview reports drift without
creating setup state; check exits nonzero for drift. Apply backs up the local
TOML, merges the declared defaults, registers marketplaces and installs plugins
through native Codex commands. Subsequent applies restore declared versions and
enablement. Partial failures return nonzero with the backup path.

The standalone installer remains OpenAI-owned, with `--release` selecting the
tracked version. It owns downloads, checksums, release directories and executable
links. Codex remains outside Mise and Homebrew CLI ownership. An interactive
Codex update can change the running version; check detects that drift.

`~/.codex/config.toml` stays a local writable file because Codex updates it.
Apply preserves undeclared setting values, including MCP configuration, project
trust, hooks, notifications, disabled unrelated plugins and machine paths.
TOML serialization can change formatting and comments. The original text is
saved with mode 0600 under `$XDG_STATE_HOME/dotfiles/codex/` (default
`~/.local/state/dotfiles/codex/`). Credentials and sessions are not copied.
Changes made concurrently before the config replacement are refused. If native
plugin management changes protected setting values, apply reports a failure;
inspect its backup before repairing those values.

Public dotfiles manages personal CLI plugins. Employer plugins retain their
private repository's setup. Account-managed cloud integrations and bundled
browser, computer-use and document plugins retain their account or desktop
runtime owner; the CLI installer cannot update that desktop bundle. This command
preserves those installations instead of sourcing laptop runtime files on a
server.

The old Mini home marketplace also uses the name `personal`. Apply explicitly
registers the dotfiles marketplace and verifies the declared plugin identities
and versions. It preserves the unrelated home catalog and experimental
marketplaces. Duplicate catalog names remain visible in native marketplace
inventory.

Installation checks do not prove activation in an already running agent.
Start a fresh Codex CLI session after sync to load changed plugins.

References: [OpenAI configuration](https://learn.chatgpt.com/docs/config-file/config-basic),
[native plugin marketplaces](https://developers.openai.com/plugins/build/plugins).
