# ----------------------------------------------------------------------------
# PATH Setup (consolidated - order matters: later entries take priority)
# ----------------------------------------------------------------------------
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export PNPM_HOME="$HOME/.local/share/pnpm"
export BUN_INSTALL="$HOME/.bun"
export PATH="$PNPM_HOME/bin:$PATH"
export PATH="$BUN_INSTALL/bin:$PATH"
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

# Interactive lookup keeps the managed command tree ahead of installer fallbacks
# at the same point where the old checkout path was prepended. .zshenv owns
# availability in every startup mode; these assignments only restore the
# interactive priority contract and are deduplicated by the path declaration
# below.
export PATH="$HOME/.local/bin:$PATH"
export PATH="$HOME/bin:$PATH"

# Interactive helper directories retain their previous precedence through the
# managed HOME/bin mapping. The parent directory itself is owned by .zshenv.
export PATH="$HOME/bin/tmux:$PATH"
export PATH="$HOME/bin/env:$PATH"

# Homebrew takes priority (must be last)
export PATH="/opt/homebrew/bin:$PATH"

# Drop every command-lookup location an agent cannot trust, preserving order.
#
# `typeset -U` only deduplicates; it keeps an empty entry and a `.` entry, both
# of which mean "the current directory". A repository file named like a common
# tool would then be executed in place of the trusted binary. A writable
# temporary directory is the same hazard with a different owner, so entries
# under TMPDIR, /tmp, and /var/tmp go too.
#
# First occurrence wins, so the priority order established above survives.
# Contract: bin/test/zsh-effective-behavior-test.sh
sanitize-path() {
  local -a safe
  local entry tmp_root
  local -a tmp_roots
  tmp_roots=(/tmp /private/tmp /var/tmp /private/var/tmp)
  [[ -n "${TMPDIR:-}" ]] && tmp_roots+=("${TMPDIR%/}")

  for entry in $path; do
    # Keep absolute entries only. One rule covers every lookup location that
    # resolves against the caller's current directory rather than a fixed place:
    # the empty entry, a bare `.`, a `./`-prefixed entry, and any other relative
    # entry all mean "wherever this command happens to run".
    [[ -z "$entry" || "$entry" != /* ]] && continue
    # Writable temporary locations.
    for tmp_root in $tmp_roots; do
      [[ -n "$tmp_root" && ( "$entry" == "$tmp_root" || "$entry" == "$tmp_root"/* ) ]] && continue 2
    done
    safe+=("$entry")
  done

  # Deduplication is a property of the `path` array itself: once declared
  # unique, zsh keeps the first occurrence of each entry on every later
  # assignment. Re-declaring here keeps that true even if this function is
  # called from a context that never ran the declaration below.
  typeset -gU path PATH
  path=($safe)
  export PATH
}

typeset -U path PATH
sanitize-path

# ----------------------------------------------------------------------------
# Environment Variables
# ----------------------------------------------------------------------------
export XDG_CONFIG_HOME="$HOME/.config"
export EDITOR="vim"
export VISUAL="vim"
# Interactive terminals own their colour preference. Do not inherit a
# non-interactive command runner's plain-output policy.
unset NO_COLOR
export TERM=xterm-256color
export LANG="en_AU.UTF-8"
export LC_COLLATE="en_AU.UTF-8"
export LC_CTYPE="en_AU.UTF-8"

# Bat (better cat)
export PAGER="bat"
export BAT_THEME="Night Owl"

# Glow (terminal markdown renderer) - custom glamour style
# Switch between: night-owl.json (custom) or catppuccin-mocha.json (community)
export GLAMOUR_STYLE="$HOME/.config/glow/night-owl.json"

# Homebrew
export HOMEBREW_BUNDLE_FILE_GLOBAL="$HOME/.config/brew/Brewfile"
export HOMEBREW_BUNDLE_FILE="$HOME/.config/brew/Brewfile"

# No CDPATH is set here. An ambient directory search path makes a relative
# `cd sub` resolve somewhere other than the current directory, so an agent can
# read one command and execute it against a different tree. Quick navigation
# lives under the distinct names below (`cdc`, `d`, `de`, `cdg`).
# Contract: bin/test/zsh-effective-behavior-test.sh

# ----------------------------------------------------------------------------
# Optional Environment Variables
# ----------------------------------------------------------------------------
# Secrets are never sourced into a shell. Deliver one value to one process:
#   with-one-password-token inject KEY "op://Vault/Item/field" -- <command>
# Do not reintroduce a load-secrets function or an on-disk env file of values;
# that pattern put 30 live credentials in plain text and leaked keys into
# shell history via argv.
#
# Startup holds no credential delivery lane at all.
#
# The retired shape read $HOME/.config/lll-account-switch/secrets.env: it
# `eval`ed `op inject` output when the file named an `op://` reference and
# plainly `source`d the file otherwise. Both put a credential into every zsh
# process, and an agent harness snapshots exported variables, so one interactive
# convenience became long-lived authority in every replayed agent command. The
# `eval` also executed whatever that file expanded to.
#
# The consumer that actually needs a credential asks for it at its own boundary:
#   with-one-password-token inject AZURE_OPENAI_API_KEY \
#     "op://Vault/Item/credential" -- <command>
# That delivers one value to one child process and leaves the shell clean.
# Contract: bin/test/zsh-work-profile-boundary-test.sh

# The account-switch helper's non-secret settings remain readable. This file
# holds repository lists and account names, never credentials; the contract
# above proves no secret file is read during startup.
if [ -f "$HOME/.config/lll-account-switch/env" ]; then
  source "$HOME/.config/lll-account-switch/env"
fi

# GUI (launchd) environment projection.
#
# GUI applications do not read zsh startup, so a few non-secret values are
# published to the launchd session on request. This is an explicit allowlist of
# names, not a denylist.
#
# A denylist was the previous shape: it skipped OP_SERVICE_ACCOUNT_TOKEN and
# projected every other `export` in dotfiles/.env. That fails open. Any
# credential added to that file later is published to every GUI process in the
# session without anyone editing this function, and launchd session variables
# outlive the shell that set them. An allowlist fails closed: a new name is not
# projected until it is deliberately added here, which forces the question of
# whether it is a secret.
#
# Nothing credential-bearing belongs in this list. Add a name only after
# confirming the value is non-secret and that a GUI process genuinely needs it.
# Contract: bin/test/codex-ambient-credential-boundary-test.sh
typeset -ga DOTFILES_LAUNCHCTL_ALLOWLIST=(
  DOTFILES_PROFILE
)

sync-launchctl-env() {
  local env_file="$HOME/code/dotfiles/.env"

  # Clear the retired projection unconditionally, before any read. A machine
  # that ran the denylist version may still hold a projected value in its
  # launchd session, and that stale authority must go even when the file below
  # is missing and this function returns early.
  launchctl unsetenv OP_SERVICE_ACCOUNT_TOKEN 2>/dev/null || true

  [ -f "$env_file" ] || {
    echo "No $env_file found"
    return 1
  }

  local -a projected=()
  # `name` is the allowlist loop variable below. It belongs here: `local` in zsh
  # is dynamic, so an undeclared loop variable is written in the caller's scope
  # and outlives the call.
  local line key value allowed name
  # Read the file as data. No `eval`, no `source`: a value in this file is never
  # executed as shell code, so a crafted line cannot run a command here.
  while IFS= read -r line; do
    case "$line" in
      'export '*) ;;
      *) continue ;;
    esac
    key="${line#export }"
    key="${key%%=*}"
    key="${key// /}"
    value="${line#*=}"
    value="${value%\"}"
    value="${value#\"}"

    allowed=no
    for name in "${DOTFILES_LAUNCHCTL_ALLOWLIST[@]}"; do
      [[ "$key" == "$name" ]] && allowed=yes && break
    done
    [[ "$allowed" == yes ]] || continue

    launchctl setenv "$key" "$value" 2>/dev/null
    projected+=("$key")
  done <"$env_file"

  # Report names only. Printing a projected value here would put it in shell
  # history and in any agent transcript that captured this command.
  if (( ${#projected} )); then
    echo "Projected to launchctl: ${projected[*]}"
  else
    echo 'Projected to launchctl: nothing (no allowlisted name present).'
  fi
}

# Node, npm, and npx are owned by the applied Mise revision selected in
# .zshenv; interactive activation runs later, after the other PATH owners. No
# other Node manager is configured. Contract: bin/test/toolchain-bootstrap-test.sh
typeset -U path PATH
sanitize-path

# ----------------------------------------------------------------------------
# Zsh Function Lookup
# ----------------------------------------------------------------------------
fpath=(
  "$HOME/.docker/completions"
  /opt/homebrew/share/zsh/site-functions
  /usr/local/share/zsh/site-functions
  /opt/homebrew/share/zsh/functions
  $fpath
)
typeset -U fpath

# ----------------------------------------------------------------------------
# Prompt with Git Branch Support + Execution Time
# ----------------------------------------------------------------------------
zmodload zsh/datetime 2>/dev/null
autoload -Uz vcs_info
precmd() {
  local cmd_status=$?  # Capture exit status immediately
  # Git branch info
  vcs_info
  # Set terminal title to current directory name.
  #
  # This is terminal control, not output. An OSC title sequence written to a
  # captured stream is not rendered by anything; it just lands in the transcript
  # an agent reads back as command output. Gate it on a real terminal so it is
  # emitted only where something can interpret it.
  # Contract: bin/test/zsh-startup-silence-test.sh
  [[ -t 1 ]] && print -Pn "\e]0;%1~\a"

  # Execution time display (if command took >1 second).
  #
  # Colour-coded presentation for a human watching a terminal. Gated on a real
  # terminal for the same reason as the title above: in a captured stream it is
  # noise an agent must parse around, not information.
  if [[ -t 1 && -n "${timer:-}" && -n "${EPOCHREALTIME:-}" ]]; then
    local elapsed_seconds=$((EPOCHREALTIME - timer))
    if (( elapsed_seconds > 1 )); then
      if [ $cmd_status -eq 0 ]; then
        printf "\033[0;32m✓ %.1fs\033[0m\n" "$elapsed_seconds"
      else
        printf "\033[0;31m✗ %.1fs\033[0m\n" "$elapsed_seconds"
      fi
    fi
    unset timer
  fi
}

# Configure vcs_info to show branch name
zstyle ':vcs_info:*' formats '%b'
zstyle ':vcs_info:*' actionformats '%b|%a'

setopt PROMPT_SUBST
# ADHD-friendly prompt with Node version indicator
PROMPT='%F{cyan}%1~%f %F{yellow}[$(node -v 2>/dev/null | sed "s/v//")]%f %F{green}${vcs_info_msg_0_}%f%(?.%(!.#.>).%(!.#.>)) '
RPS1=''  # Clear right prompt
PS2='> '

# ----------------------------------------------------------------------------
# History Configuration
# ----------------------------------------------------------------------------
HISTFILE=~/.zsh_history
HISTSIZE=100000
SAVEHIST=100000
setopt APPEND_HISTORY
setopt SHARE_HISTORY
setopt HIST_IGNORE_DUPS
setopt HIST_IGNORE_ALL_DUPS
setopt HIST_IGNORE_SPACE      # Commands starting with space won't be saved

# ----------------------------------------------------------------------------
# Auto-completion (built-in, no plugins needed)
# ----------------------------------------------------------------------------
# Where the completion cache is written.
#
# `compinit` with no `-d` dumps to $ZDOTDIR/.zcompdump, and ZDOTDIR is not always
# a home directory. An agent lane bound with a process-scoped ZDOTDIR pointing at
# a source checkout made startup deposit a completion cache straight into that
# repository. Naming the path keeps the cache with the machine's other private
# state regardless of where the startup files themselves were read from.
#
# XDG_CACHE_HOME is honoured when set; otherwise the conventional fallback. The
# directory is created up front because compinit does not create it and would
# otherwise fail to write the dump on a fresh machine.
# Contract: bin/test/zsh-startup-silence-test.sh
ZSH_COMPDUMP_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/zsh"
[[ -d "$ZSH_COMPDUMP_DIR" ]] || mkdir -p "$ZSH_COMPDUMP_DIR" 2>/dev/null
ZSH_COMPDUMP="$ZSH_COMPDUMP_DIR/zcompdump-${ZSH_VERSION}"

# Clearing the stale dumps needs a trailing glob, because compinit writes both
# the dump and a compiled `.zwc` sibling. That glob is only ever safe while
# ZSH_COMPDUMP holds a path: empty or unset it collapses to a bare `*`, and the
# deletion lands on every file in whatever directory the caller was standing in.
# A cache refresh must not be able to erase a working tree, so the function
# refuses rather than guessing a path. The message goes to stderr and the status
# is nonzero, so a caller that chains on success stops here.
#
# `--` ends option parsing before the expansion, so a dump path that begins with
# a dash is removed rather than read as flags.
#
# `(N)` makes the glob null rather than an error when nothing matches. zsh
# reports an unmatched pattern and skips the command entirely, so without it a
# machine with no dump yet would see a diagnostic on the ordinary first refresh
# and `rm` would never run. `-f` does not cover this: the shell fails before
# `rm` is reached.
# Contract: bin/test/zsh-startup-silence-test.sh
refresh-completions() {
  if [[ -z "${ZSH_COMPDUMP:-}" ]]; then
    print -ru2 -- 'refresh-completions: ZSH_COMPDUMP is empty or unset; refusing to remove completion caches'
    return 1
  fi
  # An explicit refresh may run on the machine whose startup could not create
  # the cache directory, which is exactly when automatic compinit was skipped
  # below. Create it here, and name the directory in the failure so the repair
  # is obvious, rather than letting compinit fail its dump write with a
  # generic diagnostic.
  local dump_dir="${ZSH_COMPDUMP:h}"
  if ! mkdir -p "$dump_dir" 2>/dev/null || [[ ! -w "$dump_dir" ]]; then
    print -ru2 -- "refresh-completions: completion cache directory is not writable: $dump_dir"
    return 1
  fi
  rm -f -- "$ZSH_COMPDUMP"*(N)
  autoload -U compinit && compinit -d "$ZSH_COMPDUMP"
}

# Completion is a line-editor feature. Every line below builds the interactive
# completion UI: the completion system itself, the menu-selection module, its
# styles, and its keybindings. None of it changes what a command means, and none
# of it can be used without ZLE driving a terminal.
#
# Gating on a real terminal rather than on `-o interactive` alone is deliberate.
# An agent harness starts an interactive shell without a tty, so the blanket
# interactive test would still load and dump a completion cache there. `-t 1`
# names the condition that actually makes this machinery useful.
# Contract: bin/test/zsh-startup-silence-test.sh
if [[ -o interactive && -t 1 ]]; then
  # Automatic compinit runs only when the cache directory the mkdir above was
  # asked to create is really there and writable. Without a usable dump
  # location the dump write fails, and that diagnostic would land in startup
  # on every shell of a broken machine. A missing cache directory is a defect
  # to repair through `refresh-completions`, which names the directory in its
  # failure instead of failing silently here.
  if [[ -d "$ZSH_COMPDUMP_DIR" && -w "$ZSH_COMPDUMP_DIR" ]]; then
    autoload -U compinit && compinit -C -d "$ZSH_COMPDUMP"
  fi

  # Load menuselect module for interactive menu
  zmodload zsh/complist

  # Case-insensitive completion
  zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'

  # Enable interactive menu selection (like Oh My Zsh)
  zstyle ':completion:*' menu select=2  # Show menu when 2+ matches
  setopt AUTO_MENU                      # Show menu on second tab press
  setopt COMPLETE_IN_WORD               # Complete from cursor position
  setopt ALWAYS_TO_END                  # Move cursor to end after completion

  # Highlight current selection in completion menu
  zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"

  # Completion menu navigation keybindings
  bindkey -M menuselect '^[[Z' reverse-menu-complete  # Shift+Tab: go backwards
  bindkey -M menuselect '^M' .accept-line             # Enter: accept selection
  bindkey -M menuselect '^[' send-break               # Esc: cancel completion
fi

# ----------------------------------------------------------------------------
# Directory Navigation (Better than Oh My Zsh!)
# ----------------------------------------------------------------------------
setopt AUTO_CD              # Just type directory name to cd
setopt AUTO_PUSHD          # Make cd push old dir onto dir stack
setopt PUSHD_IGNORE_DUPS   # Don't push duplicates
setopt PUSHD_SILENT        # Don't print dir stack after pushd/popd

# ----------------------------------------------------------------------------
# Aliases - Essential Tools
# ----------------------------------------------------------------------------

# Navigation
#
# Standard names keep standard behavior. `cd` stays the shell builtin so a
# generated command means what it reads. The conveniences below carry the same
# features under distinct names that cannot alter a standard command.
mkcd() { mkdir -p "$1" && cd "$1"; }
alias take='mkcd'
d() { cd ~/code; }          # Quick jump to code directory
alias de="cd ~/Desktop"

# ADHD-friendly: cd with clear Node version switching feedback.
# Distinct name; `cd` itself is left alone.
cdn() {
  local prev_node new_node
  prev_node=$(node -v 2>/dev/null)
  builtin cd "$@" || return
  new_node=$(node -v 2>/dev/null)
  if [[ "$prev_node" != "$new_node" && -n "$new_node" ]]; then
    echo "🔄 Switched Node: $prev_node → $new_node"
  fi
}

# Quick jump into ~/code/<project>. Replaces the convenience that ambient
# CDPATH used to provide, without changing what a relative `cd` means.
cdc() { builtin cd "$HOME/code/${1:-}"; }
alias c="code ."
alias ca="code . ~/code/dotfiles/config/aerospace/aerospace.toml"

# Modern replacements, under distinct names only.
#
# `ls`, `cat`, `less`, and `mv` keep their platform behavior. A generated
# command that reads `ls` must not run eza with icons and colour, and an agent
# parsing `cat` output must not receive bat's rendering. The same tools stay one
# keystroke away under the names below.
# Night Owl file roles, shared by eza and completion listings.
export LS_COLORS='di=38;2;130;170;255:ln=38;2;33;199;168:ex=38;2;156;204;101:or=38;2;239;83;80:fi=38;2;214;222;235:*.zip=38;2;199;146;234:*.tar=38;2;199;146;234:*.gz=38;2;199;146;234'
alias l="eza --color=always --icons=always"
alias ll="eza -l --color=always --icons=always"
alias lla="eza -l -a --color=always --icons=always"
alias la="eza -a --color=always --icons=always"
alias lt="eza --tree --color=always --icons=always"

# Smart pager: bat for a terminal, real cat for pipes and binaries.
# Distinct name; `cat` itself is left alone.
b() {
  # If no arguments and stdin is a terminal, show usage hint
  if [[ $# -eq 0 && -t 0 ]]; then
    echo "Usage: b <file>... (waiting for stdin, Ctrl+D to end, Ctrl+C to cancel)" >&2
    command cat "$@"
    return
  fi

  if [[ -t 1 ]]; then
    # Check if any file is binary
    local has_binary=0
    for file in "$@"; do
      if [[ -f "$file" ]] && ! command file -b --mime "$file" | command grep -q "^text/"; then
        has_binary=1
        break
      fi
    done

    if [[ $has_binary -eq 1 ]]; then
      # Binary file detected - use regular cat
      command cat "$@"
    else
      # Text file - use bat for pretty display
      command bat --paging=never --style=plain "$@"
    fi
  else
    # Output is piped - use real cat (no line numbers!)
    command cat "$@"
  fi
}
alias batn="bat -n"
alias bl="bat"
alias gmove="gmv"

# Git
alias lz="lazygit"
alias gs="git status"
alias gp="git push"
alias gl="git pull"
alias gd="git diff"
alias ga="git add"
alias gc="git commit"

# GitHub CLI - account switching
alias ghpersonal='gh auth switch -u nathanvale'

# Utilities
alias pg="echo 'Pinging Google' && ping www.google.com"
ports() { lsof -i :"$1"; }  # See what's running on a port

# Claude Code
alias cc="claude --dangerously-skip-permissions"
# ccdev function - all plugins now come from installed marketplaces
# TODO: bring node-cert into side-quest-engineering as a plugin
function ccdev() {
  COREPACK_ENABLE_STRICT=0 claude --dangerously-skip-permissions "$@"
}
alias cct="npx @mariozechner/claude-trace"
alias ccu="npx ccusage@latest"
alias ccs="npx @mariozechner/snap-happy to local"
alias ccd="c ~/Library/Application\ Support/Claude/claude_desktop_config.json"
alias ccr="claude --dangerously-skip-permissions -r"
alias cleanpaste='pbpaste | sed "s/^[[:space:]]*//" | pbcopy'  # Fix Claude Code copy-paste whitespace
alias claude-mcp="bun run ~/code/side-quest-marketplace/plugins/mcp-manager/src/cli.ts"

# Para-Obsidian Inbox Processor (AI-powered inbox processing)
alias inbox="bun run ~/code/side-quest-marketplace/plugins/para-obsidian/src/cli.ts process-inbox"

# Codex (YOLO mode)
alias cx="codex --dangerously-bypass-approvals-and-sandbox"

# Aerospace (window manager)
alias sa="aerospace reload-config"
alias aero="aerospace"
alias meeting="aerospace workspace M && aerospace close-all-windows-but-current && aerospace fullscreen"
alias teams-meeting="meeting"

# Shell config
alias cz="code ~/.zshrc"
alias sz="source ~/.zshrc"

# Morning routine for ADHD brain
morning() {
  echo "☕ Good morning, Nathan!"
  echo "Node versions installed:"
  mise ls node  # See what you have
  echo "---"
  echo "Recent projects:"
  eza -l --sort=modified --reverse ~/code | head -5
}

# Projects
alias p.dotfiles="cd ~/code/dotfiles/ && code ."

# Node
alias w.nvmrc="node -v > .nvmrc"
# Single-quoted so `$(node -v)` runs when the alias is used, not when it is
# defined. Double quotes made startup execute `node` to build the alias text,
# which printed "command not found: node" on a machine without Node and baked
# the startup-time version into the message the alias would later print.
# Contract: bin/test/zsh-startup-silence-test.sh
alias node-lock='node -v > .nvmrc && echo "📌 Locked to $(node -v)"'
alias nv='echo "Node: $(node -v) | npm: $(npm -v) | pnpm: $((cd "$HOME" && pnpm -v) 2>/dev/null)"'

# Tmux - unified launcher (tx --help for usage)
# tx          → Interactive picker (fzf)
# tx <project> → Start project (auto-detect template)
# tx .         → Start current directory
# tx --list    → List available templates

# Script Discovery & Test Helpers
alias .tmux-scripts="ls -1 ~/bin/tmux/ | column"

# Native Claude Code is reachable through the HOME/.local/bin startup owner.

# ----------------------------------------------------------------------------
# FZF (Fuzzy Finder) - If installed
# ----------------------------------------------------------------------------
export FZF_DEFAULT_OPTS='
  --ansi
  --height 40%
  --reverse
  --border
  --info=inline
  --color=fg:#D6DEEB,bg:#011627,hl:#C5E478
  --color=fg+:#D6DEEB,bg+:#1D3B53,hl+:#C5E478
  --color=info:#5F7E97,prompt:#7E57C2,pointer:#C792EA
  --color=marker:#9CCC65,spinner:#21C7A8,border:#5F7E97,header:#82AAFF
'
# Enable fzf keybindings (Ctrl+T for files, Ctrl+R for history)
source-fzf-zsh() {
  local fzf_file="$1"
  [ -f "$fzf_file" ] || return
  source "$fzf_file" 2> >(grep -v "can't change option: zle" >&2)
}
source-fzf-zsh /opt/homebrew/opt/fzf/shell/completion.zsh
source-fzf-zsh /opt/homebrew/opt/fzf/shell/key-bindings.zsh
unfunction source-fzf-zsh

# ----------------------------------------------------------------------------
# Essential Plugins (lightweight, no Oh My Zsh needed!)
# ----------------------------------------------------------------------------

# Each optional integration below initializes only when its own executable or
# readable integration file exists. On a fresh or partially configured machine
# the whole block is simply skipped, so startup stays silent instead of pushing
# "no such file or directory" and "command not found" at stderr.
# Contract: bin/test/zsh-startup-silence-test.sh

# Syntax highlighting - shows valid/invalid commands as you type
[[ -r /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ]] &&
  source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# Autosuggestions - suggests commands from history (use → to accept)
[[ -r /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh ]] &&
  source /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh

# Atuin - magical shell history sync and search (Ctrl+R only, up arrow uses traditional behavior)
# Atuin installs ZLE widgets and keybindings, so it needs an interactive shell
# as well as its own executable.
[[ -o interactive ]] && command -v atuin >/dev/null 2>&1 &&
  eval "$(atuin init zsh --disable-up-arrow)"

# Python aliases belong only to the Homebrew fallback. They must not bypass a
# validated Mise-owned Python selection.
if [[ "${DOTFILES_MISE_ACTIVE:-0}" != 1 ]]; then
  alias python='python3'
  alias pip='pip3'
fi

# ============================================================================
# END OF MINIMAL ZSHRC
# ============================================================================

# ----------------------------------------------------------------------------
# Bun Completions
# ----------------------------------------------------------------------------
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"

# ============================================================================
# DEVELOPER PRODUCTIVITY ENHANCEMENTS
# ============================================================================

# ----------------------------------------------------------------------------
# 1. Smart Paste Protection
# ----------------------------------------------------------------------------
# Prevents accidentally running pasted commands with newlines
# Must press Enter to confirm
#
# Bracketed paste is a terminal protocol and this widget only has meaning while
# ZLE is editing a line at a real terminal.
# Contract: bin/test/zsh-startup-silence-test.sh
if [[ -o interactive && -t 1 ]]; then
  autoload -Uz bracketed-paste-magic
  zle -N bracketed-paste bracketed-paste-magic
fi

# ----------------------------------------------------------------------------
# 2. Sudo Toggle (Ctrl+S)
# ----------------------------------------------------------------------------
# Press Ctrl+S to add/remove sudo from current command
sudo-command-line() {
    [[ -z $BUFFER ]] && zle up-history
    if [[ $BUFFER == sudo\ * ]]; then
        LBUFFER="${LBUFFER#sudo }"
    else
        LBUFFER="sudo $LBUFFER"
    fi
}
# The widget registration and its keybinding are terminal-only; the function
# above stays defined either way so it remains inspectable.
if [[ -o interactive && -t 1 ]]; then
  zle -N sudo-command-line
  bindkey "^S" sudo-command-line
fi

# ----------------------------------------------------------------------------
# 4. Execution Time Display
# ----------------------------------------------------------------------------
# Shows how long each command took (only if >1 second)
# Merged into main precmd() function above
function preexec() {
  timer=$EPOCHREALTIME
}

# ----------------------------------------------------------------------------
# 6. Quick Extract Function
# ----------------------------------------------------------------------------
# Extract any archive: x archive.zip
x() {
  if [ -f "$1" ]; then
    case "$1" in
      *.tar.bz2)   tar xjf "$1"     ;;
      *.tar.gz)    tar xzf "$1"     ;;
      *.bz2)       bunzip2 "$1"     ;;
      *.rar)       unrar x "$1"     ;;
      *.gz)        gunzip "$1"      ;;
      *.tar)       tar xf "$1"      ;;
      *.tbz2)      tar xjf "$1"     ;;
      *.tgz)       tar xzf "$1"     ;;
      *.zip)       unzip "$1"       ;;
      *.Z)         uncompress "$1"  ;;
      *.7z)        7z x "$1"        ;;
      *)           echo "'$1' cannot be extracted via x()" ;;
    esac
  else
    echo "'$1' is not a valid file"
  fi
}

# ----------------------------------------------------------------------------
# 7. Globbing
# ----------------------------------------------------------------------------
# No global glob options are set here. Agent harnesses capture and replay this
# interactive state, so a convenience set here becomes agent runtime configuration.
#
# EXTENDED_GLOB made an unquoted `git show HEAD^` a pattern rather than a literal.
# NULL_GLOB then deleted that unmatched pattern instead of failing, so the command
# silently ran against a different revision. GLOB_DOTS made an ordinary `*` include
# dotfiles, widening cleanup commands to repository metadata.
#
# Default NOMATCH stays enabled so an unmatched pattern fails visibly.
#
# A function that genuinely needs extended patterns must set a local baseline
# (`setopt localoptions extendedglob`) so the option cannot escape into a snapshot.
# Contract: bin/test/zsh-effective-behavior-test.sh

# ----------------------------------------------------------------------------
# 10. JSON/YAML Pretty Print
# ----------------------------------------------------------------------------
# Pretty print JSON from stdin or file
json() {
  if [ -t 0 ]; then
    # From file
    python3 -m json.tool "$@"
  else
    # From stdin
    python3 -m json.tool
  fi
}

# Pretty print YAML
yaml() {
  python3 -c 'import sys, yaml, json; print(json.dumps(yaml.safe_load(sys.stdin), indent=2))'
}

# ----------------------------------------------------------------------------
# 13. NPM/PNPM Aliases
# ----------------------------------------------------------------------------
alias ni="pnpm install"
alias nr="pnpm run"
alias nrs="pnpm start"
alias nrt="pnpm test"
alias nrd="pnpm run dev"
alias nrb="pnpm run build"
alias nrl="pnpm run lint"

# List available scripts from package.json (ADHD-friendly quick reference)
unalias scripts 2>/dev/null
scripts() {
  if [ ! -f package.json ]; then
    echo "No package.json found"
    return 1
  fi
  echo ""
  jq -r '.scripts | to_entries[] | "  \(.key)\t→ \(.value)"' package.json | column -t -s $'\t'
  echo ""
}

# ----------------------------------------------------------------------------
# 15. CD to Git Root
# ----------------------------------------------------------------------------
# Jump to git repository root
cdg() {
  local root=$(git rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$root" ]; then
    cd "$root"
  else
    echo "Not in a git repository"
    return 1
  fi
}

# ============================================================================
# END DEVELOPER ENHANCEMENTS
# ============================================================================

# ============================================================================
# Python Environment
# Skip pyenv rehash/init in non-interactive shells to avoid noisy warnings.
# Also skip when shims directory isn't writable (restricted sandboxes).
if [[ "${DOTFILES_MISE_ACTIVE:-0}" != 1 ]] && [[ -o interactive ]] && command -v pyenv >/dev/null 2>&1 &&
  [[ ! -e "$HOME/.pyenv/shims" || -w "$HOME/.pyenv/shims" ]]; then
  eval "$(pyenv init - --no-rehash)"
  # pyenv prepends its shims; re-apply the safe-PATH invariant after it.
  sanitize-path
fi

# PARA Obsidian CLI
alias para="bun run $HOME/code/side-quest-marketplace/plugins/para-obsidian/src/cli.ts"

# ----------------------------------------------------------------------------
# Machine profile (desktop or server)
# ----------------------------------------------------------------------------
# setup.sh persists the selected profile here. Shared shell configuration stays
# in this file; only genuine server runtime settings live in the small overlay.
export LM_STUDIO_BASE_URL="${LM_STUDIO_BASE_URL:-http://127.0.0.1:12340/v1}"

dotfiles_profile="${DOTFILES_PROFILE:-desktop}"
if [[ -z "${DOTFILES_PROFILE:-}" && -r "$HOME/.dotfiles_state/profile" ]]; then
  dotfiles_profile="$(<"$HOME/.dotfiles_state/profile")"
fi

if [[ "$dotfiles_profile" == "server" && -r "$HOME/.config/zsh/server.zsh" ]]; then
  source "$HOME/.config/zsh/server.zsh"
fi
unset dotfiles_profile

# ----------------------------------------------------------------------------
# Work profile config (private repo)
# ----------------------------------------------------------------------------
# Selection is one non-secret scalar owned by the existing machine-state store,
# beside the machine profile above:
#
#   echo 'acme' > ~/.dotfiles_state/work-profile
#
# The value is a slug that names a private repository, never a path and never a
# credential. It selects exactly one location:
#
#   $HOME/code/<slug>-dotfiles/profile.zsh
#
# Four properties this block must keep, each with a reason:
#
# 1. The selector's OWNER is fixed at $HOME/.dotfiles_state/work-profile, with no
#    environment override of the directory. An override would move the same
#    defect out one level: an ambient variable naming the file that names the
#    profile still lets anything able to set it choose what this shell executes.
#    The file must also hold exactly one scalar; a second line is refused rather
#    than silently ignored, so nothing can be smuggled below a benign first line.
#
# 2. The selector is read as DATA. It is never `eval`ed, never `source`d, and
#    never expanded before it is validated. The retired shape interpolated an
#    ambient $WORK_PROFILE straight into a path, so anything that could set an
#    environment variable chose which file this shell executed.
#
# 3. The grammar is conservative: lowercase letters, digits, and single interior
#    hyphens, 1-32 characters. It admits no dot, no slash, and no shell
#    metacharacter, which is what makes `../` traversal and command substitution
#    unrepresentable rather than merely filtered. A rejected value loads nothing.
#
# 4. The resolved file must still be inside $HOME/code after symlinks are
#    resolved. The grammar already forbids traversal, so this is a second,
#    independent check: it also catches a symlink planted at the intended
#    location pointing somewhere else.
#
# Rejection is silent. A malformed selector is a machine-state defect, and
# startup diagnostics land in every captured agent command; `dotfiles-work-profile`
# below reports the state on request without ever printing a secret.
#
# This adapter is the ONLY public-to-private bridge. Do not add a second loader
# naming a specific employer: a literal loader bypasses this validation, and it
# also puts an employer name in a public repository.
# Contract: bin/test/zsh-work-profile-boundary-test.sh

# Returns the validated slug on stdout, or nothing. Reads state only; the caller
# decides what to do. Kept as a function so the contract can call it directly.
dotfiles-work-profile-slug() {
  # The grammar below needs EXTENDED_GLOB, which issue 48 deliberately removed
  # as a global option because it changes the meaning of ordinary agent
  # commands. A function with a proven extended-pattern requirement takes a
  # LOCAL baseline and gives it back on return, so nothing here reaches the
  # caller's shell or an agent harness snapshot.
  #
  # This is load-bearing, not decorative: without EXTENDED_GLOB the `(#c0,31)`
  # and `##` operators are inert text, every value fails to match, and the
  # function would silently reject valid slugs and disable the work profile.
  emulate -L zsh
  setopt local_options extended_glob no_nomatch

  # The selector owner is fixed: the existing machine-state directory under the
  # effective HOME, beside the machine profile. There is deliberately no
  # environment override. An override would reintroduce exactly the defect this
  # block exists to close, one level further out: instead of an ambient variable
  # naming the profile, an ambient variable would name the FILE that names the
  # profile, and anything able to set it would again choose which file every
  # shell executes. A test that needs a different root sets HOME.
  local state_file="$HOME/.dotfiles_state/work-profile"
  [[ -r "$state_file" ]] || return 1

  local slug extra fd
  # The file holds EXACTLY one scalar. Reading it needs two reads on one file
  # descriptor, because a single `read` cannot tell a well-formed one-line file
  # from the first line of a file carrying more.
  #
  # Command substitution is not usable here: `$(<file)` strips every trailing
  # newline, so it cannot see a blank second line at all. A dedicated fd keeps
  # the file position between the two reads instead.
  #
  # First read takes the value. `read` returns non-zero at end of file, which a
  # final line with no trailing newline reaches, so that status is accepted only
  # when it actually produced a value: `printf '%s' acme > file` is an ordinary
  # way to store a scalar and must keep working.
  #
  # Second read must find nothing. Status 0 means another complete line follows.
  # A non-empty assignment on a non-zero status means trailing bytes without a
  # final newline. Either way the file holds more than one scalar and the whole
  # value is refused, because guessing which line was meant is how a smuggled
  # second value gets loaded.
  #
  # No trimming. Surrounding whitespace is not a scalar the writer intended, and
  # silently repairing it would mean the file on disk and the value in use
  # disagree. The grammar below is the only thing that decides.
  exec {fd}<"$state_file" 2>/dev/null || return 1
  IFS= read -r slug <&$fd
  if (( $? != 0 )) && [[ -z "$slug" ]]; then
    exec {fd}<&-
    return 1
  fi
  IFS= read -r extra <&$fd
  local extra_status=$?
  exec {fd}<&-
  (( extra_status == 0 )) && return 1
  [[ -n "$extra" ]] && return 1
  [[ -n "$slug" ]] || return 1

  # The grammar. `[[ == ]]` anchors the whole string, so a partial match cannot
  # pass. Reading it: one leading alphanumeric, then up to 31 more repetitions
  # that are each either alphanumeric or a hyphen followed by an alphanumeric.
  # That admits `acme` and `a-b-c`; it refuses a leading or trailing hyphen, a
  # doubled hyphen, any uppercase, and every dot, slash, space, and shell
  # metacharacter. `../evil`, `$(cmd)`, and `a;id` are therefore not merely
  # filtered, they cannot be expressed in this grammar at all.
  [[ "$slug" == [a-z0-9]([a-z0-9]|-[a-z0-9])(#c0,31) ]] || return 1

  # The pattern above bounds REPETITIONS, and a `-x` repetition is two
  # characters, so a fully hyphenated value could reach 63 characters within 31
  # repetitions. The documented limit is 32 total characters; count them.
  (( ${#slug} <= 32 )) || return 1

  print -r -- "$slug"
}

# Shared resolution for the load and report paths, so the two cannot drift.
# The caller declares `candidate` and `resolved` as locals; zsh's dynamic
# scoping keeps the assignments below inside the caller's frame, so nothing
# leaks into the interactive shell. Status:
#   0  candidate exists and resolves inside $HOME/code; `resolved` is real
#   1  no profile file exists at `candidate`
#   2  `candidate` resolves outside $HOME/code after symlinks
dotfiles-work-profile-resolve() {
  local slug="$1"
  local root="$HOME/code"
  candidate="$root/${slug}-dotfiles/profile.zsh"
  [[ -f "$candidate" ]] || return 1

  # Containment check, independent of the grammar above. `:A` resolves symlinks
  # and normalises the path, so a symlink at the intended location pointing
  # outside $HOME/code is refused here even though its slug was well-formed.
  resolved="${candidate:A}"
  local root_resolved="${root:A}"
  [[ "$resolved" == "$root_resolved"/*/profile.zsh ]] || return 2
  return 0
}

dotfiles-work-profile-load() {
  local slug
  slug="$(dotfiles-work-profile-slug)" || return 0
  [[ -n "$slug" ]] || return 0

  local candidate resolved
  dotfiles-work-profile-resolve "$slug" || return 0
  source "$resolved"
  return 0
}

# Reports work-profile state for a human. Names and status only, never file
# contents, so running it inside an agent transcript discloses nothing.
dotfiles-work-profile() {
  local state_file="$HOME/.dotfiles_state/work-profile"
  local slug
  if ! [[ -e "$state_file" ]]; then
    print -r -- "work-profile: unset (create $state_file to select one)"
    return 0
  fi
  if ! slug="$(dotfiles-work-profile-slug)"; then
    print -r -- "work-profile: rejected ($state_file must hold exactly one valid slug)"
    return 1
  fi
  # Report what the loader actually did. Resolution and containment are the
  # SAME function the loader ran, so this report cannot drift from the loader's
  # decision. A well-formed slug whose directory is a symlink out of $HOME/code
  # loads nothing; reporting "loaded" there on the strength of the file merely
  # existing would tell a human the profile was active when it was refused,
  # which is the one case where this report matters most.
  local candidate resolved rc=0
  dotfiles-work-profile-resolve "$slug" || rc=$?
  if (( rc == 1 )); then
    print -r -- "work-profile: $slug (no profile at $candidate)"
    return 0
  fi
  if (( rc == 2 )); then
    print -r -- "work-profile: $slug (refused: $candidate resolves outside $HOME/code)"
    return 1
  fi
  print -r -- "work-profile: $slug (loaded from $candidate)"
  return 0
}

dotfiles-work-profile-load

# ----------------------------------------------------------------------------
# Direnv (directory-specific env vars)
# ----------------------------------------------------------------------------
# Contract: bin/test/zsh-startup-silence-test.sh
command -v direnv >/dev/null 2>&1 && eval "$(direnv hook zsh)"

# bun completions
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"

# Added by LM Studio CLI (lms)
export PATH="$PATH:$HOME/.lmstudio/bin"
# End of LM Studio CLI section

# Interactive shells add Mise's directory-change hook only after every other
# startup owner has changed PATH. Login and noninteractive shells use shims from
# config/mise/bootstrap.sh without evaluating an interactive hook.
if [[ -o interactive ]] && [[ "${DOTFILES_MISE_ACTIVE:-0}" == 1 ]] && command -v mise >/dev/null 2>&1; then
  eval "$(mise activate zsh)"
  sanitize-path
fi
