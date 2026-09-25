# `bin/` command inventory

This file is the maintained ownership map for tracked files under `bin/`. It
records the intended invocation, the effective path class, the source owner,
and the covering route or test. It is a review index, not a replacement for a
command's `--help`, source, or owning package documentation.

Check this inventory against `git ls-files --stage 'bin/**'`. Git mode
100755 identifies executable regular files; mode 120000 identifies a symlink
whose target must be qualified separately. This README is the inventory owner.
Add a row when a command or support file is added, moved, retired, or changes
invocation mode. Keep unresolved ownership as `unverified`; an absent
tracked path reference does not prove that a command is unused.

## Exposure classes

| Class | Effective invocation | Evidence and boundary |
| --- | --- | --- |
| `TOP` | `command` for a top-level `bin/<command>` | `bin/dotfiles/symlinks/symlinks_manage.sh:61-64` maps `$HOME/bin` to the repository `bin`; `.zshenv:46-59` makes `$HOME/bin` available in login, interactive, and non-interactive zsh. |
| `TMUX` | `command` for `bin/tmux/<command>` | The same managed `$HOME/bin` tree supplies the path; `.zshrc:19-22` adds `$HOME/bin/tmux` for interactive zsh. |
| `ENV` | `command` for `bin/env/<command>` | The same managed `$HOME/bin` tree supplies the path; `.zshrc:19-22` adds `$HOME/bin/env` for interactive zsh. |
| `LOCAL` | `command` through an explicit `~/.local/bin` symlink | The manager owns `lm-studio-ensure.sh` through `symlinks_manage.sh`; `.zshenv` makes `~/.local/bin` available in all zsh modes. |
| `DIRECT` | `bin/path/to/file` or an explicit absolute path | The file is not a basename lookup on the shell PATH. Its caller, package, launch agent, app integration, or a human must name it. |
| `TEST` | `bin/test/...` directly, or `bun test ...` for TypeScript | `bin/test/README.md:3-38` owns the test directory. The inventory uses the current Git executable modes, with explicit direct commands in that README. |
| `TEMPLATE` | Copy the template into a new command | `bin/templates/README.md:5-9` owns the copy route; templates are not installed public commands. |
| `RETIRED` | Explicit path only when historical recovery is required | `bin/deprecated/` is the repository's retired area. These rows remain visible so a stale caller can be found before removal. |

The managed `bin` tree is the only source recorded for `HOME/bin`. This
inventory assigns no owner to an external `~/.local/bin/env` producer. The
interactive `ENV` class means `HOME/bin/env`; an external local `env` file is
outside this repository and remains unverified.

Status labels in the tables are deliberately narrow:

- `public` means a user, app, launch agent, config, or package route is
  intended to invoke the file.
- `helper` means the file is sourced, wrapped, or otherwise consumed by another
  command.
- `unqualified` means the file has an invocation shape, but this checkout does
  not establish a current caller or dedicated covering test. It is not a claim
  that the file is unused or retired.
- `test`, `retired`, and `template` identify their repository roles.

## Top-level commands

These 46 executable files are exposed as `TOP` through the managed `HOME/bin`
directory. The command column shows the basename after activation; the direct
path remains valid when a caller has not activated the managed tree.

| Status | File | Intended invocation | Source owner and covering route |
| --- | --- | --- | --- |
| public | `bin/agent-brief` | `agent-brief [--json\|--help\|--version]` | Source: self. Route: `config/tmux/tmux.conf:145`; Help route: `agent-brief --help`; no dedicated behavior test is recorded. |
| public | `bin/agent-context` | `agent-context [--json\|--help\|--version]` | Source: self. Route: `config/tmux/tmux.conf:142`; Help route: `agent-context --help`; no dedicated behavior test is recorded. |
| public | `bin/agent-lane-audit` | `agent-lane-audit [--receipt-dir PATH]` | Source: self. Covering command: `bin/test/agent-lane-audit-test.sh`. |
| public | `bin/agent-lane-launch` | `agent-lane-launch [LANE]` | Source: self. Covering command: `bin/test/agent-lane-launch-test.sh`. |
| public | `bin/agent-lane-receipt` | `agent-lane-receipt --lane NAME ...` | Source: self. Covering command: `bin/test/agent-lane-receipt-test.sh`. |
| public | `bin/agent-lane-zsh` | `CLAUDE_CODE_SHELL=.../bin/agent-lane-zsh ...` | Source: self. Covering commands: `bin/test/agent-lane-zsh-test.sh` and `bin/test/toolchain-bootstrap-test.sh`. |
| public | `bin/agent-skills-inventory` | `agent-skills-inventory [--json]` | Source: self. Owner docs: `docs/agents/skills.md:199`; covering command: `bun test bin/test/agent-skills-inventory.test.ts` (the test is non-executable). |
| public | `bin/atuin-agent-history` | `atuin-agent-history search ...` | Source: self. Covering command: `bin/test/atuin-agent-history-test.sh`. |
| public | `bin/browser-lane` | `browser-lane <command> ...` | Source: self. Owner doc: `docs/agents/browser-automation.md:13`; covering command: `bin/test/browser-lane-test.sh`. |
| unqualified | `bin/claude-migrate-native` | `bin/claude-migrate-native` | Source: self. It is an effectful migration route; current tracked caller and dedicated covering test are unverified. |
| public | `bin/cloudflare-access-headers` | `bin/cloudflare-access-headers` | Source: self. Owner doc: `.claude/skills/dotfiles/references/sensitive-material-access.md:96`; covering command: `bin/test/cloudflare-access-headers-test.sh`. |
| helper | `bin/colour_log.sh` | `source bin/colour_log.sh` | Source owner: sourced logger. Consumers: `bin/dotfiles/symlinks/symlinks_manage.sh`, `bin/system/fonts/nerd_fonts_manage.sh`, `config/macos/defaults.common.sh`; covering commands: `bin/test/symlinks-manage-test.sh` and `bin/test/symlinks-real-directory-test.sh`. |
| unqualified | `bin/downloads` | `downloads <recent\|search\|clear\|apps\|week\|today\|month\|stats>` | Source: self help. Current tracked caller and dedicated covering test are unverified. |
| unqualified | `bin/filevault-check` | `filevault-check` | Source: self help. Current tracked caller and dedicated covering test are unverified. |
| public | `bin/ghh` | `ghh exec --account LOGIN -- <gh arguments...>` | Source: self. Covering command: `bin/test/ghh-test.sh`. |
| public | `bin/hyperflow` | `hyperflow <mode>` | Source: `apps/hyperflow/hyperflow.sh` through the wrapper. Route: `config/karabiner/karabiner.json:167-389`; package docs: `apps/hyperflow/README.md`. |
| public | `bin/mail-to-obsidian` | `bin/mail-to-obsidian` | Source: self. Route: `config/karabiner/karabiner.json:287`; no dedicated test is recorded. |
| public | `bin/obsidian-daily-capture` | `obsidian-daily-capture [TEXT]` | Source: self. Routes: `config/macrowhisper/macrowhisper.json:60` and `config/superwhisper/modes/daily-note.json:27`; no dedicated test is recorded. |
| unqualified | `bin/obsidian-restart.sh` | `bin/obsidian-restart.sh` | Source: self. Current tracked caller and dedicated covering test are unverified. |
| direct | `bin/open-chrome-clipboard` | `open-chrome-clipboard PROFILE_DIRECTORY` | Source: self. No tracked machine-specific shortcut is installed. |
| unqualified | `bin/open-dev-document` | `open-dev-document FILE [FILE ...]` | Source: self help. Current tracked caller and dedicated covering test are unverified. |
| unqualified | `bin/quarantine` | `quarantine <subcommand>` | Source: self help. Current tracked caller and dedicated covering test are unverified. |
| unqualified | `bin/raycast_install_extensions.sh` | `bin/raycast_install_extensions.sh` | Source: self. It opens extension store pages; current tracked caller and dedicated covering test are unverified. |
| public | `bin/review-my-diff` | `review-my-diff` | Source: self. Route: `config/tmux/tmux.conf:146`; The command has a help path; no dedicated behavior test is recorded. |
| unqualified | `bin/speak` | `speak <speak\|voices\|save>` | Source: self help. The shell contract mentions its identity, but a current caller and dedicated command test are unverified. |
| public | `bin/superwhisper-agent` | `bin/superwhisper-agent` | Source: self. Route: `config/karabiner/karabiner.json:334`; no dedicated test is recorded. |
| public | `bin/superwhisper-daily-note` | `bin/superwhisper-daily-note` | Source: self. Route: `config/karabiner/karabiner.json:321`; no dedicated test is recorded. |
| unqualified | `bin/superwhisper-debug` | `bin/superwhisper-debug` | Source: self. Current tracked caller and dedicated covering test are unverified. |
| unqualified | `bin/superwhisper-default` | `bin/superwhisper-default` | Source: self. The script documents a Karabiner trigger, but the current tracked route is unverified. |
| unqualified | `bin/superwhisper-email` | `bin/superwhisper-email` | Source: self. The script documents a Karabiner trigger; the current tracked route is unverified. |
| public | `bin/superwhisper-email-complete` | `bin/superwhisper-email-complete` | Source: self. Route: `config/macrowhisper/macrowhisper.json:78`; no dedicated test is recorded. |
| public | `bin/taskdock` | `taskdock <subcommand>` | Source owner: `apps/taskdock/bin/taskdock` through the wrapper. Covering commands: `apps/taskdock/tests/integration-test.sh` and `apps/taskdock/scripts/shellcheck-all.sh`. |
| public | `bin/taskdock-vscode` | `taskdock-vscode` | Source owner: `apps/taskdock/ux/vscode-next.sh` through the wrapper. Route: `apps/taskdock/setup.sh:31`; no dedicated bin test is recorded. |
| public | `bin/teams-reply` | `teams-reply <search-text> <file\|->` | Source: self plus `bin/lib/teams-automation.sh`. Owner doc: `config/agents/skills/personal/teams/SKILL.md:297`; no dedicated test is recorded. |
| public | `bin/teams-send` | `teams-send <conversation> <file\|-> [--send]` | Source: self plus `bin/lib/teams-automation.sh`. Owner doc: `config/agents/skills/personal/teams/SKILL.md:297`; no dedicated test is recorded. |
| unqualified | `bin/test-plugin-without-symlink.sh` | `bin/test-plugin-without-symlink.sh <setup\|restore\|status>` | Source: self. It is a manual, effectful test with hard-coded machine paths; current tracked caller and covering route are unverified. |
| public | `bin/tode-diff` | `tode-diff BEFORE AFTER` | Source: self. Owner doc: `docs/dev-shortcuts.md:52`; covering route is `git difftool` through Herdr. |
| unqualified | `bin/trimmy` | `trimmy [arguments]` | Source: `/Applications/Trimmy.app/Contents/Helpers/TrimmyCLI` through the wrapper. Current tracked caller and dedicated covering test are unverified. |
| public | `bin/vault` | `vault <subcommand>` | Source owner: `apps/vault` through the wrapper. Owner doc: `VAULT_SYSTEM.md:18`; route: `config/tmuxinator/fullstack.yml:35`. |
| public | `bin/with-one-password-token` | `with-one-password-token <check\|op\|inject\|inject-stdin> ...` | Source: self. Owner docs: `.claude/skills/dotfiles/references/sensitive-material-access.md:51` and `config/agents/skills/personal/one-password/SKILL.md`; covering command: `bin/test/with-one-password-token-test.sh`. |
| unqualified | `bin/worktree-recency` | `worktree-recency` | Source: self. It emits Git worktree recency rows; current tracked caller and dedicated covering test are unverified. |

## Direct production commands and helpers

These executable files are not basename commands on the shell PATH. Call them
by their explicit repository path, by their managed `HOME/bin` path where the
class says so, or through the owner that names them.

| Status | File | Intended invocation | Path class | Source owner and covering route |
| --- | --- | --- | --- | --- |
| public | `bin/dotfiles/symlinks/symlinks_manage.sh` | `bin/dotfiles/symlinks/symlinks_manage.sh --link\|--unlink\|--status [--force]` | `DIRECT` | Source owner and single mapping owner: this script. Routes: `setup.sh:240-247`, `setup.sh:299-302`, `verify_install.sh:475-477`; covering commands: `bin/test/symlinks-manage-test.sh` and `bin/test/symlinks-real-directory-test.sh`. |
| public | `bin/dotfiles/toolchain` | `bin/dotfiles/toolchain status\|update [--json]` | `DIRECT` | Source owner: this script. Routes: `setup.sh:642`, `verify_install.sh:165`, `config/toolchain/README.md:45`; covering commands: `bin/test/toolchain-status-test.sh`, `bin/test/toolchain-apply-test.sh`, and `bin/test/toolchain-bootstrap-test.sh`. |
| unqualified | `bin/env/sync-docker-mcp` | `sync-docker-mcp [--dry-run\|--setup\|--filter PATTERN]` | `ENV` | Source: self help. It is available as `HOME/bin/env/sync-docker-mcp` in interactive zsh; current tracked caller and covering test are unverified. |
| unqualified | `bin/system/fonts/nerd_fonts_manage.sh` | `bash bin/system/fonts/nerd_fonts_manage.sh [--add\|--remove]` | `DIRECT` | Source: self plus `bin/colour_log.sh`. No external caller or dedicated covering test is verified. |
| unqualified | `bin/system/iterm/iterm_preferences_manage.sh` | `bash bin/system/iterm/iterm_preferences_manage.sh [--export\|--import\|--delete]` | `DIRECT` | Source: self plus the intended `colour_log.sh` helper. No external caller or dedicated covering test is verified. |
| public | `bin/system/lm-studio-ensure.sh` | `~/.local/bin/lm-studio-ensure.sh` or the explicit repository path | `LOCAL` | Source: self. Server symlink route: `bin/dotfiles/symlinks/symlinks_manage.sh:92-95`; covering command: `bin/test/lm-studio-ensure-test.sh`. |
| public | `bin/system/raycast_restart_if_bloated.sh` | launchd invokes the explicit repository path | `DIRECT` | Source: self. Owner route: `config/launchd/com.nathanvale.raycast-restart.plist:10`; no dedicated test is recorded. |

## Tmux commands

These 11 executable files live under the interactive `TMUX` class. Files with
no current config or test owner remain listed as `unqualified`; their presence
is not a deletion recommendation.

| Status | File | Intended invocation | Source owner and covering route |
| --- | --- | --- | --- |
| public | `bin/tmux/agent-scratchpad` | `agent-scratchpad [--help]` | Source: self. Route: `config/tmux/tmux.conf:144`; no dedicated test is recorded. |
| public | `bin/tmux/agent-status` | `agent-status [--help]` | Source: self. Route: `config/tmux/tmux.conf:143`; no dedicated test is recorded. |
| public | `bin/tmux/cheatsheet.sh` | `bash bin/tmux/cheatsheet.sh` | Source: self. Route: `config/tmux/tmux.conf:55`; no dedicated test is recorded. |
| unqualified | `bin/tmux/cycle-attached.sh` | `bash bin/tmux/cycle-attached.sh` | Source: self. Current tracked caller and covering test are unverified. |
| unqualified | `bin/tmux/open-vscode.sh` | `bash bin/tmux/open-vscode.sh` | Source: self. Current tracked caller and covering test are unverified. |
| unqualified | `bin/tmux/smart-detach.sh` | `bash bin/tmux/smart-detach.sh` | Source: self. Current tracked caller and covering test are unverified. |
| unqualified | `bin/tmux/test-migration.sh` | `bash bin/tmux/test-migration.sh` | Source: self. It tests the SideQuest migration seam; current tracked caller and covering route are unverified. |
| public | `bin/tmux/tx` | `tx [project\|path] [template]` | Source: self. Owner doc: `.claude/rules/architecture.md:43`; route: `config/tmux/tmux.conf:124`. |
| public | `bin/tmux/upgrade-ai-tools.sh` | `bash bin/tmux/upgrade-ai-tools.sh` | Source: self. Route: `config/tmux/tmux.conf:150`; no dedicated test is recorded. |
| public | `bin/tmux/worktree-ai.sh` | `bash bin/tmux/worktree-ai.sh [branch-name]` | Source: self plus `bin/tmux/sidequest-common.sh`. Route: `config/tmux/tmux.conf:139`; no dedicated test is recorded. |
| public | `bin/tmux/worktree-delete.sh` | `bash bin/tmux/worktree-delete.sh` | Source: self plus `bin/tmux/sidequest-common.sh`. Route: `config/tmux/tmux.conf:140`; no dedicated test is recorded. |

## Retired and template executables

| Status | File | Intended invocation | Path class | Source owner and covering route |
| --- | --- | --- | --- | --- |
| retired | `bin/deprecated/console-ninja` | explicit historical path only | `RETIRED` | Source: tracked mode-120000 retired symlink; its external target is unverified. No current caller or covering test is expected; locate stale references before removal. |
| retired | `bin/deprecated/setup_mnemosyne.sh` | `bash bin/deprecated/setup_mnemosyne.sh` only for historical recovery | `RETIRED` | Source: retired file. No current caller or covering test is verified. |
| retired | `bin/deprecated/ssh_config_remove.sh` | `bash bin/deprecated/ssh_config_remove.sh` only for historical recovery | `RETIRED` | Source: retired file; it sources `colour_log.sh`. No current caller or covering test is verified. |
| template | `bin/templates/cli-template` | copy into `bin/<new-command>` | `TEMPLATE` | Source owner: `bin/templates/README.md:9`; covering route is the documented `cp` command. |
| template | `bin/templates/cli-template.sh` | copy into `bin/<new-command>` | `TEMPLATE` | Source owner: `bin/templates/README.md:9`; covering route is the documented `cp` command. |

## Executable tests

These mode-100755 files are `TEST` commands. `bin/test/README.md` owns their
invocation map and describes the process and qualification boundaries.

| Status | Test command | Covers | Source owner and covering command |
| --- | --- | --- | --- |
| test | `bin/test/agent-lane-audit-test.sh` | `bin/agent-lane-audit` and its launcher inventory | Test source: this file. Run: `bin/test/agent-lane-audit-test.sh`. |
| test | `bin/test/agent-lane-launch-test.sh` | `bin/agent-lane-launch` | Test source: this file. Run: `bin/test/agent-lane-launch-test.sh`. |
| test | `bin/test/agent-lane-receipt-test.sh` | `bin/agent-lane-receipt` and the zsh contract handoff | Test source: this file. Run: `bin/test/agent-lane-receipt-test.sh`. |
| test | `bin/test/agent-lane-zsh-test.sh` | `bin/agent-lane-zsh` | Test source: this file. Run: `bin/test/agent-lane-zsh-test.sh`. |
| test | `bin/test/atuin-agent-history-test.sh` | `bin/atuin-agent-history` | Test source: this file. Run: `bin/test/atuin-agent-history-test.sh`. The direct command is also listed in `bin/test/README.md`. |
| test | `bin/test/browser-lane-test.sh` | `bin/browser-lane` and its browser helper processes | Test source: this file. Run: `bin/test/browser-lane-test.sh [focused mode]`. |
| test | `bin/test/bun-core-install-test.sh` | `setup.sh` package and toolchain phases | Test source: this file. Run: `bin/test/bun-core-install-test.sh`. The direct command is also listed in `bin/test/README.md`. |
| test | `bin/test/claude-native-install-test.sh` | `setup.sh` native Claude installer phase | Test source: this file. Run: `bin/test/claude-native-install-test.sh`. |
| test | `bin/test/cloudflare-access-headers-test.sh` | `bin/cloudflare-access-headers` | Test source: this file. Run: `bin/test/cloudflare-access-headers-test.sh`. |
| test | `bin/test/codex-ambient-credential-boundary-test.sh` | `.zshenv`, `.zshrc`, and startup credential boundaries | Test source: this file. Run: `bin/test/codex-ambient-credential-boundary-test.sh`. |
| test | `bin/test/codex-managed-install-test.sh` | `setup.sh` managed Codex installer phase | Test source: this file. Run: `bin/test/codex-managed-install-test.sh`. |
| test | `bin/test/generic-credential-consumer-test.sh` | credential-consumer ownership and `bin/with-one-password-token` | Test source: this file. Run: `bin/test/generic-credential-consumer-test.sh`. |
| test | `bin/test/ghh-test.sh` | `bin/ghh` | Test source: this file. Run: `bin/test/ghh-test.sh`. |
| test | `bin/test/git-effective-behavior-test.sh` | `.gitconfig` and Git process behavior | Test source: this file. Run: `bin/test/git-effective-behavior-test.sh`. |
| test | `bin/test/lm-studio-ensure-test.sh` | `bin/system/lm-studio-ensure.sh` | Test source: this file. Run: `bin/test/lm-studio-ensure-test.sh`. The direct command is also listed in `bin/test/README.md`. |
| test | `bin/test/setup-completion-test.sh` | `setup input and truthful completion` | Test source: this file. Run: `bin/test/setup-completion-test.sh`. |
| test | `bin/test/setup-state-recovery-test.sh` | `setup locking, state validation and interruption` | Test source: this file. Run: `bin/test/setup-state-recovery-test.sh`. |
| test | `bin/test/profile-link-parity-test.sh` | `profile prerequisites and exact managed links` | Test source: this file. Run: `bin/test/profile-link-parity-test.sh`. |
| test | `bin/test/symlinks-manage-test.sh` | `bin/dotfiles/symlinks/symlinks_manage.sh` | Test source: this file. Run: `bin/test/symlinks-manage-test.sh`. |
| test | `bin/test/symlinks-real-directory-test.sh` | `bin/dotfiles/symlinks/symlinks_manage.sh` replacement and recovery | Test source: this file. Run: `bin/test/symlinks-real-directory-test.sh`. |
| test | `bin/test/toolchain-apply-test.sh` | `bin/dotfiles/toolchain update --apply` | Test source: this file. Run: `bin/test/toolchain-apply-test.sh`. |
| test | `bin/test/toolchain-bootstrap-test.sh` | `config/mise/bootstrap.sh` and zsh startup | Test source: this file. Run: `bin/test/toolchain-bootstrap-test.sh`. |
| test | `bin/test/toolchain-status-test.sh` | `bin/dotfiles/toolchain status --json` | Test source: this file. Run: `bin/test/toolchain-status-test.sh`. |
| test | `bin/test/with-one-password-token-test.sh` | `bin/with-one-password-token` | Test source: this file. Run: `bin/test/with-one-password-token-test.sh`. |
| test | `bin/test/work-profile-slug-parity-test.sh` | `.zshrc`, `work-profile-init.sh`, and `setup.sh` selector parity | Test source: this file. Run: `bin/test/work-profile-slug-parity-test.sh`. |
| test | `bin/test/zsh-effective-behavior-test.sh` | `.zshenv`, `.zprofile`, and `.zshrc` effective behavior | Test source: this file. Run: `bin/test/zsh-effective-behavior-test.sh`. |
| test | `bin/test/zsh-startup-silence-test.sh` | zsh startup output and supported modes | Test source: this file. Run: `bin/test/zsh-startup-silence-test.sh`. |
| test | `bin/test/zsh-work-profile-boundary-test.sh` | `.zshrc` work-profile selector boundary | Test source: this file. Run: `bin/test/zsh-work-profile-boundary-test.sh`. |

## Non-executable support files

These 44 tracked files have mode 100644. They are listed so a mode change,
new caller, or retirement does not disappear from the ownership map. A
non-executable shell file must be sourced, interpreted explicitly, or copied;
it is not a public basename command.

| Role | File or exact group | Intended use | Source owner and covering route |
| --- | --- | --- | --- |
| unqualified | `bin/check_shell.sh` | `bash bin/check_shell.sh` if manually repaired | Source: self. Mode is non-executable; current caller and test are unverified. |
| unqualified | `bin/dotfiles/preferences/preferences_backup.sh` | `bash bin/dotfiles/preferences/preferences_backup.sh` | Source: self. Mode is non-executable; current caller and test are unverified. |
| unqualified | `bin/dotfiles/preferences/preferences_restore.sh` | `bash bin/dotfiles/preferences/preferences_restore.sh BACKUP_DIR` | Source: self. Mode is non-executable; current caller and test are unverified. |
| helper | `bin/dotfiles/symlinks/symlinks_install.sh` | `bash .../symlinks_install.sh` delegates `--link` | Source owner: `bin/dotfiles/symlinks/symlinks_manage.sh`; covering command: `bin/dotfiles/symlinks/symlinks_manage.sh --link`. Mode is non-executable. |
| helper | `bin/dotfiles/symlinks/symlinks_uninstall.sh` | `bash .../symlinks_uninstall.sh` delegates `--unlink` | Source owner: `bin/dotfiles/symlinks/symlinks_manage.sh`; covering command: `bin/dotfiles/symlinks/symlinks_manage.sh --unlink`. Mode is non-executable. |
| unqualified | `bin/kill-all-zombies.sh` | `bash bin/kill-all-zombies.sh` | Source: self. Mode is non-executable; it has no current tracked caller or test verified. |
| helper | `bin/lib/browser-lane-handoff.py` | imported by `bin/browser-lane` recovery paths | Source owner: `bin/browser-lane`; covering command: `bin/test/browser-lane-test.sh`. |
| helper | `bin/lib/browser-lane-open.js` | launched by `bin/lib/browser-lane-open.py` | Source owner: `bin/browser-lane`; covering command: `bin/test/browser-lane-test.sh`. |
| helper | `bin/lib/browser-lane-open.py` | launched by `bin/browser-lane` native opener path | Source owner: `bin/browser-lane`; covering command: `bin/test/browser-lane-test.sh`. |
| helper | `bin/lib/browser-lane-playwright.js` | launched by `bin/browser-lane` Playwright path | Source owner: `bin/browser-lane`; covering command: `bin/test/browser-lane-test.sh`. |
| helper | `bin/lib/browser-lane-puppeteer.js` | launched by `bin/browser-lane` Puppeteer path | Source owner: `bin/browser-lane`; covering command: `bin/test/browser-lane-test.sh`. |
| helper | `bin/lib/teams-automation.sh` | sourced by `bin/teams-send` and `bin/teams-reply` | Source owner: the two Teams commands; no dedicated covering test is recorded. |
| unqualified | `bin/superwhisper-minimize-on-startup.sh` | `bash bin/superwhisper-minimize-on-startup.sh` | Source: self. Mode is non-executable; current tracked caller and test are unverified. |
| helper | `bin/system/fonts/nerd_fonts_install.sh` | `bash .../nerd_fonts_install.sh` delegates `nerd_fonts_manage.sh --add` | Source owner: `bin/system/fonts/nerd_fonts_manage.sh`; no external covering route is verified. |
| helper | `bin/system/fonts/nerd_fonts_uninstall.sh` | `bash .../nerd_fonts_uninstall.sh` delegates `nerd_fonts_manage.sh --remove` | Source owner: `bin/system/fonts/nerd_fonts_manage.sh`; no external covering route is verified. |
| helper | `bin/system/iterm/iterm_preferences_install.sh` | `bash .../iterm_preferences_install.sh` delegates `--import` | Source owner: `bin/system/iterm/iterm_preferences_manage.sh`; no external covering route is verified. |
| helper | `bin/system/iterm/iterm_preferences_uninstall.sh` | `bash .../iterm_preferences_uninstall.sh` delegates `--delete` | Source owner: `bin/system/iterm/iterm_preferences_manage.sh`; no external covering route is verified. |
| unqualified | `bin/teams-meeting-helper.sh` | `bash bin/teams-meeting-helper.sh [--help\|--monitor\|--check]` | Source: self. Mode is non-executable; current tracked caller and test are unverified. |
| helper | `bin/teams/lib/lines.ts` | imported by `bin/teams/teams-scraper.ts` | Source owner: `bin/teams/teams-scraper.ts`; covering command: `bun test bin/test/teams-scraper.test.ts`. |
| helper | `bin/teams/lib/message.ts` | imported by `bin/teams/teams-scraper.ts` | Source owner: `bin/teams/teams-scraper.ts`; covering command: `bun test bin/test/teams-scraper.test.ts`. |
| helper | `bin/teams/lib/parser.ts` | imported by `bin/teams/teams-scraper.ts` | Source owner: `bin/teams/teams-scraper.ts`; covering command: `bun test bin/test/teams-scraper.test.ts`. |
| helper | `bin/teams/lib/types.ts` | imported by `bin/teams/teams-scraper.ts` | Source owner: `bin/teams/teams-scraper.ts`; covering command: `bun test bin/test/teams-scraper.test.ts`. |
| public | `bin/teams/teams-scraper.ts` | `bun bin/teams/teams-scraper.ts [options]` | Source: self help. Covering command: `bun test bin/test/teams-scraper.test.ts`; mode is non-executable so no bare command is promised. |
| documentation | `bin/templates/README.md` | read before copying a CLI template | Owner: template directory. Covering route: the document's `cp` example. |
| documentation | `bin/test/README.md` | read before running tests | Owner: test directory. Covering route: its Commands block and per-test notes. |
| test-support | `bin/test/agent-skills-inventory.test.ts` | `bun test bin/test/agent-skills-inventory.test.ts` | Covers `bin/agent-skills-inventory`; mode is non-executable. |
| test-support | `bin/test/browser-lane-native-host.cjs` | loaded by `bin/test/browser-lane-test.sh` fixtures | Covers `bin/browser-lane`; mode is non-executable. |
| test-support | `bin/test/teams-scraper.test.ts` | `bun test bin/test/teams-scraper.test.ts` | Covers `bin/teams/teams-scraper.ts`; mode is non-executable. |
| test-support | `bin/test/fixtures/teams/help.txt` | expected help output for `bin/test/teams-scraper.test.ts` | Source owner: the Teams scraper test; no direct command. |
| test-support | `bin/test/fixtures/teams/chrome-only.{expected.json,stdout.txt,txt}` | fixtures for `bin/test/teams-scraper.test.ts` | Source owner: the Teams scraper test; no direct command. |
| test-support | `bin/test/fixtures/teams/malformed.{expected.json,stdout.txt,txt}` | fixtures for `bin/test/teams-scraper.test.ts` | Source owner: the Teams scraper test; no direct command. |
| test-support | `bin/test/fixtures/teams/plain-messages.{expected.json,stdout.txt,txt}` | fixtures for `bin/test/teams-scraper.test.ts` | Source owner: the Teams scraper test; no direct command. |
| test-support | `bin/test/fixtures/teams/replies.{expected.json,stdout.txt,txt}` | fixtures for `bin/test/teams-scraper.test.ts` | Source owner: the Teams scraper test; no direct command. |
| helper | `bin/tmux/monitor-locks.sh` | `bash bin/tmux/monitor-locks.sh` | Source owner: `apps/taskdock/bin/taskdock` lock listing; current tracked route and test are unverified. Mode is non-executable. |
| helper | `bin/tmux/sidequest-common.sh` | `source bin/tmux/sidequest-common.sh` | Source owner: `bin/tmux/worktree-ai.sh`, `bin/tmux/worktree-delete.sh`, and `bin/tmux/test-migration.sh`; covering commands are those three consumers. |
| helper | `bin/tmux/task-monitor.sh` | `bash bin/tmux/task-monitor.sh [REFRESH_INTERVAL]` | Source owner: TaskDock lock state; current tracked route and test are unverified. Mode is non-executable. |

## Updating this inventory

When changing a file under `bin/`, inspect its shebang and usage text, run
`git ls-files --stage -- 'bin/**'` to confirm its tracked mode, and search exact
repository-relative paths for callers, tests, config, launch agents, and package
owners. Read the caller when a match is found. Record an unresolved route as
`unverified` with the search boundary and leave the command available until its
owner makes a retirement decision.
