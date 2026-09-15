# Work Profile Setup

Add or manage an employer-specific profile on a work laptop. This workflow handles
scaffolding the private repo, setting env vars, and creating Claude Code symlinks.

---

## Step 1: Get the slug

If not provided via `--work <slug>`, ask:

> What slug should name this profile?

The slug becomes both the repo name, `~/code/<slug>-dotfiles/`, and the selector
the shell reads. The `Work profile config` block in `.zshrc` owns the grammar;
`work-profile-init.sh` applies the same rule and reports a rejected value.
Contracts: `bin/test/zsh-work-profile-boundary-test.sh` and
`bin/test/work-profile-slug-parity-test.sh`.

---

## Step 2: Check for Existing Repo

```bash
ls -d ~/code/<employer>-dotfiles 2>/dev/null
```

**If it exists:** Skip scaffolding, go to Step 4.

**If a GitHub repo exists but isn't cloned:**
```bash
gh repo view nathanvale/<employer>-dotfiles --json name 2>/dev/null
```
If found, clone it:
```bash
cd ~/code && git clone git@github.com:nathanvale/<employer>-dotfiles.git
```
Then go to Step 4.

**If neither exists:** Scaffold a new repo (Step 3).

---

## Step 3: Scaffold New Repo

Run the scaffolding script:

```bash
~/code/dotfiles/.claude/skills/dotfiles/scripts/work-profile-init.sh <employer>
```

This creates the canonical structure at `~/code/<employer>-dotfiles/`. See
[work-profile-convention.md](../references/work-profile-convention.md) for what gets generated.

After scaffolding, ask Nathan:

> I've created ~/code/<employer>-dotfiles/ with the standard structure.
> Want me to create a private GitHub repo for it?

If yes:
```bash
cd ~/code/<employer>-dotfiles
gh repo create nathanvale/<employer>-dotfiles --private --source=. --push
```

---

## Step 4: Select the work profile

Check the current selection:
```bash
dotfiles-work-profile
```

If unset, write the slug that matches the repo name:
```bash
echo '<slug>' > ~/.dotfiles_state/work-profile
```

If it already names a different slug, warn Nathan and ask before changing.

The slug grammar is enforced by the `Work profile config` block in `.zshrc`. A
rejected value loads nothing and `dotfiles-work-profile` reports it.

---

## Step 5: Run the Work Profile install.sh

```bash
~/code/<employer>-dotfiles/install.sh
```

This creates the Claude Code symlinks and any other employer-specific setup.

---

## Step 6: Remove Stale References

Older setups loaded the profile through a per-employer symlink in `$HOME` or an
ambient `WORK_PROFILE` variable. Both are retired. Remove any leftover
`~/.<slug>.zsh` symlink, and drop `WORK_PROFILE` from any file that still
exports it; the selector is the only input now.

---

## Step 7: Verify

```bash
# Verify selection, validation, and load in one report
dotfiles-work-profile

# Verify work install.sh status
~/code/<employer>-dotfiles/install.sh --status

# CRITICAL: Verify no employer names leaked into public dotfiles
grep -ri "<employer>" ~/code/dotfiles/.zshrc ~/code/dotfiles/.gitconfig ~/code/dotfiles/config/brew/Brewfile && echo "LEAK DETECTED" || echo "Clean"
```
