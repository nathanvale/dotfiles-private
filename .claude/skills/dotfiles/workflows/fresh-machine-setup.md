# Fresh Machine Setup

Orchestrate a full setup of Nathan's Mac from scratch (or re-run on an existing machine).

---

## Prerequisites

Start with macOS and an internet connection. `setup.sh` owns Xcode Command Line
Tools, Homebrew, repository cloning, and both agent CLIs.

---

## Bootstrap Instructions (Fresh Mac Only)

Print this for Nathan when the repository is absent, then wait for the setup
command to finish:

```
FRESH MAC BOOTSTRAP
===================

Run in Terminal.app:

curl -fsSL https://raw.githubusercontent.com/nathanvale/dotfiles-private/main/setup.sh | bash
```

`setup.sh` installs the Claude Code CLI through its native installer and Codex
through its managed standalone installer. Homebrew owns neither CLI.

After setup completes, ask Nathan to run `claude` and `codex` and complete each
product's interactive sign-in. Treat authentication as a human boundary.

**For work laptops with a corporate TLS proxy**, bootstrap may fail with SSL errors.
Fix: get the approved corporate root CA certificate from IT, then:
```bash
export SSL_CERT_FILE=~/CorporateRootCA.pem
# Retry the setup command
```

After Nathan confirms bootstrap is complete, proceed to Phase 0.

---

## Phase 0: Determine Machine Type

Ask Nathan:

> What kind of machine is this?
>
> 1. **Desktop workstation** -- full desktop apps, no work profile
> 2. **Headless server** -- containers and local inference workloads
> 3. **Work laptop** -- Corporate MacBook, desktop apps + employer-specific config

If `$ARGUMENTS` contains `--work <employer>`, skip the prompt and go directly to
work laptop flow with the given employer name.

Store the choice for subsequent phases.

---

## Phase 1: Run dotfiles setup.sh

The existing `setup.sh` handles all seven phases, including the native Claude
Code CLI and managed Codex CLI. Re-running it is idempotent.

### For a desktop or managed workstation:
```bash
cd ~/code/dotfiles && ./setup.sh --desktop
```

### For a headless server:
```bash
cd ~/code/dotfiles && ./setup.sh --server
```

**Important:** If `setup.sh` has already been run (symlinks exist, tools installed),
ask Nathan whether to re-run or skip to Phase 2. Don't re-run unnecessarily.

### Corporate Environment Gotchas

Work laptops often have constraints. Watch for:

- **Corporate TLS proxy**: If `curl` or `brew` fails with SSL errors, check the approved root CA path
  or a corporate CA cert. May need `export SSL_CERT_FILE=~/CorporateRootCA.pem`.
- **No admin/sudo**: Some phases require sudo. If denied, note which phases
  failed and continue with what's possible.
- **MDM restrictions**: Some casks may fail to install. This is expected -- skip them.
- **Restricted git SSH**: If `git@github.com` fails, fall back to HTTPS.

---

## Phase 2: Work Profile Setup (Work Laptop Only)

Skip this phase entirely for desktop and headless-server profiles.

Route to [work-profile-setup.md](work-profile-setup.md) for the full work profile
scaffolding and configuration workflow.

---

## Phase 3: Verification

### All machines:
```bash
# Symlink status
~/code/dotfiles/bin/dotfiles/symlinks/symlinks_manage.sh --status

# Source shell and verify no errors
source ~/.zshrc
```

### Work laptop additional checks:
```bash
# Verify selection, validation, and load in one report
dotfiles-work-profile

# Verify work install.sh status
~/code/<employer>-dotfiles/install.sh --status

# CRITICAL: Verify no employer names leaked into public dotfiles
grep -ri "<employer>" ~/code/dotfiles/.zshrc ~/code/dotfiles/.gitconfig ~/code/dotfiles/config/brew/Brewfile && echo "LEAK DETECTED" || echo "Clean -- no employer names in public repo"
```

---

## Phase 4: Summary

Print a summary of what was configured:

```
Machine Setup Complete
---------------------
Type:          <desktop workstation | headless server | managed workstation>
Profile:       <desktop | server>
Work Profile:  <employer or "none">
Dotfiles:      ~/code/dotfiles
Work Config:   ~/code/<employer>-dotfiles (if applicable)

Next steps:
- Restart terminal or run: source ~/.zshrc
- <work-specific next steps if applicable>
```
