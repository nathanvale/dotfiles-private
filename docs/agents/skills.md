# Skills

## Owners

| Skill | Owner | Everyday action |
| --- | --- | --- |
| Personal | `config/agents/plugins/personal/` | Edit the plugin source and refresh the native plugin. |
| Matt Pocock and other standalone third-party skills | `npx skills` | Use its global add, list, update, and remove commands; follow [third-party skills](third-party-skills.md). |
| pstack | Each Harness's native plugin or package manager | Keep the complete upstream package and a qualified Harness adapter; follow the installation rules below. |
| GOG, Herdr, `find-skills` (pending migration to the installer) | `config/agents/skills/third-party/` | Leave as is; [third-party skills](third-party-skills.md) records the pending migration. |
| Project-only | Owning project | Keep discovery within that project. |
| Codex-installed or another plugin | That Harness or plugin | Use its native management route. |

The personal plugin replaces the transitional personal skill directory.
Its native manifests select enabled skills. Claude reads explicit directories;
Codex reads `library/`. `optional/fix-microphone/` remains available to Claude
and excluded from Codex. Keep disabled and absent skills out of that Harness's
manifest selection. Claude's `skillOverrides` does not apply to plugin skills.

## Matt Pocock and pstack installations

- Keep Matt Pocock installer-owned. Preserve the selected skills and each
  Harness's disabled choices; an upstream recommendation does not authorise a
  switch to plugins or installation of the whole collection.
- Keep pstack plugin-owned in Claude Code and Codex. Use Pi's native package
  route for its complete package and adapter. Installing only its skill folders
  loses shared documentation, agent definitions and plugin namespaces.
- Give each package one enabled source per Harness. Keep pstack out of the
  `npx skills` lock. Give Pi its own pinned package source rather than another
  Harness's cache path, so cache removal cannot break Pi.
- Build compatibility packages from a recorded upstream revision with a
  reproducible transformation, an update owner and a rollback source. Change
  their source and reinstall through the native manager; leave installed caches
  under that manager's control.
- Preserve manual invocation when restricting automatic discovery. Codex uses
  `agents/openai.yaml` with `policy.allow_implicit_invocation: false`; Claude's
  `disable-model-invocation` field alone does not provide that Codex policy.
  Check Pi's installed loader rather than assuming either setting applies.
- Qualify a replacement in every affected machine and Harness before removing
  its working source. Check manager ownership, complete package resources, a
  fresh model-visible catalogue, explicit selection and a small read-only
  workflow. Include delegation when that workflow requires it. Report tool and
  model adaptations and untested workflows separately from a passing check.

### Pi package boundaries

- Manage Pi packages with `pi install`, `pi list`, `pi update` and `pi remove`.
  A local compatibility source stays pinned until its replacement is qualified;
  a native update command does not rebuild that source automatically.
- Keep Matt in the shared installer payload. Pi also discovers
  `~/.agents/skills`; verify its actual loader before adding duplicate aliases.
- Namespace pstack's Pi skill names as `pstack-<name>` to preserve Matt's
  unprefixed names. Invoke them with `/skill:pstack-<name>` and retain the
  upstream package's relative resources.
- Treat an extension that adds delegation as a capability change. Qualify its
  agent profiles and inherited model/tool policy before enabling it. A passing
  read-only explainer does not qualify writable agents or every pstack workflow.
- Before removing a source, retain its exact registration, package revision,
  resource filters and compatibility receipt. Roll back through the owning
  manager and verify discovery again. Remove a stale alias only after checking
  its stored target, unresolved state and absent installer ownership.

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

`bin/agent-skills-inventory --json` accepts every skill in the machine lock as
installer-owned at its payload in `~/.agents/skills` and at links to that payload
from `~/.claude/skills`, with no topology or repository-lock declaration; any
other target is reported. It also checks the vendors pending migration,
project addresses, and obsolete links, and reports an entry with no lock entry
and no other owner as `unknown-provenance`. Personal enablement belongs to the
native manifests; third-party installation belongs to the installer lock.
Entries that an app writes into a user address (Claude's `synced` and `.trash`,
the work board's `herdr-projects`) are declared in `topology.json#appOwned`.

Capture protected Harness state immediately before and after a migration or
canary. Compare those operation snapshots. Cache counts and hashes are not
permanent repository acceptance criteria. Preserve unrelated Codex content,
plugins, settings, and credentials. Report pre-existing drift separately from
changes introduced by the operation.

Startup Instructions remain direct Tracking Links from `~/.codex/AGENTS.md`
and `~/.claude/CLAUDE.md` to their existing dotfiles sources.

The replacement structure is proposed in
[ADR-0013](../adr/0013-native-personal-and-matt-skills.md).
