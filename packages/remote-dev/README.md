# remote-dev

One way back to remote development from the viewing Mac:

- **Remote Development** desktop item for the existing pilot.
- **`remote-dev`** terminal chooser and commands for every configured target.

Both use one rechecking editor policy. The explicit `start` action can start an
existing, opted-in container before opening VS Code. No command creates, pulls,
rebuilds, replaces, restarts, stops or removes containers.

## Commands

```text
remote-dev                    interactive chooser (terminal only)
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
