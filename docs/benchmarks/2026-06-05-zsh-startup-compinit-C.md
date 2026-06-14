---
title: "zsh Startup: compinit -C"
type: benchmark
date: 2026-06-05
tool: hyperfine 1.20.0
subject: /Users/nathanvale/code/dotfiles/.zshrc
baseline: docs/benchmarks/2026-06-05-zsh-startup-baseline.md
raw_data: docs/benchmarks/2026-06-05-zsh-startup-after-compinit-C.hyperfine.json
---

# zsh Startup: compinit -C

## Change

- Replaced `compinit` with `compinit -C`.
- Added `refresh-completions`.
- Kept completion menus enabled.
- Kept fzf, Atuin, autosuggestions, and syntax highlighting.

## Safety Check

- Ran `compaudit` against the configured `fpath`.
- Result: no insecure completion paths printed.
- Existing completion dump existed:
  - Path: `~/.zcompdump`
  - Size: about `64K`
  - Lines: `2414`

## Before

- `normal-terminal`
  - Mean: `155.4 ms`
  - Std dev: `8.2 ms`
- `tmux-pane`
  - Mean: `139.7 ms`
  - Std dev: `7.9 ms`

## After

- `normal-terminal-after-compinit-C`
  - Mean: `153.2 ms`
  - Std dev: `11.8 ms`
  - Range: `141.0 ms` to `198.1 ms`
- `tmux-pane-after-compinit-C`
  - Mean: `125.6 ms`
  - Std dev: `6.3 ms`
  - Range: `116.5 ms` to `140.1 ms`

## Read

- Tmux-pane startup improved by about `14.1 ms`.
- Normal terminal startup was roughly flat in this run.
- `compaudit` no longer dominates startup profiling.
- Post-change profiler top costs:
  - fzf shell files: about `9.9 ms`
  - `compinit -C`: about `6.0 ms`
  - syntax highlighting: about `8.1 ms` combined

## Operational Note

- Run `refresh-completions` after installing tools that add zsh completions.
- Run `refresh-completions` if completions feel stale or missing.
