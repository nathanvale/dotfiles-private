# Herdr theming research

Date: 2026-09-09 (Australia/Melbourne)

## Finding

Herdr can be themed. Its default UI theme is `catppuccin`; the installed
release is 0.9.0. Night Owl is not a built-in theme name, but Herdr supports
the two practical ways to use it:

1. Set `theme.name = "terminal"` and configure the host terminal with Night
   Owl. Herdr then derives its UI colours from the host terminal ANSI palette.
2. Select any built-in dark base, such as `one-dark`, and override every
   Herdr palette token in `[theme.custom]` with Night Owl values.

The first approach keeps Herdr aligned with Ghostty or another host terminal
as its palette changes. The second controls the Herdr UI independently. It
does not change the terminal emulator's palette or an application's own theme.

## Supported configuration

`[theme]` supports `name`, `auto_switch` (default `false`), `dark_name`, and
`light_name`. `theme.name` defaults to `catppuccin`. Built-ins are
`catppuccin`, `catppuccin-latte`, `terminal`, `tokyo-night`,
`tokyo-night-day`, `dracula`, `nord`, `gruvbox`, `gruvbox-light`, `one-dark`,
`one-light`, `solarized`, `solarized-light`, `kanagawa`, `kanagawa-lotus`,
`rose-pine`, `rose-pine-dawn`, and `vesper`.

`[theme.custom]` can override `accent`, `panel_bg`, `sidebar_bg`,
`active_row_bg`, `selection_bg`, `surface0`, `surface1`, `surface_dim`,
`overlay0`, `overlay1`, `text`, `subtext0`, `mauve`, `green`, `yellow`, `red`,
`blue`, `teal`, and `peach`. Values accept hex, named colours, `rgb(r,g,b)`,
and `reset` aliases. With `auto_switch = true`, the same keys can appear in
`[theme.custom.light]` and `[theme.custom.dark]`; they apply after the shared
custom table.

Sources: [official configuration guide](https://herdr.dev/docs/configuration/),
[official config reference](https://herdr.dev/docs/config-reference/), and
[current upstream theme parser](https://github.com/herdrdev/herdr/blob/68c7b78ec237034cbb0e21c8666842ed7991641d/src/config/theme.rs).

## Apply and reload

On macOS, edit `~/.config/herdr/config.toml`. First validate with
`herdr config check`, then apply the live UI change with
`herdr server reload-config`, or choose `reload config` in Herdr's global
menu. The reload applies most presentation settings without restarting panes;
startup-only settings still need a restart. Themes are client-local, including
while viewing an SSH machine. The in-app reload action reloads both the local
client and selected server configuration.

Source: [official reload documentation](https://herdr.dev/docs/configuration/#reload-config).

## Terminal palette boundary

`theme.name = "terminal"` is specifically the bridge from the host terminal's
ANSI palette to the Herdr UI. Herdr also queries the host's default foreground,
background, and ANSI palette, then supplies that palette to its embedded pane
terminal. Therefore changing `[theme.custom]` themes Herdr chrome, while
changing Ghostty's Night Owl palette controls terminal and ANSI-aware
application colours. The source confirms that the host palette is queried and
applied to pane terminals.

Sources: [official theme documentation](https://herdr.dev/docs/configuration/#theme),
[terminal palette query source](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/terminal_theme.rs), and
[pane palette application source](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/pane/terminal.rs#L1181-L1208).

## Existing Night Owl configurations

Two public GitHub configurations already implement it:

- [devtough/dotfiles](https://github.com/devtough/dotfiles/blob/ffea689f0febd90fb0feefda8f172015f93492b0/night-owl/herdr-theme-block.toml)
  uses `name = "terminal"`, transparent `panel_bg`, and Night Owl's blue
  accent, expecting Ghostty to provide the Night Owl ANSI palette.
- [matija/dotfiles](https://github.com/matija/dotfiles/blob/0318efd6fb45ad74e7279f66f6b975963e923633/herdr/nightowl-theme.toml)
  uses `one-dark` plus a complete Night Owl override table. This is the useful
  template when a fixed Herdr UI is wanted irrespective of the host terminal.

Both are third-party examples, not official Herdr theme packs. The upstream
built-in theme list does not include Night Owl.

## Local state

`config/herdr/config.toml` currently declares no `[theme]` table, so either
approach would be additive. This research made no configuration change and did
not reload Herdr.
