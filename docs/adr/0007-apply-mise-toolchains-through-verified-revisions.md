---
status: accepted
---

# Apply Mise toolchains through verified revisions

## Context and Problem

The laptop baseline needs exact Node, Bun, Python, and npm defaults, project
overrides, deliberate updates, interruption recovery, and the same selected
tools in interactive and agent launches. The dotfiles repository is linked into
`~/.config`, so placing the desired Mise declaration at Mise's default global
config path would also make an ordinary source checkout change live tool
selection. A source revision must remain reviewable without becoming active
until an explicit apply succeeds.

Git still lacks an accepted exact installation owner. This decision does not
assign one or weaken that unresolved requirement.

Nathan selected Mise and approved live installation, activation, the staged
applied-revision seam, global lock generation, and non-destructive live
qualification on 8 September 2026.

## Decision Drivers

- Keep one exact desired version and selected owner for each declared runtime.
- Keep source edits and checkouts inert until an explicit apply.
- Preview without changing source, Git state, installed tools, or active state.
- Preserve the last verified active revision across failed or interrupted work.
- Make a repeated application of the same desired revision safe and observable.
- Let project-local Node, Bun, and Python declarations override personal defaults.
- Serve interactive, login, noninteractive, IDE, agent, and Git-hook launches.
- Preserve fnm, pyenv, Homebrew, pnpm, and Corepack fallbacks until replacement
  behavior is independently qualified.
- Keep desktop and server profiles diagnosable through existing setup and
  verification interfaces.

## Considered Options

- Use the repository-linked `config/mise/config.toml` directly as Mise's global
  config.
- Copy the desired config directly over one mutable global config file.
- Publish immutable verified revisions and atomically select one as current.

## Decision

Use Mise as the selected owner for exact Node, Bun, and Python defaults. npm is
owned beneath selected Node: keep its expected version in the toolchain
manifest, derive its executable from the selected Node installation, and do
not declare or install it as a standalone Mise tool.
Keep the canonical desired declaration at a non-default source path under
`config/mise`; it is input to application, not live global state.

The existing `bin/dotfiles/toolchain` interface owns preview, apply, status, and
recovery. Apply acquires one bounded run lock, copies the declaration into a
private staging revision under
`~/.dotfiles_state/toolchain/revisions`, generates its global `mise.lock`, installs
through that staged config, and verifies exact versions and ownership. Its
content identity is an unambiguous labeled digest of the application contract,
snapshotted manifest, Mise declaration, and generated lock. The lock is therefore
independently bound by the revision directory identity rather than attested only
by its colocated receipt. Only a fully verified staging revision can be published
and selected through an atomic `current` link replacement. Interruption before
selection leaves the prior revision active. Reapplying the selected content
identity verifies it and returns a no-change result.

The canonical run lock is one hard link to a complete, sealed, tokened owner
record prepared under the same state directory. Publication is atomic: other
processes observe either no lock or the complete record. Stale repair is
serialized by a BSD advisory lock whose kernel ownership is released on process
death. A stale-takeover claim is an atomic hard link from a name bound to the
exact stale owner token to the claimant's sealed 0444 record, so its token and
PID exist at publication. The serializer holder revalidates the canonical lock's
token and inode, preserves malformed or live claims, and retires a managed
claim only after its recorded owner is dead. It holds serialization through
stale removal and replacement lock publication, so a delayed contender cannot
remove a successor's live lock. Install subprocesses run in their own process
group; interruption retires that group before releasing ownership.

Every canonical publication, including normal acquisition, uses that same
crash-released serializer. If the canonical lock is absent, publication first
performs a bounded drain of no more than sixteen orphan claims. A claim is
eligible only when its filename has the managed stale-token form, its bytes are
a one-line lock record with exact fields and 0444 mode, and its recorded PID is
dead. It is classified as managed when it is a hard link to its exact private
record, or when that record is absent because an interrupted managed cleanup
already removed it while retaining the sealed claim as the final anchor.
Cleanup removes the private record first and the claim last, making every
abrupt-exit phase recursively recoverable. The drain runs before the new
entrant creates its private owner record, and removes a matching dead
retired-lock record when present. Live, malformed, foreign, or excessive
evidence is preserved and
reported as a structured refusal. This closes the abrupt-exit interval between
stale canonical retirement and successor publication without allowing a normal
entrant to bypass live takeover custody.

Recovery names an existing verified revision, verifies its required installed
tools, and atomically selects it. Recovery never uninstalls tools, downgrades
Homebrew packages, modifies app data, commits, pushes, stashes, or switches Git
branches. Staging, publication, and recovery preserve unrelated dirty source and
machine state.

Shell bootstrap sets `MISE_GLOBAL_CONFIG_FILE` only when the selected applied
config is readable and Mise is available. Login and noninteractive contexts use
Mise shims; interactive zsh additionally uses normal `mise activate zsh` so
project changes refresh automatically. Git hooks use the same applied bootstrap.
When no verified applied revision is available, existing runtime managers remain
the fallback and no source declaration becomes active implicitly.

Apply and recovery do not inherit project configuration from the caller's
working directory. Every config-sensitive Mise subprocess runs from an empty,
private, operation-owned capsule beneath validated state, uses that capsule as
`MISE_CEILING_PATHS`, receives the exact staged or selected global config, and
has inherited per-tool version and alternate-config selectors removed. The
capsule is cleaned on completion, failure, handled signals, and stale-lock
takeover. Project discovery remains enabled only for normal shell and status
behavior.
Capsule cleanup requires an explicit ownership flag set only after successful
exclusive creation. A conflicting pre-existing directory or lost creation race
is reported without deleting that path.
This token-ownership protocol also applies to staging, lock records, canonical
lock links, takeover claims, install gates, and the temporary `current` symlink.
Handled INT and TERM delivery is deferred between successful exclusive
creation and validated ownership
adoption. Selection keeps delivery deferred through the atomic `current`
replacement and clears temporary ownership only after publication. These
transitions close cleanup micro-windows without treating failed creation as
ownership or deleting a foreign preplant.
Stale canonical-lock retirement likewise defers handled signals across unlink
and adopts the exact validated private record for cleanup only after that
unlink succeeds. A signal therefore cannot strand the retired record, while a
failed unlink never grants cleanup ownership.

Add Mise through the existing Brewfile and setup profile owners. Keep the old
runtime packages and startup paths during qualification. Retire them only through
a later explicit and destructive cleanup decision backed by live evidence.

## Consequences

- Positive: source edits and checkouts cannot silently replace the active desired
  toolchain revision.
- Positive: one public interface concentrates preview, apply, verification,
  idempotence, interruption, retry, and recovery behavior.
- Positive: a failed staging operation preserves the last verified selection.
- Negative: applied state duplicates a small reviewed declaration and lockfile
  outside Git.
- Negative: shell startup must distinguish applied Mise state from temporary
  fallback managers during migration.
- Neutral: installed tool payloads remain in Mise's data directory and are not
  duplicated per applied revision.
- Neutral: Git ownership, arbitrary Homebrew downgrade, app data, commits, pushes,
  and destructive cleanup remain outside this decision.

## Options and Tradeoffs

### Repository-linked global config

- Good: minimal implementation and no copied configuration.
- Bad: installing Mise makes a source edit or checkout capable of changing live
  selection, which violates the deliberate application requirement.

### One mutable copied global config

- Good: source remains separate from live state.
- Bad: interruption can leave a partially updated config or lock, and the prior
  known-good revision has no stable recovery identity.

### Immutable verified revisions with atomic selection

- Good: source stays inert, failed staging preserves current state, same-revision
  application is idempotent, and recovery has an exact target.
- Bad: requires bounded state, locking, publication, and retention behavior behind
  the public toolchain interface.

## Confirmation

Use public-process tests for preview, first apply, same-revision no-op, failed
download, interruption before selection, bounded retry, prior-revision recovery,
concurrent refusal, and unrelated dirty Git preservation. Prove shell selection
and project overrides through the existing zsh effective-behavior and startup
silence seams, plus Git-hook and agent-launch canaries. Run desktop and server
setup and verifier checks where available.

For live qualification, install through the Brewfile, generate the selected
global lock, apply one revision, open fresh interactive, login, noninteractive,
IDE or agent, and Git-hook contexts, and observe exact paths and versions. A
separate clean no-cache macOS qualification must prove downloads without a prior
Mise cache. Revisit this decision if atomic selection cannot preserve a verified
current revision or project overrides cannot work across the required launch
contexts.

## References

- `config/toolchain/versions.tsv`.
- `bin/dotfiles/toolchain --help`.
- `projects/reproducible-mac-development/specs/laptop-baseline.md` in the My
  Second Brain playground.
- [Mise configuration](https://mise.jdx.dev/configuration.html).
- [Mise lockfiles](https://mise.jdx.dev/dev-tools/mise-lock.html).
- [Mise shims](https://mise.jdx.dev/dev-tools/shims.html).
