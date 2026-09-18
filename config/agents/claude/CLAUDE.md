@~/code/dotfiles/config/agents/global.md

If the import above is missing or unreadable, stop and report
`$HOME/code/dotfiles/config/agents/global.md`.


For Herdr-managed operations, follow the Herdr skill. As an explicit exception
for a user-authorized local or remote supervision run outside a Herdr-managed
pane, use the owner-provided `--session <name>` and an explicit pane or agent
target. The explicit session selects the Herdr socket; do not change
`HERDR_ENV`, use focus, or omit the target for this route. If the session is
known but the target is missing, use read-only `herdr --session <name> agent
list` or `pane list` to resolve it. Use the resolved Herdr agent name or pane
ID for CLI attach, never an opaque MCP worker ID; use
`herdr --remote <host> --session <name>` for the full remote UI. Ask only when
the intended session or target cannot be resolved.
