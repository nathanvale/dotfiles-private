# Terminal colour environment boundary

Date: 2026-08-24 (Australia/Melbourne)

## Conclusion

The durable repair needs two boundaries:

1. Frontier Runner must `unset NO_COLOR` before `open -na Ghostty.app`, so Ghostty and the persistent Herdr server never inherit the non-interactive Harness preference.
2. Interactive `.zshrc` startup must clear an inherited `NO_COLOR`, so directly opened Claude Code and Codex sessions recover even when some other launcher starts Ghostty with that variable.

Ghostty documents `env = KEY=` as removing a key from commands launched in a terminal surface. However, a live macOS canary against installed Ghostty 1.3.1 started the app with `NO_COLOR=1` and observed that `env = NO_COLOR=` still left `NO_COLOR=1` in the child. Ghostty's execution source explains the result: configured environment entries are added as overrides, while an empty config value removes the entry from the override map rather than explicitly removing the inherited process variable. [Ghostty `env` reference](https://ghostty.org/docs/config/reference#env), [Ghostty child-environment source](https://github.com/ghostty-org/ghostty/blob/main/src/termio/Exec.zig)

After applying the two-boundary repair, restart any existing Herdr server. Herdr is persistent, and its server launch uses a normal child process without clearing the inherited environment. A server that already inherited `NO_COLOR` can therefore continue passing it to panes even after the launch path is fixed. [Herdr server launch source](https://github.com/motionharvest/herdr/blob/16d69614fee452da41d2e088f2273110b9be7eb0/src/server/autodetect.rs#L148-L167), [Rust `Command` environment semantics](https://doc.rust-lang.org/std/process/struct.Command.html#method.env_clear)

## Why the terminal still has colour capability

`NO_COLOR` is not a terminal capability declaration. The convention says that a present, non-empty `NO_COLOR` asks command-line applications to suppress ANSI colour. Its own FAQ explicitly distinguishes that preference from whether the terminal is capable of displaying colour. [NO_COLOR convention](https://no-color.org/)

`TERM` and `COLORTERM` describe capabilities. Ghostty normally advertises its terminfo identity through `TERM`; its documentation explains the `xterm-ghostty` value and the reduced `xterm-256color` fallback. [Ghostty terminfo documentation](https://ghostty.org/docs/help/terminfo) Herdr deliberately replaces the outer terminal identity for each pane with `TERM=xterm-256color` and `COLORTERM=truecolor`. [Herdr pane environment source](https://github.com/motionharvest/herdr/blob/16d69614fee452da41d2e088f2273110b9be7eb0/src/pane.rs#L39-L50) Therefore the colour loss is consistent with an application-level `NO_COLOR` override, not a missing 256-colour capability.

## Product findings

### Ghostty

Ghostty remains responsible for terminal capability variables, but its current `env` option is not a proven removal boundary for a variable already present in the macOS app process. The observed Ghostty 1.3.1 behaviour and the implementation source both require removing `NO_COLOR` before Launch Services starts Ghostty. [Ghostty configuration reference](https://ghostty.org/docs/config/reference#env), [Ghostty child-environment source](https://github.com/ghostty-org/ghostty/blob/main/src/termio/Exec.zig)

Do not replace `TERM` or `COLORTERM` as part of this repair. Ghostty and Herdr already own those capability values.

### Herdr

The current Motion Harvest Herdr fork creates each pane command, adds its own identity variables, and applies the fixed terminal capability values before spawning the pane. It does not remove `NO_COLOR` in that path. [Shell pane spawn](https://github.com/motionharvest/herdr/blob/16d69614fee452da41d2e088f2273110b9be7eb0/src/pane.rs#L1241-L1261), [command pane spawn](https://github.com/motionharvest/herdr/blob/16d69614fee452da41d2e088f2273110b9be7eb0/src/pane.rs#L1277-L1299)

This makes a Herdr theme change irrelevant to the root cause. Herdr correctly advertises colour capability, while its children can still obey an independently inherited `NO_COLOR` signal.

### Claude Code

Anthropic's current settings reference states that `NO_COLOR` and `FORCE_COLOR` placed in Claude Code's JSON `env` block reach subprocesses only. To change Claude Code's own interface, those variables must be set or unset in the shell before `claude` starts. [Claude Code settings reference](https://code.claude.com/docs/en/settings-reference#how-env-values-interact-with-your-shell)

Therefore a Claude-specific settings entry is not the durable repair. Removing `NO_COLOR` before Claude starts is the documented boundary. Claude Code separately supports ANSI and 256-colour theme values such as `ansi256(n)`, confirming that its UI can use the terminal palette when suppression is absent. [Claude Code terminal and theme configuration](https://code.claude.com/docs/en/terminal-config#match-the-color-theme)

### OpenAI Codex CLI

Codex's TUI source asks the `supports-color` crate for stdout's colour level, then distinguishes truecolour, ANSI 256, ANSI 16, and unknown capability levels. [Codex terminal palette source](https://github.com/openai/codex/blob/main/codex-rs/tui/src/terminal_palette.rs#L6-L20) The upstream crate explicitly checks `NO_COLOR`, `TERM`, `COLORTERM`, terminal attachment, and force-colour variables; `NO_COLOR` can reduce the detected level to no colour even when `COLORTERM=truecolor` or `TERM` advertises 256 colours. [supports-color source](https://docs.rs/supports-color/latest/src/supports_color/lib.rs.html#54-106)

This is direct source evidence that clearing `NO_COLOR`, rather than forcing a different `TERM`, is the appropriate Codex fix.

### Lazygit

The installed Lazygit is 0.64.0. Its tracked `config/lazygit/config.yml` contains one custom command and no colour or theme override, so the local configuration is not suppressing colour.

Lazygit's vendored Tcell terminal backend first detects `TERM` and `COLORTERM`, then explicitly sets the available colour count to zero whenever `NO_COLOR` is non-empty. The shared shell and Frontier Runner repair therefore covers Lazygit too; no Lazygit-specific configuration change is needed. [Lazygit Tcell colour detection at the audited commit](https://github.com/jesseduffield/lazygit/blob/ea916395469808d37d726ae183fa40fd575a9d8a/vendor/github.com/gdamore/tcell/v3/tscreen.go#L399-L436), [Lazygit user configuration](https://github.com/jesseduffield/lazygit/blob/ea916395469808d37d726ae183fa40fd575a9d8a/docs/Config.md)

### Yazi

The installed Yazi is 26.5.6. Its tracked `config/yazi/yazi.toml` and `keymap.toml` contain workflow and keybinding changes but no colour override, and no user `theme.toml` exists. Yazi therefore uses its shipped theme.

A complete source search at audited commit `519939b5ab9c76e56ca5549d72c08a0e9dd5aab3` found no `NO_COLOR` or `FORCE_COLOR` handling. Yazi identifies Ghostty from `GHOSTTY_RESOURCES_DIR`, `TERM=xterm-ghostty`, or `TERM_PROGRAM=ghostty`, and owns colour through its shipped light/dark themes. No Yazi-specific repair is indicated; clearing the leaked variable remains useful for Yazi's previewers and child commands. [Yazi terminal-brand detection](https://github.com/sxyazi/yazi/blob/519939b5ab9c76e56ca5549d72c08a0e9dd5aab3/yazi-emulator/src/brand.rs#L49-L86), [Yazi default theme configuration](https://github.com/sxyazi/yazi/blob/519939b5ab9c76e56ca5549d72c08a0e9dd5aab3/yazi-config/preset/README.md)

## Context7 coverage

Context7 was queried first, with library IDs resolved before documentation queries:

| Product | Resolved corpus | Result |
| --- | --- | --- |
| Ghostty | `/ghostty-org/website` | Relevant `env` documentation found; the documented removal claim did not match the installed 1.3.1 live canary. |
| Claude Code | `/anthropics/claude-code` | No documentation matched the environment and colour query. Official Anthropic documentation filled the gap. |
| OpenAI Codex CLI | `/openai/codex` | Relevant terminal colour detection source found. |
| Herdr | `/herdrdev/herdr` | Relevant pane environment source found. The installed Motion Harvest fork was then verified directly at a fixed commit. |
| NO_COLOR | No distinct corpus | Context7 has no relevant specification corpus. The convention's own site was used. |

Context7 did not establish a precise `open -na Ghostty.app` environment-inheritance contract. Apple's Launch Services API exposes an explicit launch environment, but that does not prove that `open -na` always copies or always drops the caller's full environment. [Apple `NSWorkspace.OpenConfiguration.environment`](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/environment) The live canary established the relevant local behaviour: `NO_COLOR=1` reached a Ghostty child without launcher sanitation, and was absent when the launcher unset it before `open -na`.

## Firecrawl coverage

Firecrawl's developer index was searched after Context7 for Ghostty, Claude Code, Codex, Herdr, Lazygit, and Yazi. It found the first-party Ghostty configuration/source material, the Anthropic report describing the same long-lived `NO_COLOR` inheritance failure, Codex source, Lazygit configuration and terminal-colour reports, and Yazi's source/theme documentation. Repository checkouts at fixed commits were used where Firecrawl snippets were insufficient to establish the precise code path.

## Configuration boundaries to avoid

- Do not set `FORCE_COLOR=1` globally. It overrides an intentional no-colour preference in many tools and can emit escapes into non-interactive output.
- Do not rely on `env = NO_COLOR=` in Ghostty 1.3.1 to remove a value inherited by the app process; the live canary disproved that boundary.
- Do not change Herdr's `TERM` or `COLORTERM`; its current values already advertise ANSI 256 and truecolour support.
- Do not put `NO_COLOR` or `FORCE_COLOR` in Claude Code's JSON `env` block to control Claude's own TUI; Anthropic documents that those entries apply only to subprocesses.
- Do not rely only on a one-time `unset NO_COLOR` command. It repairs one shell process, not the durable Ghostty launch boundary or an already-running Herdr server.
