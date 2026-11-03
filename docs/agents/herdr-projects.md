# Herdr Projects coordination

Use the installed `herdr-projects` skill and its full CLI path. Current CLI
help owns syntax; `details` and `show` own task state and effective settings.
Read app-generated coordinator or task rules supplied to this session.

## Delivery and improvement

For sustained coordination, dispatch, delivery handbacks and recovery, apply the
[shared coordination policy](../../config/agents/plugins/my-second-brain-playground/skills/stage-manager/references/delivery.md).
It owns bounded delegation, evidence pointers, durable learning and the strategic
question about improving the next task. App-generated role and authority rules
remain in force.

## New-machine defaults

Configuration setup (`./setup.sh symlinks` or full setup) installs
[the portable coordinator pointer](../../config/herdr/coordinator-instructions.txt)
into the user-level `coordinator.instructions`. It adds to existing instructions;
project additions and other settings stay intact. Herdr's `HERDR_PROJECTS_HOME`
and `HERDR_PROJECTS_CONFIG_DIR` overrides select the settings location. All existing and future
coordinators inherit it, even when Herdr Projects is installed after setup.
`verify_install.sh` checks the default. Fresh chats load it at startup; ask a
running coordinator to read the policy without restarting active work.

## Desktop conversations

For typed or spoken requests to a named project coordinator, use
[Talk to Stage Manager](../../config/agents/plugins/my-second-brain-playground/skills/talk-to-stage-manager/SKILL.md).
Bind one verified host, session socket and project key. Use native coordinator
messaging and its request receipt, then correlate a fresh answer; queue acceptance
alone is not completion. The skill owns voice and typed parity, interruption
recovery, bounded reply checks and requested same-chat monitoring. Create a
separate watcher only when Nathan requests one. Keep worker execution with the
selected coordinator and qualify source, installation and activation separately.

## Distributed work

- Place new work in the named project session Nathan selected on its execution
  host. Qualify that session and its board route before dispatch; hold new work
  while either is unavailable. Keep existing tasks, reviewers and coordinator
  conversations in their original sessions through handback. A Herdr pane move
  stays within one session, and Projects binds task actions and coordinator
  state to the original socket. Use that owning session for live task actions;
  redelegation and archive/restore are not session-transfer routes.
- Ovis and its Projects front door each select one local Herdr socket. Boards
  can list host-wide tasks, but that list does not qualify Open, Talk or Retry
  for a task linked to another session. Verify those actions in the task's
  owning session before relying on them in Ovis.
- Use the Mini as the coordination host and preferred execution host. Keep the
  laptop available for explicitly assigned work. Resolve host addresses and
  session sockets from local configuration, not shared instructions.
- Start new projects through the existing main Coordinator. It routes project
  setup and cross-machine dispatch; one project coordinator owns delivery,
  acceptance and integration. Reuse these owners before creating another.
- Before dispatch, bind the execution host, session, task and checkout. Follow
  [model selection](model-selection.md) for provider and account qualification
  on that host. A remote-control connection supplies neither files nor login.
- Keep one native execution task on the machine doing the work and retain its
  machine-qualified ID. Follow [Tasks and settings](#tasks-and-settings) for
  existing direct-worker ownership.
- Keep worktrees and conversations on their execution host. Transfer committed
  code through the repository's Git remote and explicit fetch/integration
  checks. Deploy reviewed shared instructions through the existing setup;
  preserve host overrides and dirty work.
- Verify remote discovery, control and an accepted handback before relying on
  a route. Inspect the installed completion mechanism; dispatch alone does not
  establish callbacks. Use a cross-machine dependency for a real dependent
  task, or inspect the existing remote task through completion.
- After an interruption, inspect the same task and worker before retrying.
  Close finished execution spaces separately from task archive or worktree
  removal, using the preservation rules below.

## Tasks and settings

- Keep work in its owning project. Reuse an existing task for the same scope;
  add or delegate work only within Nathan's request and the selected role.
- For new tasks admitted to the contract, put five short fields first in the
  native task description; omit inapplicable fields:
  - Outcome: deliverable and done condition.
  - Scope: owned paths and exclusions.
  - Held decisions: missing facts and the claims they block.
  - Proof: the existing check or independent review owner for each claim.
  - Stop: authorized completion and approval boundary.
- Link source revisions, accepted decisions and earlier plans/verdicts through
  existing history. Keep superseded text outside the current contract.
- Choose proportionate existing checks before implementation. Prove any missing
  check rejects corrupted real input through its actual validator.
- Google Cloud: use only existing authorised non-interactive routes, such as
  CI service accounts or retained artifacts; a route is unproven until an
  actual read succeeds. Nathan has no interactive Google Cloud access, so
  sign-in, reauthentication, console or consent requests are a dead end:
  record the missing mechanism with its owner instead.
- Keep models, review, attempts, limits and merge choices in supported settings.
  Read back effective values and provenance before dispatch.
- Verify the workflow enforces the Stop boundary. Review PASS grants no
  external-write authority.
- On resume of a task using the contract, reconcile source and check/review
  state with it. Preserve existing task descriptions and retained history. Carry
  accepted decisions forward; route engineering waits to their owner and release
  condition. Ask only for needed decisions, authority or authentication.
- For native delegated tasks, let the board own its workers, worktrees, checks
  and reviews. Inspect its state before intervening through Herdr, Git or the
  forge. Verify the supported lifecycle fits the task's source, path and
  authority requirements before delegation. Global authority still governs
  external writes and approvals.
- For coordinator-managed direct workers, record the assignment and handback
  on the owning task and follow [terminal checkout ownership](herdr-terminal.md#coordinator-managed-worktrees).
  A tracking row does not attach a worker or supply the board's native check,
  review or completion lifecycle. Keep execution with the coordinator unless
  a supported adoption route is verified for the installed version.
- When organising the board, use project grouping with the selected project
  expanded and unrelated projects folded in the view Nathan uses. Verify the
  displayed result; terminal labels do not establish native task ownership.
- Let Projects own native task labels. For direct workers, keep workspace and
  tab names readable and assignment-specific, using their recorded identities.
  Preserve live locations and sessions when changing presentation.
- When adding or delegating an authorized board task whose only output is a
  report, use the documented research-only route. Keep its result in the
  task's report folder, not the product repository.
- Treat generated instructions and installed skills as app-owned. Change
  supported configuration or its named source, not generated copies.

## Complete without accumulating spaces

- Verify the scoped handback and actual outcome before marking completion.
  Record any unfinished scope and its successor; leave unfinished work open.
- Let supported automatic cleanup run. Check task details, effective settings
  and fresh pane state when a space remains. `workspace.cleanup = true` does
  not prove that setting applies to this task or that cleanup succeeded.
- Preserve reused spaces, active or paused agents, running commands, dirty
  buffers, recovery files, worktrees, unmerged branches and native custody. A
  retained space is not permission to close it forcibly.
- Investigate a stalled finish helper before any intervention. Identify its
  exact task, process, parent and outcome; act only within existing authority
  and preserve unrelated processes. Otherwise report the specific blocker.
- Archive evidence-complete tasks when tidying an authorized project list;
  keep their reports and history. Verify space cleanup separately: archiving
  a row and closing its live pane are distinct effects. Use removal only on
  Nathan's explicit request.
- Send follow-up implementation to its current owner instead of reopening a
  completed worker for routine coordination. Reopen a completed task when
  Nathan actually requests further work there; inspect the resulting state.

## Product references

Use installed behavior for local decisions. Public documentation may describe
features newer than the running version.

- [Task lifecycle and cleanup](https://github.com/eliasstravik/herdr-projects/blob/main/docs/how-work-gets-done.md)
- [Settings and applicability](https://github.com/eliasstravik/herdr-projects/blob/main/docs/settings.md)
- [Sidebar and archived live panes](https://github.com/eliasstravik/herdr-projects/blob/main/docs/sidebar.md)
- [Cross-machine tasks](https://github.com/eliasstravik/herdr-projects/blob/main/docs/other-machines.md)
- [Remote completion monitoring](https://github.com/eliasstravik/herdr-projects/blob/main/docs/autopilot.md#other-machines)
