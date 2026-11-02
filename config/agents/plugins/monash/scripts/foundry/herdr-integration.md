# Private Herdr integration

This document is part of the plugin's `scripts/foundry/` payload. Run the
source commands below from the plugin root, the directory containing
`scripts/` and `skills/`.

`scripts/foundry/install.py` installs a reviewed copy of `foundry`,
`monash-foundry`, `monash`, `monash_hosts.py`, `monash_remote.py`,
`config.json`, and the pinned `codex-models.json` into
`~/.local/share/monash-foundry`.
It also installs `CODEX-CATALOG-LICENSE` and `CODEX-CATALOG-NOTICE` beside the
catalogue to retain upstream attribution.
It writes an installation manifest with the source revision hash, and creates
only these command links:

```text
~/.local/bin/foundry -> ~/.local/share/monash-foundry/foundry
~/.local/bin/monash-foundry -> ~/.local/share/monash-foundry/monash-foundry
~/.local/bin/monash -> ~/.local/share/monash-foundry/monash
```

`monash_remote.py` is an internal mode-0500 installed payload. It is not a
command and has no `~/.local/bin` link; `monash` invokes it with a sealed host
profile and run ID. The helper persists its local remote-run identity below
`${XDG_STATE_HOME:-$HOME/.local/state}/monash/remote/` and owns the internal
`start`, `get`, `prompt`, `read`, `wait`, and `reconnect` operations. It also
keeps the remote per-run shim below the observed remote home directory.

It never uses `~/.config/herdr`: that path is public-dotfiles-owned. On first
installation, it copies the complete current `~/.config/herdr/config.toml` to
`~/.local/share/monash-foundry/herdr.toml` and appends this one binding:

```toml
[[keys.command]]
key = "prefix+f"
type = "pane"
command = 'exec /Users/example/.local/share/monash-foundry/monash launch'
description = "Monash Foundry picker"
```

The installed command path is rendered as an absolute shell-quoted path. The
normal Ctrl+G prefix remains part of the copied configuration. The private
file is a full Herdr configuration because `HERDR_CONFIG_PATH` replaces the
default path, it does not layer on it. Later installs preserve private Herdr
customizations and refuse a duplicate or foreign Ctrl+G F binding.

## Entry points

`config.json` `host_profiles` is the sealed placement registry. `--host
PROFILE_ID` selects an exact profile whose `transport` is `local` or `ssh`.
The current `laptop` profile is local and `mini` is the initial SSH profile.
`--local` and `--mini` are migration aliases for those IDs only. The installer
`--host-role` value is manifest metadata and does not select runtime placement.

Outside Herdr, bare `foundry` refuses because no host profile is assumed. Use
`foundry --host PROFILE_ID` to attach the selected dedicated Herdr session.
Inside Herdr, `foundry` without a host, or `foundry --menu`, opens the adjacent
`monash launch` picker with the same config. It does not start a nested Herdr
TUI.

`monash launch` opens the host, model, and native-agent picker. `monash spawn`
is the noninteractive coordinator: it validates the Foundry route before any
pane effect. For a local profile it creates one direct no-focus sibling in the
caller tab. For an SSH profile it creates one local no-focus sibling, starts
the remote native agent through the internal helper, and attaches that sibling
directly to the remote native agent. It never creates a nested Herdr TUI.

Before `herdr agent start`, the coordinator proves the post-login shell
resolves the canonical command to a no-secret per-run shim. After managed
startup, it proves the foreground process is the pinned real native executable
with the requested cwd and model-bearing argv, not the shim or Foundry
launcher. The local per-run shim state is below
`$XDG_STATE_HOME/monash/spawns/`.

For an SSH receipt, the direct attach command is exactly:

```sh
ssh -tt SSH_ALIAS HERDR_EXECUTABLE --session HERDR_SESSION agent attach AGENT_NAME
```

For the current `mini` profile, the fixed values are `mac-mini`,
`/opt/homebrew/bin/herdr`, and `monash-foundry`. The attach command contains
no `exec` prefix and invokes the remote native agent directly, not a nested
Herdr TUI. Detaching ends the SSH attach process and returns to the local
sibling shell; the remote Herdr server and managed native-agent PTY remain
alive for observation or reconnect.

For `mini`, the same form expands to:

```sh
ssh -tt mac-mini /opt/homebrew/bin/herdr --session monash-foundry agent attach AGENT_NAME
```

For SSH, `--cwd` is the local requested directory. The registry resolves it
with the most specific component-aware `path_mappings` entry, or the caller
can provide `--remote-cwd`. The helper verifies the remote directory and
reports actual cwd from `remote.herdr.agent.get`; expected and observed cwd
must match. There is no local execution fallback.

For local transport, `ready` means managed startup plus observed real-native
process identity and reports `session.state: pending_first_turn`. It does not
invent a native session ID. `monash verify NAME_OR_PANE` or `monash spawn
--verify` submits one harmless first turn and returns `verified` only with the
complete Herdr `agent_session` tuple and `session_id`.

For SSH, the helper reports `ready` only after remote interactive readiness and
a complete native session tuple. It reports `started` when that tuple is not
complete. Without `--verify`, Monash returns a recoverable refusal before
attach. With `--verify`, it sends the helper-backed harmless first-turn
prompt, revalidates the same remote identity, and attaches only after
verification. Every failure after pane creation preserves the local and
remote identities and repair action. Do not rerun `spawn`, answer a blocked
prompt, or silently kill a native agent while recovering.

The five implemented OpenCode routes are qualified on both laptop and Mini.
Each passed native inference and a README file-read tool through the integrated
Monash launcher. Laptop Kimi K2.7 passed on 2026-09-09; the other four laptop
routes passed on 2026-09-10. All laptop routes used OpenCode 1.18.29. On Mini,
Kimi K2.7 used OpenCode 1.18.27 and the other four routes used 1.18.30. Mini
execution also passed through the remote helper and named Herdr session.

## Installer behavior

```sh
python3 scripts/foundry/install.py --dry-run
python3 scripts/foundry/install.py --host-role laptop
python3 scripts/foundry/install.py --check --host-role laptop
python3 scripts/foundry/install.py --host-role mini
```

`--host-role` records the installer role in the manifest; it does not change
the runtime `host_profiles` registry or make bare `foundry` infer a host.
`--prefix PATH` defaults to `~/.local`; `--herdr-config PATH` selects the
baseline to copy on first install. Those two options permit isolated installer
tests without changing `HOME`. The installer refuses an incomplete source
directory, an unmanaged existing installation directory, symlinked private
destinations, edited managed source files, or either existing command path
unless it is already the expected managed link. Reinstalls create a timestamped backup below
`~/.local/share/monash-foundry/backups/` before replacing the managed snapshot.
The backup directory is mode 0700.

One edited managed file is migrated rather than refused: an installed
`config.json` that is, byte for byte, its manifest-recorded content with only the
three Claude aliases moved to their live values (`sonnet` and `sonnet5` at
`claude-sonnet-5-5`, `haiku` at `claude-haiku-5-5`, from `claude-sonnet-4-6`,
`claude-sonnet-5` and `claude-haiku-4-5`). The installer proves that by putting
the old values back and matching the recorded hash, then requiring the installed
bytes to equal the canonical serialization (indent 2, key order kept, one final
newline, no duplicate keys). Reformatting, a duplicate key or any other extra
edit is refused like any edited managed file. It also requires the source config
to carry the same aliases, and verifies its private backup of the edited file
byte for byte before replacing anything.

Existing managed command links are never unlinked or rewritten; only a missing
link is created. If an OS error stops a migration part-way, the installer
removes only the links it created in that run, restores every saved file and
the old manifest, removes a private Herdr config that did not exist before the
run, and reports restoration only after it has checked each file's hash and
mode, that absence, and each link's identity against what it saved. A check that
cannot be completed, including one whose read fails, counts as unverified. In
that case, or if any check fails, it says so and names the backup to restore by
hand. A killed process or a
power loss during the install is not covered and can leave a mixed snapshot;
recover it from the backup by hand, as there is no restore command. Any other
difference, any other alias value, any other edited managed file, or a source
that would revert the aliases is refused, and `--check` stays strict. There is
no force option.
It does not SSH, install remotely, create a saved Herdr machine, reload or stop
a Herdr server, or change a default shell.

The installer does not silently synchronize files or current directories. SSH
spawn uses sealed path mappings or explicit `--remote-cwd`, verifies the remote
directory, and obtains actual cwd from the remote Herdr observation.
