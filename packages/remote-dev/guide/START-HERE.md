# Start here

You are connected to **agents-pilot** on the Mini's ARM64 OrbStack.

Your Mac displays this editor. Files and integrated terminals in this window run
inside the container, starting at `/workspace`. A plain Remote SSH window runs
on the Mini host instead.

## Open the workspace

- Use **Explorer** to browse files. The dotfiles checkout is `/workspace/dotfiles`.
- Choose **View > Terminal** for a shell inside this container.
- Open [the pilot README](README.md) for versions and retained state locations.
- From the Mac, run `remote-dev board pilot` to open the Shepherdr board.
- From the Mac, run `remote-dev logs pilot` to read the configured service log
  with credentials redacted. Docker stdout is a separate log.
- [Open the native service log](../home/agent/.local/state/pilot-runtime/restore-intake-20261114-01/service.log)
  inside this editor. Reopen it to refresh. This raw log can contain private data.
- Choose **View > Output > Dev Containers** for editor connection logs.

A connected editor does not prove that a repository, service or agent is ready.
Check the native task's actual status before continuing work.

## Return from your Mac

Run `remote-dev` for the fuzzy chooser. Select **pilot**, then select the action
that matches its state.

- **Open VS Code** connects to the running container.
- **Start and open VS Code** starts the same stopped container, then opens it.
  You can also run `remote-dev start pilot` directly.
- `remote-dev open pilot` and the desktop item connect only when it is running.

Startup preserves the container's existing HOME, workspace and authentication
mounts. It does not create a container or sign you in. A changed container ID is
refused. If startup succeeds but VS Code fails, the container stays running.
Inspect `remote-dev list` before retrying an uncertain result.

## Leave services under their existing owner

Closing VS Code leaves the container and its services running. Reopening the
editor does not restart services or agents.

This container's startup command is `sleep infinity`. Starting the container
alone does not restore Core, Shepherdr or task terminals after a container stop.
Use the existing pilot restoration owner for those services. Never start a new
engineering task just to repair an editor connection.

If VS Code asks to rebuild, replace, install or sign in, stop at that prompt.
Those actions are outside the start-and-open command. Existing publication,
merge, migration, task and browser-permission holds remain unchanged.
