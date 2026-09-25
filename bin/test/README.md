# Test Scripts

This directory owns shell CLI contract and runtime tests.

## Usage

- Keep tests beside their owning command under `bin/`.
- Run each executable test directly.
- Preserve committed tests as CLI contract evidence.

## Commands

```bash
bin/test/ghh-test.sh
bin/test/agent-lane-audit-test.sh
bin/test/agent-lane-launch-test.sh
bin/test/agent-lane-receipt-test.sh
bin/test/agent-lane-zsh-test.sh
bin/test/claude-native-install-test.sh
bin/test/codex-managed-install-test.sh
bin/test/zsh-effective-behavior-test.sh
bin/test/zsh-startup-silence-test.sh
bin/test/git-effective-behavior-test.sh
bin/test/zsh-work-profile-boundary-test.sh
bin/test/codex-ambient-credential-boundary-test.sh
bin/test/with-one-password-token-test.sh
bin/test/work-profile-slug-parity-test.sh
bin/test/cloudflare-access-headers-test.sh
bin/test/generic-credential-consumer-test.sh
bin/test/toolchain-status-test.sh
bin/test/toolchain-apply-test.sh
bin/test/toolchain-bootstrap-test.sh
bin/test/setup-completion-test.sh
bin/test/setup-state-recovery-test.sh
bin/test/profile-link-parity-test.sh
bin/test/bun-core-install-test.sh
bin/test/lm-studio-ensure-test.sh
bin/test/atuin-agent-history-test.sh
bin/test/symlinks-manage-test.sh
bin/test/symlinks-real-directory-test.sh
```

`symlinks-real-directory-test.sh` copies the public symlink manager into
disposable Git fixtures and runs it under an empty environment. It proves the
interactive pseudo-terminal approval and refusal routes, explicit force,
noninteractive refusal, mode-600 versioned recovery manifests, public restore,
creation and final-link-verification rollback, preserved literal sentinel bytes,
and that the managed process does not call recursive `rm`. Its negative
control runs a test-owned fixture that models the retired interactive
`rm -rf` route against a disposable HOME; it proves the recursive-rm
detector observes that route, not the public symlink manager. It does not
activate a live profile or claim signal-interruption recovery.

`toolchain-status-test.sh` copies the public status and preview command into a
temporary Git fixture and supplies independent fake Node, Bun, Python, Beads,
Git, npm, Brew, and Mise processes. It proves manifest validation, selected versus
observed ownership, npm's declared Node relationship, structured output,
read-only preview, canonical Mise data, installs, and shims directory custody
despite hostile inherited redirection, and verifier separation between a corrupt declaration and a valid
but still unqualified source declaration. It does not prove a live Mise
install, launch-context activation, project override behaviour, exact Git
ownership, apply, interruption recovery, or clean-machine reconstruction.

`toolchain-apply-test.sh` uses a test-owned HOME and a fake Mise process backed
by a test-owned literal version oracle. It proves snapshot-derived identities,
read-only revision artifacts, labeled source-and-lock identity, strict receipt
binding, JSON stream isolation, public apply and no-change, honest
partial-failure effects, pre-planted target refusal, coherent tamper rejection,
atomic lock publication, simultaneous single-writer stale retry, HOME
containment, and terminating INT and TERM cleanup for the install process group.
The fake also records that lock, install, verification, and recovery receive the
same resolved-HOME Mise data, installs, and shims layout despite hostile ambient
redirection.
It does not qualify a live installation, launch-context activation, project
overrides, clean-machine reconstruction, or exact Git ownership.

`bun-core-install-test.sh` evaluates the real Brewfile for both desktop and
server profiles, rejects duplicate normalized formula ownership, then extracts
setup Phases 4 and 5 into hermetic Bash processes. Its fakes prove the common
Mise declaration, one fully qualified Peekaboo owner, retained Bun, Python,
pyenv, fnm, and pnpm fallbacks, Mise installation before exactly one public
toolchain apply, and failure before the completion or post-phase checkpoint
seams when toolchain apply or the profile Brew bundle fails. It does not run
Homebrew or prove a checkpoint on a live machine.

`toolchain-bootstrap-test.sh` runs the POSIX bootstrap, all four real zsh
startup modes, and the shared Husky init under a test-owned HOME. It proves
contained lowercase revision selection, regular config selection, canonical
data, installs, and shims directory replacement, hostile empty, relative,
duplicate, and stale shim PATH
removal, inactive malformed and symlinked state, shim-only
noninteractive launches, interactive activation, Beads shim selection,
fallback-manager suppression
only while applied Mise is active, script-relative verifier custody despite a
hostile inherited `DOTFILES`, and silent zero-exit startup. Mise, fnm, and
pyenv are process fakes, so this does not prove a Homebrew install, real runtime
download, project-local override, arbitrary GUI host, or clean no-cache Mac.

`setup-completion-test.sh` runs the complete public `setup.sh` process in a
disposable HOME fixture. It proves phase-option arity and range validation,
environment and stored-profile validation before state writes, documented phase
suffix execution, mandatory verification before checkpoint clearance, retained
repair checkpoints for failed or missing verification, qualified warning
receipts, malformed machine-summary refusal, the real verifier's stable summary
emission, and the linked-worktree activation boundary. It uses harmless Phase 6
collaborators and a fake verifier for setup boundary cases, so it does not prove
live macOS, Homebrew, Mise, profile dependency parity, or serialized setup-state
recovery.

`profile-link-parity-test.sh` runs the complete symlink manager and verifier
with a disposable HOME. It derives the profile-owned package rows from
`config/brew/profile-requirements.tsv`, checks both profiles through public
`brew bundle list` and verifier processes, and covers every managed mapping,
exact target identity, malformed machine status, and server recovery
file/executable readiness. Host macOS checks are observed separately; these
fixtures do not prove a live installation.

`setup-state-recovery-test.sh` drives complete setup processes with harmless
phase collaborators. It covers competing invocation, malformed state,
interruption and explicit stale recovery. The named phase collaborators are
fixtures, so this is setup state-boundary proof, not interrupted Homebrew or
live application recovery qualification.

`claude-native-install-test.sh` and `codex-managed-install-test.sh` extract
Phase 2 from `setup.sh` and run it in isolated Bash children. They prove the
native or managed installer routes, durable outputs, idempotent skips,
non-fatal failures, and the absence of Homebrew CLI routes without changing the
live machine.

`symlinks-manage-test.sh` copies the public symlink manager and its required
repository targets into a non-Git fixture, then runs `--link` in disposable
server-profile HOMEs. Independent filesystem reads prove wrong and dangling
directory links are replaced as links, former referents receive no child and
retain sentinel bytes, correct and missing links behave normally, and injected
intended-creation or zero-exit lying-link failures restore the exact prior raw
target. It does not prove canonical-checkout activation, interactive
real-directory migration, or failures beyond the controlled link-creation
seam. Noninteractive real-directory refusal is owned by
`symlinks-real-directory-test.sh` (`noninteractive-refusal`).

`zsh-effective-behavior-test.sh` reads a real `/bin/zsh` child under a hermetic
`HOME`, so it proves effective startup state rather than startup file text. It
covers glob and argument behavior, navigation, command identity, and the
effective executable search path.

The navigation rows use a fixture where the target directory exists only under a
would-be search-path parent, so a relative `cd` that resolves must have gone
through ambient state. The identity rows read `whence -w` inside the started
shell, so an alias or function introduced by startup is visible as such;
aliases exist only in interactive shells, which makes the two interactive modes
load-bearing there and the noninteractive modes canaries for `.zshenv` and
`.zprofile`.

The path rows run in their own lane that seeds the child with a deliberately
hostile `PATH` (empty, `.`, `./bin`, a relative entry, a duplicate, and two
writable temporary directories) and a pinned `TMPDIR`. Seeding is load-bearing:
against a clean inbound `PATH`, a startup that filtered nothing would still pass
every row.

Its snapshot replay lane is skipped unless a path is supplied at run time:

```bash
ZSH_CONTRACT_SNAPSHOT=/path/to/snapshot-zsh.sh bin/test/zsh-effective-behavior-test.sh
```

The snapshot is written by the agent product, not by anything in this
repository, so the newest one belongs to the session that is running now:

```bash
ZSH_CONTRACT_SNAPSHOT="$(ls -t ~/.claude/shell-snapshots/*.sh | head -1)" \
  bin/test/zsh-effective-behavior-test.sh
```

Supplying a hand-written file would prove the fixture rather than the shell an
agent is actually given, which is the only claim this lane exists to make. The
hermetic modes above already prove the startup files are correct in principle;
this lane is what proves the repair reached the captured snapshot in practice.

The lane cannot run on a cold checkout, because that snapshot exists only once a
real agent lane has run. Absence is therefore reported as a skip rather than a
pass, and the skip is load-bearing: it marks a claim as unproven instead of
letting a missing input read as evidence. Treat a skipped row here as an
unproven lane, not as a green one.

Replaying a snapshot captured before the repair fails these rows on
`extendedglob`, which is what makes the passing case a measurement rather than a
description. A snapshot that predates the repair is not evidence for it.

`zsh-startup-silence-test.sh` is the companion contract for startup noise. It
claims what the file above deliberately leaves out: every startup mode exits
zero with empty stderr when the optional integrations are unavailable, the
prompt, completion, terminal-control, and notice machinery stays behind narrow
capability checks, and repeated clean-environment calls receive the same
baseline.

Making the optional integrations genuinely absent is load-bearing and is not
achieved by a minimal `PATH`. `.zshrc` prepends the Homebrew prefix
unconditionally, so `fnm`, `atuin`, `direnv`, and `pyenv` all remain resolvable
however small the inbound `PATH` was, and every silence row would pass
vacuously. The contract instead copies the startup owners with the Homebrew
prefix rewritten to an empty directory, so each optional executable and
integration file really does not exist.

The stderr rows report a byte count rather than the captured text. A startup
diagnostic can carry a `HOME` path or an environment value, so reprinting one to
prove it existed would recreate the disclosure the sibling contract refuses.

The prompt hook is invoked directly rather than waited for. `precmd` runs before
each prompt and a `-c` shell never draws one, so calling it is what makes the
terminal title sequence and the colour-coded timing line observable in the
captured stream.

The missing-Node-version lane executes the installed `fnm` against a real
uninstalled version pin under `ERR_EXIT`, because `fnm env --use-on-cd` installs
a chpwd hook whose failure aborts the shell at the `cd` itself. `ERR_EXIT` is
what makes that a behavioural claim: without it the failing hook is invisible.

It runs three lanes. Two are a control pair that eval the same generated hook
and differ only in whether the production wrapper is applied: the raw lane must
exit nonzero and stop before the marker after the `cd`, the wrapped lane must
reach it. Comparing the two lanes' stderr sizes is what makes "the wrapper
changes only fatality" a measurement rather than a description. The third lane
starts a real shell against this repository's startup owners and proves `.zshrc`
actually installs that wrapper.

That third lane asserts wrapper identity before it asserts navigation, and the
order matters. Navigation surviving is satisfiable without any wrapper, for
instance by returning fnm to `--log-level quiet`, so navigation alone cannot
tell "the repair is installed" from "the symptom went away". The identity rows
read the started shell's own function table: the generated hook must be
preserved under `_fnm_original_autoload_hook` with the body fnm generated, and
`_fnm_autoload_hook` must no longer hold that body but call the preserved hook
and discard only its failing status. The expected body is captured from a
separate unwrapped run of the installed fnm rather than hardcoded, so the rows
do not pin the contract to one fnm version. Deleting the wrapper block from
`.zshrc` fails these rows while both control lanes stay green.

Navigation and reporting are asserted separately because they can fail
independently. `.zshrc` selects `fnm --log-level error` rather than `quiet`:
`quiet` suppresses fnm's own error output, so the wrapper would hide the
missing-version diagnostic instead of merely making it non-fatal. Against the
installed fnm 1.39.0 (levels `quiet`, `error`, `info`) `error` is the narrowest
level that keeps ordinary startup silent while still reporting a real failure.
The diagnostic rows assert only that the channel is nonempty, never its text.

The lane is reported as a skip, row by row, when `fnm` is unavailable.


`git-effective-behavior-test.sh` runs the real `git` CLI under a hermetic `HOME`
holding copies of this repository's Git owners, with `GIT_CONFIG_NOSYSTEM=1` so
system configuration is disabled. It proves effective Git behavior rather than
configuration text.

`env -i` is load-bearing: `GIT_EDITOR`, `EDITOR`, and `VISUAL` outrank
`core.editor`, so an inherited value would satisfy the editor assertions
without the configuration under test doing anything.

Expected values for the machine-output rows come from a control lane running
`GIT_CONFIG_GLOBAL=/dev/null`, so each row compares this repository's effective
Git against Git's own defaults instead of against a hard-coded string.

The terminal lane attaches a real PTY through `python3` to prove human colour
and automatic paging survive. It is reported as a skip when `python3` is
unavailable.

`zsh-work-profile-boundary-test.sh` owns the work-profile selection and
credential boundary. It extracts the adapter from `.zshrc` and the migration
from `setup.sh` rather than restating either, so the contract cannot drift into
testing its own copy of the logic, and it asserts the extraction found something
so an empty extraction cannot pass vacuously.

The selector rows run a real `/bin/zsh` child under a hermetic `HOME` holding
two fixture profiles: an intended one where a valid slug resolves, and a second
outside `$HOME/code` exporting a different sentinel. "Did not escape" is
therefore measured by that second sentinel's absence rather than asserted.

The injection rows use a side effect as the oracle, not a string comparison.
Each hostile selector would create a marker file if its text were ever expanded,
so the rows fail the moment the adapter evaluates the value; a grammar check
alone cannot prove this. A planted marker proves the oracle can see one.

The selector owner is a fixed path under the effective `HOME`, with no
environment override, so a row plants a state file at a `DOTFILES_STATE_DIR`
naming a slug that really resolves and asserts it still selects nothing. Its
complement moves the same bytes to the real owner and asserts they do load, so
the refusal cannot pass because the fixture was wrong.

The file must hold exactly one scalar. Rows refuse a hostile second line, a
second line with no final newline, a blank second line, and surrounding
whitespace, because reading only the first line would make an appended value
look well-formed rather than refused.

Positive controls are load-bearing in a way that is easy to lose. Every refusal
row above is satisfied by an adapter that loads nothing and silently disables the
work profile, so one row asserts a valid slug with a trailing newline is accepted
and another asserts a slug written with `printf '%s'` is accepted. Without the
second, an adapter treating `read`'s end-of-file status as a rejection would look
correct while refusing every file written that way.

The bridge scan matches any startup line sourcing a `-dotfiles/profile.zsh`
path and subtracts only the adapter's own validated `$resolved` line, so it
catches both a literal employer-named loader and the retired interpolated
`${WORK_PROFILE}` shape. Fixtures prove it detects each and clears the adapter.

An option row asserts `EXTENDED_GLOB` is off and `NOMATCH` on after validation.
The grammar needs extended patterns, which issue 48 removed globally, so the
adapter takes a local baseline; without this row the repair for issue 51 could
silently reopen issue 48.

`codex-ambient-credential-boundary-test.sh` owns GUI projection. Its rows are
written so that reverting `sync-launchctl-env` to a denylist fails them: an
allowlisted name must be projected, and a name that is neither allowlisted nor
secret-shaped must not be. The oracle is the argv handed to a stub `launchctl`
on `PATH`, never the helper's source text, and no projected value is printed.

Both files hold sentinel strings only. No fixture carries a credential, and no
assertion prints a file's contents or an environment value.

`work-profile-slug-parity-test.sh` owns one promise the three carriers of the
slug grammar make together: every value a writer accepts, the canonical selector
in `.zshrc` also accepts. The writers are `work-profile-init.sh`, which validates
its argument then tells the operator to select it, and `setup.sh`, whose
migration writes a selection directly. A writer that admitted `acme-` produced a
real repository or a real selection whose profile the shell then refused at every
startup, with no diagnostic anywhere.

Extracting all three grammars is load-bearing. A copy of any expression in the
test would drift and would prove only that the copies agree, so both bash guards
are lifted from their owners and the selector function whole from `.zshrc`, and
each extraction is asserted non-empty before any row runs. The `$slug` anchor in
the `setup.sh` extraction is deliberate: that file carries unrelated `$REPLY`
prompts that also use `=~`.

The expected verdicts are written by hand from the grammar's prose contract
rather than by running any expression, so no owner is its own oracle. Each named
row reports `generator/setup/selector`, which localises a drift to the owner that
moved and, by asserting full three-way agreement per case, already proves the
one-way parity property (a writer must not be wider than the selector) for
every case the file exercises. The closing rows run the real script, so
rejection is proved as exit status and stderr with nothing scaffolded, not as a
regex result.
