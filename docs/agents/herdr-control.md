# Herdr control

Nathan permits direct Herdr CLI control from external apps, including Codex
Desktop. This owned instruction overrides only the third-party Herdr skill's
blanket refusal outside `HERDR_ENV=1`. Keep its remaining guidance and reviewed
payload intact; use installed CLI help for current syntax.

## Resolve the caller and destination

- Inside Herdr (`HERDR_ENV=1`): use inherited session and pane context for
  caller-relative work. Resolve another machine explicitly.
- Outside Herdr: discover running sessions with `herdr session list`; select the
  intended session explicitly with `--session`. Discover its workspaces, tabs,
  panes and agents before effects. Do not set `HERDR_ENV=1` to impersonate a pane.
- Resolve the destination as machine, Herdr session, workspace, tab and pane or
  agent. Use only the levels required by the operation. IDs are session-local;
  rediscover them after moving a pane or switching servers.
- Resolve once per operation; retain the host, session, target ID and observed
  agent identity through submission and verification. Local CLI and SSH are
  transport adapters for the same Herdr interface. Revalidate identity before
  effects; a pane may now contain a different agent.
- Match user intent against labels, native session identity and recent output.
  Ask one target question if ambiguous. UI focus alone does not identify a target.
- Remote control: read saved machine profiles, then execute the CLI on the
  selected SSH host with its explicit Herdr session. Selecting a machine in the
  UI does not retarget this process. Verify remote reachability and CLI syntax;
  never silently substitute local execution.

## Act through existing owners

- Use the agent surface for prompts, identity, reads and waits; the pane surface
  for ordinary commands and layout. Read command-group help before unfamiliar work.
- Create requested tabs or workspaces with explicit parent and cwd. Use returned
  pane IDs to start an agent. A tab does not itself start a coordinator.
- Preserve focus for background work; focus the destination when Nathan asks to
  open or switch to it. Preserve the coordinator pane during worker changes.
- Treat machine add, enable, disable and remove as requested configuration
  changes. Inspect setup consequences; installing or replacing a remote server
  differs from selecting an existing machine. Removing a profile does not stop
  its remote agents.
- Keep worktree creation and retirement under the existing WorkTree policy;
  CLI availability does not authorize deleting a checkout or closing other work.
- Use Foundry for its supported provider, model and account routes. Herdr agent
  kinds advertise launch syntax, not verified model access or subscription health.
- Keep transport selection separate from provider selection. External Herdr CLI
  access does not prove a caller-relative Foundry launcher works externally.
  Verify that launcher's caller requirements; use its supported in-pane route
  when required. Preserve selected host, model and account through the handoff.
- Distinguish agent execution host from model inference host. A laptop agent
  using a Mini model reads laptop files; an agent running on the Mini needs an
  explicitly available remote checkout or path. Path mapping does not sync files.

## Verify the effect

- Recheck the selected agent before sending. Preserve a blocked approval or
  question for Nathan; do not answer it as a transport retry.
- A successful prompt submission proves delivery to the terminal, not receipt,
  turn completion or accepted work. Read the target's acknowledgement or result.
- After a timeout or uncertain submission, inspect the same target before retrying
  to avoid duplicate work. A wait on a busy agent may observe its earlier turn.
- Treat missing output as unknown. Follow the skill's file-handback fallback when
  terminal history cannot recover the result.
- Report unavailable routes with their actual failure. MCP is optional; neither
  a broken bridge nor missing caller context proves the direct CLI is unavailable.
- Qualify each operation through its public interface. Local list, read and prompt
  evidence does not qualify remote launch, tab creation, focus or cleanup. Verify
  returned destination IDs and the requested effect when exercising those routes.
