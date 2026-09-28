# Private history cache

Use the cache to avoid repeated browser reads. Xero owns current accounting state;
cached examples suggest coding and never authorize a write.

## Location and custody

Resolve an absolute `XDG_STATE_HOME`, falling back to `$HOME/.local/state` when
unset or relative. Use `xero-cash-coding/<organisation-key>/<account-key>/history.json`
beneath it. Derive directory keys from verified stable Xero identifiers using only
letters, digits, and hyphens; store the observed display names inside the file.
The helper encodes each exact verified ID as `id-<lowercase UTF-8 hex>` so IDs
that differ by case have distinct keys on case-insensitive filesystems. Beside
`history.json`, it keeps `history.json.preview.json`,
`history.json.journal.jsonl`, and `history.json.lock` in the same account folder.
Reject symlinks in the cache path. Keep directories owner-only (0700) and files
owner-only (0600); create the private directory before writing financial data.

Use `xero-history status` and `lookup` to read cached examples. Submit verified
observations through `preview`; review its added and replaced IDs before the
exact `apply --approve`. The helper reads before merging, preserves unrelated
observations, validates JSON, and replaces through a sibling temporary file and
atomic rename. If another session is writing the same account, stop cache writes
and continue live reads. Use read-only `recover` for interrupted updates and
follow its operator repair steps for a pending journal or dead writer lock. A
missing, malformed, or incompatible cache is a cache miss, not a reconciliation
blocker; preserve a damaged file for recovery instead of overwriting it.

Keep this data outside Git, vault notes, shared folders, and plugin payloads. Store
no credentials, cookies, authentication-bearing URLs, screenshots, or full bank
account numbers. Keep only the history needed for coding and source references.

## JSON format, version 1

Store these top-level fields:

- `schemaVersion`: `1`.
- `organisation`: verified `id` and `name`.
- `bankAccount`: verified `id` and `name`.
- `updatedAt`: ISO timestamp of the cache update.
- `coverage`: an array of observed date intervals or search scopes, each with
  `from`, `to`, `query`, `observedAt`, and `complete`. A payee search is not full
  account coverage. Mark complete only after checking all results in that scope.
- `transactions`: verified historical observations, keyed by Xero transaction ID.

Each transaction contains `id`, `date`, `direction`, `currency`, `amountMinor`,
`payee`, `description`, `contact`, `reconciled`, `observedAt`, and `lines`.
Represent amounts as integer minor units in the stated currency; transaction
`amountMinor` is the bank movement. Each line stores the observed `accountCode`,
`accountName`, `taxType`, `amountMinor`, `amountBasis`, and any observed tracking
values. Store `amountBasis` per line as observed; lines of one transaction
normally share one basis. Set it to `tax-inclusive`, `tax-exclusive`, or `no-tax`
only when that basis is visible in Xero; use null when unobserved. Record the
basis as shown, without inferring it from `taxType` or converting `amountMinor`.
Use null for other unavailable fields; retain Xero's exact tax label.
Preserve splits rather than flattening them into one account. A contact stores its
observed ID when available and its display name. A transaction ID is its source
reference; omit session-bearing URLs. Incomplete observations cannot support a
confident coding suggestion.

## Refresh and lookup

Partition by organisation and bank account before searching. Preserve raw payee
and description text; normalize case and whitespace for lookup without merging
distinct merchant names. Rank examples by context similarity and recency, and
surface differing accounts or tax treatments rather than voting them away.
Compare a pending bank amount with the cached transaction `amountMinor` (the bank
movement), never with a line `amountMinor`.
Compare line amounts only when both `amountBasis` values are observed and equal.
Surface differing or unknown bases as a match exception and in the proposal;
inspect live details before treating those amounts as equivalent or suggesting
confident coding.

On each run, refresh relevant recent history and the newest cached interval with
an overlap so late entries are seen. Deduplicate by transaction ID and replace a
cached record when live detail has changed. An incremental refresh cannot detect
every historical edit: recheck a representative live precedent for each proposed
coding group before approval, and inspect all conflicts individually.

Record refresh coverage only after the relevant results have been read. Absence
from a partial search does not mean a transaction was deleted. Invalidate a
specific record when live evidence shows deletion or changed coding. Cache
unavailability reduces speed only; continue through Xero's UI when possible.
