# Design contract resolution

Resolve the Bestie design contract through this route before any chapter build,
revision, template work or consistency review. Both `bestie-chapter-design` and
`kate-berry-creative-director` use it. The packet owns the contract's content;
this file owns only how to find and trust it.

## Find the packet

1. Read `~/.config/context/vault.md`, then the vault root instructions and the
   `projects/melanie-fourth-anniversary-meme-album/` packet `README.md` and
   `GOAL.md`. Follow the packet's own pointers to its design owner. Never
   assume a fixed vault path or that `design-system.md` exists locally.
2. Use the design owner the packet names. Today that is `design-system.md`.
   Check the live packet, not a remembered path or a prior session's copy.

## Accept one source

Accept exactly one of these, and record which in the handback:

- **Current canonical source.** The packet's design owner, read now. Record its
  path, revision (commit or digest) and the time read.
- **Verified dated snapshot.** Use only when the canonical file is absent or
  unreadable on this machine. It must have all of:
  - a date and the canonical revision it was taken from;
  - a content hash that you recompute and match against the recorded hash;
  - an owning receipt, written by the packet's design owner, that names the
    snapshot and its hash.

  A snapshot missing any part is unverified. A copy found in a worktree, cache,
  handoff or chat is context, not authority.

Neither source available: stop the layout decision. Report the missing owner
and what you tried, and keep to work the contract does not govern (source
copy checks, read-only inspection). Never rebuild the contract from memory,
exemplar pixels or this skill's prose.

## Surface uncertainty first

Before a new layout decision, tell Nathan which source you resolved and any
doubt: stale or unverified snapshot, revision mismatch with the packet,
conflicting owners, or a missing proof. Ask one grounded question when the
doubt could change the layout. Carry a settled choice forward without asking.

## Keep these bindings exact

- Copy: use the selected blocks from their copy owner, verbatim.
- Artwork: use the accepted version and its recorded hash; keep revisions and
  originals separate.
- Status: label every choice accepted, proposed or unresolved. A proposed
  layout never becomes accepted by being used.
- Style provenance: read paragraph, character, object and parent styles from the
  native document (actual ranges, overrides and applied parents), then compare
  them with the contract. A style name, an installed font or the snapshot's
  description alone does not prove what a page uses.

## Hand back

Name the contract source (canonical or snapshot), its revision or hash and, for
a snapshot, the receipt. Record deviations and unresolved uncertainty.
