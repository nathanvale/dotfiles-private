# Diagnostic Traps

Commands and tools that report confident, wrong answers, or destroy state
while succeeding. Each caused a real misdiagnosis or loss. Prefer the correct
form; do not trust the naive one.

## Optional-value flags swallow the next argument

A flag declared as `--flag [<VALUE>]` takes its value with no `=`, so a
positional argument that follows it is consumed as that value and rejected.
In eza v0.23.5 this affects `--icons`, `--color`, `--classify` / `-F`,
`--hyperlink`, `--absolute`, and `--color-scale`.

Symptom: `ls <path>` failed with `invalid value '<path>' for '--icons
[<WHEN>]'` while bare `ls` worked. The usage error reads like a missing
directory, so a present directory was reported as absent.

- Bind the value: write `--icons=always`, never a bare `--icons` before a path.
- List the exposed flags for a tool with `<tool> --help | grep '\[<'`.
- Fixed in `.zshrc` aliases `ls`, `ll`, `lla`, `la`, `lt`.

## Broken-symlink scans report false positives

`find -type l ! -exec test -e {} \;` misreports resolvable links. It reported
87 broken links in `~/.claude` and 26 in dotfiles; the true counts were 2 and
0. Verify each candidate with a plain `[ -e "$link" ]` test instead.

```sh
find "$root" -type l | while IFS= read -r l; do
  [ -e "$l" ] || echo "DANGLING: $l -> $(readlink "$l")"
done
```

- A link whose target is its own path never resolves. Read `readlink` output
  before judging a link broken.
- Exclude `.worktrees` when scanning a repository. Its links are disposable.

## The `/plugin` UI drops `skillOverrides`

`/plugin` rewrites `~/.claude/settings.json` wholesale rather than merging.
A session removing marketplaces on 2026-08-19 also removed the entire
`skillOverrides` block, 73 entries, reported only as `✔ Removed 1
marketplace`. The diff was 16 insertions, 91 deletions.

The file has two writers that do not know about each other: dotfiles owns it
as tracked config at `config/agents/claude/settings.json`; the harness owns it
as runtime state. Unrecognised keys do not survive the harness write.

Observed, not isolated: several removals happened in one session, so the
triggering action is unconfirmed. Treat any `/plugin` use as able to destroy
the block.

- Commit a `skillOverrides` change before other work. Recovery is then
  `git show <sha>:config/agents/claude/settings.json`.
- After any `/plugin` use, run `git status` in dotfiles and confirm the block
  is present with an unchanged entry count.
- Plugin state also lives in untracked runtime files
  (`~/.claude/plugins/known_marketplaces.json`, `installed_plugins.json`).
  An `enabledPlugins` key with no matching install is inert: a session starts
  clean, exit 0, no warning. The key declares; it does not restore.
