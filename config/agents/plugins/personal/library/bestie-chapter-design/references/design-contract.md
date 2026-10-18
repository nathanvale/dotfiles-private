# Design contract resolution

Use this route to find and trust the Bestie design contract before any chapter
build, revision, template work or consistency review. `bestie-chapter-design`
and `kate-berry-creative-director` both use it. The packet owns the contract's
content; this file owns only how to find and trust it.

## Find the owner

1. Read `~/.config/context/vault.md`, then the canonical packet
   `projects/melanie-fourth-anniversary-meme-album/` (`README.md`, `GOAL.md`).
   Look for the design owner there. Do not assume a fixed path, or that the
   packet names one: on the Mini it currently has no `design-system.md` and no
   pointer to it.
2. When the packet has no design owner, follow the Bestie project memory route:
   `MEMORY.md`, then `memory/reference/README.md` (from the Herdr project root
   `bestie-book`). That index names the snapshot location and its verification
   boundary. Read it each time; do not copy its paths here or from an earlier
   session.

## Accept one source

Record which one you used:

- **Current canonical source.** The packet's design owner, read now, with its
  path, revision (commit or digest) and the time read.
- **Verified dated snapshot.** Only when the canonical file is absent. It needs
  all of: the date and source revision in its name or header; a content hash
  you recompute with `shasum -a 256`; and an owning receipt, named by the memory
  index or a fresh source handoff, that records that hash. A snapshot is not
  automatically current. A dated copy found anywhere else (worktree, cache,
  handoff, chat) is context, not authority.

A snapshot missing the receipt, or whose hash differs, is unverified: request a
fresh source handoff. Never invent a receipt, infer authority from a filename, or
rebuild the contract from memory or exemplar pixels. With no verified source,
stop layout decisions and keep to read-only inspection and copy checks.

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

Name the contract source (canonical revision, or snapshot path, hash and
receipt), and any deviation or unresolved uncertainty.
