All MCP tools are machine-to-machine interfaces. **ALWAYS pass `response_format: "json"`** — markdown wastes tokens and is only for results shown directly to the user.

- **Git reads** → MCP tools
- **Git writes** → bash or `/git:*` slash commands
- **Search** → Kit plugin
- **History** → Atuin MCP
- **Package execution** → prefer `bunx` over `npx`

## Code quality runners

NEVER run raw `bun test`, `biome`, or `tsc` via Bash.

- **Bun tests** → the `test-runner` skill; Agent Runner compact, repair, triage, detail, and coverage paths come from its `context/bun-runner.md`
- **Biome** → `biome_lintCheck`, `biome_lintFix`, `biome_formatCheck`
- **TypeScript** → `tsc_check`

Exit code `2` is blocking — fix before proceeding. Never retry blindly or wrap in `|| true`.
