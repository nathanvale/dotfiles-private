# remote-dev

One way back to remote development from the viewing Mac:

- **Remote Development** desktop item for the existing pilot.
- **`remote-dev`** help and explicit commands for every configured target.

Both use one rechecking editor policy. The explicit `start` action can start an
existing, opted-in container before opening VS Code. No command creates, pulls,
rebuilds, replaces, restarts, stops or removes containers.

## Commands

```text
remote-dev                    show help, with no connection or startup
remote-dev choose             interactive chooser (terminal only)
remote-dev list [--all]       configured targets; --all adds unclassified containers
remote-dev open TARGET        open the running target in isolated VS Code
remote-dev start TARGET       start the opted-in target, then open isolated VS Code
remote-dev logs TARGET        recheck, then print the native service log tail (redacted)
remote-dev board TARGET       recheck, then open the configured task board
remote-dev --help | --discover --json | --discover-command ID --json
```

Add `--json` for one Contract Core 2.0 envelope on stdout. Without a terminal,
the chooser refuses at once (exit 2) instead of waiting for keyboard input.

In the chooser, type to filter, use the arrow keys, press Enter to choose and
Escape to cancel. Ctrl-A switches between known targets and all containers.

The chooser puts recent editor launch requests first. `list` retains configuration
order. Target settings remain in the existing targets file; history contains only
host/target/container identities, never credentials or a second launch configuration.
History is scoped to that config path under `${XDG_STATE_HOME:-~/.local/state}/remote-dev/recents-<hash>.json`,
retains at most 50 identities, and is written privately after successful editor
dispatch. It is advisory: missing or invalid history falls back to configuration
order, and a history write failure never repeats or undoes a launch. A dispatch
record does not prove VS Code connected. Cancellation, inspection and failed
editor dispatch do not update history. Concurrent launches can lose a ranking
update; they cannot change target settings or grant container access.

## Start the existing pilot

From your Mac, run:

```sh
remote-dev start pilot
```

Or run `remote-dev`, select **pilot**, then select **Start and open VS Code**.
The running pilot offers **Restore services and open VS Code**. Other running
targets offer **Open VS Code**. The desktop item continues
to use `open pilot` and never starts a stopped container.

Startup requires `allowStart: true` on that exact configured target. The default
is false. `start` checks the host, container name and full ID, then uses native
`docker start` by ID. Only `exited` or `created` containers can be started. An
already-running container is opened without restart. A missing, replaced, paused
or otherwise unexpected container is refused. The isolated editor directories
must exist before startup.

The same container keeps its existing HOME, workspace, authentication mounts and
startup command. Docker runs that existing command. For `agents-pilot`, it is
`sleep infinity`. Its explicit `restore` profile then checks Core, Tailscale and
Shepherdr and starts only missing services through their existing native commands.
It opens VS Code only when the services are ready. A running pilot's chooser
therefore offers **Restore services and open VS Code**.

The profile keeps Jobs off. It never launches agents, tasks, a browser or a new
sign-in. A missing retained Tailscale login or Shepherdr token fails closed.
Healthy services and their terminals are left alone. Core0.1.20 recovery uses
native kept-terminal recovery shells, not an agent resume command.

When Core is absent, the existing `with-one-password-token inject-stdin` owner
delivers the profile's declared Claude OAuth field to Core only. The service-account
token never enters the container. No secret is placed in argv, logs or source.
Tailscale and the web service do not inherit the Claude token. Codex keeps its
existing exclusive authentication mount. No API-billing route is selected.

A target without a `restore` profile keeps container-only startup. The profile
is `{"kind":"shepherdr-pilot","shepherdrVersion":"3.1.33","claudeOAuthRef":"op://VAULT/EXISTING-ITEM/FIELD"}`.
Keep its real credential reference in the private targets file. This profile
expects the existing Core0.1.20 layout. `resources/pilot-runtime.py` owns its
startup, locking and sanitized readiness result. It reuses the previously
reviewed stdin-to-Docker-env delivery pattern. It is not a cloud credential broker.

If startup or service restoration succeeds but VS Code fails, running services stay running. The
result records the completed start and the unfinished editor action. If the
start result is unknown, inspect `remote-dev list` before another action. There
is no automatic mutation retry or stop-on-error rollback. Restore logs and its
receipt stay private in `~/.local/state/pilot-runtime/remote-dev` inside the container.

## How it decides

- **Inventory:** one read-only `docker ps --all` over SSH to each admitted host
  (`BatchMode`, strict host keys, no agent, no forwarding). Container names are
  never put into remote commands; unsafe names are dropped and counted.
- **Roles:** only from the targets file. Every other container is
  `unclassified` and inspect-only. A UI pilot is never shown as a coordinator.
- **Recheck:** `open`, `logs` and `board` rediscover the host immediately before
  acting. The configured container ID must be present and running. This is a
  point-in-time guard; it cannot stop the container changing later.
- **Editor:** the existing isolated `--user-data-dir` and `--extensions-dir`,
  `SSH_AUTH_SOCK` cleared, and `VSCODE_IPC_HOOK_CLI` removed so the daily VS
  Code instance is never reused. If an isolated directory is missing, it refuses
  rather than starting a fresh profile. Attachment is to the existing container;
  no devcontainer definition, hooks or Docker socket mounts are added.
- **Logs:** `docker exec <id> tail` of the configured service log, with
  credentials, tokens, URL queries and terminal control sequences removed.
  Editor connection logs (View > Output) and Docker stdout are separate.

## Reconnect a disconnected editor

A successful `open` or `start` confirms official VS Code CLI dispatch. The legacy
`editor-window:TARGET` effect records that request, not a completed connection.
Confirm a file read and an integrated terminal in the intended container.

VS Code can focus an existing window for the same folder even with `--new-window`.
If the container stopped, that window may have already given up reconnecting.
After the container and services return, run **Developer: Reload Window** from
the Command Palette in that target's isolated window. This restarts native
connection resolution without restarting the container or its services.
Reissuing `remote-dev open TARGET` alone is not a reload or attachment proof.

The launcher does not automate UI commands, close windows, change settings or
retry service mutations to repair an editor connection. A warm reload after an
earlier stop is separate evidence from a complete new cold-start recovery test.

## Targets file

`$REMOTE_DEV_CONFIG`, else `${XDG_CONFIG_HOME:-~/.config}/remote-dev/targets.json`.
[`examples/targets.json`](examples/targets.json) describes the current pilot.
Board URLs must be `https` with no credentials, query or fragment. Add the
pilot's private board URL only in your local copy. Set `allowStart: true` only
after admitting that target's full ID, retained mounts and existing startup
command. The example leaves startup disabled.

## Install on another Mac

The existing pilot Mac already has the launcher and private target configuration.
These blocks are for a new installation. They refuse occupied destinations.
The CLI does not run them.

- **Adopt** refuses before writing anything if a destination already exists,
  including a broken symlink. It records each addition just before making it.
- **Roll back** removes an addition only while it still matches its record. It
  keeps and names anything changed since, and leaves every other file alone.
  After you review what it kept, run it again.
- **A partial adoption** is undone by the same rollback.

### Adopt on the Mac

Adds `targets.json` (and its `remote-dev` folder if absent), the desktop item
and the `remote-dev` link. Records go in `~/.local/state/remote-dev-adoption/`.

```sh
( set -eu
src="$HOME/code/dotfiles/packages/remote-dev"
state="$HOME/.local/state/remote-dev-adoption"
conf="${XDG_CONFIG_HOME:-$HOME/.config}/remote-dev"
desk="$HOME/Desktop/Remote Development.command"
link="$HOME/.local/bin/remote-dev"
for f in examples/targets.json "desktop/Remote Development.command" bin/remote-dev; do
  [ -f "$src/$f" ] || { echo "Missing source, nothing adopted: $src/$f" >&2; exit 1; }
done
for p in "$state" "$conf/targets.json" "$desk" "$link"; do
  if [ -e "$p" ] || [ -L "$p" ]; then echo "Occupied, nothing adopted: $p" >&2; exit 1; fi
done
if { [ -e "$conf" ] || [ -L "$conf" ]; } && [ ! -d "$conf" ]; then
  echo "Occupied, nothing adopted: $conf" >&2; exit 1
fi
set -C
mkdir -p "$state" "$HOME/.local/bin"
if [ ! -d "$conf" ]; then
  printf '%s\n' "$conf" > "$state/dir"
  mkdir -p "$conf"
fi
printf '%s\n%s\n' "$conf/targets.json" "$(shasum -a 256 < "$src/examples/targets.json")" > "$state/targets"
cat "$src/examples/targets.json" > "$conf/targets.json"
printf '%s\n%s\n' "$desk" "$(shasum -a 256 < "$src/desktop/Remote Development.command")" > "$state/desktop"
cat "$src/desktop/Remote Development.command" > "$desk"
chmod 755 "$desk"
printf '%s\n%s\n' "$link" "$src/bin/remote-dev" > "$state/link"
ln -s "$src/bin/remote-dev" "$link"
echo "remote-dev adopted. Records: $state"
)
```

Adding the private board URL to `targets.json` afterwards is your edit, so
rollback keeps that file for you to review and remove.

### Roll back on the Mac

```sh
( state="$HOME/.local/state/remote-dev-adoption"
[ -d "$state" ] || { echo "No remote-dev adoption record; nothing removed." >&2; exit 1; }
kept=0
release() { # $1 names a record: line 1 is the path, line 2 what was added there
  record="$state/$1"
  [ -f "$record" ] || return 0
  path="$(sed -n 1p "$record")"
  added="$(sed -n 2p "$record")"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    rm "$record"
  elif [ "$1" = link ] && [ -L "$path" ] && [ "$(readlink "$path")" = "$added" ]; then
    rm "$path" "$record"
  elif [ "$1" = dir ] && [ -d "$path" ] && [ ! -L "$path" ] && rmdir "$path" 2>/dev/null; then
    rm "$record"
  elif [ "$1" != link ] && [ "$1" != dir ] && [ -f "$path" ] && [ ! -L "$path" ] \
    && [ "$(shasum -a 256 < "$path")" = "$added" ]; then
    rm "$path" "$record"
  else
    echo "Kept, changed since adoption: $path" >&2
    kept=1
  fi
}
release link
release desktop
release targets
release dir
if [ "$kept" = 0 ]; then
  rmdir "$state" && echo "remote-dev adoption removed."
else
  echo "Review the kept paths, then run this again." >&2; exit 1
fi
)
```

### Place the guide in the pilot

This writes into the container, so it needs its own approval. In a terminal of
the pilot VS Code window (it runs inside the container), run `cd /workspace`,
then the block below. It needs a dotfiles checkout at `/workspace/dotfiles` that
contains this package. It adds only `/workspace/START-HERE.md` and its record,
`~/.local/state/remote-dev-guide`, inside the container.

```sh
( set -eu
guide=dotfiles/packages/remote-dev/guide/START-HERE.md
record="$HOME/.local/state/remote-dev-guide"
[ -f "$guide" ] || { echo "Missing source, nothing placed: $guide" >&2; exit 1; }
for p in START-HERE.md "$record"; do
  if [ -e "$p" ] || [ -L "$p" ]; then echo "Occupied, nothing placed: $p" >&2; exit 1; fi
done
set -C
mkdir -p "$HOME/.local/state"
printf '%s\n%s\n' "$PWD/START-HERE.md" "$(sha256sum < "$guide")" > "$record"
cat "$guide" > START-HERE.md
echo "Guide placed. Record: $record"
)
```

### Remove the guide from the pilot

Run in a terminal of the pilot window, from any folder:

```sh
( record="$HOME/.local/state/remote-dev-guide"
[ -f "$record" ] || { echo "No guide record; nothing removed." >&2; exit 1; }
path="$(sed -n 1p "$record")"
if [ ! -e "$path" ] && [ ! -L "$path" ]; then
  rm "$record"
elif [ -f "$path" ] && [ ! -L "$path" ] && [ "$(sha256sum < "$path")" = "$(sed -n 2p "$record")" ]; then
  rm "$path" "$record" && echo "Guide removed."
else
  echo "Kept, changed since placement: $path" >&2; exit 1
fi
)
```

The isolated editor directories and pilot container are not owned by this
package. Guide updates to an existing pilot must compare the current bytes,
save a scoped backup and update the guide record. Do not rerun the absent-only
placement block over an existing guide. The native image, HOME, credentials and
task state are outside guide rollback.

## Source and local activation

Dotfiles owns `packages/remote-dev/`. The Mac's `~/.local/bin/remote-dev` link
selects the installed checkout. Keep a selected worktree until that link moves
to its reviewed replacement. The desktop entry resolves through the same link.
Machine-specific target configuration stays in `~/.config/remote-dev/targets.json`.
Changing a source file alone does not update another installed checkout.

## Tests

```sh
bun run test       # public-process tests with fake ssh, code, fzf and opener
bun run typecheck
```

The tests launch the real CLI, the chooser on a real pseudo-terminal, and the
desktop script. External tools are faked through the targets file. The
adoption, rollback and guide blocks above are run as written with `/bin/sh`
against throwaway folders.

They do not prove any of these:

- a real SSH or OrbStack connection
- a real VS Code window
- macOS Terminal behaviour
- real fzf rendering
- that the board is available
- reconnection
- adoption on the real Mac, or guide placement in the real pilot

### Proposed credential startup integration

Source candidate only. The installed launcher and running pilot are unchanged.
A target's existing `restore` object may opt into `credentialJobs` with an
absolute `manifest` path and its exact `sha256`. Keep that manifest, native
job definitions and credential-owner coordinates in private runtime state.
Never put tokens or machine-specific authentication stores in the configuration.

`start` validates the profile before restoring credentials. After the existing
Core, Tailscale and Shepherdr readiness checks, it uses two on-demand per-user
macOS launchd jobs: the existing native Git cache command and the existing
pinned deployment CLI's `credential serve` command. It then requires native
cache custody, two event listeners and a completed, current cache lease before
opening VS Code. `open` remains connection-only; closing VS Code stops neither
job. No task, agent, sign-in or provider selection is performed by startup.

The exact profile binds the container, transport, source revision and input-file
hashes. Healthy recorded jobs are reused without a restart. Unknown, substituted
or stopped registered jobs are refused for operator inspection. There is no
KeepAlive policy, credential-write retry or automatic orphan adoption. The
helper uses documented legacy `launchctl list` columns and `kickstart -p` PID
output; it does not parse the unsupported `launchctl print` format.

The credential jobs require the selected Mac GUI login. They do not provide a
logged-out or cloud-host process owner. The agent image remains independent of
this Mac-specific startup adapter. Git's empty-cache grace period is a native
30-second startup constraint. One monotonic deadline starts before cache
`kickstart`; native calls use its remaining time, and late readiness is refused.
The deadline is never reset for delivery startup. This does not change the approved 900-second lease
or 600-second refill policy.

Before a new owner starts, the hash-bound private manifest must additionally
contain `priorOutcomes`. Existing manifests without it fail closed at startup;
this source change does not modify a prepared or live manifest. Its fields are:

- `decision: "reviewed-new-owner"`: an explicit proposed operator admission,
  requiring approval before activation, not an automatically generated verdict.
- `result: {path, sha256}`: the retained deployment `credential serve` result
  envelope. It must report a complete inventory, no uncertain effects, and a
  completed or unchanged transaction. A known failed session needs this exact
  reviewed admission; an unknown result cannot be acknowledged into success.
- `states: [{path, files: [{name, sha256}]}]`: exact nonsecret inventories of
  all three configured credential state directories. Added, changed, missing,
  unowned or nonprivate files refuse admission. The pinned deployment source's
  `pendingJournalIntent` reader rejects pending writes; any retained journal
  lock also requires inspection. This adapter does not resolve journals.
- `logs: [{path, sha256}]`: the exact delivery stdout/stderr and this adapter's
  `restore-result.json`. Use `null` only for independently verified absence.
  Operator review must correlate the retained result with those logs and
  journal snapshots. Hash matching alone does not establish their meaning.

Healthy recorded owners are reused without a frozen journal inventory, but the
pinned reader rechecks current pending intents and locks before accepting reuse.
New failed/unknown delivery results or changed nonempty stderr require review.
A failed or unfinished startup record still requires review even when both PIDs
remain alive. Each registration/start intent is persisted before its native call,
then advanced to confirmed after the reply and required identity checks. The
private `restore-result.json` and public CLI result preserve separate completed
and uncertain per-job effects. Neither is permission to retry or clean up blindly.
A missing or malformed native effect inventory stays unknown, not complete.

Activation requires review and approval of the exact source, private manifest
and two property lists. Rollback removes only the added `credentialJobs` leaf
and boots out those verified jobs, delivery first, after inspecting pending
writes. Inspect the dedicated remote Git daemon separately before its native
exit; SSH termination alone does not prove it stopped. Retain journals, logs,
profiles and authentication. Do not restore stale credentials or stop the pilot.

Source process tests cover argument binding, editor gating and refusal behavior.
They do not prove launchd activation, credential custody in that process context,
provider authentication, cold-start recovery or the full engineering workflow.
