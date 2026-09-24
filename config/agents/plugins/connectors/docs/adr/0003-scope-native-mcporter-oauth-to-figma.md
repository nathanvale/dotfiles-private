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

Declare `oauth: "mcporter"` only on Figma's route. The shared launcher permits attended `auth` only for that declaration and keeps `--no-oauth` on ordinary `list` and `call`, which use cached credentials. MCPorter owns the Figma OAuth cache. Existing Provider routes retain their current credential custody and behavior. The registry fixes Figma's endpoint, admits `whoami` alone for this connection slice, and uses the locally working `clientName: "Claude Code"`. Later frame reads require their own ticket gates.

An explicit `auth --reset` forwards to MCPorter's per-server reset for this declared OAuth route. It clears the local `figma-connectors` grant before attended reauthorization; it does not claim remote revocation.

## Consequences

- Positive: the plugin follows the locally proven MCPorter login and discovery path without another OAuth implementation.
- Positive: ordinary reads cannot open an OAuth browser flow implicitly.
- Negative: MCPorter now holds Figma tokens above the former credential line, with its own cache and refresh semantics.
- Negative: `Claude Code` is a borrowed client name. Local interoperability is not Connectors client admission or provider endorsement.
- Negative: attended MCPorter auth can print an authorization URL or loopback redirect. Agent-captured terminal output may retain those values, including a callback code. Keep the human terminal flow for remote access and do not promote its output into chat or durable logs.
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

The public launcher tests must show Figma attended auth, cached-token reads, refusal of auth for other skills, exact endpoint and tools, and scrubbed child environment. Attended login and cached schema discovery through the exact candidate are separate live canaries; neither establishes provider approval or the intended principal. Revisit this decision when Figma offers a distinct admitted client identity or when Canva's own native OAuth qualification and migration decision are complete.

## Evidence and remaining qualification

- Documented by Figma: the hosted endpoint uses OAuth, and Figma limits remote MCP access to clients in its MCP Catalog. A new client must seek registration through Figma. The catalog lists Claude Code and Codex, but does not list this Connectors Plugin as an admitted client.
- Documented by Figma: `whoami`, `get_design_context`, `get_screenshot`, `get_variable_defs`, and `get_metadata` are read tools. An isolated cached-token schema listing confirmed their names and input keys, but this candidate admits only `whoami`. Figma's public MCP setup and tool pages do not specify the Connectors client's registration or redirect rules, scopes, token-endpoint authentication, access-token lifetime, refresh replacement, or revocation contract.
- Documented by MCPorter: `auth` performs attended OAuth; `--no-oauth` uses cached tokens without interactive consent. An explicit `--config` selects only that registry, and MCPorter owns the private credential vault for native OAuth.
- Locally observed on 24 September 2026: MCPorter 0.14.0 received HTTP 403 during dynamic registration with its default client identity. A separate isolated registry with `clientName: "Claude Code"` completed attended OAuth and listed 40 tools. A fresh `list figma --json --no-oauth` from that isolated cache exited 0. These observations prove local interoperability for the borrowed name, not admission of the actual Connectors client.
- Locally observed on 24 September 2026 through the earlier `figma` server entry: attended `provider-route figma -- auth --no-browser --json` exited 0 after the browser flow completed, then a cached schema listing exposed only `whoami`. MCPorter 0.14.0 printed authorization and redirect URLs in this mode. Their values are not recorded here.
- Locally observed on 24 September 2026 through the isolated `figma-connectors` entry at `2dacadc83e646ac1d404f6266138bd7dffe07b0d`: a cached listing first returned HTTP 401. Fresh attended `auth` then exited 0, and a later cached `list --schema --json --timeout 15000` exited 0 with only `whoami` exposed. No Figma tool or private design content was read.
- Unproved: the authenticated principal, a private Figma design read, provider approval of the borrowed name, and Figma-specific registration, redirect, scope, refresh, or revocation behavior. Leave [issue #68](https://github.com/nathanvale/dotfiles-private/issues/68) open against its current acceptance criteria. The foreground coordinator can amend [Spec #67](https://github.com/nathanvale/dotfiles-private/issues/67) and that ticket to the explicitly chosen local connection; a separately supported Connectors identity is outside this local result.

## References

- [Figma remote MCP installation](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)
- [Figma MCP client catalog](https://www.figma.com/mcp-catalog/)
- [Figma MCP tools](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)
- [MCPorter CLI reference](https://github.com/openclaw/mcporter/blob/main/docs/cli-reference.md)
- [MCPorter configuration](https://github.com/openclaw/mcporter/blob/main/docs/config.md)
- [Canva OAuth proposal](0002-own-canva-per-user-oauth-below-mcporter.md)
