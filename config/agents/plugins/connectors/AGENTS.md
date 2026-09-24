# Connectors Plugin

Read [CONTEXT.md](CONTEXT.md) for the plugin's vocabulary before naming anything.
Read [CODING_STANDARDS.md](CODING_STANDARDS.md) before Connectors code or test work.

## Invariants

- The worktree candidate under `config/agents/plugins/connectors` is the source. An installed plugin cache is a copy: never edit it, and never treat its presence as activation proof.
- Shared route selection into MCPorter lives only in `bin/provider-route.ts`. It names no service; it selects one Connector Skill's registry and replaces itself with MCPorter. Everything below MCPorter is Provider code, shared only through the `bin/` helpers listed below.
- Every skill registry sets `imports: []` and gives every server an explicit exact-name `allowedTools` array. The route refuses a registry that omits either, before any process starts. Broad dispatcher tools (`discover`, `executeRead`, `executeWrite`, `executeDestructive`) never enter an allow-list.
- Credential custody stays below MCPorter for static-credential Providers (Atlassian).
- Figma's OAuth grant lives in MCPorter's default native vault through the shared route; read [`docs/adr/0003-scope-native-mcporter-oauth-to-figma.md`](docs/adr/0003-scope-native-mcporter-oauth-to-figma.md) before changing it.
- Canva's OAuth grant lives in MCPorter's native vault under one private root per Canva Account, reached only through the Canva launcher; read [`docs/adr/0004-move-canva-custody-into-mcporter-native-vault.md`](docs/adr/0004-move-canva-custody-into-mcporter-native-vault.md) before changing it. ADR 0004 stays proposed, and ADR 0002 unchanged, until Nathan accepts it.
- Only non-secret Route Selection values cross the route; secret values never enter plugin config, arguments, envelopes, tests, or docs. No document claims a vault is encrypted.
- Shared Provider plumbing lives in `bin/`: `provider-process.ts` (refusal prefix, PATH lookup, scrub, exec), `private-state.ts` (owned 0700 directories, exact-0600 files), `hyper-mcp-remote.ts` (the pinned bridge). A skill's custody module is imported only through its `index.ts`.
- Each service family co-locates its `SKILL.md`, `config/mcporter.json`, `config/route.json`, owned tests, and any launcher or Provider code under `skills/<name>/`.
- Report configured, fixture-tested, schema-qualified, authenticated, live-read-proven, and live-write-proven as distinct states. Claim only the state current evidence proves.

## Adding a connector

1. Choose the shape. A keyless hosted MCP endpoint (Context7, Firecrawl) needs a registry, a route declaration, a `SKILL.md`, and one owned test through `tests/harness.ts`. Figma's hosted native OAuth shape adds an attended `auth` route; read ADR 0003 before copying it. A credentialed service (Atlassian) adds one Provider script below MCPorter and a semantic dispatcher that owns Route Selection, the trusted-origin binding, and any write policy. A per-user OAuth service (Canva) declares a dispatcher-owned MCPorter OAuth route, a client-mode switch, and a launcher that places each account's MCPorter vault under a private root; read ADR 0004 before changing it.
2. Copy the closest existing skill as the template: `skills/context7/` for the keyless shape, `skills/atlassian/` for the credentialed shape, `skills/canva/` for the OAuth shape. Rename, then remove everything the new service does not need.
3. Declare the registry: `imports: []`, one server per product, exact `allowedTools` confirmed against live schema discovery, `${SELECTOR}` placeholders only for non-secret Route Selection values declared in `route.json`.
4. Write the skill for the agent: the dispatcher or route command it must use, the inputs it must supply, the refusals it will meet, and the live states it cannot assume. Invoke `writing-for-agents` first.
5. Add the owned test file beside the skill: route composition, custody through `assertCustody` for ordinary calls, a separate attended-auth process assertion for native OAuth, refusals with literal causes, and no secret in any stream.
6. Any write capability follows the Atlassian pattern: preview and apply through a durable journal, exact provider write tools, and an operator adjudication path. Read [`docs/adr/0001-route-atlassian-through-mcporter.md`](docs/adr/0001-route-atlassian-through-mcporter.md) before designing it.
7. For plugin development, installation, refresh, or activation lifecycle, follow the repository's [`docs/agents/skills.md`](../../../../docs/agents/skills.md). Discovery canaries there are the only activation proof.

## Verification

- Plugin gates: `bun run test` and `bun run typecheck` in this directory.
- Repository gates from the worktree root: `bun run biome:check`, `bun run typecheck`, and `bun run --silent quality:fallow --changed-since <task-start-commit>` (see `docs/agents/fallow.md`).
- Completion reports name each gate's result, then separately list the live proof that was unavailable: authentication, live schema, live reads, and any write.
