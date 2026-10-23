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

## Tasks and settings

- Keep work in its owning project. Reuse an existing task for the same scope;
  add or delegate work only within Nathan's request and the selected role.
- Write short outcome titles and descriptions containing requirements,
  exclusions and acceptance evidence. Keep model, review, attempts, limits and
  merge choices in supported settings rather than operational prose.
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
