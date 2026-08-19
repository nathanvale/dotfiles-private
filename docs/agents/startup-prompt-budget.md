# Startup Prompt Budget

Context Load has a second contributor beside authored lines: the built-in tool
definitions the Harness ships every turn. Each has its own lever, so trimming
rules never shrinks the tool surface.

## Levers

- Remove a built-in with its `disable*` key in `settings.json`, or with a
  bare-name deny rule. Both drop the definition from context.
- A scoped deny such as `Bash(rm *)` keeps the definition and blocks matching
  calls. It buys safety, not tokens.
- `EndConversation` survives bare-name removal while any other tool remains.

## Before setting a key

- Verify the key against the installed binary's strings. Published docs drift
  in both directions: the build carries keys the docs omit, and the docs list
  keys the build lacks.
- Read the enclosing function before trusting a grepped string. A validator
  message names the setting it validates, which is often not the one you are
  looking for.
- `disabledMcpjsonServers` breaks the pattern: `disabled`, and an array.
- `disableModelInvocation` is skill frontmatter, not a setting. It is the most
  frequent `disable*` string in the binary, so a glob search surfaces it first.

## Owner

- Hook and status-line keys: `hooks.md`.
- Applied set, rejected keys, and the rationale for each: vault project
  `user-scope-config-consolidation`, Pass 4.
