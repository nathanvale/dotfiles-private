# Diagnostic Traps

Two shell checks that report confident, wrong answers. Both caused a real
misdiagnosis. Prefer the correct command; do not trust the naive form.

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
