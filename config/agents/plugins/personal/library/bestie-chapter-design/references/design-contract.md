# Design contract resolution

Use this route to find and trust the Bestie design contract before any chapter
build, revision, template work or consistency review. `bestie-chapter-design`
and `kate-berry-creative-director` both use it. The packet owns the contract's
content; this file owns only how to find and trust it.

## Find the owner

1. Read `~/.config/context/vault.md`, then the canonical packet
   `projects/melanie-fourth-anniversary-meme-album/` (`README.md`, `GOAL.md`).
   Look for the design owner there. Do not assume a fixed path or that the
   packet names one; a machine may hold the packet without that file.
2. When the file is absent, follow the Bestie project memory route:
   `MEMORY.md`, then `memory/reference/README.md` (Herdr project `bestie-book`).
   That index names the snapshot location and its verification boundary. Read
   it each time. Mini paths, hashes and revisions are mutable state: take them
   from the live owner, never from this skill or an earlier session.
3. For the owning receipt, look in the project's public coordinator record (the
   Herdr project state for `bestie-book`; see Herdr control for how to read it)
   for a handoff that names the snapshot, its hash and the canonical source.
   Without one, request a fresh source handoff.

## Accept one source

Record which one you used:

- **Current canonical source.** The packet's design owner, read now, with its
  path, revision (commit or digest) and the time read.
- **Verified dated snapshot.** Only when the canonical file is absent. It needs
  all of: the date and source revision in its name or header; a content hash
  you recompute with `shasum -a 256`; and an owning receipt (step 3) that records
  that same hash and names the canonical source it came from. A dated copy found
  anywhere else (worktree, cache, handoff text, chat) is context, not authority.

A verified snapshot is authority as of the receipt, not proof of the current
canonical file. Say so: report the receipt's recorded source revision, and
treat the snapshot as current only if fresh foreground evidence (Nathan or
Desktop) confirms the canonical file's hash is unchanged. When currency is
unconfirmed, a settled choice may continue; ask before a new layout decision
the later canonical revisions could change.

A snapshot with no matching receipt, or a hash that differs, is unverified:
request a fresh source handoff. Never invent a receipt, infer authority from a
filename, create the canonical file on a machine that lacks it, or rebuild the
contract from memory or exemplar pixels. With no verified source, stop layout
decisions and keep to read-only inspection and copy checks.

## Surface uncertainty first

Before a new layout decision, say which source you resolved and any doubt:
unverified or stale snapshot, revision mismatch, conflicting owners, missing
proof. Ask one grounded question when the doubt could change the layout. Carry
settled choices forward.

## Then work from the owners

Copy and artwork bindings, accepted-versus-proposed status and native style
provenance stay with their existing owners:
[the chapter workflow](../SKILL.md) and [production checks](production-checks.md).
Do not restate them here.

## Hand back

Name the contract source (canonical revision, or snapshot path, hash, receipt
and its currency qualification), and any deviation or unresolved uncertainty.
