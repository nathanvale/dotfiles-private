---
name: xero-cash-coding
description: Review and batch-code Xero bank statement lines in the native browser using reconciled history and a private local cache.
---

# Xero Cash Coding

Use Xero's Cash coding screen and Account transactions history directly. This
workflow needs no Xero API, OAuth application, or xero-cli. BAS preparation,
lodgment, payroll, and payments are separate workflows.

## Open and scope

Use the native Harness browser selected by Nathan. In Codex, use the existing
in-app Xero tab when requested; inspect its actual login state. Nathan completes
sign-in challenges. Keep using that tab and confirm the organisation and bank
account from the live page. Record `organisation.id` verbatim from the Xero
web-app organisation route shown in its URL; do not infer a GUID. Carry forward
the selected quarter or date range.

Open Cash coding through the account's visible navigation. Read its pending rows
and available filters. If it reports no statement lines to reconcile, report that
and stop reconciliation. A balance difference is a separate issue; it does not
authorize creating entries or undoing reconciliations. An empty queue does not
prove all bank activity has been imported or the BAS has been lodged.

## Learn only what the batch needs

Read [the cache contract](references/history-cache.md) before using local history.
From `config/agents/plugins/personal/skills/xero-cash-coding/helper/`, run
`bun --no-install dist/xero-history.js <command> [options]`. In the repository,
`bun run --silent xero-history <command> [options]` uses the same committed
bundle. Single-quote the route code in shell commands, for example
`--organisation-id '!Ab12c'`, to keep `!` literal. Use `status` and `lookup`
for cached examples, and `recover` to inspect an interrupted update. Feed only
verified browser observations to `preview`, review its added and replaced
transaction IDs, then use `apply --approve` for that exact preview. Use cached
examples to identify likely matches, then inspect Account transactions
for missing, conflicting, or stale evidence. Open transaction details to obtain
the actual account, tax treatment, splits, and contact: a list row saying
Reconciled proves none of those coding choices by itself.

Read visible tables in a batch through the browser's supported DOM tools when
available. Use search, date filters, sorting, and pagination exposed by Xero.
Collect recurring payees needed for the pending batch before expanding history.
Prefer a suitable built-in report/export if it exposes the required coding fields;
verify its headers and scope before treating it as history. Browser interaction
stays in the native tool; local processing operates only on obtained observations.

Treat historical coding as precedent, not a tax decision. Match direction,
description, contact, currency, and business context as well as payee. Keep
conflicting treatments, split transactions, mixed-purpose merchants, and new
vendors for review. Use the Reconcile screen for invoice/bill matches and
transfers so cash coding does not create duplicate entries.

## Review and apply

Group consistent proposed rows by contact, account, and tax treatment. Present a
compact preview with date range, row count, total, proposed fields, historical
examples, and exceptions. Bind approval to the exact rows and values; obtain
Nathan's approval before saving the batch. Follow the active Harness's action
policy and hand off a final action when that policy requires it.

Re-read the live rows before applying. Populate only approved fields and verify
every selected row, amount, account, tax treatment, and batch total before Save &
Reconcile. Use Xero's bulk controls when their selection scope is visible. Start
with a small batch on the first run; enlarge batches after a verified result.

After saving, inspect the result and confirm affected transactions in Xero. If a
save times out or its outcome is unclear, inspect those transactions before any
retry; leave unknown outcomes unresolved. A changed queue count alone does not
prove correct coding. Update the cache from verified saved details through
`xero-history preview` and `apply`.

Report confirmed reconciliations, exceptions, and unresolved outcomes separately.
Keep history collection resumable; a partial cache is sufficient to start a batch.
