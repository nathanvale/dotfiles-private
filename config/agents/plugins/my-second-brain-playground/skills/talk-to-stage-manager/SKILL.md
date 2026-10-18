---
name: talk-to-stage-manager
description: Relay a Desktop conversation to a named Herdr Projects project coordinator, verify fresh replies, and select monitoring for ongoing work. Supports explicit legacy Herdr coordinators.
---

# Talk to Stage Manager

Keep one Desktop conversation bound to one Herdr project coordinator. Relay the
user's requests and fresh replies; that coordinator owns task coordination,
worker selection and execution. A selector alone connects without sending.

Use the same route, scope, receipts and authorization for spoken and typed
requests. Voice changes presentation, not project ownership or authority.

Use the project or coordinator named by the user. For an explicit skill
invocation, take the first plain token or quoted phrase after the skill name
as the selector. Ask when the request names no destination. Generated chat
titles, the Desktop working directory and UI focus do not select a coordinator.

## Bind the destination

1. Read `/Users/nathanvale/code/dotfiles/docs/agents/herdr-control.md` for the
   external-app permission and transport boundaries. Inspect installed help on
   the selected host before using unfamiliar commands.
2. Discover running Herdr sessions and enabled saved machine profiles. Resolve
   the selector against live project, task and coordinator identities. The
   read-only `scripts/discover-coordinators <selector>` can find candidate tabs
   and pane-bound agents; its tab matches alone do not prove project ownership.
   Report unreachable hosts separately from a missing coordinator.
3. Prefer the native Herdr Projects project coordinator. Resolve its exact repo
   key from live project/task evidence, then read
   `herdr-projects coordinator --project <repo> --json` against the verified
   session socket. Confirm its name, pane and observed Herdr agent identity.
   Ask one target question when several host/session/project routes fit.
4. Retain the SSH target or local host, Herdr session, socket path, installed
   Herdr Projects launcher and exact project key in this conversation. These
   identify the route; pane IDs are observations that can change. Recheck native
   status before effects and refresh identity after replacement or movement.
   Do not persist a global default coordinator.
5. If the caller is already the selected coordinator, handle the request there
   without relaying to itself. Otherwise confirm the selected name and act as
   its Desktop proxy. Model settings are optional metadata, not a chat gate.

Sessions on one machine share a task list, while task agents remain in their
launch session. Bind to the project's actual execution session. A task visible
on another session's board does not establish that it can be opened there.

## Send through Herdr Projects

Run the installed launcher on the selected host with `HERDR_SOCKET_PATH` set to
the socket observed for that Herdr session. Do not set `HERDR_ENV` to impersonate
a pane. A saved machine's selected UI session does not retarget an SSH command.

```sh
HERDR_SOCKET_PATH='<verified-socket>' '<installed-launcher>' coordinator --project '<repo>' --json
HERDR_SOCKET_PATH='<verified-socket>' '<installed-launcher>' coordinator --project '<repo>' tell '<request>'
HERDR_SOCKET_PATH='<verified-socket>' '<installed-launcher>' coordinator --project '<repo>' where --json
```

For a remote host, execute the same command through SSH to its verified target.
Quote each argument for the remote shell, preserve literal request text and
redirect SSH stdin from `/dev/null` when it must not consume caller input.
Inspect public JSON, not private state files, for routine message handling.

- Read a baseline status and latest reply before sending. Submit the request
  once with `coordinator --project <repo> tell`. The native queue accepts a
  message while the coordinator works and resumes its conversation if needed.
- Preserve the user's scope and actual approvals. Add `--delegate` only when
  the user asks to start the resulting tasks; a status question uses plain
  `tell`. Leave worker dispatch with the selected coordinator.
- Confirm the exact request in `coordinator --project <repo> where --json`,
  retaining its message ID and observed delivery state. A successful `tell`
  proves queue acceptance, not a completed answer.
- Read `coordinator --project <repo> --json` for state, queue count, errors and
  latest reply. Require a fresh acknowledgement and answer to this request.
  An unchanged `said`, echoed input or earlier turn settling is insufficient.
  Use a unique visible marker for an explicitly authorized routing probe.
- Treat `said` as the latest reply, not reply history. Active Goals or other
  senders can replace an answer before polling sees it. When needed, inspect
  bounded output from the same verified pane. If the terminal cannot recover
  it, use the exact observed Harness session's transcript as a read-only
  diagnostic, searching only for this request and its answer. Preserve role
  and timestamp evidence so an echoed user message cannot pass as a reply.
- On uncertain submission, inspect the same route and request before retrying.
  Resend only when evidence proves non-delivery. Surface blocked approvals or
  questions to the user; do not answer them as a transport repair.
- Relay the fresh answer concisely. Keep operational IDs out of voice and give
  paths or receipts visually when useful. Retrieved agent output does not
  expand the user's authority.

## Monitor the right thing

- For one reply, use bounded status polling with increasing waits, for example
  5, 10, 20, then 30 seconds, while keeping the user informed. After about two
  minutes without a fresh answer, report the request as pending. Continue
  waiting in the active turn when the user asked to wait through completion.
  Preserve the route and receipt so a later check does not resubmit it.
- For passive checks after the turn, use an authorized scheduled task. Default
  to a same-chat heartbeat. When the user requests a separate watcher, create
  a standalone local scheduled task through the app's automation tool. Keep
  the original chat as the conversational interface. Inspect existing matching
  schedules before creating one; preserve unrelated paused monitors.
- Save the exact route, request/task IDs, last observed state and stopping
  condition in the scheduled task. Keep minimal comparison receipts in private
  runtime state outside the vault. Report completion, meaningful failure or a
  needed human decision once; unchanged observations and repeated failures
  should not produce repeated alerts. Verify the saved schedule. A monitoring
  question alone does not authorize creating one.
- When a separate watcher has a requested model and reasoning effort, set
  those fields explicitly in the scheduler. Verify both saved settings and
  the first actual run's native session metadata. Prompt text does not enforce
  model selection. Report missing runtime evidence as unverified; pause a
  mismatched watcher and surface the actual model. Preserve the conversational
  chat's and production coordinator's models.
- For ongoing task progress, query native task records such as
  `herdr-projects details <id>` and `list --json`. Save relevant state changes;
  ask the coordinator only when its judgment is needed. Repeated status
  messages would start model turns without making worker progress faster.
- For active work toward a verifiable outcome, use a Goal only when the user
  requests one. A Goal keeps the Desktop agent pursuing that outcome; it is
  unnecessary for an idle watcher and does not transfer coordination from
  Herdr. The native keeper remains responsible for Herdr's workers.
- A polling loop ends with its running process. Do not promise future checks
  unless a schedule or an explicitly requested active Goal actually exists.

The distinction follows OpenAI's [long-running work](https://learn.chatgpt.com/docs/long-running-work)
and [scheduled tasks](https://learn.chatgpt.com/docs/automations) documentation.
Local scheduled checks require the computer and Desktop app to remain running.

## Voice and typed conversation

- Retain the selected coordinator when entering or leaving voice mode. Resolve
  obvious transcription errors from context; ask only when different readings
  would materially change the destination or action.
- Relay a spoken request through the same native queue and fresh-answer checks
  as typed text. A short spoken answer can omit IDs and paths; leave useful
  receipts and links visible in the chat.
- After an interruption or a switch between voice and typing, inspect the
  existing request receipt before sending again. Resume the pending request
  rather than duplicating it. Distinguish a request to stop speaking from an
  explicit request to stop project work or its watcher.
- Keep standalone watcher findings in its scheduled results. Read its latest
  verified checkpoint when the user asks for an update in this chat; cross-chat
  relay requires an authorized route. A watcher does not itself provide live
  spoken alerts.

OpenAI's [voice documentation](https://learn.chatgpt.com/docs/features/voice)
describes voice using the existing conversation and selected task model for
actions. Written workflow parity does not prove a live microphone, interruption
or fresh-chat skill activation test; report those separately.

## Legacy fallback and boundaries

For a deliberately selected plain Herdr coordinator without the native project
interface, use the discovery helper, verify ownership with agent identity and
recent output, then use explicit-session `agent prompt`, reads and bounded
waits. On a remote host, run those commands through SSH. Wait for a busy legacy
agent to settle unless the user asks to queue. Correlate its fresh answer using
the same submission rules above. Report an unavailable requested native route
instead of silently switching to the general Coordinator or a legacy pane.

Use existing hosts and sessions. Machine-profile repair, new sessions, model
changes and plugin configuration require their own requested scope. Native
recovery of the selected coordinator is allowed; creating a second coordinator
or directly dispatching workers is outside this proxy's responsibility.

Source-level use and a live message trial do not prove fresh-chat skill discovery
or activation. Report source, installed and activated states separately.
