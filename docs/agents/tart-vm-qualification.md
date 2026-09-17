# Tart clean macOS qualification

Use this runbook to prove that one exact dotfiles candidate can bootstrap a
clean macOS guest, select the intended tools, and apply a second time without
unwanted changes. Treat the VM as qualification evidence, not as a replacement
for attended permission and hardware checks on a physical Mac.

The supporting research and source rationale live in
[`../research/2026-09-09-tart-vm-qualification.md`](../research/2026-09-09-tart-vm-qualification.md).

## Completion contract

Qualify one immutable candidate commit on two sequential disposable clones of
the same source-clean prepared baseline. A run passes only when it records all
of these facts:

- The source image tag, OCI digest, macOS version and build match the declared
  inputs.
- The guest starts without Homebrew, Mise, Node, Bun, Beads or npm. Record any system
  Python and Git launchers separately.
- The first `./setup.sh --desktop` exits zero without a manual repair or retry.
  Phase 5 uses serial Homebrew downloads and may retry its `brew bundle`
  command once automatically after a nonzero first attempt. That bounded retry
  remains part of the same setup invocation and is not a resumed run or manual
  repair.
- An interactive login shell selects the intended Git owner and the exact
  Mise-managed Node, Bun, Python, Beads and npm versions.
- `bin/dotfiles/toolchain status --json` reports the selected owners ready.
- The second full setup exits zero and produces no unexpected replacement,
  backup, version or ownership change.
- The retained receipts identify the candidate commit and tree, source archive
  digest, image digest, VM name, commands, exit codes and final verdict.

Do not qualify an exploratory run, a resumed failed run, or a candidate that
was later rebased or merged. Rebuild the source archive and repeat both clones
after the candidate identity changes.

## Host preparation

Use an Apple Silicon Mac with enough free storage. Keep one source-clean
prepared baseline and at most one disposable qualification clone at a time.
The only allowed baseline mutation is the one-time disk expansion below; never
install source or tools into it. This keeps the run inside the guest count
described in the supporting research and makes cleanup obvious.

Install the VM host package through the repository-owned opt-in:

```bash
export HOMEBREW_DOTFILES_PROFILE=desktop
export HOMEBREW_DOTFILES_VM_HOST=1
brew bundle --file=config/brew/Brewfile
tart --version
```

Pin the image by readable tag and immutable digest. Never qualify `latest`.

```bash
export DOTFILES_VM_IMAGE='ghcr.io/cirruslabs/macos-tahoe-vanilla:26.6.2'
export DOTFILES_VM_DIGEST='sha256:eeec54bfe1f076e27786c5d92b89187a05b1d109b5071eb2dcdf02d596e34640'
export DOTFILES_VM_BASELINE='dotfiles-macos-26.6.2-baseline'

tart clone "${DOTFILES_VM_IMAGE%@*}@${DOTFILES_VM_DIGEST}" "$DOTFILES_VM_BASELINE"
tart set "$DOTFILES_VM_BASELINE" --cpu 4 --memory 8192 --disk-size 100
```

If the tagged variable has no digest suffix, the expression above produces the
expected `name:tag@sha256:...` reference. Confirm the resolved identity in the
receipt before continuing.

## Expand the guest APFS container

The published image starts with a 50 GB guest partition map. `tart set
--disk-size 100` enlarges the virtual disk file but does not grow the APFS
container. Setup will otherwise run out of space during the desktop package
phase.

Boot the baseline into Recovery and use Screen Sharing for Recovery Terminal:

```bash
tart run --recovery --vnc-experimental --no-audio --no-clipboard \
  "$DOTFILES_VM_BASELINE"
```

In Recovery Terminal, inspect before changing anything:

```text
diskutil list physical
diskutil info disk0s2
diskutil info disk0s3
```

Continue only when `disk0s2` is the main APFS container, `disk0s3` is the
Recovery APFS container, and about 50 GB of free space follows it. Then run:

```text
diskutil eraseVolume free free disk0s3
diskutil apfs resizeContainer disk0s2 0
printf 'y\n' | diskutil repairDisk disk0
diskutil apfs resizeContainer disk0s2 0
diskutil list physical
diskutil apfs list
```

The first resize can absorb only the former Recovery partition. Repairing the
partition map makes the enlarged virtual disk boundary visible; the second
resize consumes the remaining free space. Require `disk0s2` to be about 99.5
GB before shutting down Recovery.

Recovery input can arrive late or one character at a time. Wake a black Screen
Sharing window with Space, reconnect if keys queue, and send each complete
command once. Prefer the piped confirmation above for `repairDisk`. Never place
the VNC credential in a repository file, receipt or task message.

Boot normally and record a health check before cloning:

```bash
export DOTFILES_VM_BASELINE_EVIDENCE="$HOME/.local/state/dotfiles-vm-qualification/$DOTFILES_VM_BASELINE"
mkdir -p "$DOTFILES_VM_BASELINE_EVIDENCE"

tart run --no-graphics --no-audio --no-clipboard "$DOTFILES_VM_BASELINE" \
  >"$DOTFILES_VM_BASELINE_EVIDENCE/tart-run.log" 2>&1 &
baseline_pid=$!
printf '%s\n' "$baseline_pid" >"$DOTFILES_VM_BASELINE_EVIDENCE/tart-run.pid"

baseline_ip=''
for attempt in {1..60}; do
  if baseline_ip="$(tart ip "$DOTFILES_VM_BASELINE" 2>/dev/null)" && \
      [[ -n "$baseline_ip" ]]; then
    break
  fi
  if ! kill -0 "$baseline_pid" 2>/dev/null; then
    baseline_exit=0
    wait "$baseline_pid" || baseline_exit=$?
    printf 'baseline exited before readiness: %s\n' "$baseline_exit" >&2
    exit 1
  fi
  sleep 2
done
if [[ -z "$baseline_ip" ]]; then
  printf 'baseline IP was not ready within 120 seconds\n' >&2
  tart stop "$DOTFILES_VM_BASELINE"
  exit 1
fi
printf 'baseline_ip=%s\n' "$baseline_ip"
```

Set `DOTFILES_VM_BASELINE_SSH_TARGET` to the exact `user@address` that passed
the baseline's public-key SSH check. Record the host health and reject the
baseline before any clone when a forbidden development tool is present:

```bash
if ! ssh "$DOTFILES_VM_BASELINE_SSH_TARGET" /bin/bash <<'GUEST'
set -euo pipefail
sw_vers
diskutil list physical
df -h /

for tool in brew mise node bun npm; do
  tool_path="$(command -v "$tool" 2>/dev/null || true)"
  [[ -z "$tool_path" ]] || {
    printf 'contaminated baseline: %s resolves to %s\n' "$tool" "$tool_path" >&2
    exit 1
  }
  printf 'baseline_%s=absent\n' "$tool"
done

for tool in python git; do
  tool_path="$(command -v "$tool" 2>/dev/null || true)"
  printf 'baseline_%s=%s\n' "$tool" "${tool_path:-absent}"
done
GUEST
then
  tart stop "$DOTFILES_VM_BASELINE"
  exit 1
fi
tart stop "$DOTFILES_VM_BASELINE"
```

The forbidden-tool assertions keep a contaminated guest from becoming the
source for a qualification clone. Python and Git remain separate inventory
facts because the vanilla image may expose their system launchers. Do not
install source or tools into the baseline.

## Freeze the candidate source

Create the source artifact from the candidate commit on the host. A pristine
vanilla guest has the `/usr/bin/git` launcher but no Command Line Tools, so a
Git bundle cannot bootstrap the first setup run. Use an exact Git archive for
bootstrap and retain a HEAD-only bundle for later provenance checks.

When a read-only Tart handoff replaces `scp`, find the mounted directory under
`/Volumes` before building its archive path; this image presents a label such
as `qualification` at `/Volumes/My Shared Files/qualification`. Before
`setup.sh`, use the archive checksum, `tar`, and `test` only. Running the
system Git launcher starts the Command Line Tools installer and contaminates
the clean preflight; inspect the retained bundle only after setup installs Git.

```bash
export DOTFILES_CANDIDATE="$(git rev-parse HEAD)"
export DOTFILES_TREE="$(git rev-parse HEAD^{tree})"
export DOTFILES_EVIDENCE="$HOME/.local/state/dotfiles-vm-qualification/$DOTFILES_CANDIDATE"
mkdir -p "$DOTFILES_EVIDENCE"

git archive --format=tar.gz \
  --output="$DOTFILES_EVIDENCE/dotfiles-$DOTFILES_CANDIDATE.tar.gz" \
  "$DOTFILES_CANDIDATE"
git bundle create "$DOTFILES_EVIDENCE/dotfiles-$DOTFILES_CANDIDATE.bundle" \
  HEAD

bundle_heads="$(git bundle list-heads \
  "$DOTFILES_EVIDENCE/dotfiles-$DOTFILES_CANDIDATE.bundle")"
[[ "$(printf '%s\n' "$bundle_heads" | wc -l | tr -d ' ')" == 1 ]]
[[ "${bundle_heads##* }" == HEAD ]]
printf '%s\n' "$bundle_heads" \
  >"$DOTFILES_EVIDENCE/dotfiles-$DOTFILES_CANDIDATE.bundle-heads.txt"

(
  cd "$DOTFILES_EVIDENCE"
  shasum -a 256 "dotfiles-$DOTFILES_CANDIDATE.tar.gz" \
    >"dotfiles-$DOTFILES_CANDIDATE.tar.gz.sha256"
  shasum -a 256 "dotfiles-$DOTFILES_CANDIDATE.bundle"
  shasum -a 256 "dotfiles-$DOTFILES_CANDIDATE.bundle-heads.txt"
)
```

Retain the bundle only when `git bundle list-heads` reports one advertised head
named `HEAD`. `--all` exposes every local ref and must never create a
qualification bundle.

## Run one disposable clone

Use a unique name for every attempt:

```bash
export DOTFILES_VM_RUN="dotfiles-qualification-$(date +%Y%m%d-%H%M%S)"
tart clone "$DOTFILES_VM_BASELINE" "$DOTFILES_VM_RUN"
```

Select the start path from the clone's SSH state. When the clone already accepts
the disposable public key, continue to the headless start. Otherwise put the
public key and its tiny installer in a dedicated handoff directory, then launch
the graphical bootstrap from a dedicated host terminal:

```bash
export DOTFILES_SSH_HANDOFF="$HOME/.local/state/dotfiles-vm-qualification/ssh-handoff"
test -f "$DOTFILES_SSH_HANDOFF/public-key"
test -x "$DOTFILES_SSH_HANDOFF/install-key"

tart run --no-audio --no-clipboard \
  --dir="qualification:$DOTFILES_SSH_HANDOFF:ro" \
  "$DOTFILES_VM_RUN"
```

Use the guest desktop to run the installer. From a second host terminal, wait
for `tart ip`, verify public-key SSH, then run:

```bash
tart stop "$DOTFILES_VM_RUN"
```

The next start must be headless and omit `--dir`; the qualification source and
receipt root remain outside the graphical share. Never share the receipt root,
because it can contain the private half of the key, VNC logs or other private
evidence.

Synthesized keyboard input into a Tart window can lose Shift-modified
characters, turn underscores into hyphens or duplicate a long command. Keep the
desktop command short and lowercase, such as
`/volumes/*/qualification/install-key`, then verify SSH from the host. Observe
the terminal before retrying an uncertain input. Do not type a public key or a
long setup command through the virtual keyboard.

Start the clone headless, retain the Tart process evidence, and wait at most 120
seconds for an IP address:

```bash
export DOTFILES_VM_RUN_EVIDENCE="$DOTFILES_EVIDENCE/$DOTFILES_VM_RUN"
mkdir -p "$DOTFILES_VM_RUN_EVIDENCE"

tart run --no-graphics --no-audio --no-clipboard "$DOTFILES_VM_RUN" \
  >"$DOTFILES_VM_RUN_EVIDENCE/tart-run.log" 2>&1 &
run_pid=$!
printf '%s\n' "$run_pid" >"$DOTFILES_VM_RUN_EVIDENCE/tart-run.pid"

run_ip=''
for attempt in {1..60}; do
  if run_ip="$(tart ip "$DOTFILES_VM_RUN" 2>/dev/null)" && \
      [[ -n "$run_ip" ]]; then
    break
  fi
  if ! kill -0 "$run_pid" 2>/dev/null; then
    run_exit=0
    wait "$run_pid" || run_exit=$?
    printf 'clone exited before readiness: %s\n' "$run_exit" >&2
    exit 1
  fi
  sleep 2
done
if [[ -z "$run_ip" ]]; then
  printf 'clone IP was not ready within 120 seconds\n' >&2
  tart stop "$DOTFILES_VM_RUN"
  exit 1
fi
export DOTFILES_VM_IP="$run_ip"
printf 'run_ip=%s\n' "$DOTFILES_VM_IP"
```

Set `DOTFILES_VM_SSH_TARGET` to the exact `user@address` that passed the
public-key check. After every guest reboot, poll outbound GitHub connectivity
before invoking setup; a 120-second miss fails the clone:

```bash
ssh "$DOTFILES_VM_SSH_TARGET" /bin/bash <<'GUEST'
github_ready=false
for attempt in {1..30}; do
  if /usr/bin/curl --fail --silent --max-time 2 \
      https://github.com/robots.txt >/dev/null; then
    github_ready=true
    break
  fi
  sleep 2
done
[[ "$github_ready" == true ]] || {
  printf 'outbound GitHub connectivity was not ready within 120 seconds\n' >&2
  exit 1
}
GUEST
```

Copy the candidate archive and checksum to the running clone:

```bash
scp "$DOTFILES_EVIDENCE/dotfiles-$DOTFILES_CANDIDATE.tar.gz" \
  "$DOTFILES_EVIDENCE/dotfiles-$DOTFILES_CANDIDATE.tar.gz.sha256" \
  "$DOTFILES_VM_SSH_TARGET:/tmp/"
```

In the guest, derive the candidate from the one transferred archive, verify its
SHA-256, and extract it into the repository directory:

```bash
set -- /tmp/dotfiles-*.tar.gz
[[ "$#" -eq 1 && -f "$1" ]] || {
  printf 'expected exactly one candidate archive\n' >&2
  exit 1
}
candidate_archive="$1"
candidate_name="${candidate_archive##*/}"
export DOTFILES_CANDIDATE="${candidate_name#dotfiles-}"
DOTFILES_CANDIDATE="${DOTFILES_CANDIDATE%.tar.gz}"
[[ "$DOTFILES_CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'candidate archive does not name one full commit\n' >&2
  exit 1
}

cd /tmp
shasum -a 256 -c "dotfiles-$DOTFILES_CANDIDATE.tar.gz.sha256"
rm -rf "$HOME/code/dotfiles"
mkdir -p "$HOME/code/dotfiles"
tar -xzf "$candidate_archive" -C "$HOME/code/dotfiles"
test -x "$HOME/code/dotfiles/setup.sh"
```

`git archive` places repository files at the archive root unless it was created
with `--prefix`. Extracting it directly into `~/code` scatters those files one
directory too high and invalidates the clone. Do not repair that clone in
place. Do not mount the host home directory or a live checkout into the guest.

Capture the baseline inventory before setup. Then run the first setup from the
extracted source and retain the complete log and exit code:

```bash
cd "$HOME/code/dotfiles"
set -o pipefail
./setup.sh --desktop 2>&1 | tee "$HOME/setup-first.log"
setup_status=$?
printf 'setup_first_exit=%s\n' "$setup_status"
exit "$setup_status"
```

Keep `pipefail` enabled so `tee` cannot hide a setup failure. If a harness reads
the per-command array instead, zsh exposes `pipestatus` and Bash exposes
`PIPESTATUS`; use the array owned by the shell that actually runs the command.
Do not assign the result to lowercase `status` in zsh because it is a read-only
special parameter. Use a name such as `setup_exit` and preserve the outer exit:

```zsh
./setup.sh --desktop 2>&1 | tee "$HOME/setup-first.log"
setup_exit=${pipestatus[1]}
printf 'setup_first_exit=%s\n' "$setup_exit"
exit "$setup_exit"
```

The retained first-setup log must show each package-bundle attempt, its exit
status, and whether the one automatic retry succeeded. Copy those ordered
attempt records into the per-run manifest. If both attempts fail, the clone
fails; do not run a third bundle attempt, resume setup, or repair that clone in
place.

After the first setup, measure ownership inside the intended interactive login
shell:

```bash
/bin/zsh -lic '
  cd "$HOME/code/dotfiles" || exit 1
  git_path="$(command -v git 2>/dev/null || true)"
  [[ "$git_path" == "/usr/bin/git" ]] || {
    printf "expected Git at /usr/bin/git, got %s\n" "${git_path:-unavailable}" >&2
    exit 1
  }
  claude_path="$(command -v claude 2>/dev/null || true)"
  if [[ -z "$claude_path" ]]; then
    claude_path="$HOME/.local/bin/claude"
  fi
  [[ -x "$claude_path" ]] || {
    printf "expected an executable Claude Code at PATH or %s\n" "$HOME/.local/bin/claude" >&2
    exit 1
  }
  command -v node bun python bd npm >/dev/null
  printf "git_path=%s\nclaude_path=%s\n" "$git_path" "$claude_path"
  git --version
  node --version
  bun --version
  python --version
  bd --version
  npm --version
  toolchain_exit=0
  toolchain_output="$(bin/dotfiles/toolchain status --json)" || toolchain_exit=$?
  printf "%s\n" "$toolchain_output"
  [[ "$toolchain_exit" -eq 2 ]] || {
    printf "expected toolchain status exit 2, got %s\n" "$toolchain_exit" >&2
    exit 1
  }
  printf "%s\n" "$toolchain_output" | jq -e --arg mise_root "$HOME/.local/share/mise" '\''
    .status == "ready" and
    .exact_reconstruction == "not_qualified" and
    ([.tools[] | select(.name == "git" or .name == "node" or .name == "bun" or .name == "python" or .name == "bd" or .name == "npm")] | length == 6) and
    all(.tools[]; .executable_path != "" and .effective_version == .expected_version and .version_matches == true) and
    (.tools[] | select(.name == "git") |
      .selected_owner == "system" and .observed_owner == "system" and
      .selected_owner_matches == true and .executable_path == "/usr/bin/git") and
    all(.tools[] | select(.name == "node" or .name == "bun" or .name == "python" or .name == "bd" or .name == "npm");
      .selected_owner == "mise" and .observed_owner == "mise" and
      .selected_owner_matches == true and
      (.executable_path | startswith($mise_root + "/")))
  '\'' >/dev/null
'
```

Exit 2 is expected here: the selected owners are ready, while exact
reconstruction remains `not_qualified` until the external two-clone evidence is
accepted. Any other exit, a status other than `ready`, or a different
qualification value fails the ownership check.

A bare SSH command does not load the same startup files and can select Homebrew
fallback runtimes. Record that non-interactive state if useful, but do not use
it as the user-shell ownership verdict. Also avoid assigning to lowercase
`path` in zsh: it is tied to the `PATH` array and can erase command lookup.

Before the second setup, snapshot the managed symlink targets, tool versions,
toolchain content ID, and any repository-created backup directories. Run the
same full setup again, retain its log and exit code, and compare the snapshot.
Expected package-manager refresh output is not itself configuration drift.
Unexpected link replacement, new backup data, owner changes, version changes,
or a nonzero exit fails the run.

Copy all receipts to the host before stopping the VM. Remove secrets, tokens,
passwords and VNC URLs from retained output.

## Repeat and close

Stop and delete the named disposable clone after its receipts are safely on the
host:

```bash
tart stop "$DOTFILES_VM_RUN"
tart delete "$DOTFILES_VM_RUN"
```

Create a second clone from the same prepared baseline and repeat the complete
journey with the same candidate archive. Do not reuse the first clone or repair
a failed run in place. A failure creates diagnostic evidence; it does not count
as a passing qualification.

After both runs pass:

1. Record a per-run manifest and verdict plus one summary that binds both runs
   to the candidate commit, tree and archive SHA-256.
2. Obtain an independent review of the commands, retained receipts and verdict.
3. Run the repository's required Fallow, Biome, typecheck and relevant setup
   tests against the final candidate.
4. Update the reproducible Mac project proof with receipt paths and remaining
   physical-Mac gaps.
5. Delete the disposable clone. Retain or remove the prepared baseline through
   an explicit storage decision.

Do not record `exact_reconstruction` as qualified until both clean clones pass
against the final candidate. A same-machine retry, a resumed setup, or a clean
run against an earlier commit is diagnostic evidence only.
