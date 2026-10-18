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
2. When the file is absent, read the current canonical source from the
   MacBook before any snapshot. Follow the Bestie project memory route
   (`MEMORY.md`, then `memory/preferences.md` and `memory/reference/README.md`,
   Herdr project `bestie-book`):
   - `preferences.md` names the SSH alias for scoped MacBook source reads. Use
     it as written and check reachability now; a sandbox denial does not prove
     the host is offline.
   - The reference index and its receipt name the canonical packet and design
     owner path on the MacBook. Take the path from there; never from this skill
     or an earlier session.
   - Read it read-only (no writes, no checkout changes):

     ```sh
     ssh <alias> 'cd <packet repo> && git rev-parse HEAD && git status --short \
       && git log -1 --format=%H -- <design owner> && shasum -a 256 <design owner>'
     ssh <alias> 'cat <design owner>'
     ```

   A successful read is the **current canonical source** (see below). Use the
   dated snapshot only when this route cannot be reached or the owner is absent
   there; then continue with step 3 and its qualification limits.
3. Find the owning receipt, durable record first:
   - **Durable.** The project memory index (step 2), or a note it links, may
     record the receipt: snapshot path, sha256, canonical source path and
     revision, and the date. Prefer it; it survives project traffic.
   - **Transient.** The coordinator's recent-entries window. Read the installed
     board CLI help (`herdr-projects --help`) for `coordinator --project REPO
     where`, then run it with `--json` and `HERDR_SOCKET_PATH` set to the live
     Herdr socket:

     ```sh
     herdr-projects coordinator --project bestie-book where --json
     ```

     Plain `where` shows truncated previews; only `--json` returns each entry's
     full `.said`. The window is short: ordinary project traffic pushes older
     entries out, so a receipt found there earlier may be gone now.

   A qualifying receipt, from either, names the snapshot path, its sha256, and
   the canonical source path and revision. Select entries by full `id`; never by
   prefix or preview, and never from the coordinator's private state files. If
   neither source yields one, the receipt is unresolvable: say so, stop layout
   decisions, and ask the owner (Desktop or the native Bestie project) to record
   the receipt in the project memory. Do not write it yourself.

## Accept one source

Record which one you used:

- **Current canonical source.** The packet's design owner, read now (locally or
  over the MacBook route), with its path, revision (commit or digest), sha256
  and the time read.
- **Verified dated snapshot.** Only when no canonical source can be read. It needs
  all of: the date and source revision in its name or header; a content hash
  you recompute with `shasum -a 256`; and an owning receipt (step 3) that records
  that same hash and names the canonical source it came from. A dated copy found
  anywhere else (worktree, cache, handoff text, chat) is context, not authority.

A verified snapshot is authority as of the receipt, not proof of the current
canonical file. Say so: report the receipt's recorded source revision, and
treat the snapshot as current only if fresh foreground evidence confirms the
canonical file's hash is unchanged. Check the durable project memory first, then
a second public lookup, the default (machine) coordinator, which is a different
record from the project's and has the same short window:

```sh
herdr-projects coordinator where --json
```

Select `.where[]` by full `id`. Accept an entry only when its full `.said` gives
the canonical path, the observed revision, the last file-changing commit and a
sha256, and that sha256 equals the one you recomputed for the snapshot. A direct
reply from Nathan also counts. A claim you cannot resolve to such an entry, or a
differing hash, stays unconfirmed. When currency is unconfirmed, a settled choice
may continue; ask before a new layout decision the later canonical revisions
could change.

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
