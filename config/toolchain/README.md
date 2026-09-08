# Toolchain baseline

`versions.tsv` records the laptop's expected Node, Bun, Python, Git, and npm
versions, selected owner, qualification state, and any parent runtime. It is
consumed by
`bin/dotfiles/toolchain`.

The manifest is deliberately not a lockfile. Mise is the selected source owner
for Node, Bun, and Python, declared in `../mise/source.toml`. npm names `node`
as its declared parent and is not declared or installed as a standalone Mise
tool. Its expected child version remains in this manifest. Status observes the owning Node
runtime through Mise, including the npm and Node executable paths, the Node
version, and whether `mise which npm` routes to the npm executable beside that
Node. A canonical shim is not sufficient evidence when Mise still routes npm
to a standalone installation. A
declaration alone does not satisfy this check. Setup and shell bootstrap are now configured to install Mise, apply one
verified revision, and select it across terminal and Git-hook launches. The
implementation is hermetically tested but not yet evidence of live machine
installation or activation. fnm, pyenv, and Homebrew remain installed fallbacks
during qualification. System Git remains `unqualified`: its exact supported
owner is explicitly unresolved.

`source_declared` means an exact version appears in tracked source, including
npm's child expectation in the manifest. It does not
mean the version can be installed on a clean machine, activated in every launch
context, or reconstructed exactly. The command reports the selected owner and
an independently observed owner separately; selected-owner matching is not an
inference from a version alone.

The manifest is complete only with exactly one Node, Bun, Python, Git, and npm
row. Every version must use exact three-part numeric syntax. npm must be
Mise-owned beneath Node; the other language-runtime rows must be Mise-owned
with no parent; Git stays system-owned with no parent. This source-only command
accepts `source_declared` or `unqualified` rows only. A `qualified` row needs an
external qualification receipt and returns a structured repairable error here.
Empty, missing, duplicate, unknown, or malformed rows also return a structured
repairable error in JSON mode. `verify_install.sh` treats that declaration
health as a failure and suppresses the separate qualification warning until
health is restored. A valid but source-only or not-selected runtime remains the
separate, non-blocking qualification warning.

Run this read-only check after setup or before an update decision:

```sh
bin/dotfiles/toolchain status --json
bin/dotfiles/toolchain update --preview --json
```

`status` reports expected and effective versions, executable paths, current
owner checks, npm's observed owning Node runtime, and an explicit qualification
verdict. Missing, unreadable, split, or version-mismatched npm parent evidence
makes status `not_ready`. `update --preview` reports
truthful actions, including `no_change` when a declaration already matches, and
refuses to apply them. Both commands are read-only: they never install,
upgrade, modify configuration, change Git state, or read credentials.

Mise ownership accepts either the executable path returned by `mise which` or
a configured Mise shim path, but only after `mise which` succeeds. Python can
also be observed as pyenv-owned by its direct `pyenv which python` result or
configured pyenv shim, but only after that command succeeds. A path that merely
resembles either shim is not ownership evidence.

The applied-revision process now proves a labeled identity that binds the source
snapshot and generated lock, immutable publication, atomic tokened lock records,
idempotent application, race-sensitive single-writer retry, whole-process-group
interruption cleanup, HOME containment, and known-good recovery through its
fake-Mise public-process harness. Config-sensitive Mise calls for lock, install,
no-change verification, publication verification, and recovery run from a
private empty operation capsule beneath the validated toolchain state. The
capsule is also supplied as `MISE_CEILING_PATHS`, while
`MISE_GLOBAL_CONFIG_FILE` names only the staged or selected revision. Relevant
per-tool version selectors and alternate config discovery variables are
removed from the child environment. The capsule is removed on success,
failure, handled signals, and stale-lock takeover. This prevents project or
state-directory config from merging into the fixed global revision operation.
Cleanup eligibility is ownership-explicit: a process marks a capsule owned only
after exclusive creation succeeds, so a pre-existing path or losing creation
race cannot delete another process's directory.
The same create-then-adopt rule covers staging directories, lock records,
canonical lock links, stale-takeover claims, install gates, and the temporary
`current` symlink. INT and TERM are deferred across each successful
exclusive-create-to-owned transition, then
delivered after validation so cleanup cannot miss a newly owned artifact or
remove an unowned race winner.
Stale repair is serialized by a BSD advisory lock that the operating system
releases if its process dies. The managed claim is an atomic hard link from a
name bound to the exact stale owner token to the claimant's sealed 0444 record,
so its token and PID exist at publication. A serializer holder revalidates the
canonical lock's token and inode, preserves malformed or live claims, and may
retire a managed claim only after its recorded owner is dead. It holds the
serializer through stale removal and replacement lock publication, so a
delayed contender cannot act on a replacement live lock. Stale canonical
retirement defers handled signals and adopts the exact validated private record
for cleanup immediately after unlink succeeds. Selection similarly owns its
temporary symlink only after exclusive creation and defers handled signals
through the atomic replacement, preserving both foreign preplants and the last
selected revision on failure.
Normal canonical lock publication uses the same serializer. When the canonical
lock is absent, it drains at most sixteen orphan claims only after validating
each claim filename, exact one-line shape, 0444 mode, and dead PID. A claim is
managed when it is a hard link to its sealed claimant record, or when that
record is absent because an interrupted cleanup already removed it while
retaining the sealed claim as the final recovery anchor. Cleanup removes the
private claimant record first and the claim link last. It also removes a
matching dead retired-lock record when present. Normal drain runs before the
new entrant creates its own private record. Live,
malformed, foreign, or excessive evidence is preserved and produces a
structured refusal. This lets a normal apply recover a takeover killed between
canonical retirement and successor publication without bypassing an in-flight
takeover.
The applied global config is the personal default. Hermetic real-zsh and agent
launch tests prove that project-local Node, Bun, and Python overrides win while
inside a project, then the personal defaults resume outside it without changing
the applied config bytes.

Future boundaries remain explicit: clean no-cache VM qualification, live Mise
installation and activation in login, interactive, noninteractive, agent, and
Git-hook launches, exact Git ownership, and destructive package pruning.
