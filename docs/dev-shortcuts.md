# Development shortcuts

Running reference for configured shortcuts. Update alongside each binding change.
Checked against local configuration on 2026-09-09. Uppercase means Shift+letter.

## Herdr

Press Ctrl+G, release, then the following key. Prefix is configured locally;
actions below are installed Herdr defaults.

| Key | Action |
| --- | --- |
| ? | Help |
| w | Workspace picker |
| G | New worktree |
| c | New tab |
| n / p | Next / previous tab |
| v / - | Split right / down |
| h / j / k / l | Focus left / down / up / right |
| z | Zoom pane |
| x | Close pane |

## Lazygit

| Context | Key | Action |
| --- | --- | --- |
| Files | e | Edit in VS Code (built-in editor preset) |
| Files | V | Diff in desktop VS Code (custom) |
| Files | Ctrl+V | Merge in desktop VS Code (custom) |
| Files | F6 | Trial: diff in Terminal Code in a Herdr right pane (custom) |
| Worktrees | s | Custom recency picker; retirement planned, still configured |
| Local branches | e | Open current folder in VS Code; retirement planned |

F6 currently compares unstaged changes. It requires Herdr and `tode`. The
`bin/tode-diff` adapter copies both sides into `~/.cache/tode-review/diff-*`
before returning to Git, so temporary comparison files remain available.
These snapshots accumulate until explicitly removed after review.
Use `git difftool --cached --tool=tode -- path/to/file` for a staged comparison.

## Yazi

| Key | Current action |
| --- | --- |
| Enter on Markdown | Glow (VS Code migration planned, not applied) |
| e | Vim (custom; VS Code migration planned) |
| M | Preview with Glow |
| B | Browse with Mo |
| O | Reveal in Finder (custom, overrides the default chooser) |

## VS Code

| Key | Action |
| --- | --- |
| Ctrl+S, then G | New Lazygit editor terminal |
| Ctrl+S, then W | Switch window |
| Ctrl+Alt+H / L | Previous / next terminal pane |
| Ctrl+- / Ctrl+= | Previous / next editor |

## Commands

| Command | Action |
| --- | --- |
| `tode --split right --diff before.ts after.ts --timing` | Trial two-file diff pane with startup timings |
| `git difftool --tool=tode -- path/to/file` | Unstaged Git diff in Terminal Code |
| `git difftool --cached --tool=tode -- path/to/file` | Staged Git diff in Terminal Code |

Terminal Code uses code-server and terminal-browser. It avoids a separate desktop
window but still runs a browser engine. Performance must be measured separately.

F6 reuses its own recorded Terminal Code socket, opening a new right pane only
when the recorded window is gone. Its workspace is an empty scratch folder with
`config/tode/review-settings.json`: no repository scan, hidden activity/status
bars, breadcrumbs and minimap, and syntax diagnostics disabled. The actual Night
Owl theme is in `config/tode/night-owl.json` and is applied to Terminal Code's
shared theme, including other open Terminal Code panes.

The Primary Side Bar is window state: use F1, `View: Close Primary Side Bar`,
Enter if it appears in a fresh pane. No custom editor patch is needed.

Measured scratch-workspace trial: first open with an already-running code-server
2.05 seconds; repeat open in the same pane 0.24 seconds. A real Git difftool call
with a spaced filename also completed in 0.24 seconds; both snapshot contents
were verified after Git returned. These measure command acknowledgement, not
first paint or human-perceived latency. F6 bindings themselves still need a
hands-on Lazygit check.

Trial on 2026-09-09: a two-file diff launch created a right-hand Herdr pane and
returned in 2.72 seconds; code-server startup reported 1047 ms. The subsequent
timing report recorded workbench-ready, but no screenshot or interaction check
has yet established visual correctness or editing responsiveness. This is an
optional experiment, not the default editor or a desktop performance comparison.
