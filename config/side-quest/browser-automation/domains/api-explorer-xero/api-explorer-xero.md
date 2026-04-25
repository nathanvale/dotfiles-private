---
domain_format_version: 1
domain_key: api-explorer-xero
vendor: Xero
purpose: Finance API & Accounting API extraction via Xero API Explorer browser
session_name: api-explorer-xero
engine: agent-browser
auth: password_totp
canonical_status: canonical-managed
phase1_state: new-domain-bootstrapped
maturity_summary: flow-scaffolded-candidate
last_validated: 2026-04-08
expected_identity: nathanvale73@gmail.com
---

# api-explorer-xero

Xero API Explorer domain — used for Finance API and Accounting API access that bypasses the OAuth WAF block on the PKCE app (GitHub issue #10). The API Explorer browser session has access to partner-only scopes (e.g. `finance.bankstatementsplus.read`) that the programmatic app cannot obtain.

**URL:** https://api-explorer.xero.com/
**Active tenant:** Arthur & B Consulting

## Target Flows

### bootstrap-observe
- auth_required: no
- expected_identity: n/a
- maturity_state: observation-only
- promotion_eligible: no
- run_id: xero-cli-bootstrap-2026-04-07-002
- completed: 2026-04-07
- notes: First-run bootstrap observation. Landed warm (no TOTP challenge). Identity matched. API dropdown structure captured. Finance API confirmed visible.

### healthcheck
- auth_required: yes
- expected_identity: nathanvale73@gmail.com
- cold_start_reset: Clear cookies for api-explorer.xero.com when the first open resolves to login and the existing session is suspected stale.
- maturity_state: validated
- promotion_eligible: yes
- first_validated_run_id: xero-cli-api-explorer-healthcheck-2026-04-07-001
- last_validated: 2026-04-07
- notes: First live `/browse` run (iteration 3). Warm session confirmed. Identity matched (nathanvale73@gmail.com via DOM eval). Tenant matched (Arthur & B Consulting). API dropdown expanded — 9 APIs observed, exact match with bootstrap list. Finance API visible. Endpoint and Operation dropdowns confirmed disabled-until-API-selected (G-007 re-validated). No recovery used. Promoted to validated.

### ensure-api
- auth_required: yes
- expected_identity: nathanvale73@gmail.com
- cold_start_reset: Clear cookies for api-explorer.xero.com when the first open resolves to login and the existing session is suspected stale.
- maturity_state: candidate
- promotion_eligible: yes
- notes: Candidate scaffold from the legacy API-switch recipe. Downstream Endpoint and Operation dropdowns stay disabled until API is selected. Always re-snapshot after changing the API.

### extract-bankstatementsplus
- auth_required: yes
- expected_identity: nathanvale73@gmail.com
- cold_start_reset: Clear cookies for api-explorer.xero.com when the first open resolves to login and the existing session is suspected stale.
- maturity_state: candidate
- promotion_eligible: yes
- first_exercised_run_id: api-explorer-xero-extract-bsp-fy26-q1-2026-04-08-001
- last_exercised: 2026-04-08
- notes: Candidate playbook translated from the legacy BankStatementsPlus extraction cascade. Envelope remains `statements[].statementLines[]`. Guardrail: reject ranges longer than 366 days before touching the browser. First live /browse exercise on 2026-04-08: warm session, Status 200, 414 lines for Q1 FY26. Ace editor JS extraction confirmed (copy-response.js scaffold insufficient — Ace editor used instead). Response body is in Ace editor; access via `ace.edit(document.querySelector('.ace_editor')).getValue()`. Promotion requires one additional recovery-free cold-start run.

### post-banktransaction
- auth_required: yes
- expected_identity: nathanvale73@gmail.com
- cold_start_reset: Clear cookies for api-explorer.xero.com when the first open resolves to login and the existing session is suspected stale.
- maturity_state: candidate
- promotion_eligible: yes
- notes: Candidate playbook translated from the legacy rapid-fire POST path. Uses Accounting API, BankTransactions endpoint, and a caller-supplied JSON body. Not yet exercised via `/browse`.

## Domain Gotchas

### G-001: fill-not-type-for-uuid-values
- state: validated
- source: xero-cli project memory pre-bootstrap
- agent-browser `type @ref` command breaks on UUID values (e.g. `601e62a1-...`) — they are parsed as CSS selectors, not string literals. Use `fill @ref "value"` for any field that may receive a UUID (tenant IDs, statement IDs, parameter form inputs in the API Explorer).

### G-002: git-safety-hook-blocks-inline-interpreters
- state: validated
- source: xero-cli project memory pre-bootstrap
- The xero-cli repo's git-safety hook blocks `python3 -c "..."` and heredoc (`<< 'EOF'`) patterns. Helper scripts must be standalone files under `scripts/` and called directly. Not directly a browser automation gotcha but affects any agent working in the xero-cli repo while the browser session is live.

### G-003: agent-browser-must-run-synchronous-foreground
- state: validated
- source: xero-cli project memory pre-bootstrap
- agent-browser commands must run synchronously (foreground). Background tasks cause silent extraction failures. Particularly critical during BankStatementsPlus extraction where the response copy step has historically failed silently in background mode.

### G-004: snapshot-refs-unstable-between-dropdown-changes
- state: validated
- source: observed during bootstrap-observe run xero-cli-bootstrap-2026-04-07-002
- The API Explorer re-renders the DOM on every dropdown selection. Snapshot refs (e.g. @e8, @e9) change after every dropdown mutation. A fresh `snapshot` is required after each dropdown selection before targeting downstream elements. Never reuse refs across dropdown interactions.

### G-005: prefer-fill-over-type-globally
- state: validated
- source: xero-cli project memory pre-bootstrap (legacy recipe pattern)
- All historical xero-cli browser recipes preferred `fill @ref "value"` over `type @ref "value"`. Apply this preference consistently across all API Explorer interactions.

### G-006: finance-api-scope-partner-only
- state: validated
- source: xero-cli project memory pre-bootstrap
- `finance.bankstatementsplus.read` is a partner-only scope. It is unavailable to PKCE apps but IS accessible via the API Explorer browser session. This is the entire architectural reason the api-explorer-xero domain exists — it routes around the programmatic OAuth WAF block documented in GitHub issue #10.

### G-007: endpoint-and-operation-dropdowns-gated-on-api-selection
- state: validated
- source: observed during bootstrap-observe run xero-cli-bootstrap-2026-04-07-002
- The Endpoint dropdown and Operation dropdown are disabled (aria-disabled) until an API is selected. Similarly the Endpoint must be selected before Operation becomes active. The cascade is strict: API → Endpoint → Operation. Do not attempt to click downstream dropdowns before the upstream selection is made.

### G-008: 1password-overlay-blocks-totp-confirm-button
- state: candidate
- source: observed during healthcheck run api-explorer-xero-healthcheck-2026-04-08-001
- The 1Password browser extension renders a "Save in 1Password" / "No items to show" dropdown overlay on the TOTP input field during login. This overlay blocks the Confirm button visually and may intercept agent-browser click commands on it. Workaround: (1) fill the TOTP field, (2) call `document.activeElement.blur()` via eval to dismiss the overlay, (3) submit via JS: `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Confirm').click()`. Also note: the overlay delay can consume most of a 30-second TOTP window — if the first code expires, fetch a fresh code before retrying. This gotcha is specific to the shared Chrome profile where 1Password extension is active.

## Earned Artifacts

- selectors: `~/.config/side-quest/browser-automation/domains/api-explorer-xero/selectors.yaml`
- scripts: `~/.config/side-quest/browser-automation/domains/api-explorer-xero/scripts/*.js`
- playbooks: `~/.config/side-quest/browser-automation/domains/api-explorer-xero/playbooks/*.yaml`

### Selector Assets

| Asset | State | Allowed flows | Notes |
| --- | --- | --- | --- |
| `selectors.yaml#canonical_assets.browser_state` | `candidate` | `healthcheck`, `ensure-api` | Candidate shell/page fingerprint registry scaffolded from the legacy API Explorer navigation reference. |
| `selectors.yaml#canonical_assets.bankstatementsplus` | `candidate` | `extract-bankstatementsplus` | Candidate parameter form and response-area metadata for Finance API extraction. |
| `selectors.yaml#canonical_assets.banktransaction_post` | `candidate` | `post-banktransaction` | Candidate endpoint/operation metadata for Accounting API POST requests. |

### Script Assets

| Path | State | Allowed flows | Notes |
| --- | --- | --- | --- |
| `scripts/healthcheck.js` | `candidate` | `healthcheck` | Read-only DOM healthcheck scaffold translated from the legacy browser recipe. |
| `scripts/ensure-api.js` | `candidate` | `ensure-api`, `extract-bankstatementsplus`, `post-banktransaction` | Candidate API dropdown helper that switches only after explicit target-api injection. |
| `scripts/copy-response.js` | `candidate` | `extract-bankstatementsplus`, `post-banktransaction` | Candidate response-body extraction helper. Not yet exercised against the live API Explorer DOM. |

### Playbook Assets

| Path | State | Allowed flows | Notes |
| --- | --- | --- | --- |
| `playbooks/extract-bankstatementsplus.yaml` | `candidate` | `extract-bankstatementsplus` | Candidate Finance API extraction flow with a 366-day preflight guardrail. |
| `playbooks/post-banktransaction.yaml` | `candidate` | `post-banktransaction` | Candidate Accounting API POST flow using the same endpoint/operation cascade as the legacy path. |

## Iteration Log

| run_id | iteration | target_flow | status | commands_used | discovery_mode_cycles | tool_uses | duration_ms | recovery_used | promotion_recommendation | notes |
|--------|-----------|-------------|--------|---------------|----------------------|-----------|-------------|---------------|--------------------------|-------|
| xero-cli-bootstrap-2026-04-07-002 | 1 | bootstrap-observe | SUCCESS | 14 | 0 | 14 | ~60000 | no | n/a | Warm session, identity matched, API dropdown structure captured, Finance API confirmed visible |
| xero-cli-retrofit-scaffold-2026-04-07-api | 2 | flow-scaffold | PARTIAL | 0 | 0 | 0 | 0 | no | n/a | Candidate selectors, scripts, and playbooks scaffolded from legacy xero-cli recipes. No live `/browse` execution yet. |
| xero-cli-api-explorer-healthcheck-2026-04-07-001 | 3 | healthcheck | SUCCESS | 13 | 0 | 13 | ~120000 | no | healthcheck→validated; selectors.yaml#canonical_assets.browser_state→validated; selectors.yaml#pages.api_explorer_shell.route→validated | First live healthcheck. Warm session, identity confirmed (nathanvale73@gmail.com via DOM eval), tenant matched (Arthur & B Consulting), 9 APIs observed (exact bootstrap match), Finance API visible, Endpoint+Operation disabled-until-API-selected (G-007 re-validated). |
| api-explorer-xero-healthcheck-2026-04-08-001 | 4 | healthcheck | SUCCESS | 22 | 0 | 22 | ~180000 | no | n/a | Cold session — login+TOTP required. 1Password overlay on TOTP field required blur+JS click workaround (new gotcha G-008 staged). Fresh TOTP needed after first code expired during overlay delay. All 9 APIs confirmed. Finance API visible. Endpoint+Operation disabled until API selected (G-007 re-validated). |
| api-explorer-xero-extract-bsp-fy26-q1-2026-04-08-001 | 5 | extract-bankstatementsplus | SUCCESS | 22 | 0 | 22 | ~900000 | no | extract-bankstatementsplus→candidate (no recovery, single run — warm+cold needed for promotion) | Warm session. Identity matched (Nathan Vale / nathanvale73@gmail.com). Finance API → BankStatementsPlus → Get Bank Statement Accounting. Status 200. 414 statement lines, 1 statement envelope (2025-07-01 to 2025-09-30). Root keys confirmed: bankAccountId, bankAccountName, bankAccountCurrencyCode, statements. Ace editor extraction via JS API. Raw envelope saved to transaction path. G-001/G-004/G-005 all applied (fill not type, fresh snapshot after each dropdown, refs discarded after each mutation). |
