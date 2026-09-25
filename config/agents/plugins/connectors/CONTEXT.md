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
One external MCP tool surface that a Connector Skill selects. Atlassian has
exactly one active Provider, Atlassian Community; a retired Provider survives
only as a name on persisted records.
_Avoid_: Connector Skill, Provider Route, service account

**Provider Route**:
The selected path from a Connector Skill to one Provider for one product and
one request. Atlassian has one Provider but two Provider Routes, one per
product, because the API token, credential item, and tool surface are
product-specific.
_Avoid_: Provider, server, credential

## Generic command core

**Front Door**:
The single plugin-wide compiled `bin/connectors` executable through which
humans and agents list, validate, and inspect Connector Skills; later
Tickets extend it to set up, diagnose, authenticate, repair and run them.
_Avoid_: wrapper, launcher, script

**Connector Manifest**:
The schema-validated, nonsecret `config/manifest.json` declaration of one
Connector Skill: its transport registry reference, selectors, requirements,
declared adapter, and any Custody Mode reference. Adding a keyless Connector
Skill needs only this file and its transport registry; the Front Door's own
source never changes for it.
_Avoid_: config, settings, mcporter.json

**Custody Mode**:
Where a Connector Skill's credential lives and which owner reads it, declared
per Connector Skill in its manifest as a nonsecret reference; it names a place
and an owner, never a credential value. `null` marks a keyless Connector
Skill. A packaged adapter's local check may confirm a reference is declared
without ever reading or holding the credential itself.
_Avoid_: auth type, login method, source

## Atlassian routing

**Atlassian Operation**:
One semantic Jira or Confluence action the Connector Skill exposes: get,
search, list transitions, create, update, transition, assign, comment, edit a
comment, attach a file, delete an attachment, or delete an issue or page.
_Avoid_: Tool, tool call, command

**Upload Outbox**:
The tenant's private 0700 directory under the state root where the dispatcher
stages every file to upload under a digest of its content, and where the
Provider starts so it can read staged uploads and nothing else.
_Avoid_: Temp directory, working directory, cache

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
The nonsecret record custody returns for one Atlassian Tenant and product: the
principal, the credential item revision, and the Trusted Site Origin. It
crosses the route; the credential value never does.
_Avoid_: Context, token, credential

**Atlassian Community**:
The independent `sooperset/mcp-atlassian` MCP Provider for Jira and Confluence,
the only active Atlassian Provider.
_Avoid_: Community route, fallback provider, backup provider, legacy connector

**Retired Provider**:
A Provider name that persisted Write Previews and Write Receipts may still
carry after its route was removed; today only `official`, the former
Atlassian-operated MCP Provider. Its records stay readable and keep blocking
their Object Identity, and no active route applies, adjudicates, or unlocks
them.
_Avoid_: Legacy provider, fallback, migration

## Canva custody

**Canva Account**:
The nonsecret slug that selects one Canva user's grant for a request. It is
the Route Selection for Canva; grants, vault roots, and logs never cross
accounts.
_Avoid_: User, tenant, profile, login

**Account Vault**:
The private owned directory per Canva Account that the packaged Canva adapter
gives MCPorter as its data and cache home, so MCPorter's native OAuth vault for that
account is independent of every other account and of MCPorter's default
home vault. MCPorter alone reads and writes the grant inside it; Connectors
claims no encryption for it.
_Avoid_: Session, token store, keychain

**Client Mode**:
The declared Canva client identity MCPorter registers with: `dcr`, dynamic
client registration, the working first-release mode; or `approved`, a
reserved future Developer Portal or metadata-document client that refuses
until separately built and admitted. No fallback runs between modes.
_Avoid_: Auth type, login method

**Canva Session** (former):
The below-MCPorter per-account record of client identity and tokens that the
packaged Canva adapter never uses (ADR 0004). Its files stay where they
are, unopened and unimported. After that account's replacement login and
reads pass, Nathan retires its `session.json`: an attended step removes
exactly that one file, never opened, copied, backed up, or printed, and
confirms absence by an existence check only. Connectors carries no remote
revocation and no automatic deletion.
_Avoid_: Current custody, Account Vault

**Attended Login**:
The one-time flow in which the system browser is opened for the user to grant
access and the loopback callback returns the code. Nathan completes it; no
agent drives the browser. For Canva it is MCPorter's own `auth`.
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
arguments, Object Identity, and observed revision before anything is sent.
_Avoid_: Dry run, plan, draft

**Write Receipt**:
The durable record of one attempted write: its Write Preview, whether the
request may have left the process, and its Write Outcome once known.
_Avoid_: Log entry, transaction, response

**Write Outcome**:
What a Write Receipt proves about the external object: completed with a named
effect, unchanged with a named basis, or unknown. Unknown is a state to
resolve, never a result to retry. A delete completes only on a not-found
read-back; an update completes only when the requested values, absent at
preview, are found.
_Avoid_: Status code, success or failure, error

**Adjudication**:
Operator-directed read-back through the Write Receipt's own Provider Route that
settles an unknown Write Outcome only on evidence found or proven absent. A
Write Receipt from a Retired Provider has no such route and is refused. It is
never a retry and never a manual mark of success.
_Avoid_: Retry, override, manual resolve, recovery run
