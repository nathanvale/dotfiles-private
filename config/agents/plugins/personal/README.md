# Personal skills

This plugin owns Nathan's personal skills. Edit here; refresh through each
Harness's native plugin commands. Matt Pocock skills are managed separately
with `npx skills`.

Bitbucket belongs to Monash Tools and is absent from this personal plugin.
Merge and activate the Monash replacement before refreshing this personal
candidate.

```text
personal/
  .claude-plugin/plugin.json   # Claude's enabled directories.
  .codex-plugin/plugin.json    # Codex selects library/.
  library/<skill>/            # 38 skill trees, including existing workflows.
  optional/fix-microphone/    # Claude enabled; Codex disabled.
```

Claude's explicit native manifest preserves the existing enabled set. Skills
omitted from it remain stored here. There is no default `skills/` directory,
so Claude does not accidentally discover omitted entries. Use `personal:<name>`
for plugin skills in Claude and the resolved plugin skill selector in Codex.

## Build and check

From the repository root:

```sh
bun install --frozen-lockfile
bun run personal:build
claude plugin validate config/agents/plugins/personal --strict --json
bun run test:quality:repository
```

Runtime packages retain their sources and tests. Their `build:bundle` scripts
package dependencies into `dist/`; loaded skill instructions use these bundles
relative to the loaded directory. The existing archive and Xero helper bundles
remain with their skills. Build success proves packaging, not live activation.

## One-time cutover before merge

The draft prepares source changes. Its deletion of old source paths cannot be
merged safely while live addresses still point there. Activate after review:

1. Capture the full native machine lock, stored/resolved old links, protected
   Harness snapshots, and source bytes/modes. Preserve pre-existing issues.
   The reviewed starting sources are recoverable from commit
   `6a8549a0e906541df783906f53ae576d22fd021c`.
2. Build and test the candidate personal payload. Register a development
   marketplace pointing at that candidate; use native install/refresh commands.
   Prove the intended enabled and unavailable names in fresh Claude and Codex
   chats. Do not edit installed caches.
3. Remove only old personal links proven to point into the retired personal
   source, after their replacement plugin entries work. Preserve conflicting
   copies and unrelated registrations.
4. Adopt the 35 reviewed Matt directories into the installed CLI's native
   canonical skill location. Replace only their positively identified old
   source links with byte-identical directories and standard installer links.
   Preserve executable modes. Exclude retired `loop-me`.
5. Detach the machine lock's former dotfiles symlink into a real native file,
   preserving **every** entry, upstream source, hash, and timestamp, including
   other vendors. Resolve the actual native lock address from the installed
   CLI, including any configured XDG state path. The repository lock now serves
   only the remaining reviewed vendor sources.
6. Run `npx skills list -g` and prove the 35 Matt identities and upstream
   provenance. Compare their files and modes with the saved archive. Do not use
   upstream `add` or `update` for this adoption: either would also fetch an upgrade.
7. Compare protected snapshots and prove other vendors and settings unchanged.
   Preserve existing Matt Claude visibility overrides. Once old source paths
   have no live dependants, the source deletion can be merged.

The native CLI owns subsequent Matt installs, updates, and removals. This
one-time adoption introduces no custom installation command or registry.
Rollback restores the captured addresses and lock plus the previous native
personal plugin version. Keep recovery material until the cutover is accepted.

The draft does not claim live activation. Its pre-change inventory recorded
19 pre-existing issues; these are not attributed to the source migration.

See [skill ownership](../../../../docs/agents/skills.md),
[third-party commands](../../../../docs/agents/third-party-skills.md), and
[the proposed decision](../../../../docs/adr/0013-native-personal-and-matt-skills.md).
