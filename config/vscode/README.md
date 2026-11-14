# VS Code Configuration

Complete VS Code setup integrated with dotfiles architecture, including Copilot prompts, settings,
and task management workflow.

## Architecture Overview

All VS Code configuration is symlinked from dotfiles, mirroring the standard `.vscode` folder
structure from Git repositories:

```
~/code/dotfiles/config/vscode/
├── settings.json        → ~/Library/Application Support/Code/User/settings.json
├── tasks.json           → ~/Library/Application Support/Code/User/tasks.json
├── prompts/             → ~/Library/Application Support/Code/User/prompts/
│   ├── Next.prompt.md
│   ├── Merge.prompt.md
│   ├── SETTINGS.md
│   └── README.md
└── README.md            → this file
```

This structure matches the standard `.vscode` folder layout used in Git repositories.

**Benefits:**

- ✅ Version controlled in git
- ✅ Easy restoration on new machines
- ✅ Single source of truth
- ✅ Consistent with dotfiles architecture
- ✅ Auto-approval settings persist across reinstalls

## Installation

### Automatic (Recommended)

All symlinks are created automatically by the dotfiles installation script:

```bash
cd ~/code/dotfiles/bin/dotfiles/symlinks
./symlinks_manage.sh --link
```

This creates symlinks for:

- ✅ `settings.json` (includes Copilot auto-approval)
- ✅ `tasks.json` (VS Code tasks)
- ✅ `prompts/` (Copilot prompt files)

### Manual Installation

If needed, create symlinks manually:

```bash
# Create VS Code User directory
mkdir -p ~/Library/Application\ Support/Code/User

# Symlink settings and tasks
ln -sf ~/code/dotfiles/config/vscode/settings.json ~/Library/Application\ Support/Code/User/settings.json
ln -sf ~/code/dotfiles/config/vscode/tasks.json ~/Library/Application\ Support/Code/User/tasks.json

# Symlink prompts directory
ln -sf ~/code/dotfiles/config/vscode/prompts ~/Library/Application\ Support/Code/User/prompts
```

### Enable Prompt Files

After symlinks are created:

1. Open VS Code Settings (Cmd+,)
2. Search for `chat.promptFiles`
3. Enable the setting
4. Reload VS Code: Cmd+Shift+P → `Developer: Reload Window`

## Settings Configuration

The symlinked `settings.json` includes all required configuration:

```json
{
  "chat.agent.maxRequests": 300,
  "chat.promptFiles": true,

  // Copilot Auto-Approval (Required for /merge and /next prompts)
  "chat.tools.global.autoApprove": true,
  "editor.codeActionsOnSave": {
    "source.fixAll": "explicit"
  },
  // Editor
  "editor.formatOnSave": true
}
```

### What These Settings Do

**`chat.tools.global.autoApprove: true`**

- Enables "YOLO mode" - auto-approves all tool operations
- Eliminates confirmation dialogs for terminal commands
- **Required** for `/merge` and `/next` prompts to work
- Security warning: Not recommended for untrusted workspaces

**`chat.agent.maxRequests: 300`**

- Maximum requests an agent can make before asking to continue
- Default: 25
- Prevents "continue iteration" interruptions during complex tasks

**`chat.promptFiles: true`**

- Enables the prompt files feature
- Required to use `/merge` and `/next` commands

### Alternative: Selective Auto-Approval

For more control, enable auto-approval only for specific commands:

```json
{
  "chat.tools.terminal.autoApprove": {
    "chmod": false,
    "chown": false,
    "curl": false,
    "del": false,
    "eval": false,
    "kill": false,
    "rm": false,
    "rmdir": false,
    "wget": false
  },
  "chat.tools.terminal.enableAutoApprove": true
}
```

## Copilot Prompt Files

### Available Prompts

#### `/next` - Start Next Task

Atomically selects, locks, and starts the next highest-priority task.

**Usage:**

```
/next
```

**Workflow:**

1. Finds READY tasks sorted by priority
2. Atomically locks task (prevents race conditions)
3. Reads task requirements
4. Creates git worktree
5. Sets up development environment
6. Guides implementation
7. Creates PR when complete

**Delegation:** Reads `~/.claude/commands/next.md` for instructions

#### `/merge` - Merge PR and Cleanup

Merges a completed PR and performs complete cleanup.

**Usage:**

```
/merge              # Merge PR from current worktree
/merge 123          # Merge PR #123
/merge T0030        # Merge task T0030
/merge PROJ-0005    # Merge task PROJ-0005
```

**What it does:**

- Executes `~/.claude/scripts/merge-pr.sh`
- Detects git provider (GitHub/Azure DevOps)
- Verifies PR status
- Merges to main branch
- Deletes remote and local branches
- Removes worktree
- Cleans up task locks
- Updates local main branch

**Performance:**

- Optimized with batched API calls (2 instead of 4-5)
- 40-50% faster than manual workflow

**Delegation:** Reads `~/.claude/commands/merge.md` for instructions

### Complete Task Lifecycle

```
/next → Implementation → PR Review → /merge → Repeat
  ↓           ↓              ↓           ↓
Lock       Worktree      Approval    Cleanup
Task       Changes       Process     Everything
```

### Prompt Design Philosophy

Both prompts follow the **delegation pattern**:

- Minimal prompt files that reference command files
- Single source of truth in `~/.claude/commands/`
- No duplication of workflow logic
- Automatic updates when command files change
- Works with both Claude Code and VS Code Copilot

## Testing the Configuration

After installation:

1. Reload VS Code: Cmd+Shift+P → `Developer: Reload Window`
2. Open Chat view (Cmd+Alt+I)
3. Type `/next` or `/merge`
4. Commands should execute without confirmation dialogs

If you still see permission prompts, verify:

- `settings.json` symlink points to dotfiles
- `chat.tools.global.autoApprove` is `true` in settings
- VS Code was reloaded after changing settings

## Syncing Across Devices

To sync prompt files across multiple devices:

1. Enable **Settings Sync** in VS Code
2. Run **Settings Sync: Configure** (Cmd+Shift+P)
3. Select **Prompts and Instructions** from sync options

Your prompt files will now sync across all VS Code installations.

**Note:** Settings Sync also syncs `settings.json`, but the symlink approach ensures you have a
local backup in your dotfiles.

## Directory Structure

```
config/vscode/               # Mirrors standard .vscode folder from Git
├── settings.json            # VS Code settings (symlinked)
├── tasks.json               # VS Code tasks (symlinked)
├── prompts/                 # Copilot prompt files (symlinked)
│   ├── Next.prompt.md       # /next command
│   ├── Merge.prompt.md      # /merge command
│   ├── SETTINGS.md          # Detailed settings guide
│   └── README.md            # Prompts documentation
├── CODE_SHOTGUNS.md         # Shotgun CLI + Shotgun Surgery concepts
└── README.md                # This file - complete documentation
```

## Troubleshooting

### Prompts not found

```bash
# Verify symlink
readlink ~/Library/Application\ Support/Code/User/prompts

# Should output:
# /Users/nathanvale/code/dotfiles/config/vscode/prompts
```

### Permission prompts still appear

```bash
# Check settings.json content
cat ~/code/dotfiles/config/Code/User/settings.json | grep autoApprove

# Should include:
# "chat.tools.global.autoApprove": true
```

### Settings not taking effect

1. Verify symlink points to vscode folder:
   ```bash
   readlink ~/Library/Application\ Support/Code/User/settings.json
   # Should output: /Users/nathanvale/code/dotfiles/config/vscode/settings.json
   ```
2. Reload VS Code: Cmd+Shift+P → `Developer: Reload Window`
3. Check for syntax errors in settings.json

## Related Documentation

**Local Documentation:**
- [CODE_SHOTGUNS.md](./CODE_SHOTGUNS.md) - Comprehensive guide to Shotgun CLI (spec-driven development tool) and Shotgun Surgery (anti-pattern to avoid). Essential reading for AI-powered development workflows.

## References

- [VS Code Prompt Files Documentation](https://code.visualstudio.com/docs/copilot/customization/prompt-files)
- [VS Code 1.104 - Global Auto Approve](https://code.visualstudio.com/updates/v1_104#_global-auto-approve)
- [GitHub Copilot Custom Instructions](https://docs.github.com/en/copilot/concepts/prompting/response-customization)
- [Community Prompt Examples](https://github.com/github/awesome-copilot/tree/main)
- [Stack Overflow: Auto-approve Copilot Commands](https://stackoverflow.com/questions/79720577/)

**External Resources:**
- [Shotgun CLI Official Site](https://shotgun.sh/)
- [Shotgun CLI GitHub](https://github.com/shotgun-sh/shotgun)
- [Shotgun Surgery - Wikipedia](https://en.wikipedia.org/wiki/Shotgun_surgery)

## Shared isolated editor configuration

Dotfiles owns the personal baseline in `settings.json`, `keybindings.json`
and `extensions.json`. `isolated.json` owns the overrides and excluded setting
prefixes for the isolated container editor. The daily editor's existing links
and the remote-development launcher are unchanged.

Run `bun run vscode --help` from this checkout. Bun is required. This is a
configuration command, not an editor launcher or a container provisioner.

### Preview, then apply

An admitted target is an existing root containing separate `user-data/User`
and `extensions` directories. There is deliberately no default editor target.
Preview reads the target, writes a private plan outside it, and never runs Code:

```sh
bun run vscode preview \
  --target "$HOME/.local/state/remote-devcontainer-isolation/trial-01" \
  --code "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --json
```

Read the returned `data.plan`. It contains exact before/after configuration,
source and artifact hashes, installed extension versions and proposed effects.
The plan is mode 0600 under a mode 0700 per-target state directory. Treat it as
private because existing settings may contain personal values. Preview reports
blockers without applying anything.

For a local extension absent at the requested version, supply a matching VSIX
in preview with `--vsix publisher.name=/absolute/file.vsix`. Its embedded
identity/version and bytes are checked. Use the extension's existing packaging
owner; never copy installed extension directories or their native registries.
The initial Nathan ADHD Helper declaration is the observed 0.3.6. Main's source
is 0.3.5, so that source must not be packaged as a supposed 0.3.6 artifact.

Only when activation is separately intended, save buffers and close the isolated
editor yourself. Then apply the exact returned plan path:

```sh
bun run vscode apply --plan /absolute/returned-plan.json --editor-closed --json
bun run vscode status --plan /absolute/returned-plan.json --json
```

`--editor-closed` is the operator's assertion. The command does not inspect UI
buffers or prove that VS Code is closed. Keep it closed throughout apply and
rollback; comparison before rename is not an atomic lock against another editor.
Apply never opens or reloads VS Code. Preview alone is appropriate while editing.

Apply refuses changed source, targets, extension inventory, executable or VSIX,
and refuses consumed or unfinished previews. Applying a completed plan again is
a no-op if its results still match. Concurrent apply/rollback has one lock owner.

### Where to make changes

Edit the dotfiles baseline, preview again, and explicitly apply. Settings and
keybindings are installed as snapshots, so source edits do not bypass preview.
Deleted baseline settings disappear on the next apply. Target-only settings are
preserved. Direct changes in the isolated User settings/keybindings cause drift
refusal: preserve the edit, reconcile it into dotfiles if appropriate, and
restore the last managed target bytes before creating another preview. There is
no automatic reverse sync or force overwrite.

The composed User settings apply to container windows using this same isolated
client. Remote, workspace and language overrides retain VS Code's precedence;
keep project-specific configuration in the project. Another isolated client
directory requires its own preview/apply. No shared Docker container is needed.
Do not enable Settings Sync in this client without choosing its conflict and
exclusion policy first.

### Extensions and connection controls

- `client` contains exact initial UI versions from the personal inventory.
  Apply uses native Code CLI installation with the isolated data/extension
  paths, no pack/dependency expansion, and no forced transport upgrades.
- `protected` versions must already be installed exactly. Their setup and
  upgrades remain with the connection owner. Dev Containers stays at 0.469.0.
- `local` contains local extensions requiring a matching VSIX when absent.
- `workspace` contains IDs requested by `dev.containers.defaultExtensions`.
  A later authorized native container connection performs platform-appropriate
  installation. These are requests, not proof of installation or pinned remote
  versions. No container is contacted by this command. Removing an ID stops
  requesting it; it does not uninstall it.

The declaration captures all 16 observed personal extensions, with the isolated
transport versions preserved. Prettier and Markdown Preview Enhanced are
referenced by personal settings but were absent from that inventory. They are
not silently added. Terminal profiles and terminal environment settings excluded
by the isolated policy are not imported; the personal lazygit profile therefore
needs a later explicit decision for the container platform.

The isolated overlay wins over personal preferences: credential/helper copying,
automatic forwarding, transport updates, AI features, tool auto-approval,
script execution and restoring windows stay disabled. Autosave stays off until
the operator deliberately changes the isolated policy. Workspace trust stays on.
UI preferences such as font, theme and accessibility otherwise use the baseline.
The installer clears `SSH_AUTH_SOCK`, removes `VSCODE_IPC_HOOK_CLI` and portable
mode, and always passes both isolated directories. The existing launcher,
strict SSH configuration and `ForwardAgent=no` remain their own owners.

### Interrupted work and rollback

Intent is fsynced before configuration changes or installer launch. Readback
records completion. A failed or cancelled install is nonretryable until inspected;
status never replays effects. The installer has a 120 second deadline, bounded
output, ignored stdin and a task-owned process group killed on SIGINT/SIGTERM.
There are no diagnostic streams or background jobs; the private journal is the
recovery owner.

After interruption, inspect status and native registry readback. A stale lock
reports its PID. Prove that PID has exited before manually removing only that
plan's state `lock` directory; PID reuse or an empty owner record needs manual
inspection. Never remove a live owner's lock.

```sh
bun run vscode rollback --plan /absolute/returned-plan.json --editor-closed --json
```

Rollback restores exact previous configuration bytes and removes a keybindings
file only if this apply created it. It refuses edits that match neither the
saved before nor after bytes. Only the active plan can roll back. Installed
extensions are retained and returned in the result; rollback does not promise
extension uninstall or restoration of upgraded client extension versions.

Tests use temporary targets, a copied source checkout and a fake native CLI.
They prove process contracts and durable file behavior, not effective settings
or extension activation in a running editor or container. Those checks require
a later authorized activation.

Microsoft references:
[settings precedence](https://code.visualstudio.com/docs/configure/settings#_settings-precedence),
[container extension defaults](https://code.visualstudio.com/docs/devcontainers/containers#_managing-extensions),
[CLI extension installation](https://code.visualstudio.com/docs/configure/command-line),
[Settings Sync](https://code.visualstudio.com/docs/configure/settings-sync).
