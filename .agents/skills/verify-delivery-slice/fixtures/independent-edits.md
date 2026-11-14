# Supplied synthetic note-board outcome

Canonical source: `urn:delivery-slice:note-board`, branch revision 7.
The owner accepted two local CLI improvements on 14 November 2026. Rename a
note and toggle its favorite flag. Draft spec and tickets only; no implementation,
publication, readiness or dispatch approval exists.

## Existing supported behavior and seam

The supplied baseline already creates notes, lists them, persists title and
favorite fields across restart, and exports both fields through its public CLI.
Its export reads current persisted fields without a new adapter. The existing
process-level seam can create two notes, run commands, restart on the same data
directory, list and parse JSON export. The baseline accepts an empty note board.
The title and favorite mutations are independent operations on the same stable
entry contract. Neither new command needs the other implemented first. There
is no new storage/setup prerequisite or new test interface to design here.
This is supplied evidence for planning; no actual note-board app is provided.

## Accepted outcomes

- Rename preserves identity and the favorite flag. A nonblank title is required;
  blank input explains the problem and preserves state. List and export show
  the new title before and after restart.
- Favorite toggle preserves identity and title. List and export show its new
  flag before and after restart. Repeating toggle restores the original value.
- Unknown note identifiers report an explanatory error without mutation. An
  empty board remains empty after either rejected operation and after restart.
- Using both commands in either order preserves both changes in list/export.
  Each owning slice includes applicable interaction checks using the existing
  public seam. Joint checks do not create a new implementation dependency.

## Decisions and open fog

D-N1 accepted: keep the existing local entry contract, CLI and process seam.
D-N2 accepted: no accounts, network, sync or storage migration in this outcome.
Shared cloud boards remain an unrelated open question. No delivery records
exist in this complete synthetic ledger; live deduplication is unverified.
