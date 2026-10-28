# Herdr routes

For coordinator or worker startup, resume, or model changes in Herdr or Herdr
Projects, read [model selection](model-selection.md) before choosing the route.

Choose the owner for the request before acting:

Use the explicit Stage Manager or Cast route when requested; otherwise route a
named project-coordinator request through Project conversation.

| Request | Read |
| --- | --- |
| Desktop typed or spoken request to a named project coordinator | [Project conversation](herdr-projects.md#desktop-conversations) |
| Herdr Projects board, tasks, coordinators, settings or completion | [Board coordination](herdr-projects.md) |
| Herdr sessions, workspaces, tabs, panes, terminal agents or remote control | [Terminal control](herdr-terminal.md) |
| Explicit Stage Manager or Cast workflow | [Cast coordination](herdr-cast.md) |
| Explicit Beads workflow | [Beads route](beads.md) |

Answer direct questions, research and read-only reviews in the current chat
unless Nathan asks to contact a coordinator. A project name supplies scope;
it does not itself request another worker.
When acting as a board coordinator, follow its app-generated role rules.

Keep an existing task and its coordinator as the work owner. Use terminal
control for supporting inspection or recovery, preserving board ownership.

## Verify effects

- Refresh the selected owner and target before effects.
- Verify a fresh answer or requested result after submission. Terminal delivery
  and settled lifecycle state alone do not prove the requested work completed.
- After an uncertain submission, inspect the same target before retrying.
- Preserve pending approvals and questions for Nathan. Report an unavailable
  route with its actual failure.

Global authority, Git, WorkTree, browser, Google and vault routes still govern
those operations. Herdr transport does not transfer their ownership.

## Updates

- Identify how Herdr is installed before updating it. Use `herdr update` only
  for installs managed by Herdr's installer. Update Homebrew, mise, Nix, or
  another package-managed install through that package manager (for example,
  `brew upgrade herdr` for Homebrew).
- After updating Herdr, check `herdr --version` and `herdr status --json`.
  `herdr update` reports running servers and saved SSH machines still on an old
  version. Update each saved machine on that machine; preserve live sessions
  and review any printed server restart command before using it.
- Update one GitHub plugin with `herdr plugin update <plugin-id>`. A plugin
  installed without `--ref` tracks the repository's default branch; installing
  with `--ref <tag-or-commit>` records a deliberate pin. Plugin updates fetch
  the recorded ref, so updating a pinned plugin does not remove its pin.
- Existing plugin panes and processes keep their original files after an
  update; new invocations use the new installation. Do not restart Herdr just
  to refresh a plugin.
- For Herdr Projects, use `herdr-projects doctor` after a plugin update to
  check the CLI and agent/hook launcher. If it reports a launcher mismatch,
  follow the exact repair command it prints or open the board from the updated
  plugin action once. Do not edit the launcher by hand. `herdr-projects update`
  updates the downloaded CLI release; it does not change the plugin's recorded
  source ref.
