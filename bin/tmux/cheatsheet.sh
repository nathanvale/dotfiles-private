#!/bin/bash
# bin/tmux/cheatsheet.sh
# Custom tmux keybinding cheatsheet

less -R << 'EOF'
╭──────────────────────────────────────────────────────────────────────────────╮
│                        TMUX CHEATSHEET (Prefix: Ctrl-g)                      │
╰──────────────────────────────────────────────────────────────────────────────╯

 HELP & CONFIG
 ─────────────────────────────────────────────────────────────────────────────
   H           Show this cheatsheet          r           Reload tmux config

 SESSIONS
 ─────────────────────────────────────────────────────────────────────────────
   t           Project launcher (tx)         s           Session tree
   n           New session                   x           Kill session
   (  )        Previous/Next session         L           Last session
   Ctrl-\      Cycle sessions (no prefix)

 WINDOWS
 ─────────────────────────────────────────────────────────────────────────────
   1-4         Accordion: jump + zoom        5-9         Select window
   Tab         Last window                   w           Window tree
   Alt-1..9    Select window (no prefix)

 PANES
 ─────────────────────────────────────────────────────────────────────────────
   |           Split horizontal              -           Split vertical
   h j k l     Navigate (vim-style)          Alt-arrows  Navigate (no prefix)
   z           Toggle zoom                   Alt-z       Toggle zoom (no prefix)
   Space       Toggle zoom (accordion)       y           Sync panes toggle
   < >         Swap pane up/down

 LAYOUTS
 ─────────────────────────────────────────────────────────────────────────────
   T           Tiled (equal)                 E           Even horizontal
   S           Even vertical

 AI AGENTS
 ─────────────────────────────────────────────────────────────────────────────
   A c         Spawn Claude                  A g         Spawn Gemini
   A x         Spawn Codex                   A o         Spawn OpenAI (legacy)
   A n         New AI window                 A v         Claude (vertical)
   A w         Worktree wizard               U           Upgrade AI tools
   A i         Agent context                 A s         Agent status
   A p         Agent scratchpad              A l         Worktree log
   A b         Agent brief                   A r         Review diff
   B           Broadcast toggle (sync panes)

 MARKDOWN & FILE BROWSING (Yazi + Glow + Grip + mdr)
 ─────────────────────────────────────────────────────────────────────────────
   f           Yazi file browser (new window)
   m           Glow markdown preview (horiz split)

   Inside Yazi:
   Enter       Open file (Glow for .md)      M           Preview with Glow
   G           Open in browser (Grip)        o           Open-with menu (all openers)
   cc          Copy full file path            Tab         Toggle preview pane
   gg          Jump to top                   gh          Go to home dir
   g Space     Zoxide jump                   /           Search files

   From shell:
   glow <file>             Terminal markdown preview (night-owl theme)
   mo <file>               Browser preview (dark mode, live reload, Mermaid)
   grip <file> -b          GitHub-exact preview in browser
   mdserve <file> --open   Live-reload browser preview (AI agent companion)

 COPY MODE (vi-style)
 ─────────────────────────────────────────────────────────────────────────────
   [           Enter copy mode               /  ?        Search forward/back
   v           Begin selection               y           Copy to clipboard
   Escape      Cancel

 OTHER
 ─────────────────────────────────────────────────────────────────────────────
   g           GitHub browse

╭──────────────────────────────────────────────────────────────────────────────╮
│  Press q to close                                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
EOF
