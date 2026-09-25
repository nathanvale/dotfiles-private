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
bin/test/browser-lane-test.sh
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

`browser-lane-test.sh` copies the `browser-lane` executable into a temporary
tree and runs it as a real process under a hermetic `HOME`, `XDG_STATE_HOME`,
and `PATH` whose browser opener, `openclaw`, `mcporter`, and `lsof` are stub
scripts, so every row is a process contract rather than a function call. The listener rows prove
that an unexpected runtime or non-loopback owner fails health before page
access. The recovery rows read the
snapshot state back through `stat`, `find`, `grep`, `jq`, and `shasum` instead
of trusting the CLI's own envelope: directory and file modes, the exact entry
count, the manifest digest against an independently computed SHA-256, and the
literal top-level key set of the blueprint. The claim that no authentication
state is copied is measured, not asserted: the fixture profile is seeded with
fake sentinel strings in Preferences, Secure Preferences, Cookies, Login Data,
and Web Data, each row first proves the oracle can see its sentinel in the
profile, then proves it is absent under the snapshot directory. The assertion
count is pinned to a literal so adding or dropping a row is a reviewable edit.
It does not prove live OpenClaw discovery, a real relay, the real Chrome profile
layout, or the access-mode live check; those stay unproven until a real profile
and relay are exercised on the machine.

Run `bin/test/browser-lane-test.sh --open-only` for the focused profile-opening
contract. The rows prove exact profile arguments, no relay or admission calls,
reservation and lease behavior, both declared profile roles, running and closed
Chrome dispatch, typed uncertain outcomes, and unchanged profile or registry
state. They do not prove live tab focus or profile selection.

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

The attended-login rows prove both handoff start modes through the public
command. The pre-admission path must create its private reservation before the
profile opener starts and must contact neither OpenClaw nor the relay. Process
receipts cover overlapping attempts, stale state, a wrong nonce, explicit
cancellation, an uncertain launcher exit, and a signal delivered to the public
process. Independent filesystem reads prove the persisted record contains the
declared task, lane, role, profile-directory digest, application origin, nonce
digest, timestamps, and start mode, while secret-shaped login paths, queries,
fragments, and plaintext nonces stay out. A provider-redirect row proves the
router makes no relay or page call when the human interval starts; it does not
inspect or model the browser's redirect journey. The uncertain paths retain the
private token file so the reservation can be resumed or released without
exposing its token in command output.
The continuation rows prove fresh profile and Selected-tabs preflight, the
reserved origin, one selected exact task URL, preservation of unrelated
admitted pages, reuse of a valid grant, one grant instruction only when no
exact target is admitted, competing ownership, prompt MCPorter process-group
retirement, interruption recovery, sanitized failures, and atomic reservation
completion. Public Agent Browser, Playwright, and Puppeteer operations after
resume prove the adapters act on the unique selected exact target while
unrelated admissions remain untouched. An Agent Browser snapshot
after resume returns an observed page result and proves the workflow reaches
adapter work before retiring its run-scoped session. Fixture proof does not
establish the deferred live matrix: Codex with personal and work profiles for both Codex and Claude Code. Those remain separate
visible journeys after installed activation.

Run `bin/test/browser-lane-test.sh --handoff-security-only` for the private
token and explicit recovery process contract (93 assertions including setup).
The rows independently observe file permissions and bytes, rejected symlinks,
hardlinks, FIFOs and oversized input, no token in streams or live process and
`jq` arguments, uncertain launch, interruption before publication and during
dispatch, and a failed reservation writer. Recovery rows prove preview makes
no durable changes, execution binds the exact reservation and acknowledged
task under the lane lease, failure before audit publication preserves state,
and private before and outcome receipts identify the removed reservation. An
injected fsync failure after unlink records incomplete recovery and directs
fresh state inspection. Legacy and malformed
records remain distinct. This does not claim protection against arbitrary
same-user clients that bypass the lane lease, power-loss testing, or real
browser authentication.

Run `bin/test/browser-lane-test.sh --handoff-only` for the existing lifecycle
regression through reservation ordering (445 assertions). Those rows now use
explicit private token output and file input; fake token bytes retained by
the test are used only for independent hashing and sanitation expectations.

Run `bin/test/browser-lane-test.sh --inspect-only` for the focused tab-access
diagnostic contract. The real public command receives empty text, an absent
target, an exact selected or unselected target, ambiguous inventories, and
malformed replies. Diagnostics distinguish visible-page counts, observed access
mode, and unknown stored grants. Child-call receipts prove relay-only
inventory, while sentinel checks prove secret-safe output and filesystem checks
prove lease cleanup and unchanged profile/registry state. These fixture rows do
not prove live tab admission or installed skill discovery.
The `mcporter` stub returns the page-list envelope observed live through
`mcporter` on the paired relay, which is the MCP content envelope carrying a
Markdown list as text, not a structured `pages` array:

```json
{"content":[{"type":"text","text":"## Pages\n1: Example Domain (https://example.com/) [selected]"}]}
```

A page line is `IDX: TITLE (URL)` with a trailing ` [selected]` on the relay's
default selected page. The title is chosen by the page, so `resolve_admitted_page`
reads every field from a fixed terminal position rather than a greedy pattern:
the selected marker is an exact suffix, and the URL is the last parenthesised
group closing the line. Any line that does not parse under those rules refuses
the whole list rather than admitting the lines that happened to parse. The gate
requires one exact URL match and requires that match to be the relay's selected
page. Unrelated admitted pages do not weaken exact matching and remain
untouched.

The adversarial rows feed the stub text a hostile page could put in its own
title, and each one is load-bearing: reverting the parser to a first-paren URL
field, a substring selected marker, a tolerated unknown line, or a whitespace
URL each fails a distinct named row. A title carrying a parenthesised URL does
not displace the real URL field; a title carrying the declared URL does not
match the declared page; a title containing `[selected]`, in any position other
than the terminal suffix, does not select its page. Non-execution and no-leak
are both measured rather than asserted: a call log file is an independent oracle
for whether the child process ever ran, a canary directory is an independent
oracle for shell expansion, so a title of `$(...)`, backticks, `;`, `|`, `&&`,
and `${IFS}*` is proved to create nothing, an option-shaped title is proved
never to reach the child command line, and URL sentinel strings prove refusals
never contain the declared or admitted URL. Structurally unreadable relay
output, covering a top-level array or string, a non-array or absent `content`,
a non-string or absent text part, non-JSON, and empty output, is refused as
`page_list_unreadable` with exit 16, no child call, no stdout, a released
lease, and no leftover page-list temporary file.

Resolving custody is not the same as handing it over. `mcporter` does not read
`BROWSER_LANE_PAGE_ID` as tool input, so the resolved index is only a real
handoff once it reaches the child argument vector as the named argument
`pageId=INDEX`. The `mcporter` stub therefore writes the arguments it actually
received, one per line, and the routing rows assert on exact argument identity
and order rather than on a re-quoted string. They cover an existing `--args`
payload, no `--args` at all, unrelated flags keeping their order, and a child
carrying its own `--`, where the routed argument has to be inserted before the
first terminator because `mcporter` stops reading named arguments there. Each
rule is load-bearing: removing the injection, extending it to `list_pages`,
inserting before every terminator instead of the first, and inserting after the
terminator instead of before each fail a distinct named row.

`list_pages` takes no input and is never given a page id, with or without a
declared page; when a page is declared it still resolves custody, and the
environment variable remains as observability only. The router owns the
argument: a caller-supplied `pageId` or `pageIdx` is refused before the lease
and before any relay call, including behind the child's own terminator, so it
can never race or override the routed value. The routed argument carries the
index alone, proved by rows that assert the declared URL and a sentinel title
never appear on the command line the child received.

Live OpenClaw admission, a real relay page list, and the index-to-page mapping
require separate live qualification. This suite proves the parse and routing
contracts, not the live relay's behaviour.

The Agent Browser rows prove the second execution route keeps the same lane
preflight and lease, selects the declared loopback relay, creates a run-scoped
session, enables strict PinTab, and performs tab discovery, sole-tab binding,
an exact-URL digest guard, and caller commands in one `batch --bail`. They also
prove custody-changing commands fail before MCPorter, the admitted URL is not
placed in the child argument vector, child status is preserved, and the lease
is released on success or failure. Exit cleanup accepts only the exact task-tab
shape or that task plus one inactive `about:blank`; it closes the exact blank
target and run-scoped session, while any ambiguous shape closes nothing and
fails with status 17. The stub proves the process contract; the separate live
proof owns real authenticated Agent Browser connectivity and cleanup.

The Playwright rows prove the third execution route accepts only an absolute
mode-600 action plan, snapshots it into private state, rejects navigation and
option injection before the lease, and enters only MCPorter's one-use relay
handoff. A fake daemon independently records that its CDP endpoint arrived in
the environment and not its argument vector; fake CLI processes prove the
exact-page recheck, ordered action output, original failure status, run-scoped
session name, detach attempt, daemon exit, lease release, and removal of the
private plan and daemon evidence. A multi-page row proves the selected unique
exact page remains bound while unrelated pages receive no action. Duplicate
exact matches, wrong selection, and URL drift still fail. Those rows prove the
process contract, not a live Playwright attachment to Chrome; the live
qualification remains a separate machine-state check.

The Puppeteer rows prove the fourth execution route at the same public seam
with a deeper proof layer for the engine. The copied executable runs under real
Bash; the fake `node` on `PATH` owns only the Playwright daemon path and hands
every other invocation to the real Node, so the lane-owned helper copied to
`bin/lib/browser-lane-puppeteer.js` executes for real; only the `puppeteer`
module is a test-owned fake, placed under the fixture tree's `node_modules`
where Node resolution from the copied helper finds it. The fake records every
engine call, one per line, holds or rejects on demand, writes its process id,
and never reaches the repository's real package. The rows prove that plan
refusals (relative path, mode, navigation, wrong arity, option injection, a
Playwright-only command) fail before MCPorter and before the lease; that the
one-use WebSocket endpoint reaches the helper only through its environment and
never the MCPorter argument vector; that connect leaves the viewport untouched;
that the unique exact page remains bound before every action while unrelated
page URL metadata is read without an unrelated action; that ordered actions
print exactly one JSON line each; and that a target which changes, disappears,
duplicates, is not selected at preflight, or closes refuses before or between
actions with status 16. Diagnostics are fixed strings: an action failure exits 18
naming only the index, command, and an admitted engine error class, proved by
selector, typed-text, engine-message, URL, and error-name sentinels absent from
stderr, with an admitted `TimeoutError` as the positive control. Connect, page
discovery, and each action are bounded by the lease TTL; no action starts after
expiry, proved with a synchronous URL read that spends the remaining TTL
between page discovery and the action; and each bounded failure leaves no
helper process behind its held promise, measured through the recorded process
id. Disconnect is called exactly once and `close` never; an unprovable
disconnect exits 17 after success and keeps 18 after an action failure. Signal
custody is proved twice: on the internal child, and on the public command,
where a TERM sent only to the parent is forwarded through the fake broker to
the helper, the helper disconnects, and the parent removes its plan snapshot
and releases the lease only after the helper is gone. The fake broker forwards
signals as the real one does. Live Chrome transport through the real relay,
real Puppeteer target discovery under Selected tabs, and the two-lane
simultaneous fixture remain unproven here.

Health reads the authenticated access snapshot through `chrome-relay status`,
without page inventory or an engine child. Rows accept enabled, stable Selected
tabs and refuse All tabs, disabled access, transitions, or unavailable evidence.
The effective-policy warning remains a separate proof gap. Page admission stays
a separate run preflight, so a loading Chrome New Tab cannot be misreported as a
dead relay. Extension inventory rows distinguish a missing reviewed allowlist,
which stays visible as a warning, from an installed extension outside a
declared allowlist, which fails the baseline. The inventory compares only
user-installed and unpacked extension locations; Chrome's built-in components
are outside that product boundary.
The selection rows prove `browser-lane` prefers an installed MCPorter that
advertises both `chrome-relay exec` and `chrome-relay status`. If either is
missing, it selects the executable built by the local MCPorter source checkout.

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
