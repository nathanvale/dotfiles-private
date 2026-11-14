# Supplied flawed proposal to audit before returning drafts

Source `urn:delivery-slice:reading-queue`, SPEC-DRAFT r0.
AC-01: add valid entries and list them.
AC-02: invalid input preserves the queue and explains the error.
AC-03: entries and archive state survive restart.
AC-04: archive hides entries from active list and JSON export.
AC-05: JSON export contains active title/URL pairs; empty list/export are empty.

1. DRAFT-1: Add/list and validation. Covers AC-01, AC-02. No blockers.
2. DRAFT-2: Archive. Covers AC-04. Blocked by DRAFT-3, no reason supplied.
3. DRAFT-3: Export. Covers AC-05 and nonexistent AC-99. Blocked by DRAFT-2.
4. DRAFT-4: Archive again. Covers AC-04. Blocked by DRAFT-1.

This proposal is not accepted. Audit its outcomes, edges and coverage against the
source. Return corrected drafts and explain repairs. Preserve stable criterion
identities when revising the spec.
