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

Each step needs separate approval. None is performed by this package.

1. Copy `examples/targets.json` to `~/.config/remote-dev/targets.json`, then
   add the board URL locally.
2. Link the CLI. `ln -s` refuses if anything already exists there. Record the
   exact link target for rollback:
   `ln -s "$HOME/code/dotfiles/packages/remote-dev/bin/remote-dev" "$HOME/.local/bin/remote-dev" && readlink "$HOME/.local/bin/remote-dev" > ~/.local/state/remote-dev-adoption.link`.
3. Copy `desktop/Remote Development.command` to `~/Desktop/`, keeping it executable.
4. Place `guide/START-HERE.md` at `/workspace/START-HERE.md` in the pilot.
   This writes into the container, so it needs its own approval.
5. Record a checksum of each added file for rollback:
   `shasum -a 256 ~/.config/remote-dev/targets.json "$HOME/Desktop/Remote Development.command" > ~/.local/state/remote-dev-adoption.sha256`.

## Rollback

Remove only the additions above, and only if they are unchanged since adoption:

```sh
state="$HOME/.local/state"
if shasum -a 256 -c "$state/remote-dev-adoption.sha256"; then
  rm ~/.config/remote-dev/targets.json "$HOME/Desktop/Remote Development.command" \
    && rm "$state/remote-dev-adoption.sha256"
else
  echo "A remote-dev file changed since adoption; left untouched." >&2
fi
link="$HOME/.local/bin/remote-dev"
if [ -L "$link" ] && [ -f "$state/remote-dev-adoption.link" ] \
  && [ "$(readlink "$link")" = "$(cat "$state/remote-dev-adoption.link")" ]; then
  rm "$link" && rm "$state/remote-dev-adoption.link"
else
  echo "The remote-dev link is absent or now points elsewhere; left untouched." >&2
fi
```

If a check fails, something was changed after adoption: a file was edited, or
the link was removed, replaced or repointed. Stop and review it rather than
deleting it. The isolated editor directories, the pilot container and its
README are not owned by this package. Leave them alone. Restoring
`START-HERE.md` in the pilot needs its own approval.

## Tests

```sh
bun run test       # public-process tests with fake ssh, code, fzf and opener
bun run typecheck
```

The tests launch the real CLI, the chooser on a real pseudo-terminal, and the
desktop script. External tools are faked through the targets file.

They do not prove any of these:

- a real SSH or OrbStack connection
- a real VS Code window
- macOS Terminal behaviour
- real fzf rendering
- that the board is available
- reconnection
