---
status: accepted
---

# Use Agent Browser for approved unattended website logins

## Context and Problem

Pi, Claude Code and Codex need the same unattended website login route on the
laptop and Mini. The scoped read-only 1Password account and encrypted Keychain
delivery work on both. The native Codex credential helper cannot supply the
other harnesses' browser runtimes. Native autofill requires Nathan to unlock
and approve the extension when it locks.

## Decision Drivers

- Reuse supported browser and credential-delivery interfaces.
- Keep credentials outside model-visible commands, output and persistent agent environments.
- Preserve API Credentials access for Connectors.
- Limit website delivery to approved Agent Browsing bindings and domains.
- Keep the existing trusted same-user security model explicit.

## Considered Options

- Native harness browsers: preserve existing sessions, but provide no common
  private unattended credential interface across the three harnesses.
- Native 1Password autofill: supported and useful for user-present login, but
  cannot meet unattended operation when unlock is required.
- Agent Browser's credential-provider protocol: shares one maintained browser
  CLI across harnesses and resolves credentials on demand through private
  stdio. It adds one pinned browser dependency and a small provider adapter.

## Decision

Adopt the third option for approved unattended logins. Keep ordinary user-browser
work on its native harness route under ADR-0011. Keep native 1Password autofill
as the user-present fallback. The existing whitelist owns account, origin and
item bindings; only Agent Browsing is eligible for this provider. Connectors
continues its independent API Credentials custody path.

Nathan approved permanent adoption on 30 October 2026 after the bounded trial
passed on both machines through Codex-controlled shell, Pi RPC shell and Claude
Code shell mode. This is an unattended-login exception to ADR-0011, not a return
to the retired browser relay infrastructure. ADR-0014's native Codex route
remains available for its supported runtime.

Nathan's 2 November 2026 timesheets uplift extends this exception to the
timesheets consumer's draft preparation, screenshot review and separately
approved submission in the same dedicated session. The consumer retains its
identity, period, draft and screenshot-bound approval checks. This avoids a
session transfer to personal Chrome. Other user-browser work retains its native
harness route.

FastTrack's username-first flow uses the same provider's `credential.fill`
capability, one observed field at a time. The adapter keeps native batch input
private and returns only status; the consuming workflow owns Next, Login and
protected-account proof. Native complete-form auth remains the OnCore route.

## Consequences

- Positive: supported native browser commands own credential input transport;
  the provider reuses existing item validation and scoped custody. Staged
  filling adds input checks and leaves login buttons with the consumer.
- Negative: dedicated browser sessions require their own login and may expire.
  Keychain lock or desktop logout may block Mini SSH access.
- Negative: same-user code, a voluntary whitelist and existing Mini admin rights
  cannot contain a compromised agent. Read-only vault grants do not make the
  website or retrieved API credentials read-only.
- Neutral: no paid service, additional vault grant, stored unlock password or
  replacement of underlying website/API credentials is required.

## Confirmation

Pass process tests for private protocol delivery, mapping/account refusal and
sanitized failures. Repeat real Oncore account verification, session reuse and
controlled logout recovery through installed payloads on both Macs and each
harness. Verify configured Connectors consumers and live Jira reads before and
after old-token revocation. Keep natural expiry and reboot recovery distinct
from controlled logout proof.

For timesheets, qualify each portal with a saved draft reopened from its
canonical list and a complete private screenshot evidence set. Stop before
submission until Nathan approves that exact set. A new login or resumed task
must recheck the saved draft before using an approval.

Qualify FastTrack's staged route independently on each Mac and harness with
protected-account proof, session reuse, controlled logout recovery and native
refusal of a wrong stage or nonempty field. Serialize these runs because
FastTrack invalidates another browser or device's session. Keep approved runtime
hosts separate from the exact origin eligible for credential delivery.

## References

- [Native harness browsers](0011-native-harness-browsers.md).
- [Native Codex login composition](0014-allowlisted-native-browser-logins.md).
- [Agent Browser setup](../../config/agents/plugins/personal/library/one-password/references/agent-browser.md).
- [Vendor credential-provider interface](https://agent-browser.dev/commands#auth-vault).
