# Reading queue: supplied synthetic Wayfinder records

These records are a test input, not live planning or permission to publish.
Canonical fixture identity: `urn:delivery-slice:reading-queue`. Revision 3.

## Accepted outcome

The owner accepted a local reading queue on 12 November 2026: add a titled URL,
list active entries, archive an entry and export active entries as JSON. Entries
and archive state must survive restart. Empty queues list and export as empty.
The owner requests a reviewable spec and ticket breakdown only.

## Decisions

- D1, accepted: single-user local storage; no accounts, sync, credentials or server.
- D2, accepted: add requires a nonblank title and an HTTP or HTTPS URL; invalid
  input explains the error and leaves the queue unchanged.
- D3, accepted: archive hides an entry from the active list and active JSON export.
- D4, accepted: JSON export includes title and URL for active entries only.
- D5, accepted: use the existing CLI and its process-level regression seam. No
  new persistence or interface architecture is accepted by this record.

## Open fog

Multi-user sharing, search and phone capture remain unanswered and outside this
outcome. They must remain open; none gates local queue planning.

## Existing delivery records

This complete synthetic ledger contains one canceled record, OLD-A: add a cloud
sync login. It is outside the accepted outcome and is not an implementation
prerequisite. There are no other delivery records in this fixture. Live tracker
currency and live deduplication remain unverified.

## Implementation evidence

An existing CLI exposes add, list, archive and export entry points. Its normal
process tests can start with a fresh temporary storage directory and restart
against the same directory. This supplied record describes an existing seam;
no actual reading-queue application is provided for execution in this test.
