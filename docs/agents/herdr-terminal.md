# Herdr terminal control

Use the installed third-party `herdr` skill and current CLI help for terminal
operations. For Desktop portal/coordinator routes, invoke that skill even
without an explicit Herdr mention and permit control outside `HERDR_ENV=1`.
This overrides only its mention trigger and environment refusal; keep its
reviewed payload intact. Board operations use [their own route](herdr-projects.md).

## Resolve and retain the target

- Inside Herdr, use inherited context for caller-relative operations.
- Outside Herdr, discover sessions and select the intended `--session`
  explicitly. Keep the resolved host, session and pane or live agent identity.
  Do not set `HERDR_ENV=1` to impersonate a pane or use another client's focus.
- Find a named coordinator through live session labels, agent identity and
  recent output. Use history for requested lookup or recovery. Ask one target
  question when multiple destinations fit; a top-left pane is not identity.
- Revalidate the selected target before effects. Rediscover when its identity
  is missing, moved, replaced or ambiguous, rather than on every follow-up.
- For remote control, inspect saved profiles and execute on the selected host
  with its explicit session. UI machine selection does not retarget the CLI.
- For owner-provided external supervision, retain the exact session and an
  explicit pane or live agent target, without changing focus. On other routes,
  preserve background focus and switch only when Nathan asks to open it.

## Coordinator-managed worktrees

- For direct workers managed by a coordinator, make Herdr the sole checkout
  creator. Use `worktree create` with explicit `--cwd`, `--base` at the
  admitted commit SHA, and `--path <repo>/.worktrees/<name>`. Reopen a retained
  checkout with `worktree open`, supplying both `--cwd` and `--path`.
- Record Herdr's returned workspace and pane identities, then verify the
  actual checkout path, branch, HEAD and dirty state before worker writes.
  Start or continue the worker in that checkout; do not request subsequent
  Claude worktree isolation for the same assignment. Keep the Claude worktree
  hook for Claude-managed isolation outside this route.
- Keep source admission, repository bootstrap, independent review, evidence,
  finite host-operation grants and publication with their declared owners.
  Checkout creation proves none of those requirements complete. Preserve
  existing assignments and retained candidates through their handback.
- Use [Projects ownership](herdr-projects.md#tasks-and-settings) for native
  delegated tasks and board records of coordinator-managed workers.

## Capability and recovery

Keep execution host, inference provider and transport distinct. A live pane
proves neither provider access, computer-use permissions nor remote file
availability. Verify the capability the next operation actually requires.

For Foundry launches, use the selected provider's installed skill. Verify
its caller requirements and model route before dispatch; external Herdr CLI
access alone does not prove that launcher works.

Use the skill's agent surface for direct terminal supervision and explicit
legacy coordinator messaging; use [native project messaging](herdr-projects.md#desktop-conversations)
for a managed project's Desktop conversation. Use the pane surface for ordinary
commands and layout. Apply [effect verification](herdr-control.md#verify-effects)
after submission. A busy-agent wait can observe an earlier turn.

For missing output, try a bounded recent-history read on a supported idle
agent before requesting the skill's temporary-file handback. Current Herdr
supports alternate-screen history reads; verify installed client/server
support if the skill and public documentation differ. Missing evidence stays
unknown and does not justify repeating the requested operation.

- [Herdr agent automation](https://herdr.dev/docs/agent-automation/)
- [Configuration, worktree groups and sidebar](https://herdr.dev/docs/configuration/)
