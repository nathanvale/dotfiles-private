# Night Owl theme contract

VS Code's installed `sdras.night-owl@2.1.1` theme is the source of truth for
this desktop. The checked `Night Owl-color-theme.json` SHA-256 is
`5f7a6aebcb28e803f30b54dc4d401a8c5f9ca42d83a31d1fadcb2494fe1dc78b`.
This document preserves the shared palette because the extension itself is
installed outside this repository.

## Core palette

| Role | Value |
| --- | --- |
| Surface | `#011627` |
| Elevated surface | `#0B253A` |
| Foreground | `#D6DEEB` |
| Muted foreground | `#5F7E97` |
| Accent | `#7E57C2` |
| Blue | `#82AAFF` |
| Purple | `#C792EA` |
| Cyan | `#21C7A8` |
| Green | `#22DA6E` |
| Yellow | `#C5E478` |
| Red | `#EF5350` |
| Added gutter | `#9CCC65` |

## Semantic rules

- Use `#9CCC65` for added-line markers and `#EF5350` for removed-line markers.
- VS Code's diff backgrounds are translucent. Terminal renderers use opaque
  composites over `#011627`: `#162C31` for added lines and `#31222F` for
  removed lines.
- Preserve the ANSI palette in the Ghostty theme. Terminal applications inherit
  those values rather than defining their own near matches.

## Active consumers

| Consumer | Configuration |
| --- | --- |
| VS Code | [`config/vscode/settings.json`](../config/vscode/settings.json) selects `Night Owl`. |
| Ghostty | [`config/ghostty/themes/NightOwlDark`](../config/ghostty/themes/NightOwlDark) supplies the ANSI palette. |
| Herdr | [`config/herdr/config.toml`](../config/herdr/config.toml) uses the terminal theme. |
| tmux | [`config/tmux/tmux-night-owl.conf`](../config/tmux/tmux-night-owl.conf) uses the shared UI colors. |
| Bat | [`config/bat/themes/Night Owl.tmTheme`](../config/bat/themes/Night%20Owl.tmTheme) mirrors Night Owl syntax colors. |
| Glow | [`.zshrc`](../.zshrc) selects the Night Owl Glow style. |
| Git and Lazygit | [`.gitconfig`](../.gitconfig) configures Delta, which Lazygit uses for diffs. |
| lnav | [`config/lnav/config.json`](../config/lnav/config.json) selects `night-owl`. |
| Lazygit UI | [`config/lazygit/config.yml`](../config/lazygit/config.yml) maps borders, selections, authors, and status colours. |
| Yazi UI | [`config/yazi/theme.toml`](../config/yazi/theme.toml) maps surfaces, tabs, selections, and file roles. Built-in file icons and syntax preview colours are separate. |
| fzf and eza | [`.zshrc`](../.zshrc) defines RGB search highlights and file-list colours. New shells load these values. |
| OpenCode | [`config/opencode/tui.jsonc`](../config/opencode/tui.jsonc) selects the tracked [`night-owl`](../config/opencode/themes/night-owl.json) theme. |

## Typography and diff layout

Ghostty uses JetBrains Mono at 14 points with normal character width and 8%
extra cell height. VS Code uses the same family at 18 CSS pixels (approximately
13.5 points), with editor line height 1.4 and terminal line height 1.15.
These are starting values for similar apparent size, not measured visual parity.

Lazygit's Delta renderer switches to side-by-side only when each side has at
least 60 content columns. Plain Git uses unified Delta output; `delta
--side-by-side` opts into a wide view. VS Code switches to inline below 1100
pixels and wraps diff lines. Codex Desktop's import sets the code font family;
its size and spacing have not been changed or verified.

## Manual consumers

| Consumer | Required action |
| --- | --- |
| Codex Desktop | Import the clipboard payload in the Dark theme panel. Codex Desktop does not retain a named import artifact in this repository. |
| Home Assistant | Include the theme file in the live server's `frontend.themes` configuration, reload themes, and select `Night Owl`. |

Update this contract and every listed consumer together when the palette
changes. It is intentionally on demand and is not part of agent startup
instructions.
