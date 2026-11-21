---
status: proposed
---

# Run Connectors in the Linux agents pilot

## Context

The agents pilot is a Linux arm64 container whose coordinators need Connector
Skills. The plugin was macOS-only: a Mach-O front door, a notarized MCPorter
binary, Mac-only op, mise, and uv releases, and static credentials read with a
Keychain-held 1Password service-account token. A pilot worker never receives
that token (agents-home capabilities guidance). MCPorter 0.14.0 publishes
compiled binaries for macOS only; its other release asset is the npm package,
whose digest `provenance.json` lists.

In scope: Context7, Firecrawl, Mermaid, Notion, and JEV. Figma, Figma Console,
and Canva are excluded by Nathan; Atlassian is Monash-only.

## Decision drivers

Keep the macOS build and behavior unchanged. Pin and verify every executable
the pilot runs. Keep the service-account token and 1Password out of the
worker. Reuse the pilot's existing credential delivery. Add no ongoing
dependency the operator cannot audit. Ship no Skill that can only fail.

## Options

MCPorter on Linux:

- Official npm package installed by a committed lockfile (chosen). The lock's
  sha512 for mcporter equals the official release tgz; every dependency
  installs only by its locked integrity, with lifecycle scripts off. Runs on
  the pilot's Node 24. Per-use checks cover layout, launcher text, modes, the
  Node binary's recorded sha256, one recorded digest of the mcporter package's
  files, and the reported version. They do not cover the bytes of MCPorter's
  dependencies, which the lockfile pins at install time only, and the Node
  digest is the build host's own, not an upstream pin: weaker than the macOS
  signature check. Each MCPorter bump needs a new lockfile.
- Compile MCPorter for bun-linux-arm64 from the pinned commit. Matches the
  macOS shape, but the digest becomes ours, not upstream's.
- Wait for an upstream Linux release. Blocks the pilot indefinitely.

Credentials on Linux:

- The operator's delivery receiver (chosen). A host process reads one
  1Password item and stores its value on SSH stdin in a git credential-cache
  receiver behind a private 0700 socket, under a 900 s lease it refreshes.
  Connectors asks that receiver at call time with the registered item ID as
  the username. No op, token, file, or new protocol in the worker.
- A Connectors-owned receiver. Same properties, but new code on both ends.
- herdr-secret. A second secret store to keep in sync.
- op in the pilot. Needs the token in the worker, which is forbidden.

NotebookLM needs a logged-in desktop browser profile and a launchd route; it
is left out of the pilot until a persistent browser profile exists there.

Notion uses no shared credential: each account's grant comes
from MCPorter's attended OAuth login, whose callback lands on the
container's loopback. It can complete only in a browser inside the
container (the task browser), with Nathan signing in; that login is not yet
proven, so it stays on the live-proof list.

## Proposed decision

`pilot/build.ts` (`bun run build:pilot`) builds a directory marketplace on the
Linux arm64 host. It holds the front door compiled for bun-linux-arm64, only
the admitted Skills, and `vendor/mcporter`: the locked package plus a launcher
bound to the host's Node. The build records, in `vendor/mcporter/release.json`,
the sha256 of that Node binary and one digest over every file of the staged
mcporter package. On Linux the front door selects that staged copy read-only
(`bin/mcporter-packaged.ts`): before each use, and before Node or MCPorter
runs, it recomputes both digests and refuses a difference as
`packaged-node-mismatch` or `packaged-mcporter-mismatch`. It declares MCPorter
as its only dependency, and refuses `setup`, `deps repair`, and every staged
MCPorter failure with a rebuild handoff, never an in-place repair.
Account-key, Mermaid, and JEV custody reads its item through
`bin/credential-item.ts`, which asks the receiver on Linux
(`bin/delivered-credential.ts`) and 1Password on macOS. The receiver for a
connector is `~/.cache/connectors/<id>/socket`, host
`<id>.connectors.invalid`, username the registered 1Password item ID.

Installation copies the marketplace to `/opt/plugin-sources/connectors` and
enables it in the pilot's Claude settings. The operator owns the sender,
its targets, and the pilot-side receiver lifecycle.

## Consequences

Positive: the pilot gets Connectors without its token or op; the macOS route
is untouched; a lapsed lease refuses with an operator handoff and never falls
back to keyless mode. Negative: a 66 MB Node dependency tree the pilot build
owns; per-use MCPorter checks are weaker than on macOS; each use hashes the
122 MB Node binary and the 2 MB mcporter package, about 50 ms beside the
existing 32 ms version check (measured in a scratch container from the pilot
image, 21 November 2026); the record sits in the same plugin copy as the
front door, so it catches a changed Node or package, not a writer who
replaces the whole copy; the macOS test suite cannot run on Linux, so macOS
proof stays with CI. Neutral: the receiver answers whoever can reach its
socket as this user, as git's own cache does.

## Confirmation

`tests/linux-pilot.test.ts` proves platform tools, staged-MCPorter selection,
the recorded Node and package digests, the lockfile pin, receiver reads with
their ownership and symlink refusals, and the packaged build with a real git
receiver holding a sentinel. Its two Linux process tests run in no hosted
check; macOS CI skips them and keeps `bun run test`.

Observed live, each with a record:

- On the pilot, keyless reads through the staged MCPorter: Firecrawl
  `firecrawl_search` (17 November 2026 UTC) and Context7 `resolve-library-id`
  (18 November 2026 UTC), retained in the pilot's Connectors evidence state.
- In a scratch container from the pilot image (21 November 2026, recorded on
  dotfiles-private pull request 291 and its digest follow-up): the pilot
  build, the Linux process tests, a keyless Context7 schema and read, and
  `auth check` against a real git credential-cache receiver holding a
  sentinel.

Not proven:

- A Context7 account-mode read with a real delivered key. An earlier draft
  listed it as live proof. No record of it exists: Connectors retains keyless
  reads only, and every recorded receiver check used a sentinel.
- The Skills list in a fresh pilot Claude Code session: reported by the
  DOTF-10 task, with no retained record.
- A Notion attended login and read in the task browser.
