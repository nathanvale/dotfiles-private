# Skills

## Owners

| Skill | Owner | Everyday action |
| --- | --- | --- |
| Personal | `config/agents/plugins/personal/` | Edit the plugin source and refresh the native plugin. |
| Matt Pocock | `npx skills` | Use its global add, list, update, and remove commands. |
| Other reviewed third-party | `config/agents/skills/third-party/` | Follow [third-party skills](third-party-skills.md). |
| Project-only | Owning project | Keep discovery within that project. |
| Codex-installed or another plugin | That Harness or plugin | Use its native management route. |

The personal plugin replaces the transitional personal skill directory.
Its native manifests select enabled skills. Claude reads explicit directories;
Codex reads `library/`. `optional/fix-microphone/` remains available to Claude
and excluded from Codex. Keep disabled and absent skills out of that Harness's
manifest selection. Claude's `skillOverrides` does not apply to plugin skills.

## Personal work

- Use `writing-for-agents` for skill content and review.
- Use the My Second Brain Playground `cli-design` skill for CLI and runtime changes.
- Edit sources in the task worktree, including both native manifests when selection changes.
- Build executable payloads with `bun run personal:build`. Keep authored sources and tests;
  run packaged commands relative to the loaded skill directory.
- Bump the personal version in both manifests and both marketplace catalogs together.
- Validate with `claude plugin validate config/agents/plugins/personal --strict --json`.
- Test copied payloads outside the repository before claiming packaged runtime behavior.

Claude development uses `claude --plugin-dir <candidate-plugin>` and
`/reload-plugins`. Codex development uses a native development marketplace
whose registered root resolves to the candidate worktree, followed by a fresh
chat. Read the installed CLI help before registering or installing a candidate.
A source edit or successful build alone does not prove installation or activation.

Installed personal refresh:

```sh
claude plugin marketplace update personal
claude plugin update personal@personal --scope user
codex plugin add personal@personal --json
```

Confirm the marketplace points to the intended source before refreshing.
Keep production promotion separate from candidate testing.
Other plugins retain their own native install and release routes.

## Checks and cutover

Use [the personal plugin README](../../config/agents/plugins/personal/README.md)
for the one-time source and installed-address cutover. Preserve old live links
until the replacement plugin works. Remove only links whose stored and resolved
targets identify the old personal source.

`bin/agent-skills-inventory --json` checks the remaining reviewed vendors,
project addresses, and obsolete links. Personal enablement belongs to the
native manifests; Matt installation belongs to the installer lock.

Capture protected Harness state immediately before and after a migration or
canary. Compare those operation snapshots. Cache counts and hashes are not
permanent repository acceptance criteria. Preserve unrelated Codex content,
plugins, settings, and credentials. Report pre-existing drift separately from
changes introduced by the operation.

Startup Instructions remain direct Tracking Links from `~/.codex/AGENTS.md`
and `~/.claude/CLAUDE.md` to their existing dotfiles sources.

The replacement structure is proposed in
[ADR-0013](../adr/0013-native-personal-and-matt-skills.md).
