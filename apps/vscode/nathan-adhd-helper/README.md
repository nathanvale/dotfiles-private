# Nathan ADHD Helper

Local VS Code extension for fast, visible keyboard workflows.

## Verify

```sh
npm test
npx --yes @vscode/vsce package --out /tmp/nathan-adhd-helper.vsix
code --install-extension /tmp/nathan-adhd-helper.vsix --force
```

Keep generated `.vsix` packages outside the repository.

## Current acceptance

- `Ctrl+G, D` opens the active file's Git diff.
- Running it from a diff returns to that diff's source.
- Rendered Markdown resolves to its current source before opening the diff.
- Staged and unstaged entries for one file appear once.
- Missing sources clear stale navigation state.

The remaining product decision is whether `Ctrl+G, U` may undo a commit without confirmation.
