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
  the pilot's Node 24. Per-use checks cover layout, launcher text, modes, and
  version, not every dependency byte: weaker than the macOS signature check.
  Each MCPorter bump needs a new lockfile.
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

## Proposed decision

`pilot/build.ts` (`bun run build:pilot`) builds a directory marketplace on the
Linux arm64 host. It holds the front door compiled for bun-linux-arm64, only
the admitted Skills, and `vendor/mcporter`: the locked package plus a launcher
bound to the host's Node. On Linux the front door selects that staged copy
read-only (`bin/mcporter-packaged.ts`), declares MCPorter as its only
dependency, and refuses `setup` and `deps repair` with a rebuild handoff.
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
owns; per-use MCPorter checks are weaker than on macOS; the macOS test suite
cannot run on Linux, so macOS proof stays with CI. Neutral: the receiver
answers whoever can reach its socket as this user, as git's own cache does.

## Confirmation

`tests/linux-pilot.test.ts` proves platform tools, staged-MCPorter selection,
the lockfile pin, receiver reads, and the packaged build with a real git
receiver holding a sentinel. Live proof: in a fresh pilot Claude Code session
the Skills list, keyless Context7 and Firecrawl reads succeed, and Context7
account mode reads with the delivered key. macOS CI keeps `bun run test`.
