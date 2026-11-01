# Third-Party Skills

## One route: the installer

Every skill you did not write follows the Matt Pocock pattern: `npx skills`
owns its files, links, and machine lock. Keep installed payloads outside this
repository. Add no copy under `config/agents/skills/third-party/`, no
repository lock record, and no `topology.json#thirdParty` declaration.
Check installed command syntax with `npx skills --help`.

```sh
# Choose a named skill; always restrict installation to these two agents.
npx skills add OWNER/REPO -g --skill SKILL_NAME -a claude-code -a codex
npx skills list -g
npx skills update SKILL_NAME -g
npx skills remove SKILL_NAME -g -a claude-code -a codex
```

- Select the exact skills requested. Retired `loop-me` remains excluded.
- Use named updates so one update does not touch other skills. Updating
  resolves the current upstream source.
- Preserve existing Claude visibility settings for these non-plugin skills.
- Read the installer's warnings before enabling unfamiliar behavior.

The machine lock (`~/.agents/.skill-lock.json`, or an XDG state path in newer
CLI versions) is a real installer-owned file. Check its address with the
installed CLI. Do not redirect it into dotfiles or replace installer-created
addresses with links to copies. Its entry for a skill records the upstream
`source`, `ref`, and `skillFolderHash`.

`bin/agent-skills-inventory` accepts any skill with a machine-lock entry as
installer-owned at the installer-created addresses, whatever its upstream
source: the payload at `~/.agents/skills/<name>`, and links to that payload from
`~/.claude/skills` and `~/.codex/skills`. It reports a link to any other target
(including the obsolete repository sources), an independent copy at a link
address, broken links, and entries with no lock entry and no other owner.

### Unfamiliar authors

Stage before installing for an author you do not know:

1. Stage the exact skill with `npx skills add` without `-g` in task-only
   scratch; pass `-a claude-code -a codex`. Read every file and warning.
2. Install it globally with the command above.
3. Compare the new lock entry's `ref` and `skillFolderHash` with the staged
   copy. A mismatch means upstream moved after review: remove and review again.

Review is practice, not a gate: the inventory does not require it.

Use [the personal plugin cutover](../../config/agents/plugins/personal/README.md)
to adopt the existing 35 Matt payloads without fetching an upgrade.

## Pending migration: GOG, Herdr, `find-skills`

The reviewed-vendor route is retired. GOG (30 skills), Herdr, and `find-skills`
still carry their old declarations until a follow-on task migrates them to the
installer. Until then they are pending migration, not a second supported route:

- Their reviewed source stays under `config/agents/skills/third-party/`.
- `topology.json#thirdParty` and the repository `.skill-lock.json` keep their
  declarations and hashes; the inventory keeps checking them.
- Keep GOG disabled in Claude and Herdr matched to its installed release.
- Do not add another skill to this route. Do not move their files, links, or
  declarations outside that migration.

Native external plugins keep their marketplace route. Use the owning plugin's
instructions rather than the skill installer.

References: [skills CLI](https://github.com/vercel-labs/skills),
[skill ownership](skills.md).
