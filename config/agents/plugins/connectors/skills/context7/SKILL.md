---
name: context7
description: Find current external library and API documentation through the plugin's MCPorter-backed Context7 route. Use for a library's documented behavior or versioned examples, not repository-local source.
---

# Context7

Use the shared Bun launcher at `../../bin/provider-route.ts`, resolved from this skill directory. Its skill-local registry selects the keyless hosted Context7 MCP server; do not add a separate Harness MCP registration.

The plugin also ships a compiled front door at `../../bin/connectors`, resolved from this same skill directory, no global command and no dotfiles path required. It answers only `--discover --json`, `--help`, and `--help --json` today; it does not yet carry this skill's operations, which still go through the launcher above.

1. Discover the live schema with `bun <plugin-root>/bin/provider-route.ts context7 -- list --schema --json`.
2. Call `resolve-library-id` with a specific question and library name. Select the matching library and version from its returned IDs.
3. Call `query-docs` with that exact `libraryId` and the question. Re-resolve when the library or version changes.

Use `--args` with a JSON object for each call:

```text
bun <plugin-root>/bin/provider-route.ts context7 -- call resolve-library-id --args '{"query":"<question>","libraryName":"<library>"}' --output json
bun <plugin-root>/bin/provider-route.ts context7 -- call query-docs --args '{"libraryId":"/<org>/<project>","query":"<question>"}' --output json
```

Treat returned snippets as documentation evidence, not local implementation truth. Cite the source documentation URL when the result supplies one. On a rate limit or auth requirement, report the limit; do not install a CLI, start OAuth, or request a key through chat.
