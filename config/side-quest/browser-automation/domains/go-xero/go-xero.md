---
domain_format_version: 1
domain_key: go-xero
vendor: Xero
purpose: Bank reconciliation UI automation
session_name: go-xero
engine: agent-browser
auth: password_totp
canonical_status: canonical-managed
phase1_state: new-domain-bootstrapped
maturity_summary: flow-scaffolded-candidate
last_validated: 2026-04-07
expected_identity: nathanvale73@gmail.com
---

# go.xero.com

Xero web app — bank reconciliation UI automation for the `xero-cli` project. Covers `go.xero.com` and shares a Xero session with `login.xero.com`. The primary downstream task is filling `Who`/`What` fields and clicking `OK` on statement lines at `go.xero.com/BankRec/BankRec.aspx`.

## Target Flows

### bootstrap-observe

- **auth_required:** no
- **expected_identity:** n/a
- **maturity_state:** observation-only
- **promotion_eligible:** no
- **run_id:** xero-cli-bootstrap-2026-04-07-001
- **completed:** 2026-04-07
- **notes:** First-run observe-only bootstrap. Landed warm (no TOTP challenge). Password login sufficed. 751 items to reconcile observed on the dashboard.

### healthcheck

- **auth_required:** yes
- **expected_identity:** nathanvale73@gmail.com
- **cold_start_reset:** Clear cookies for go.xero.com when the first open resolves to login and the existing session is suspected stale.
- **maturity_state:** validated
- **promotion_eligible:** yes
- **notes:** Promoted to validated on run `go-xero-healthcheck-2026-04-08-001` (2026-04-08). Warm session confirmed, identity matched (Nathan Vale / nathanvale73@gmail.com), tenant confirmed (Arthur & B Consulting), BankRec URL confirmed, 750 unreconciled lines confirmed. G-008 fix applied and validated (DOM attribute query for Who/What fields). Recovery-free run with full evidence — promotion criteria met.

### reconcile-click-ok

- **auth_required:** yes
- **expected_identity:** nathanvale73@gmail.com
- **cold_start_reset:** Clear cookies for go.xero.com when the first open resolves to login and the existing session is suspected stale.
- **maturity_state:** candidate
- **promotion_eligible:** yes
- **notes:** Candidate helper translated from the legacy `CLICK_OK` recipe. Reads the visible reconcile count and clicks the target OK button for an already validated line. Not yet exercised via `/browse`.

### reconcile-fill

- **auth_required:** yes
- **expected_identity:** nathanvale73@gmail.com
- **cold_start_reset:** Clear cookies for go.xero.com when the first open resolves to login and the existing session is suspected stale.
- **maturity_state:** candidate
- **promotion_eligible:** yes
- **notes:** Candidate playbook translated from the legacy `FILL` recipe. Who uses `fill`; What remains unresolved between `type + Enter` and UUID-safe `fill` until the first live `/browse` run settles the tradeoff.

### reconcile-clear-and-fill

- **auth_required:** yes
- **expected_identity:** nathanvale73@gmail.com
- **cold_start_reset:** Clear cookies for go.xero.com when the first open resolves to login and the existing session is suspected stale.
- **maturity_state:** candidate
- **promotion_eligible:** yes
- **notes:** Candidate playbook translated from the legacy `CLEAR_AND_FILL` recipe. Clears the existing What value with `fill ""` before re-entering the corrected code. Not yet exercised via `/browse`.

### reconcile-batch

- **auth_required:** yes
- **expected_identity:** nathanvale73@gmail.com
- **cold_start_reset:** Clear cookies for go.xero.com when the first open resolves to login and the existing session is suspected stale.
- **maturity_state:** validated
- **promotion_eligible:** yes
- **notes:** Promoted to validated on run `go-xero-reconcile-batch-2026-04-10-002` (2026-04-10). 10 lines reconciled successfully (cold-start, count 750→740). Canonical reconciliation method is `_reconcile{id}.reconcileToFastTransaction()` via JS eval with `_accountCompleter.setValue(uuid_key)` for FILL lines. Must stay single-worker — same-domain parallel sessions remain unsafe.

## Domain Gotchas

### G-001 — `agent-browser type @ref` breaks on UUID values

- **state:** validated
- **source:** xero-cli project memory pre-bootstrap
- **applies_to_flows:** reconcile-fill, reconcile-clear-and-fill
- **detail:** Values like `601e62a1-...` are parsed as CSS selectors by the `type` command. For any field that may receive a UUID-shaped token (e.g. the `What` account dropdown), use `fill @ref "value"` instead of `type @ref "value"`.

### G-002 — xero-cli git-safety hook blocks inline interpreters

- **state:** validated
- **source:** xero-cli project memory pre-bootstrap
- **applies_to_flows:** all
- **detail:** The xero-cli repo's `git-safety` hook rejects `python3 -c "..."` and heredoc (`<< 'EOF'`) patterns. Any helper scripts must be standalone files under `scripts/` and called directly. Never use inline interpreters in commands or wrappers inside this domain folder.

### G-003 — agent-browser commands must run synchronously/foreground

- **state:** validated
- **source:** xero-cli project memory pre-bootstrap
- **applies_to_flows:** all
- **detail:** Background `agent-browser` tasks cause silent extraction failures. Any wrappers or scripts in this domain folder must enforce foreground/synchronous execution only.

### G-004 — What dropdown requires `type` + `press Enter`, not `fill`

- **state:** candidate (not yet exercised; sourced from prior xero-cli work notes)
- **source:** xero-cli project memory pre-bootstrap
- **applies_to_flows:** reconcile-fill, reconcile-clear-and-fill
- **detail:** The `What` dropdown is a React select. `fill` sets the visible value but the React component does not activate its selection handler. Use `type @ref "value"` followed by `press Enter` for this field specifically. Note the tension with G-001: if the account value contains UUID-shaped tokens, prefer `fill` to avoid CSS-selector parsing — test the actual values encountered to determine which gotcha takes precedence.

### G-005 — BankRec URL pattern resolved: legacy route confirmed

- **state:** validated
- **source:** run `xero-cli-reconcile-q1-fy26-2026-04-07-002` (healthcheck, 2026-04-07)
- **applies_to_flows:** healthcheck, reconcile-click-ok, reconcile-fill, reconcile-clear-and-fill, reconcile-batch
- **detail:** The Reconcile surface uses the LEGACY route `go.xero.com/BankRec/BankRec.aspx?accountId={uuid}`, NOT the tenant-scoped `go.xero.com/app/!rrT86/BankRec/...` pattern. The dashboard homepage is at the tenant-scoped `go.xero.com/app/!rrT86/homepage`, but clicking "Reconcile NNN items" on the Business Transaction Account card navigates to the legacy BankRec route. The accountId for Business Transaction Account 063-104-10535159 is `601e62a1-d42b-42da-a9fe-2a0a9e703a3b`. **Direct-nav URL:** `https://go.xero.com/BankRec/BankRec.aspx?accountId=601e62a1-d42b-42da-a9fe-2a0a9e703a3b`. Future flows can skip the dashboard navigation and go straight to this URL.

### G-006 — `op item get --fields password` returns OTP secret when 1Password item has TOTP

- **state:** validated
- **source:** diagnosed in run `xero-cli-reconcile-q1-fy26-2026-04-07-001` (quarantined NEEDS_HUMAN), carried forward and committed via run `xero-cli-reconcile-q1-fy26-2026-04-07-002`
- **applies_to_flows:** all auth-bearing flows (healthcheck, reconcile-click-ok, reconcile-fill, reconcile-clear-and-fill, reconcile-batch)
- **detail:** When the 1Password item contains an OTP field, `op item get <uuid> --fields password` returns the OTP secret string (65 chars) rather than the actual PASSWORD-purpose field (13 chars). Always use `op read "op://Vault/UUID/password"` for password retrieval on items with TOTP. Confirmed against the Xero 1Password item `xqeqosfunrvunkb3tpwvioftqa` on 2026-04-07.

### G-007 — Xero login endpoint rate-limits after repeated failures (not a stale-password problem)

- **state:** validated
- **source:** diagnosed in run `xero-cli-reconcile-q1-fy26-2026-04-07-001` (quarantined NEEDS_HUMAN), carried forward and committed via run `xero-cli-reconcile-q1-fy26-2026-04-07-002`
- **replaces:** the original G-007 ("1Password item has stale password") which was an incorrect diagnosis — the vault copy was verified current during the same session
- **applies_to_flows:** all auth-bearing flows (healthcheck, reconcile-click-ok, reconcile-fill, reconcile-clear-and-fill, reconcile-batch)
- **detail:** Xero's `login.xero.com` endpoint rate-limits or otherwise blocks repeated failed attempts from the same session. After two rejected attempts in quick succession, subsequent attempts with the CORRECT password still return the generic "Your email or password is incorrect" error. The agent cannot distinguish this from a genuinely wrong password. Agents MUST cap automated login attempts at 1 and return `Status: NEEDS_HUMAN` on first failure rather than retrying. Retrying makes the problem worse and can compound into account lockout. Implementation: pass `max_login_attempts: 1` in the dispatch prompt context of any `/browse` run that may need cold-start auth.

### G-008 — `scripts/healthcheck.js` placeholder matching must use DOM attribute query, not innerText

- **state:** validated
- **source:** run `xero-cli-reconcile-q1-fy26-2026-04-07-002` (filed), confirmed and fixed by run `go-xero-healthcheck-2026-04-08-001`
- **applies_to_flows:** healthcheck
- **detail:** Browser `placeholder` attribute text is NOT included in `document.body.innerText` — it lives only in input element placeholder attributes. Searching innerText for `"Name of the contact..."` or `"Choose the account..."` always returns `false` even when 103+ statement line inputs are visible. The original G-008 entry suggested adding trailing `...` — that was insufficient; the real root cause is innerText vs attribute. Fix applied in run `go-xero-healthcheck-2026-04-08-001`: use `document.querySelector('input[placeholder*="contact"]') !== null` for `hasWhoField` and `document.querySelector('input[placeholder*="account"]') !== null` for `hasWhatField`. Confirmed: both return `true` when statement lines are visible. Promoted to validated.

### G-009 — `agent-browser click @eN` does not trigger ExtJS OK button; use `.click()` via JS eval

- **state:** candidate
- **source:** run `xero-cli-reconcile-q1-fy26-2026-04-07-004` (reconcile-fill, 2026-04-07)
- **applies_to_flows:** reconcile-click-ok, reconcile-fill, reconcile-clear-and-fill, reconcile-batch
- **detail:** The Xero BankRec OK button is rendered by ExtJS. `agent-browser click @eN` on the OK link ref (`ref=eNNN`) and its parent onclick container do NOT trigger the reconciliation action — the click returns success but no state change occurs. JS `dispatchEvent(new MouseEvent('click', ...))` also fails. The correct method is `eval` with an IIFE that targets the `<a class="okayButton">` element inside the statement line's DOM container and calls `.focus(); .click()`. The statement line's DOM ID is `sl` + the statementLineId with hyphens stripped (e.g. `sl22cdec92e0b44884bdb5db88ed304352` for statementLineId `22cdec92-e0b4-4884-bdb5-db88ed304352`). Selector: `div.line[id="sl{statementLineId}"] a.okayButton`. Confirmed: this method successfully reconciled APPLE.COM/BILL $22.99 on 1 Jul 2025 (count 751→750) in run xero-cli-reconcile-q1-fy26-2026-04-07-004.

### G-012 — Reconcile object uses `_paidToCompleter` not `_contactCompleter` for the Who field

- **state:** validated
- **source:** run `go-xero-reconcile-batch-2026-04-10-003` (reconcile-batch, 2026-04-10)
- **applies_to_flows:** reconcile-click-ok, reconcile-fill, reconcile-clear-and-fill, reconcile-batch
- **detail:** The `_reconcile{idNoHyphens}` window object exposes `_paidToCompleter` (not `_contactCompleter`) for setting the Who/contact field. Any code calling `obj._contactCompleter.setValue(...)` will throw `TypeError: Cannot read properties of undefined`. The correct call is `obj._paidToCompleter.setValue('Contact Name')`. The `candidate-script-reconcile-fast-transaction.js` from batch 2026-04-10-002 must be updated to use `_paidToCompleter`. All 10 lines in batch-003 were reconciled successfully using this correction.

## Earned Artifacts

- selectors: `~/.config/side-quest/browser-automation/domains/go-xero/selectors.yaml`
- scripts: `~/.config/side-quest/browser-automation/domains/go-xero/scripts/*.js`
- playbooks: `~/.config/side-quest/browser-automation/domains/go-xero/playbooks/*.yaml`

### Selector Assets

| Asset | State | Allowed flows | Notes |
| --- | --- | --- | --- |
| `selectors.yaml#canonical_assets.browser_state` | `candidate` | `healthcheck`, `reconcile-batch` | Candidate shell/page fingerprints for the Xero web app and Reconcile surface. |
| `selectors.yaml#canonical_assets.bankrec_line_actions` | `candidate` | `reconcile-click-ok`, `reconcile-fill`, `reconcile-clear-and-fill`, `reconcile-batch` | Candidate line-level field metadata translated from the legacy Xero reconcile recipes. |
| `selectors.yaml#pages.bankrec.route` | `validated` | `healthcheck`, `reconcile-click-ok`, `reconcile-fill`, `reconcile-clear-and-fill`, `reconcile-batch` | Direct-nav URL: `https://go.xero.com/BankRec/BankRec.aspx?accountId=601e62a1-d42b-42da-a9fe-2a0a9e703a3b` (confirmed by runs xero-cli-reconcile-q1-fy26-2026-04-07-002 and xero-cli-reconcile-q1-fy26-2026-04-07-004). Promoted to validated. |

### Script Assets

| Path | State | Allowed flows | Notes |
| --- | --- | --- | --- |
| `scripts/healthcheck.js` | `validated` | `healthcheck`, `reconcile-batch` | Promoted to validated on run `go-xero-healthcheck-2026-04-08-001`. G-008 fix applied: DOM attribute query (`input[placeholder*="contact/account"]`) replaces broken innerText search. All fields (`success`, `reconcileCount`, `hasWhoField`, `hasWhatField`, `loginDetected`, `title`, `url`) confirmed working. 750 unreconciled count captured. |
| `scripts/reconcile-click-ok.js` | `candidate` | `reconcile-click-ok`, `reconcile-batch` | Candidate OK-button helper translated from the legacy single-line click path. NOTE: must be rewritten to use `.click()` via JS eval per G-009 — the `click @eN` method does not work for ExtJS buttons. |
| `scripts/click-ok-by-statement-line-id.js` | `candidate` | `reconcile-click-ok`, `reconcile-fill`, `reconcile-clear-and-fill`, `reconcile-batch` | New candidate script discovered in run xero-cli-reconcile-q1-fy26-2026-04-07-004. Targets `div.line[id="sl{statementLineId}"] a.okayButton` and calls `.focus(); .click()`. Requires the statementLineId (UUID with hyphens stripped to form the `sl...` div ID). |

### Playbook Assets

| Path | State | Allowed flows | Notes |
| --- | --- | --- | --- |
| `playbooks/reconcile-fill.yaml` | `candidate` | `reconcile-fill`, `reconcile-batch` | Candidate Who/What fill path with fresh-snapshot guardrails between each mutation. |
| `playbooks/reconcile-clear-and-fill.yaml` | `candidate` | `reconcile-clear-and-fill`, `reconcile-batch` | Candidate mismatch-correction flow that clears the What field before re-entry. |
| `playbooks/reconcile-batch.yaml` | `candidate` | `reconcile-batch` | Candidate sequential wrapper that composes the line-level reconcile flows without same-domain parallelism. |

## Iteration Log

| run_id | iteration | target_flow | status | commands_used | discovery_mode_cycles | tool_uses | duration_ms | recovery_used | promotion_recommendation | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| xero-cli-bootstrap-2026-04-07-001 | 1 | bootstrap-observe | SUCCESS | 14 | 0 | 14 | 66000 | no | n/a | Warm session — no TOTP challenge. 751 items to reconcile on dashboard. |
| xero-cli-retrofit-scaffold-2026-04-07-go | 2 | flow-scaffold | PARTIAL | 0 | 0 | 0 | 0 | no | n/a | Candidate selectors, script, and playbooks scaffolded from legacy xero-cli reconcile recipes. No live `/browse` execution yet. |
| xero-cli-reconcile-q1-fy26-2026-04-07-001 | 3 | healthcheck | NEEDS_HUMAN | 17 | 0 | 17 | 183000 | no | quarantine | Cold-start session. Two failed auto-login attempts: attempt 1 hit G-006 (wrong op field), attempt 2 hit G-007 rate-limit (original diagnosis of stale password was wrong). Run quarantined per protocol. Produced `pending-gotcha-corrections.json` for carry-forward. |
| xero-cli-reconcile-q1-fy26-2026-04-07-002 | 4 | healthcheck | SUCCESS | 24 | 0 | 35 | 406000 | no | G-005/G-006/G-007-corrected → validated; G-008 filed as candidate; selectors.yaml#pages.bankrec.route updated with concrete URL; healthcheck.js exercised successfully (bar G-008 bug) | Warm session after manual re-login. Identity matched. BankRec URL resolved to legacy route `go.xero.com/BankRec/BankRec.aspx?accountId=601e62a1-d42b-42da-a9fe-2a0a9e703a3b`. Reconcile tab shows 751 items. First visible line: 1 Jul 2025, Thats Amore Chadstone, Spent $16.26, Who/What blank (no bank rule). UI positioned at start of Q1 FY26 window. Carried forward G-006 and G-007-corrected from quarantined prior run. |
| xero-cli-retrofit-scaffold-2026-04-07-go | 2 | flow-scaffold | PARTIAL | 0 | 0 | 0 | 0 | no | n/a | Candidate selectors, script, and playbooks scaffolded from legacy xero-cli reconcile recipes. No live `/browse` execution yet. |
| xero-cli-reconcile-q1-fy26-2026-04-07-003 | 5 | reconcile-fill | PARTIAL | 8 | 0 | 8 | 0 | no | n/a | Target line (PRIME VIDEO $9.99) not visible on BankRec page — likely auto-reconciled by Xero bank rule. Bailed per protocol. Snapshot captured; APPLE.COM/BILL $22.99 confirmed visible at position 7 of 1 Jul 2025 group. |
| xero-cli-reconcile-q1-fy26-2026-04-07-004 | 6 | reconcile-fill | SUCCESS | 18 | 0 | 18 | 345000 | no | G-009 filed as candidate; selectors.yaml#pages.bankrec.route → validated; scripts/click-ok-by-statement-line-id.js filed as candidate | Warm session. APPLE.COM/BILL $22.99 (1 Jul 2025, statementLineId=22cdec92-...) reconciled. Fields pre-filled by bank rule. G-004 NOT exercised. G-009 discovered: `click @eN` fails on ExtJS OK button; use `.focus(); .click()` via JS eval on `div.line[id="sl{statementLineId}"] a.okayButton`. Count 751→750 confirmed. |
| go-xero-healthcheck-2026-04-08-001 | 7 | healthcheck | SUCCESS | 11 | 0 | 11 | 240000 | no | healthcheck → validated; G-008 → validated; scripts/healthcheck.js → validated | Warm session, no auth required. Identity: Nathan Vale / nathanvale73@gmail.com confirmed via user menu. Tenant: Arthur & B Consulting confirmed. BankRec direct-nav URL resolved correctly. Reconcile(750) tab counter captured. 103 statement lines visible in DOM (50 Who + 50 What input fields). G-008 root cause confirmed (innerText vs placeholder attribute) and fix applied. healthcheck flow promoted to validated — first recovery-free warm run with full field confirmation. |
| go-xero-healthcheck-2026-04-10-002 | 8 | healthcheck | SUCCESS | 9 | 0 | 9 | 480000 | no | cold-start TOTP path confirmed — warm+cold evidence now complete for healthcheck flow | Cold-start session: login.xero.com redirect confirmed, password + TOTP challenge both resolved automatically (G-006 compliant op read, G-007 compliant single attempt). Identity: Nathan Vale / nathanvale73@gmail.com confirmed. Tenant: Arthur & B Consulting. Reconcile(750) confirmed. healthcheck.js returned success, hasWhoField=true, hasWhatField=true. First fully automated cold-start TOTP run — resolves project memory note about unproven cold path. |
| go-xero-reconcile-batch-2026-04-10-002 | 9 | reconcile-batch | SUCCESS | 18 | 3 | 45 | 1500000 | no | reconcile-batch → candidate_to_validated; G-010 corrected (uuid key pattern confirmed); G-011 filed (1Password intercepts login clicks); scripts/reconcile-fast-transaction.js filed as candidate | Cold-start session. 10 lines reconciled: 8 FILL + 2 CLICK_OK (pre-filled TOKYO DELI + LIUSHILIN). Count 750→740 confirmed. Key discoveries: (1) `_reconcile{id}.reconcileToFastTransaction()` is more reliable than G-009 okayButton.click(); (2) _accountCompleter.setValue() needs UUID key not account code string; (3) 1Password extension intercepts login button clicks — JS eval workaround required. |
| go-xero-reconcile-batch-2026-04-10-003 | 10 | reconcile-batch | SUCCESS | 20 | 0 | 20 | 480000 | no | G-012 filed+validated (_paidToCompleter correction); 6 new account UUID keys discovered (433/400/469/449/434/485); account key catalog extended to 10 codes | Cold-start session (password+TOTP). 10 lines reconciled (lines 11-20, all 2 Jul 2025 except line 20 on 3 Jul 2025). Count 740→730 confirmed. Mix: 1 FILL + 6 CLEAR_AND_FILL_WHO_ONLY + 2 CLEAR_AND_FILL_WHAT + 1 CLEAR_AND_FILL_BOTH. Key correction: _contactCompleter does not exist — correct property is _paidToCompleter (G-012). |
| go-xero-reconcile-batch-2026-04-10-004 | 11 | reconcile-batch | SUCCESS | 18 | 0 | 18 | 420000 | no | 2 new account UUID keys discovered (465/493); account key catalog extended to 12 codes | Cold-start session (password+TOTP). 5 lines reconciled (lines 21-25, 3-4 Jul 2025). Count 730→725 confirmed. Mix: 2 CLICK_OK (GITHUB, MYKI) + 1 CLEAR_AND_FILL_BOTH (RUSTICA CAFE) + 2 CLEAR_AND_FILL_WHO_ONLY (Intl Transaction Fee, FRONTENDMASTERS). accountCompleter.data used (not masterData/_items) to discover 465/493 UUID keys. |
