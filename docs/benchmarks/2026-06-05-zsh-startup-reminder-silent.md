---
title: "zsh Startup: Silent Repeated Reminder"
type: benchmark
date: 2026-06-05
tool: hyperfine 1.20.0
subject: /Users/nathanvale/code/dotfiles/.zshrc
baseline: docs/benchmarks/2026-06-05-zsh-startup-baseline.md
raw_data: docs/benchmarks/2026-06-05-zsh-startup-after-reminder-silent.hyperfine.json
---

# zsh Startup: Silent Repeated Reminder

## Change

- Kept the full quick reference once per day.
- Removed the repeated mini reminder from later normal terminal startups.
- Kept `qr` and `help` aliases for manual access.
- Tmux panes were already skipping the reminder.

## Before

- Original baseline:
  - `normal-terminal`: `155.4 ms`
  - `tmux-pane`: `139.7 ms`
- After `compinit -C`:
  - `normal-terminal-after-compinit-C`: `153.2 ms`
  - `tmux-pane-after-compinit-C`: `125.6 ms`

## After

- `normal-terminal-after-reminder-silent`
  - Mean: `138.7 ms`
  - Std dev: `9.8 ms`
  - Range: `125.8 ms` to `162.1 ms`
- `tmux-pane-after-reminder-silent`
  - Mean: `123.7 ms`
  - Std dev: `8.3 ms`
  - Range: `114.5 ms` to `155.1 ms`

## Read

- Normal terminal startup improved by about `16.7 ms` versus the original baseline.
- Tmux-pane startup improved by about `16.0 ms` versus the original baseline.
- The repeated reminder was a normal-terminal-only cost.
- The once-per-day full reminder remains.

## Preserved

- Atuin `Ctrl-R`.
- fzf `Ctrl-T`.
- Bun completion.
- zsh completion menus.
- autosuggestions.
- syntax highlighting.
