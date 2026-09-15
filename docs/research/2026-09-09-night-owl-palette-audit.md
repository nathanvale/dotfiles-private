# Night Owl palette audit

Date: 2026-09-09 (Australia/Melbourne)

## Canonical local palette

The installed VS Code Night Owl extension is the canonical source. Its terminal
palette is mirrored in [`config/ghostty/themes/NightOwlDark`](../../config/ghostty/themes/NightOwlDark):

| Role | Value |
| --- | --- |
| Background | `#011627` |
| Foreground | `#d6deeb` |
| Cursor | `#7e57c2` |
| Selection | `#5f7e97` |
| ANSI red | `#ef5350` |
| ANSI green | `#22da6e` |
| ANSI yellow | `#c5e478` (`#ffeb95` bright) |
| ANSI blue | `#82aaff` |
| ANSI magenta | `#c792ea` |
| ANSI cyan | `#21c7a8` (`#7fdbca` bright) |

[`config/ghostty/config`](../../config/ghostty/config) selects `NightOwlDark`, so this is active. Ghostty loads a named custom theme from its theme directories and a theme defines the palette, background, foreground, cursor, and selection values. [Ghostty theme documentation](https://ghostty.org/docs/features/theme)

## Consumers and drift

| Path | Status | Finding |
| --- | --- | --- |
| [`config/ghostty/config`](../../config/ghostty/config), [`config/ghostty/themes/NightOwlDark`](../../config/ghostty/themes/NightOwlDark) | Active | Canonical source. |
| [`config/tmux/tmux.conf`](../../config/tmux/tmux.conf), [`config/tmux/tmux-night-owl.conf`](../../config/tmux/tmux-night-owl.conf) | Active | `tmux.conf` sources the Night Owl file. Its primary accent is `#7e57c2`, with VS Code's input surface `#0b253a` and muted foreground `#5f7e97`. Tmux supports literal RGB styles. [tmux documentation](https://github.com/tmux/tmux/wiki/Getting-Started#colours-and-styles) |
| [`config/bat/config`](../../config/bat/config), [`config/bat/themes/Night Owl.tmTheme`](../../config/bat/themes/Night%20Owl.tmTheme) | Active | `bat` selects the tracked theme. Its background and foreground match; its syntax palette includes `#c5e478`, `#f78c6c`, and `#ffcb8b`, which are Night Owl syntax roles but not values in Ghostty's ANSI table. [bat theme documentation](https://github.com/sharkdp/bat#adding-new-themes) |
| [`config/vscode/settings.json`](../../config/vscode/settings.json) | Active, extension-owned | Selects `workbench.colorTheme: "Night Owl"`. The installed extension is `sdras.night-owl@2.1.1`; its payload is not tracked here, so exact token-by-token parity cannot be proven from this repository. VS Code persists the active theme in user settings. [VS Code theme documentation](https://code.visualstudio.com/docs/configure/themes) |
| [`.gitconfig`](../../.gitconfig), [`config/lazygit/config.yml`](../../config/lazygit/config.yml) | Active | Lazygit invokes Delta for side-by-side diffs. Delta now renders VS Code's translucent added and removed diff overlays as their opaque composites over `#011627`, with `#9ccc65` and `#ef5350` gutter numbers. The same configuration applies to Git's Delta pagers. [Delta configuration documentation](https://dandavison.github.io/delta/configuration.html) |
| [`config/herdr/config.toml`](../../config/herdr/config.toml) | Active | `theme.name = "terminal"` makes Herdr inherit Ghostty's Night Owl ANSI palette. [Herdr theme documentation](https://herdr.dev/docs/configuration/#theme) |
| [`config/glow/glow.yml`](../../config/glow/glow.yml), [`.zshrc`](../../.zshrc) | Active | `glow.yml` defaults to `auto`, but `.zshrc` exports `GLAMOUR_STYLE=$HOME/.config/glow/night-owl.json`; an interactive shell resolved that exact path. The Night Owl style is therefore active when Glow starts through your shell. Glow accepts a style name or JSON path. [Glow documentation](https://github.com/charmbracelet/glow#the-config-file) |
| [`config/lnav/config.json`](../../config/lnav/config.json), [`config/lnav/configs/default/night-owl.json.sample`](../../config/lnav/configs/default/night-owl.json.sample) | Active | lnav selects `night-owl`; the shipped definition provides its UI and syntax roles. lnav themes are JSON configuration. [lnav documentation](https://docs.lnav.org/en/stable/config.html) |
| [`README.md`](../../README.md), [`vscode-extensions-backup.txt`](../../vscode-extensions-backup.txt) | Reference or archive | These mention Night Owl but do not configure a running UI. |

Herdr, tmux, Bat, Delta, and Glow now use the VS Code Night Owl palette. Glow
uses a Night Owl JSON style through its shell environment rather than its
default configuration file.

## Home Assistant

[`config/home-assistant/themes/night-owl.yaml`](../../config/home-assistant/themes/night-owl.yaml)
now contains the palette as a Home Assistant dark theme. This checkout still
has no `configuration.yaml` or `frontend.themes` declaration, and the locally
reachable Home Assistant paths do not reveal the live server's theme location.
The theme file is ready to include from that server configuration, but does not
establish the selected theme.

Home Assistant supports custom frontend themes under `frontend: themes:`,
including dark-mode layers, and reloads YAML definitions through
`frontend.reload_themes`. [Home Assistant frontend theming documentation](https://www.home-assistant.io/integrations/frontend/#defining-themes)

## Scope and proof

The audit was followed by a targeted alignment of Ghostty, tmux, Bat, and
Herdr, plus a Home Assistant theme file. Home Assistant was not queried or
changed.
