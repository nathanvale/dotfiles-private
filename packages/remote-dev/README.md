# remote-dev

One way back to remote development from the viewing Mac:

- **Remote Development** desktop item for the existing pilot.
- **`remote-dev`** terminal chooser and commands for every configured target.

Both use one rechecking launch policy. Nothing here creates, starts, restarts,
rebuilds, replaces, stops, removes or prunes containers or services.

## Commands

```text
remote-dev                    interactive chooser (terminal only)
remote-dev list [--all]       configured targets; --all adds unclassified containers
remote-dev open TARGET        recheck, then open the isolated VS Code environment
remote-dev logs TARGET        recheck, then print the native service log tail (redacted)
remote-dev board TARGET       recheck, then open the configured task board
remote-dev --help | --discover --json | --discover-command ID --json
```

Add `--json` for one Contract Core 2.0 envelope on stdout. Without a terminal,
the chooser refuses at once (exit 2) instead of waiting for keyboard input.

In the chooser, type to filter, use the arrow keys, press Enter to choose and
Escape to cancel. Ctrl-A switches between known targets and all containers.

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
Board URLs must be `https` with no credentials, query or fragment; add the
pilot's private board URL only in your local copy.

## Adoption (not yet done)

None of this has been run. Each block needs its own approval and is run by
hand; this package performs none of it.

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

The isolated editor directories, the pilot container and its existing
`README.md` are not owned by this package. Leave them alone.

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
