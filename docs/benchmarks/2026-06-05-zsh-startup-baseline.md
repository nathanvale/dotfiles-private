---
title: "zsh Startup Baseline"
type: benchmark
date: 2026-06-05
tool: hyperfine 1.20.0
subject: /Users/nathanvale/code/dotfiles/.zshrc
---

# zsh Startup Baseline

## Context

- Record current terminal startup time before further optimization.
- Measure zsh startup to first command completion.
- Include normal terminal and tmux-pane-shaped shells.
- Use current `.zshrc` after the 2026-06-05 cleanup pass.
- Raw data: `docs/benchmarks/2026-06-05-zsh-startup-baseline.hyperfine.json`

## Results

- `normal-terminal`
  - Mean: `155.4 ms`
  - Std dev: `8.2 ms`
  - Range: `146.5 ms` to `189.8 ms`
  - Runs: `30`
- `tmux-pane`
  - Mean: `139.7 ms`
  - Std dev: `7.9 ms`
  - Range: `129.0 ms` to `170.7 ms`
  - Runs: `30`
- `bare-zsh-no-rc`
  - Mean: `4.4 ms`
  - Std dev: `0.4 ms`
  - Range: `3.7 ms` to `5.5 ms`
  - Runs: `30`

## Read

- Current practical terminal startup baseline: about `155 ms`.
- Current practical tmux-pane startup baseline: about `140 ms`.
- Bare zsh is about `4 ms`.
- Most startup cost comes from rc-file work: completion, fzf, syntax highlighting, autosuggestions, Atuin, fnm, pyenv, direnv, prompt work.
- Tmux-pane startup is faster because the terminal reminder is skipped inside tmux.

## Commands

```zsh
hyperfine --warmup 5 --runs 30 \
  --export-json /Users/nathanvale/code/dotfiles/docs/benchmarks/2026-06-05-zsh-startup-baseline.hyperfine.json \
  --command-name normal-terminal \
  'env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/opt/homebrew/bin/zsh PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin TERM=xterm-256color /opt/homebrew/bin/zsh -lic "exit" >/dev/null' \
  --command-name tmux-pane \
  'env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/opt/homebrew/bin/zsh PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin TERM=xterm-256color TMUX=/tmp/tmux-benchmark /opt/homebrew/bin/zsh -lic "exit" >/dev/null' \
  --command-name bare-zsh-no-rc \
  'env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/opt/homebrew/bin/zsh PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin TERM=xterm-256color /opt/homebrew/bin/zsh -fic "exit" >/dev/null'
```

## Next Optimization Candidates

- Profile `compinit` and `compaudit`; completion is likely the largest fixed cost.
- Consider `compinit -C` after validating trusted completion directories.
- Lazy-load or defer noncritical helpers in non-tmux normal terminals.
- Keep Atuin, fzf, autosuggestions, syntax highlighting, and completion unless a specific measured change proves worthwhile.
- Re-run this exact benchmark after each change.
