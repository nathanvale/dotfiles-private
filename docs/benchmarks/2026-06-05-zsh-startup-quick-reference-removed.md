---
title: "zsh Startup: Quick Reference Removed"
type: benchmark
date: 2026-06-05
tool: hyperfine 1.20.0
subject: /Users/nathanvale/code/dotfiles/.zshrc
baseline: docs/benchmarks/2026-06-05-zsh-startup-baseline.md
raw_data: docs/benchmarks/2026-06-05-zsh-startup-after-quick-reference-removed.hyperfine.json
---

# zsh Startup: Quick Reference Removed

## Change

- Removed `show_quick_reference`.
- Removed `terminal_reminder`.
- Removed `qr` alias.
- Removed `help` alias override.
- Removed terminal startup reminder checks.

## Before

- Original baseline:
  - `normal-terminal`: `155.4 ms`
  - `tmux-pane`: `139.7 ms`
- After silent repeated reminder:
  - `normal-terminal-after-reminder-silent`: `138.7 ms`
  - `tmux-pane-after-reminder-silent`: `123.7 ms`

## After

- `normal-terminal-after-quick-reference-removed`
  - Mean: `121.7 ms`
  - Std dev: `4.8 ms`
  - Range: `115.3 ms` to `132.5 ms`
- `tmux-pane-after-quick-reference-removed`
  - Mean: `133.0 ms`
  - Std dev: `6.5 ms`
  - Range: `123.9 ms` to `152.5 ms`
- Tmux rerun after removal:
  - Mean: `125.6 ms`
  - Std dev: `4.9 ms`
  - Range: `116.4 ms` to `134.4 ms`

## Read

- Normal terminal startup improved by about `33.7 ms` versus the original baseline.
- Tmux-pane startup remains about `124-126 ms`; the quick reference was already skipped in tmux.
- Removing the quick reference removed startup file checks and reminder logic from normal terminals.

## Preserved

- Atuin `Ctrl-R`.
- fzf `Ctrl-T`.
- Bun completion.
- zsh completion menus.
- autosuggestions.
- syntax highlighting.
