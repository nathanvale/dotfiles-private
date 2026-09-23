---
status: proposed
---

# Scope native MCPorter OAuth to Figma

## Context and Problem

The Connectors route currently forces `--no-oauth` and keeps credentials below MCPorter. A local MCPorter 0.14.0 trial against Figma's hosted MCP completed attended OAuth and tool discovery when the client name was `Claude Code`. Registration under MCPorter's own identity returned HTTP 403. Nathan selected the working local flow for this connector. How should that flow enter the plugin without changing existing Providers?

## Decision Drivers

- Keep the Figma endpoint fixed and the exposed tools read-only.
- Make browser authorization attended and separate from ordinary calls.
- Preserve existing Providers' custody and route behavior.
- State the borrowed client identity and provider approval gap plainly.
- Keep credential material out of source, arguments, and logs.

## Considered Options

- Continue waiting for a separately admitted Connectors client and below-MCPorter Provider.
- Add a declared MCPorter OAuth mode for Figma's hosted Provider.
- Enable OAuth for every Connector Skill.

## Decision

Declare `oauth: "mcporter"` only on Figma's route. The shared launcher permits attended `auth` only for that declaration and keeps `--no-oauth` on ordinary `list` and `call`, which use cached credentials. MCPorter owns the Figma OAuth cache. Existing Provider routes retain their current credential custody and behavior. The registry fixes Figma's endpoint, read-tool allow-list, and the locally working `clientName: "Claude Code"`.

## Consequences

- Positive: the plugin follows the locally proven MCPorter login and discovery path without another OAuth implementation.
- Positive: ordinary reads cannot open an OAuth browser flow implicitly.
- Negative: MCPorter now holds Figma tokens above the former credential line, with its own cache and refresh semantics.
- Negative: `Claude Code` is a borrowed client name. Local interoperability is not Connectors client admission or provider endorsement.
- Neutral: Canva's existing per-account route and its proposed ADR 0002 remain unchanged while a separate native OAuth qualification is planned.

## Options and Tradeoffs

### Wait for a separate client and Provider

- Good: preserves the earlier custody boundary and independent client identity.
- Bad: blocks the working local Figma connection.

### Declared Figma OAuth mode

- Good: limits the changed route policy to one named registry declaration.
- Bad: relies on MCPorter's cache and Figma accepting the borrowed name.

### Universal OAuth

- Good: less route branching.
- Bad: changes every Provider's login and credential behavior without qualification.

## Confirmation

The public launcher tests must show Figma attended auth, cached-token reads, refusal of auth for other skills, exact endpoint and tools, and scrubbed child environment. A separate attended live canary may show login and schema for the exact candidate; it cannot establish provider approval. Revisit this decision when Figma offers a distinct admitted client identity or when Canva's own native OAuth qualification and migration decision are complete.

## References

- [Figma remote MCP installation](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)
- [MCPorter CLI reference](https://github.com/openclaw/mcporter/blob/main/docs/cli-reference.md)
- [MCPorter configuration](https://github.com/openclaw/mcporter/blob/main/docs/config.md)
- [Canva OAuth proposal](0002-own-canva-per-user-oauth-below-mcporter.md)
