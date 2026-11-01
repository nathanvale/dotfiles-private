---
status: proposed
---

# Admit NotebookLM through its vendor-managed profile

## Context and problem

Nathan requested restoration of NotebookLM in the current Connectors Plugin
for Codex and Claude Code. The retired development plugin remains disabled.
The installed vendor uses its own profile store, rather than MCPorter OAuth
or a static API key. Existing global MCPorter configuration cannot enforce
the new Connector Skill's action guards or output projections.

## Decision drivers

- Reuse vendor authentication without exposing or copying credentials.
- Keep route selection in the shared Provider Route and one compiled Front Door.
- Enforce bounded input, projected output and unknown-effect recovery.
- Preserve unsupported workflows as explicit qualification gaps.

## Considered options

| Option | Credential ownership | Routing and privacy | Recovery and cost |
| --- | --- | --- | --- |
| Restore the old global commands | Vendor keeps profiles | Bypasses packaged action guards; relies on agent redaction | No enforced preview or durable receipt |
| Implement a new Google client | Duplicates authentication | New transport and security responsibilities | Largest maintenance burden and unsupported protocol assumptions |
| Package a vendor-managed stdio Provider | Vendor keeps profiles | Existing shared route; exact tools and internal projections | Qualify each effect; block unsupported operations |

## Proposed decision

Use the vendor-managed stdio Provider. Add `vendor-managed-profile` to Custody
Mode and report it as not yet effective in local configuration inspection.
Live safe readiness separately establishes authentication status. An explicit
`profile` Route Selection maps to the vendor's source-qualified `NLM_PROFILE`
setting. The Provider disables debug output and automatic rate-limit retries.

The adapter admits schema-qualified reads and journaled notebook/source
renames. It refuses all remaining effects before dispatch. Notebook queries
persist chat history and therefore remain outside the read-only route.

## Consequences

Credential ownership stays with the vendor. The Front Door never imports
cookies. Every admitted call uses a packaged registry and validated reply
projection. Unsupported operations remain unavailable rather than silently
inheriting the old skill's broad dispatch authority.

The dependency remains independently installed. Profile selection does not
prove its Google account identity or protect against manual reauthentication
and direct vendor calls. New vendor versions need qualification.

## Reuse of Canva authentication plumbing

Canva's accepted ADR 0004 places its OAuth grant and refresh in MCPorter's
account-scoped vault. NotebookLM uses the vendor's profile and browser login,
so reusing that vault or OAuth exchange would misrepresent credential custody.
Both adapters reuse the Front Door, Prepared contract, Provider Route,
safe-environment policy and private-state helpers. The NotebookLM Provider
also reuses provider-process for executable selection and process replacement.
No second token store, browser controller or OAuth implementation is added.

## Confirmation and authority

Nathan is decision authority. This record remains proposed; the implementation
is a reviewable candidate under the foreground implementation request.
Public-process tests must prove privacy, action guards, stale/duplicate apply
refusals and unknown-write recovery. Fresh Codex and Claude Code sessions must
prove discovery and safe readiness separately from live content and write proof.
Revisit on vendor profile semantics changes or any newly admitted effect.
