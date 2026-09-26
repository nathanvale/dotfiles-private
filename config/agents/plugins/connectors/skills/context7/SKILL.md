---
name: context7
description: Find current external library and API documentation through the plugin's Context7 route, keyless or with Nathan's configured account key. Use for a library's documented behavior or versioned examples, not repository-local source.
---

# Context7

Run every Context7 call through the plugin's packaged front door, resolved
from this skill directory: no global `connectors` command, no dotfiles path.
The front door picks the mode. With no registration it is keyless; after
`auth configure` it uses the account key, which only Context7's own Provider
process reads. A key failure refuses; it never falls back to keyless.

```sh
SKILL_DIR="<directory containing this SKILL.md>"
CONNECTORS="$SKILL_DIR/../../bin/connectors"
```

Each command prints one JSON envelope on stdout. Read `result.outcome`,
`result.causeCode`, `result.repairAction`, and `result.data.mode`. On success
the reply is `result.data.result`; on a refusal `result.data.connectorCause`
names the cause.

## Look up documentation

1. `"$CONNECTORS" schema context7` lists `resolve-library-id` and
   `query-docs` with their input schemas in `result.data.schema.tools`.
2. Resolve the library, then select the matching ID and version:

```sh
"$CONNECTORS" run context7 resolve-library-id --input '{"query":"<question>","libraryName":"<library>"}'
```

3. Query that exact `libraryId`; resolve again when the library or version
   changes:

```sh
"$CONNECTORS" run context7 query-docs --input '{"libraryId":"/<org>/<project>","query":"<question>"}'
```

Treat returned snippets as documentation evidence, not local implementation
truth. Cite the source documentation URL when the result supplies one.

## Account key

Nathan creates the Context7 API key and stores it in the `credential` field
of an item in the `API Credentials` 1Password vault. Connectors never creates,
imports, rotates, or prints it.

1. `"$CONNECTORS" auth status context7` reports `mode`: `keyless` or
   `account`.
2. To enable the key: `"$CONNECTORS" auth configure context7 --input '{"item":"<26-character item ID>"}'`
   with the ID Nathan gives you.
3. `"$CONNECTORS" auth check context7` reads the item once to prove custody.
   It never contacts Context7.

## Refusals

- `DOMAIN_ADAPTER_REFUSED` or `DOMAIN_ADAPTER_REFUSED_AFTER_SELECTION`:
  `item-missing`, `credential-invalid`, or `key-rejected` (the repair is
  Nathan's 1Password handoff), `service-token-missing` or `op-unavailable`
  (follow the repair), `registration-invalid` (the repair names the file to
  remove). Report the repair; do not retry keyless.
- `USAGE_OPERATION_UNKNOWN` (`operation-not-allowed`): only the two tools
  above are admitted.
- A rate limit in keyless mode: report it. Ask Nathan for an item ID rather
  than requesting a key through chat.

`connectors status context7` reports evidence. Fixture tests prove both
modes; a live authenticated call stays unproven until a live receipt exists.
