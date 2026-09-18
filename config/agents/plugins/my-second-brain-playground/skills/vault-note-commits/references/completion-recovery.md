# Completion recovery

The helper saves a terminal receipt before removing a successful candidate.
Receipts live under `$XDG_STATE_HOME/my-second-brain/vault-note-commits/receipts/`,
defaulting to `~/.local/state/my-second-brain/vault-note-commits/receipts/`.
Files use mode `0600`; their directory uses `0700`.

Retry using the same XDG state owner and exact absolute worktree path returned
by `begin`. The receipt binds that path, run identity, vault, admitted files,
and original outcome. A local `refs/vault-note-commits/<runId>` Git reference
anchors its evidence. Keep those local references out of remote publication.

`ALREADY_COMPLETED` is read-only. If cleanup failed, it reports the retained
candidate for inspection instead of removing later edits. An invalid or
missing receipt is not evidence of failure or permission to repeat the work.
Inspect the candidate and canonical Git history before taking another action.

Recovery covers losing the response after the terminal receipt was saved.
A crash between integration and receipt persistence leaves an integrated
commit without a receipt; retry `finish` with the same worktree path. When
Git proves `main` already contains the candidate commit with exactly the
admitted paths, the retry records the completion and returns `INTEGRATED`
without replaying the fast-forward. Any other crash boundary still requires
inspection; the helper does not claim automatic recovery across all of them.

Nathan owns retention. Keep a receipt and its matching local Git reference
together while retries may occur; remove both only after the run is no longer
needed. Private checker diagnostics are disposable after the failure has been
resolved. Promote durable findings, not diagnostic logs, into the vault.
