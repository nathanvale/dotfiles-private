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

Run `remote-dev choose` for the fuzzy chooser. Select **pilot**, then select the action
you need. Recent editor requests appear first; the saved target keeps the same
workspace and isolated VS Code settings. Every action still rechecks its target.

- `remote-dev open pilot` connects to the running container without restoration.
- **Start and open VS Code** starts the same stopped container, restores missing
  Core, Tailscale and Shepherdr services, then opens the editor.
- **Restore services and open VS Code** checks the running pilot and restores
  only missing services. Healthy services and terminals are left alone.
- Run `remote-dev start pilot` directly for the same startup and restore flow.
- `remote-dev open pilot` and the desktop item connect only when it is running.

Startup preserves the container's existing HOME, workspace and authentication
mounts. It does not create a container or sign you in. A changed container ID is
refused. If startup succeeds but VS Code fails, the container stays running.
Inspect `remote-dev list` before retrying an uncertain result.

## Leave services under their existing owner

Closing VS Code leaves the container and its services running. Reopening the
editor does not restart services or agents.

Docker starts this container with `sleep infinity`. `remote-dev start pilot`
then restores Core, Tailscale and Shepherdr through the configured native route.
It reuses the saved Tailscale login, Shepherdr token and existing auth owner.
It does not copy credentials or ask you to sign in to a new container.

Agents, tasks and the native browser stay held. Jobs remains off. A stopped
container cannot preserve live terminal processes. Core retains its native task
and terminal state and recovers kept shells without resuming an agent.

If retained auth or state is missing, the command stops before opening VS Code.
Inspect the reported cause. Never start a new task or sign in to another profile
to repair an editor connection.

If VS Code asks to rebuild, replace, install or sign in, stop at that prompt.
Those actions are outside the start-and-open command. Existing publication,
merge, migration, task and browser-permission holds remain unchanged.
