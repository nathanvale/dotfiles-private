# Third-Party Skills

## Matt Pocock: use the installer

Use `npx skills` as the owner of Matt Pocock skill files, links, and machine lock.
Keep those installed payloads outside this repository. Check installed command
syntax with `npx skills --help`.

```sh
# Choose a named skill; always restrict installation to these two agents.
npx skills add mattpocock/skills -g --skill SKILL_NAME -a claude-code -a codex
npx skills list -g
npx skills update SKILL_NAME -g
npx skills remove SKILL_NAME -g -a claude-code -a codex
```

Select the exact skills requested. Retired `loop-me` remains excluded.
Use named updates so an ordinary Matt update does not also update GOG or Herdr.
Preserve existing Claude visibility settings for these non-plugin skills.
Review the selected payload and any installer warning before enabling unfamiliar
behavior. Updating a skill deliberately resolves its current upstream source.

The machine lock is a real installer-owned file. Preserve its complete upstream
records and metadata when detaching the former Tracking Link. Check the actual
lock address with the installed CLI; newer versions can use an XDG state path.
Do not redirect the machine lock into dotfiles or replace installer-created
addresses with links to vendored Matt files.

Use [the personal plugin cutover](../../config/agents/plugins/personal/README.md)
to adopt the existing 35 Matt payloads without fetching an upgrade.

## Remaining reviewed vendors

GOG, Herdr, and `find-skills` retain their reviewed source under
`config/agents/skills/third-party/`. `topology.json#thirdParty` declares their
installed addresses and disabled state. The repository `.skill-lock.json`
retains only their reviewed provenance and content hashes; it is not the live
machine lock. Keep GOG disabled in Claude and Herdr matched to its installed
release.

For their installation or update:

1. Inventory the exact name and source. Preserve current bytes and activation state.
2. Stage the exact skill with `npx skills add` without `-g` in task-only scratch;
   pass `-a claude-code -a codex`. Review all files and warnings.
3. Promote the exact reviewed bytes while retaining upstream provenance. A fresh
   upstream fetch does not prove staged-byte promotion; stop if the installed
   CLI cannot supply that route.
4. Keep reviewed source, repository lock, topology, and flat Tracking Links in agreement.
5. Run `bin/agent-skills-inventory --json` and fresh Harness discovery checks.
   Compare protected-state snapshots around each operation.

For restoration, rebuild only missing or incorrect declared links to existing
reviewed sources. Preserve differing content and unsafe ancestors for resolution.
Restore without fetching upstream or changing hashes. `experimental_install`
fetches upstream and does not restore reviewed bytes.

Native external plugins keep their marketplace route. Use the owning plugin's
instructions rather than the skill installer.

References: [skills CLI](https://github.com/vercel-labs/skills),
[skill ownership](skills.md).
