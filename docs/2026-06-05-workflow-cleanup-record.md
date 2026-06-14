---
title: "Workflow Cleanup Record"
type: change-record
status: complete
date: 2026-06-05
audience: human-and-agent
---

# Workflow Cleanup Record

## Summary

- Optimized zsh startup for everyday terminal and tmux use.
- Kept autocomplete, Atuin, fzf, autosuggestions, syntax highlighting, fnm, pyenv, and direnv.
- Removed the terminal quick reference and startup reminder.
- Added `hyperfine` for repeatable terminal startup benchmarks.
- Cleaned Superwhisper mode configuration for agent-heavy dictation.
- Added `agent-context` for quick repo/tmux orientation.
- Did not delete Superwhisper recordings.
- Did not delete VS Code extensions.
- Added one new Superwhisper keyboard shortcut.
- Added five new tmux agent-prefix controls.
- Did not remove existing keyboard shortcuts.

## Terminal Changes

- Removed `.zshrc` sourcing from `.zprofile`.
- Made `~/.zshenv` side-effect-free.
- Stopped automatic secret loading in every shell.
- Added explicit `load-secrets`.
- Added explicit `sync-launchctl-env`.
- Fixed zsh completion function paths before `compinit`.
- Switched to `compinit -C` for faster startup.
- Added `refresh-completions` for manual completion cache rebuilds.
- Replaced stale fzf startup loading with Homebrew fzf shell files.
- Filtered known Homebrew fzf startup noise.
- Removed duplicate Bun completion setup.
- Removed dead aliases.
- Changed shell timing to use `EPOCHREALTIME`.
- Removed the quick reference banner.
- Removed the old startup reminder path.

## Benchmark Results

- Baseline normal terminal: about `155 ms`.
- Baseline tmux pane: about `140 ms`.
- After cleanup normal terminal: about `122 ms`.
- After cleanup tmux pane: about `126 ms`.
- Bare zsh stayed about `4 ms`.

## Superwhisper Changes

- Added `agent-prompt` mode for dictated agent instructions.
- Tuned `agent-prompt` to preserve commands, paths, URLs, env vars, repo names, API names, and uncertainty.
- Added missing `daily-note` mode.
- Connected `daily-note` to `bin/obsidian-daily-capture`.
- Added `daily-note` to Superwhisper mode keys.
- Normalized `professional-engineer` mode to the newer Superwhisper mode schema.
- Added `bin/superwhisper-agent`.
- Made HyperFlow's Superwhisper switcher list modes from actual mode files.
- Made HyperFlow reject unknown Superwhisper modes before opening a deep link.
- Removed the stale advertised `melanie` mode from the switcher output by making the list dynamic.
- Added narrow dictation replacements for `.zshrc`, `tmux`, `Karabiner`, `Codex`, `Superwhisper`, and `APIs`.

## Agent Context Command

- Added `bin/agent-context`.
- Printed current path, repo root, branch, upstream, dirty count, tmux location, context files, package scripts, and status preview.
- Added `--json`.
- Added `--help`.
- Added `--version`.
- Kept it read-only.
- Avoided prompts, network calls, clipboard writes, and file edits.
- Capped the status preview at 20 lines.

## Tmux Agent Workflow

- Added `bin/tmux/agent-status`.
- Added `bin/tmux/agent-scratchpad`.
- Added `bin/agent-brief`.
- Added `bin/review-my-diff`.
- Added `Ctrl-g A i` for `agent-context`.
- Added `Ctrl-g A s` for `agent-status`.
- Added `Ctrl-g A p` for `agent-scratchpad`.
- Added `Ctrl-g A b` for `agent-brief`.
- Added `Ctrl-g A r` for `review-my-diff`.
- Added tmux pane titles for spawned `claude`, `gemini`, `codex`, and `openai` panes.
- Kept existing tmux bindings in place.
- Kept existing Karabiner bindings in place.
- Updated `tx` picker preview with branch, dirty count, session windows, pane commands, and paths.
- Updated tmux cheat sheet.
- Updated tmuxinator agent docs.

## Keyboard Changes

- Added `Right Shift + Option + A`.
- Routed it to `bin/superwhisper-agent`.
- Kept `Right Shift + Option + Space` routed to `bin/superwhisper-daily-note`.
- Left existing Karabiner bindings unchanged.

## Left Alone

- Left Superwhisper recordings on disk.
- Left inactive mode files in place.
- Left email mode in place.
- Left existing Karabiner shortcuts in place.
- Left app-generated Superwhisper settings changes intact.
- Left unrelated dirty repo files untouched.

## Still Worth Deciding

- Decide whether to archive or keep inactive Superwhisper modes.
- Decide whether to prune old Superwhisper recordings after checking backups.
- Try `Right Shift + Option + A` for a few agent prompts before adding more voice shortcuts.
- Try `Ctrl-g A i`, `Ctrl-g A s`, `Ctrl-g A p`, `Ctrl-g A b`, and `Ctrl-g A r` during a real agent session.

## Raycast Resource Audit (2026-06-06)

### Why

- Original goal was freeing system resources by removing Karabiner.
- Measured footprint flipped the premise: Raycast is the heavy consumer, not Karabiner.

### Measured Footprint

- Raycast: `232 MB` resident across 3 processes.
- Karabiner: `91 MB` resident across daemons plus DriverKit extension.
- Conclusion: keep Karabiner; target Raycast background-refresh extensions instead.

### Constraint

- Raycast settings live in encrypted DBs (`raycast-enc.sqlite`, `raycast-activities-enc.sqlite`).
- The plist (`com.raycast.macos.plist`) holds no extension or interval keys.
- No scriptable path: every change below is a manual toggle in `Raycast > Settings > Extensions`.
- Last-launched usage data is encrypted and unreadable, so "unused" items are flagged as decisions, not asserted facts.

### Background-Refresh Extensions Found

- Set Audio Device: two enforcers every `10s`.
- Messages: unread poll every `2m`.
- Port Manager: menu bar every `1m`.
- GitHub: four menu-bar commands every `15m`.
- 1Password: auto-renew authorization every `9m`.
- Apple Reminders: menu bar every `10m`.
- Arc: spaces and favorites every `10m`.

### Correction: Set Audio Device Is Not Waste

- Earlier draft told to disable Set Audio Device; that was wrong.
- The two `10s` enforcers (`auto-switch-input`, `auto-switch-output`) ARE the mic auto-switcher.
- Behaviour: Elgato Wave:3 plugged in -> Wave default; unplugged -> MacBook mic.
- The `10s` poll is how it detects plug/unplug (polling, not event-driven).
- Keep it enabled. Never deactivate to save RAM.
- Note: refresh intervals are baked into each extension `package.json` by the author. Users cannot edit the seconds value; the only lever is Deactivate / Background-Refresh off.

### Wave Link Removed (2026-06-14)

- Removed Elgato Wave Link entirely; kept the Wave:3 as a bare USB condenser mic.
- Reason: Wave Link only adds a streamer audio mixer, not mic quality; AI transcription does not need it.
- Voice isolation now via macOS Voice Isolation (Control Center > Mic Mode), available on macOS 26.5, works on any mic, no Elgato software.
- Bonus: removed the phantom Wave Link virtual devices (Personal/Chat/Stream Mix) that confused the audio auto-switcher.
- Removed (user-level, to Trash): `/Applications/Elgato Wave Link.app`, `~/Library/Application Support/com.elgato.WaveLink3`, `ElgatoTelemetry`, `~/Library/Preferences/com.elgato.WaveLink3.plist`, `~/Library/Caches/com.elgato.WaveLink3`.
- Removed (system, sudo): `/Library/Audio/Plug-Ins/HAL/WaveLink3VirtualAudio.driver`, `ParrotAudioPlugin.driver`, then `killall coreaudiod`.
- Verified: device list now shows only Elgato Wave:3, MacBook Pro Microphone, MacBook Pro Speakers. Wave:3 is default input.
- No login items or launch agents existed, so drivers will not reload.

### Actions Applied (2026-06-14, manual in Raycast Settings)

- [x] GitHub: trimmed to fewer menu-bar commands (four `15m` pollers reduced).
- [x] Arc: extension uninstalled (Arc browser unused).
- [x] Port Manager: Background Refresh toggled OFF for `Open Ports in Menu Bar` (no more `1m` poll).
- [x] Set Audio Device: KEPT (it is the mic auto-switcher, not waste).
- [x] Messages: `Unread Messages` menu-bar poll toggled OFF (no more `2m` poll); on-demand commands kept.
- [x] Apple Reminders: extension uninstalled (removed the `10m` poll).
- [x] Aerospace Tiling Window Manager: uninstalled (HyperFlow uses Raycast native window management, not Aerospace).

### Auto-Restart Agent (2026-06-14)

- Raycast RAM drifts upward over multi-day uptime (renderer churn from menu-bar commands). Restarting resets it.
- Added a threshold-based launchd agent: checks every `2h`, restarts Raycast only if RSS exceeds `300 MB`. No-op when lean.
- Files (all in dotfiles, reproducible):
  - `bin/system/raycast_restart_if_bloated.sh` - measures total Raycast RSS, restarts if over threshold.
  - `config/launchd/com.nathanvale.raycast-restart.plist` - `StartInterval` `7200`, `RunAtLoad` false, logs to `/tmp/raycast-restart.log`.
  - `bin/dotfiles/symlinks/symlinks_manage.sh` - added LaunchAgent symlink entry.
  - Symlink: `~/Library/LaunchAgents/com.nathanvale.raycast-restart.plist`.
- Threshold tunable via `RAYCAST_RESTART_THRESHOLD_MB`; cadence via plist `StartInterval`.
- Verified live: caught Raycast at `338 MB`, restarted, dropped to `195 MB`.

### Result

- Raycast RAM: `232 MB` (start) / `338 MB` (peak observed) -> `~196 MB` stable.
- Karabiner kept (was never the problem; it is the lighter tool).
- Wave Link grief eliminated; mic switching now reliable on a clean device list.
- At the optimization floor: the only remaining background poller is 1Password auto-renew at `9m`, which is required for auth. Further removals (Lorem Ipsum, HTTP Status Codes, etc.) are launcher decluttering, not RAM savings, since on-demand commands cost nothing at idle.

### Keep As-Is

- 1Password auto-renew at `9m` (needed for auth; the only remaining background poller).
- Set Audio Device enforcers at `10s` (the mic auto-switcher).
- Karabiner (lighter than Raycast; owns tap-hold and Hyper-layer primitives Raycast cannot replicate).

### Why Raycast Cannot Replace Karabiner

- Caps Lock tap-to-Escape plus hold-to-Control needs `to_if_alone`; Raycast tap always emits the original key.
- Hyper+H/J/K/L to arrow keys needs key-to-key passthrough to the focused app; Raycast hotkeys only launch Raycast commands.
- Right Command to a 4-modifier Hyper chord is partial in Raycast (built around Caps Lock as source).
