---
name: monash-foundry
description: "Install, verify, launch, or repair the Monash Azure Foundry routes for Codex, Claude Code, and OpenCode."
---

# Monash Foundry

This is the Monash plugin's first skill. Use the versioned plugin payload as
the implementation owner. Resolve the plugin root as two directories above
this `SKILL.md`; its launcher source is `scripts/foundry/`. Run source
commands from that plugin root.

## Launch and placement

Treat `config.json` `host_profiles` as the sealed placement registry. A
profile ID is selected with `--host PROFILE_ID`, and its `transport` is either
`local` or `ssh`. The current `laptop` profile is local and `mini` is the
initial SSH profile. `--local` and `--mini` are migration aliases for those
IDs only.

- Outside Herdr, use `foundry --host PROFILE_ID` to attach the selected
  dedicated Herdr session. Bare `foundry` refuses because it does not infer a
  host from the machine or installer role.
- Inside Herdr, `foundry` without a host, or `foundry --menu`, opens an
  adjacent `monash launch` picker with the same config. It does not start a
  nested Herdr TUI.
- `monash launch` selects the host profile, model, native agent, and working
  directory. The native agent choices are `codex`, `claude`, and `opencode`.
- `monash spawn --host PROFILE_ID --model STABLE_ID --agent AGENT
  --cwd ABSOLUTE_DIRECTORY` creates one no-focus sibling in the caller tab.
  Local profiles start the native agent directly in that sibling. SSH profiles
  use one local sibling and the internal remote helper, then attach that
  sibling directly to the remote native agent.

For SSH, map the local `--cwd` through the profile's component-aware
`path_mappings`, or pass an explicit `--remote-cwd`. The helper verifies the
remote directory and the actual cwd comes from `remote.herdr.agent.get`; there
is no local execution fallback.

The direct SSH attach form is:

```sh
ssh -tt SSH_ALIAS HERDR_EXECUTABLE --session HERDR_SESSION agent attach AGENT_NAME
```

It has no `exec` prefix and does not open a nested Herdr TUI. Detaching returns
to the local sibling shell while the remote Herdr server and managed native
agent PTY remain alive.

Use `monash-foundry codex`, `monash-foundry claude`, or explicit OpenCode
selection for a direct Foundry route without the coordinator picker.

The launcher prints host, agent, provider and deployment before starting the
native harness. Preserve canonical Codex and Claude homes and existing session
history.

## Install and verify

Run the plugin-owned installer from `scripts/foundry/install.py` with the
correct role:

```sh
python3 /absolute/plugin/root/scripts/foundry/install.py --host-role laptop
python3 /absolute/plugin/root/scripts/foundry/install.py --host-role mini
```

Then run the same command with `--check`. `--host-role` records installer
manifest metadata; it does not select the runtime host profile. Installation
owns only
`~/.local/share/monash-foundry`, the `~/.local/bin/foundry`,
`~/.local/bin/monash-foundry`, and `~/.local/bin/monash` links, and the
private Herdr Foundry binding. The internal `monash_remote.py` payload is
installed in the private directory with mode 0500 and has no command or bin
link.

## Qualification and recovery

All five implemented OpenCode routes are qualified on laptop and Mini by native
inference and a harmless README file-read through the installed Monash
launcher. All laptop routes used OpenCode 1.18.29. On Mini, Kimi K2.7 used
1.18.27 and the other four routes used 1.18.30. Production launches no longer
require `--qualification` for these routes. Read each route's `config.json`
evidence for its receipt reference.

For local transport, `ready` includes real native executable, model-bearing
argv, and cwd evidence but uses `session.state: pending_first_turn`; it does
not invent a native session ID. Use `monash verify NAME_OR_PANE` or
`monash spawn --verify` for the harmless first turn and `verified` session
identity.

For SSH, a helper `started` result without a complete native session is a
recoverable refusal unless `--verify` was explicit. With `--verify`, Monash
sends the helper-backed first-turn prompt, revalidates the same remote run
identity, and attaches only after verification. Preserve every returned local
or remote identity and repair action. Do not rerun `spawn`, answer a blocked
prompt, or kill a native agent while recovering. `monash_remote.py` owns
internal `start`, `get`, `prompt`, `read`, `wait`, and `reconnect` operations;
do not treat it as a public command.

## Credentials and repair

Codex receives only `AZURE_OPENAI_API_KEY` through
`~/code/dotfiles/bin/with-one-password-token inject` and the declared
`op://API Credentials/AZURE_OPENAI_API_KEY_MONASH/credential` reference.
Use the wrapper's `check` command for custody and an injected no-output command
for access. Keep token and credential values out of output, files and shell
state.

Claude uses the validated Azure tenant and subscription through native Foundry
support. A rejected account, endpoint, deployment, argument or credential stops
the launch. Follow the launcher's displayed repair action; preserve personal
provider behavior rather than adding a fallback.

## Source checks

From the plugin root, run:

```sh
python3 -m unittest discover -s scripts/foundry -p 'test_*.py' -v
```

Read `scripts/foundry/README.md` for implementation boundaries and
`scripts/foundry/herdr-integration.md` for the installed Herdr contract.
