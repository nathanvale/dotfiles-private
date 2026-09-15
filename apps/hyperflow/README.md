# HyperFlow

Simple keyboard-driven app launching and SuperWhisper mode switching powered by the **Hyper Key**.

## Overview

Replaces AeroSpace with a simpler, more powerful solution:

- **Hyper Key** (Caps Lock) - One modifier key for everything
- **Karabiner** for keyboard shortcuts
- **One script** (`hyperflow.sh`) for all app launching
- **SuperWhisper mode switching** integrated automatically
- **Raycast Window Management** for window positioning

## The Hyper Key Revolution

**Caps Lock = Hyper Key (Ctrl+Opt+Cmd+Shift)** when held, Caps Lock when tapped alone.

This unlocks a **completely conflict-free namespace** of shortcuts:

- ✅ **No conflicts** - macOS and apps rarely use this modifier combo
- ✅ **Ergonomic** - One pinky hold + right hand for any key
- ✅ **Scalable** - 26+ letters, 10 numbers, all symbols available
- ✅ **Muscle memory** - Single modifier for all custom workflows
- ✅ **Future-proof** - Add new shortcuts without breaking existing ones

**Why this is powerful**: You have an entire keyboard layer just for you. No more memorizing complex
Cmd+Opt+Shift+X combos or worrying about conflicts with app shortcuts.

## Architecture

```
User holds Caps Lock + 1 (Hyper+1)
    ↓
Karabiner intercepts Hyper+1
    ↓
Runs: hyperflow.sh 1
    ↓
Opens Ghostty + switches to "default" mode
```

## Keyboard Shortcuts

**All shortcuts use the Hyper Key (Caps Lock when held):**

### Navigation & Editing

- **Hyper+J**: Down arrow
- **Hyper+K**: Up arrow
- **Hyper+L**: Right arrow
- **Control+H/J/K/L**: Arrow navigation for left/down/up/right
- **Hyper+[**: Escape
- **Hyper+\\**: Cycle tmux sessions

### Primary Apps (Control+Number)

**Personal (default):**
- **Control+1**: Ghostty (Terminal)
- **Control+2**: Visual Studio Code
- **Control+3**: Google Chrome (Browser)
- **Control+4**: Codex
- **Control+5**: Slack
- **Control+6**: Zoom
- **Control+7**: Unassigned

**Work overlay (example, when selected in `~/.dotfiles_state/work-profile`):**
- **Control+1**: Ghostty (Terminal)
- **Control+2**: Google Chrome (Browser)
- **Control+3**: Safari (Browser)
- **Control+4**: Microsoft Outlook
- **Control+5**: Microsoft Teams
- **Control+6**: Mode switch only
- **Control+7**: Microsoft Outlook

A work overlay loads from `~/.config/hyperflow/workspaces.<slug>.json` only when
`~/.dotfiles_state/work-profile` holds that slug: the same fixed machine-state
selector `.zshrc` uses. The file must hold exactly one slug passing the
work-profile grammar (1 to 32 characters, lowercase letters, digits, single
interior hyphens); the ambient `WORK_PROFILE` variable is never consulted.
Otherwise `workspaces.json` applies. Keep employer-specific workspace files in
the private work repo, not here. The neutral
[`workspaces.example.json`](../../config/hyperflow/workspaces.example.json)
contains only generic application shortcuts; copy and customize it in that
private owner before selecting a work profile. Renaming a tracked example
does not migrate an existing machine overlay.

### Secondary Apps (Hyper+Letter)

- **Hyper+C**: ChatGPT
- **Hyper+M**: Messages
- **Hyper+F**: Finder
- **Hyper+O**: 1Password
- **Hyper+N**: Notion
- **Hyper+R**: Reminders
- **Hyper+I**: Music
- **Hyper+P**: Podcasts
- **Hyper+S**: Structured

### Window Management (Raycast Native Hotkeys)

Set these directly in Raycast (not through Karabiner):

- Left/Right/Top/Bottom Half, Maximize, Center, Toggle Fullscreen

📖 See [WINDOW_MANAGEMENT.md](./WINDOW_MANAGEMENT.md) for setup instructions.

## System Integration

HyperFlow orchestrates multiple tools into a unified keyboard-driven workflow:

### The Stack

```
┌──────────────────────┐
│   You (Caps Lock)    │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Karabiner-Elements  │  ← Converts Caps Lock to Hyper key
│  (Keyboard Layer)    │    Routes Hyper+Key → Shell commands
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│    HyperFlow.sh      │  ← Launches apps, triggers mode switching
│  (Orchestration)     │    Handles focus restoration
└───┬────────┬─────┬───┘
    │        │     │
    ▼        ▼     ▼
┌─────┐ ┌────────┐ ┌─────────┐
│macOS│ │SuperW. │ │ Raycast │
│Apps │ │ Modes  │ │ Windows │
└─────┘ └────────┘ └─────────┘
```

### Components

1. **Karabiner-Elements**: System-wide keyboard remapping
   - Maps Caps Lock → Hyper (Ctrl+Opt+Cmd+Shift)
   - Routes all Hyper+Key combos to shell commands
   - Zero app conflicts

2. **HyperFlow** (`hyperflow.sh`): Orchestration layer
   - Single script routes shortcuts to handlers
   - Launches/focuses apps via AppleScript
   - Triggers SuperWhisper mode switching
   - Coordinates focus restoration

3. **SuperWhisper Mode Switcher**: Context-aware voice input
   - Automatically switches dictation modes per app
   - Modes: default, casual-text, professional-engineer, email
   - Debouncing prevents mode-switch spam
   - Restores focus after mode change

4. **Raycast**: Window management
   - Native hotkeys (not through Karabiner)
   - Faster than deeplink approach
   - Replaces tiling managers like AeroSpace

5. **Claude Code**: Development assistant
   - Understands HyperFlow architecture
   - Custom slash commands for dotfiles
   - Maintains consistency when editing configs

### Flow Example

```
User: Caps Lock + 2
  ↓
Karabiner: Hyper+2 detected → Run hyperflow.sh 2
  ↓
HyperFlow: open_and_activate "Visual Studio Code"
  ↓
macOS: VS Code activated (or launched if not running)
  ↓
HyperFlow: superwhisper-mode-switch.sh "default" &
  ↓
SuperWhisper: Mode switched, focus restored to VS Code
  ↓
Result: VS Code focused, voice dictation in coding mode
```

### Why This Architecture

- **Separation of concerns**: Each tool has one job
- **No daemon overhead**: Scripts run on keyboard events only
- **Composable**: Swap components independently
- **Debuggable**: Each layer logs separately
- **Fast**: Direct shell execution, no IPC
- **Extensible**: Add apps/modes without touching other layers

## Installation

### 1. Set Up Hyper Key

In Karabiner-Elements:

1. Go to **Complex Modifications** tab
2. Click **"Add predefined rule"**
3. Search for: **"Caps Lock → Hyper Key (⌃⌥⇧⌘) (Caps Lock if alone)"**
4. Import and enable it

This maps Caps Lock to Hyper when held, Caps Lock when tapped.

### 2. Configure App Launching

The Karabiner configuration in `config/karabiner/karabiner.json` is already set up with:

- Hyper key app launching (Hyper+1-7, Hyper+Letters)
- Navigation shortcuts (Hyper+J/K/L and Control+H/J/K/L for arrows, Hyper+[ for escape)
- tmux session cycling (Hyper+backslash)

No manual configuration needed - just ensure Karabiner is running.

### 3. Make Scripts Executable

```bash
chmod +x ~/code/dotfiles/bin/hyperflow/hyperflow.sh
chmod +x ~/code/dotfiles/bin/hyperflow/superwhisper-mode-switch.sh
```

## Usage

Just press the keyboard shortcut - the script handles:

1. Opening/activating the application
2. Switching SuperWhisper to the appropriate mode
3. Debouncing rapid key presses (via SuperWhisper mode switcher)

## SuperWhisper Modes

Each app automatically switches to the appropriate mode:

| App                                                                                               | Mode                    |
| ------------------------------------------------------------------------------------------------- | ----------------------- |
| Ghostty, Arc, Google Chrome, Finder, 1Password, Notion, Reminders, Music, Podcasts, Structured | `default`               |
| Microsoft Teams                                                                                   | `professional-engineer` |
| Mail, Microsoft Outlook                                                                           | `email`                 |
| Messages                                                                                          | `casual-text`           |

## Window Management (Optional)

Use Raycast's built-in Window Management for positioning:

**Recommended Raycast Shortcuts:**

- **Ctrl+Alt+Left**: Left Half
- **Ctrl+Alt+Right**: Right Half
- **Ctrl+Alt+Up**: Top Half
- **Ctrl+Alt+Down**: Bottom Half
- **Ctrl+Alt+M**: Maximize
- **Ctrl+Alt+C**: Center
- **Ctrl+Alt+F**: Toggle Fullscreen

Set these in: Raycast → Extensions → Window Management → Configure shortcuts

## Customization

### Add a New App

Edit `hyperflow.sh` and add a new case:

```bash
"X")
    open_and_activate "YourApp"
    "$SUPERWHISPER_SWITCHER" "your-mode" &
    ;;
```

Then add the Karabiner keybinding in `karabiner.json`.

### Change SuperWhisper Mode

Edit the mode in the script's case statement for that app.

## Troubleshooting

### App not opening

- Check if the app name is correct: `ls /Applications/`
- Ensure script is executable: `chmod +x hyperflow.sh`

### SuperWhisper mode not switching

- Check if SuperWhisper is running: `ps aux | grep -i superwhisper`
- Enable debug mode: `export SUPERWHISPER_DEBUG=1`
- View logs: `tail -f /tmp/superwhisper-debug.log`

### Keyboard shortcut not working

- Check Karabiner is running
- Verify JSON syntax in `karabiner.json`
- Look at Karabiner EventViewer to see if key is detected

## Migration from AeroSpace

If migrating from AeroSpace:

1. **Keep SuperWhisper mode switcher** - already integrated
2. **Remove AeroSpace autostart** if you want
3. **Keep existing scripts** in `bin/aerospace/` for reference
4. **Test each shortcut** to ensure it works

## File Structure

```
bin/hyperflow/
├── README.md                      # This file
├── WINDOW_MANAGEMENT.md           # Window management setup guide
├── hyperflow.sh                   # Main app launcher orchestrator
└── superwhisper-mode-switch.sh    # Context-aware voice mode switcher
```

## Dependencies

- **Karabiner-Elements**: Keyboard remapping
- **SuperWhisper**: Voice dictation with mode switching
- **Raycast** (optional): Window management

## Performance

- **App launch time**: Instant (macOS handles it)
- **Mode switch time**: 400ms debounced (configurable)
- **Memory footprint**: Minimal (no background daemon)
- **CPU usage**: Negligible (only runs on keypress)

## Advantages Over AeroSpace

✅ Simpler - one script, no tiling manager complexity ✅ Faster - no workspace management overhead
✅ Native - uses macOS app activation ✅ Flexible - easy to add/remove apps ✅ Portable - works on
any Mac with Karabiner ✅ Maintainable - single script to understand

## Notes

- Script runs in background (`&`) to avoid blocking keyboard
- Uses same SuperWhisper debounce logic from AeroSpace setup
- AppleScript activation ensures app gets keyboard focus
- Supports both letter and number workspace identifiers
