# Herdr control

For Codex Desktop or Claude Desktop portal/coordinator routes, invoke the
third-party Herdr skill even when the request does not mention Herdr, and permit
direct Herdr CLI control outside `HERDR_ENV=1`. This owned instruction overrides
only that skill's explicit-mention trigger and `HERDR_ENV` refusal on those
routes. Keep its remaining guidance and reviewed payload intact; use installed
CLI help for current syntax.

## Portal and workflow

- Follow the global vault entry. In that vault, read `CONTEXT.md` for vocabulary,
  `docs/agents/workflow-governance.md` for scope and completion, and
  `projects/engineering-workflow/cast.md` for coordination and execution owners.
- Treat Codex Desktop and Claude Desktop as lightweight communication
  portals to the selected Stage Manager. Relay requests and fresh replies;
  keep coordination with that owner. The Stage Manager coordinates visible,
  bounded Cast Members in Herdr for exploration and execution. A missing
  destination requires discovery or one target question; Desktop does not
  silently become the coordinator.
- Prefer low reasoning for portal communication when the selected Harness
  supports it. Verify actual session settings before reporting them; do not
  change models or infer the Stage Manager's model from the portal's setting.
- Keep computer-use capability available in Codex and in equipped agents
  inside Herdr. Verify the selected agent's actual tools and host permissions;
  a Herdr pane alone does not supply computer-use access. Capability does not
  transfer workflow ownership. Computer-use implementation remains OPEN.
- Follow the global browser and Google routes for those operations. Portal
  routing does not change their owners.

## Find a coordinator

- Route requests to talk to, ask, or check a project coordinator through live
  Herdr discovery, including from a blank Desktop task. Discover running sessions
  and tab labels first; use Codex history only when explicitly requested or when
  live discovery cannot locate the target and history is needed for recovery.
- Match approximate project/tab names against live labels. Accept a unique short
  name or first word, such as "ADHD" for "ADHD Development Workflow". If multiple
  destinations fit, ask one short question before sending.
- Resolve the coordinator within the matched tab using agent identity and recent
  output. The top-left pane is the expected coordinator location, not proof of
  ownership; distinguish it from helpers before sending.
- Retain the selected host, session, tab, pane and agent identity for follow-up
  requests. Revalidate the selected agent directly before effects. Repeat full
  discovery only when selection is absent, invalid, moved, replaced or ambiguous.
- Keep a fresh question tied to its fresh answer. Read a baseline before sending;
  verify acknowledgement and a response to that question after submission. A
  matching echoed prompt, queued input, old result or settled earlier turn does
  not complete the request. Use bounded agent waits and inspect new output rather
  than repeatedly searching for text already present.

## Resolve the caller and destination

- Inside Herdr (`HERDR_ENV=1`): use inherited session and pane context for
  caller-relative work. Resolve another machine explicitly.
- Outside Herdr: discover running sessions with `herdr session list`; select the
  intended session explicitly with `--session`. Discover its workspaces, tabs,
  panes and agents before effects. Do not set `HERDR_ENV=1` to impersonate a pane.
- For owner-provided external supervision, retain the exact `--session` and
  an explicit pane ID or live agent name. The session selects the socket.
  Resolve a missing target with `herdr --session <name> agent list` or
  `herdr --session <name> pane list`. Do not change `HERDR_ENV`, use focus, or
  omit the target on this route. Ask only when the intended session or target
  cannot be resolved.
- Use a resolved Herdr agent name or pane ID for `agent attach`, never an
  opaque MCP worker ID. Use `herdr --remote <host> --session <name>` for the
  full remote UI. Verify remote API transport and syntax separately before use;
  a UI attachment does not qualify API access.
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
- Preserve focus on the external supervision route above. On other routes,
  preserve focus for background work; focus the destination when Nathan asks to
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
