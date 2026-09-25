---
name: xero
description: "Coordinate one Xero BAS quarter cycle through reconciliation, handoff, and lodgment evidence."
disable-model-invocation: true
---

# Xero

Use only after explicit invocation for one named organisation and quarter.

## Quarter Cycle

- Choose or reconcile a quarter, assess its BAS due date, or inspect prepared,
  sent, lodged, and payment state: read
  `references/quarter-reconciliation.md`.
- For the standard quarterly BAS due-date reference: read
  `references/ato-quarter-due-dates.md`.
- Import a bank statement, run payroll, finalise a BAS workpaper, or export
  Excel data: read `references/capability-stubs.md` and stop at its handoff.

## Safety Gate

- Treat `draft_created`, `sent_to_accountant`, `lodged`, and `paid` as separate
  evidence states.
- Never infer accountant lodgment from Xero finalisation, an exported workbook,
  a Gmail draft, or a payment notice.
- Use `xero-cli` for deterministic reconciliation state, the native Harness
  browser in Nathan's signed-in Chrome for live Xero interaction
  (`$HOME/code/dotfiles/docs/agents/browser-automation.md`), `gog` for
  Gmail evidence, and `quarter-ledger.ts` as the cross-owner receipt spine.
- Require current human approval before any financial or externally visible
  write. Ledger recording is local evidence, not write authority.

## Start

Run `bun skills/xero/scripts/quarter-ledger.ts commands --json`, then `status
--json`. If a quarter is named, inspect and continue only that quarter through
the approved cycle. Never switch to another quarter. If no quarter is named,
show the redacted ledger table and ask for one exact quarter.
