# Connectors

This context names the agent-facing concepts for reaching MCP-backed external
services through the Connectors plugin. It is a glossary only.

## Core routing

**Connectors Plugin**:
The versioned personal plugin that groups focused skills for MCP-backed
external services and owns their Route Selection and guarded outcomes.
_Avoid_: Generic MCP registry, Harness configuration, integration layer

**Connector Skill**:
An agent-facing workflow for one MCP-backed service or a coherent service
family within the Connectors Plugin.
_Avoid_: Provider, connector, integration

**Route Selection**:
The non-secret values a request supplies to choose a Provider Route, such as
the Atlassian Tenant. A Route Selection never carries a credential.
_Avoid_: Credential, configuration, environment

**Provider**:
One external MCP tool surface that a Connector Skill can select. Two Providers
may expose different operations for the same service.
_Avoid_: Connector Skill, Provider Route, service account

**Provider Route**:
The selected path from a Connector Skill to one Provider for one product and
one request. Atlassian has two Providers but four Provider Routes, one per
Provider and product.
_Avoid_: Provider, server, credential

## Atlassian routing

**Atlassian Operation**:
One semantic Jira or Confluence action the Connector Skill exposes: get,
search, create, update, or comment on an issue or page.
_Avoid_: Tool, tool call, command

**Atlassian Tenant**:
The Atlassian site intended for one request, distinct from the credential that
may grant access to several sites.
_Avoid_: API token, cloud ID, account

**Trusted Site Origin**:
The tenant's site address as recorded in its own credential item metadata,
the only source against which a Provider's reported site may be matched. Canva
has no analogue: its endpoint is fixed and its identity is the account.
_Avoid_: Token-management URL, provider-reported URL

**Credential Binding**:
The nonsecret record custody returns for one Atlassian Tenant and product:
product tag, principal, credential item revision, and Trusted Site Origin. Both
Providers use the same product binding. The credential value never crosses it.
_Avoid_: Context, token, credential

**Atlassian Official**:
The Atlassian-operated MCP Provider for Atlassian Cloud products.
On 2026-09-23 both existing Monash product items authenticated to its live
endpoint with Basic (initialize HTTP 200), and direct schema discovery returned
the same 21-tool catalog. This is distinct from a dispatcher live read.
_Avoid_: Official route, default provider, Rovo

**Atlassian Community**:
The independent `sooperset/mcp-atlassian` MCP Provider for Jira and Confluence.
_Avoid_: Community route, fallback provider, backup provider, legacy connector

**Provider Parity**:
Live evidence that Atlassian Official and Atlassian Community answered the same
Atlassian Operation for the same Atlassian Tenant, Trusted Site Origin, and
normalized principal with the same object, using the same product Credential
Binding. Without it, one Provider never stands in for the other.
Default selection of Community for an operation Official cannot safely prepare
is made before a process starts and still requires the Community write gate;
it is not a retry after an Official attempt.
_Avoid_: Fallback, compatibility, equivalence

**Parity Attestation**:
The durable, expiring record of one proven Provider Parity for one Atlassian
Operation and input shape. It binds the safe revision of the shared product
credential item, so rotation invalidates it. It gates automatic fallback and explicit
selection of Atlassian Community, including direct capability selection for
unsupported Official writes.
_Avoid_: Cache, allowlist, override

## Canva sessions

**Canva Account**:
The nonsecret slug that selects one Canva user's session for a request. It is
the Route Selection for Canva; sessions, locks, and logs never cross accounts.
_Avoid_: User, tenant, profile, login

**Canva Session**:
The private per-account record of one authorised grant: its client identity,
authorization server, access token, and refresh token. It exists only below
MCPorter and ends by logout or by Canva revoking the grant.
_Avoid_: Credential, cache, cookie

**Attended Login**:
The one-time flow in which the system browser is opened for the user to grant
access and the loopback callback returns the code. Nathan completes it; no
agent drives the browser.
_Avoid_: Automated login, headless login, OAuth flow

## Atlassian writes

**Object Identity**:
The stable name of the Jira or Confluence object a write acts on, derived only
from the request: the issue key or page id for an update or comment, and the
destination container plus subject for a create, whose object does not yet
exist.
_Avoid_: Page title alone, provider-assigned id, target

**Write Preview**:
The durable record that binds an intended write to its exact input, provider
selection and arguments, Object Identity, and observed revision before anything
is sent. Apply refuses a different selected Provider before credential custody.
_Avoid_: Dry run, plan, draft

**Write Receipt**:
The durable record of one attempted write: its Write Preview, whether the
request may have left the process, and its Write Outcome once known.
_Avoid_: Log entry, transaction, response

**Write Outcome**:
What a Write Receipt proves about the external object: completed with a named
effect, unchanged with a named basis, or unknown. Unknown is a state to
resolve, never a result to retry.
_Avoid_: Status code, success or failure, error

**Adjudication**:
Operator-directed read-back through the Write Receipt's own Provider Route that
settles an unknown Write Outcome only on evidence found or proven absent. It
is never a retry and never a manual mark of success.
_Avoid_: Retry, override, manual resolve, recovery run
