# Troubleshooting Reference

Expanded troubleshooting guide for common dotfiles issues.

---

## Homebrew Issues

### SSL Errors (Corporate TLS Proxy)

**Symptom:** `brew install` or `curl` fails with SSL certificate errors.

**Cause:** A corporate TLS proxy can intercept HTTPS traffic with its own CA certificate.

**Fix:**
```bash
# Find the corporate root CA certificate (ask IT for its approved location)
ls ~/CorporateRootCA.pem

# Set for current session
export SSL_CERT_FILE=~/CAFile.pem

# Make permanent: add the export to profile.zsh in the private work repo.
# It is a work-machine setting, not a credential.
```

### brew bundle Ignores Environment Variable

**Symptom:** Brewfile conditionals don't work, always installs desktop profile.

**Cause:** Homebrew filters out env vars without the `HOMEBREW_` prefix.

**Fix:** Use `HOMEBREW_DOTFILES_PROFILE` (not `DOTFILES_PROFILE`):
```bash
HOMEBREW_DOTFILES_PROFILE=server brew bundle --file=~/code/dotfiles/config/brew/Brewfile
```

### Cask Install Fails on Work Laptop

**Symptom:** `Error: <cask> is not allowed by your organization.`

**Cause:** MDM/endpoint management blocks certain apps.

**Fix:** Skip the cask. Note which ones failed for reference. These can often be
installed via the company's internal app catalog instead.

---

## Git / GitHub Issues

### gh Auth Fails

**Symptom:** `gh` commands return authentication errors.

**Fix:**
```bash
gh auth login
# Follow the prompts (browser or token)
```

### SSH to GitHub Blocked

**Symptom:** `git clone git@github.com:...` hangs or times out.

**Cause:** Corporate firewall blocks SSH (port 22).

**Fix:** Use HTTPS instead:
```bash
git clone https://github.com/nathanvale/dotfiles-private.git ~/code/dotfiles
```

Or configure SSH over HTTPS port in `~/.ssh/config`:
```
Host github.com
  Hostname ssh.github.com
  Port 443
```

---

## Shell / Environment Issues

### profile.zsh Not Sourced

**Symptom:** Work aliases and env vars not available.

**Cause:** The slug is unset, rejected by the grammar, or refused by the
containment check.

**Fix:** Ask for the state, which names which of the three applies:
```bash
dotfiles-work-profile
```

If unset, write the slug and start a new shell:
```bash
echo '<slug>' > ~/.dotfiles_state/work-profile
```

### Node Not Found in Non-Interactive Shell

**Symptom:** Scripts or CI can't find `node`.

**Cause:** no verified applied Mise revision is selected, so
`config/mise/bootstrap.sh` leaves the Mise shims off PATH.

**Fix:** Check the selection, then apply the declared revision:
```bash
bin/dotfiles/toolchain status --json
bin/dotfiles/toolchain update --apply
```

### 1Password Access Fails

**Symptom:** a wrapper reports blocked custody, or an `op://` reference fails.

**Fix:** check custody without printing any value. A blocked check ends stderr
with a redacted JSON repair envelope naming the cause:
```bash
with-one-password-token check
```

Then confirm the reference resolves to a real vault, item, and field:
```bash
with-one-password-token op item list --vault "API Credentials"
```

Never `grep` or `cat` `~/code/dotfiles/.env` -- that prints the live
service-account token to your terminal and shell history.

---

## Symlink Issues

### Symlink Shows WRONG Status

**Symptom:** `symlinks_manage.sh --status` shows WRONG for a link.

**Cause:** Target path changed (e.g., repo moved).

**Fix:**
```bash
bin/dotfiles/symlinks/symlinks_manage.sh --link --force
```

### Existing File Blocks Symlink

**Symptom:** `symlinks_manage.sh --link` shows "EXISTS (not a symlink)".

**Cause:** A real file exists where the symlink should be.

**Fix:**
```bash
# Backup and replace
bin/dotfiles/symlinks/symlinks_manage.sh --link --force
# Or manually:
mv ~/.zshrc ~/.zshrc.backup
bin/dotfiles/symlinks/symlinks_manage.sh --link
```

---

## macOS Preferences

### Preferences Not Applied

**Symptom:** System settings don't match expected values after running prefs.

**Fix:** Some preferences require a process restart:
```bash
killall SystemUIServer
killall Finder
killall Dock
```

Or restart the Mac for all changes to take effect.

---

## Legacy Cleanup

### Old Work Profile Symlinks

**Symptom:** A `~/.<slug>.zsh` file from pre-migration setup.

**Fix:** Remove the leftover symlink. Selection now comes from the work-profile
slug in machine state; both the per-employer symlink and the ambient
`WORK_PROFILE` variable are retired.
