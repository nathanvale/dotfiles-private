# Simple profile

Use simple only when every command is read-only and no complex trigger applies.
The canonical starter lives in `bun-typescript-template/starters/simple`; consume
it through the public bootstrap or preservation-safe composer.

## Layout

```text
.github/workflows/ci.yml
README.md
package.json
bun.lock
biome.json
.fallowrc.json
tsconfig.json
src/cli.ts
tests/cli.test.ts
```

Keep the behavioral entry point cohesive while it remains small. Split a module
only when one concern gains an independent contract or test seam. The simple
starter has no runtime dependency and no LogTape.

## Contract behavior

- Every product command has `effectClass: inspect` and
  `transactionState: unchanged`.
- Human help names supported commands and examples.
- `--discover --json` reports Contract Core 2.0 and the simple profile.
- `--discover-command COMMAND_IDENTITY --json` reports the selected read-only
  command's possible stations.
- Machine success and refusal use the strict 2.0 envelope.
- Non-TTY stdin never prompts.

A command that changes user data or configuration moves the CLI to complex.
Keep the repository layout proportionate after that move; complex does not imply
a workspace or monorepo.

## Maintenance and extension

For a read-only command, update its identity, route, help, implementation,
selected-command discovery, and process tests together. If the new behavior
introduces mutation, authority, recovery, partial state, or diagnostics history,
change the profile before implementing it.

## Tests

Use `Bun.spawn` or `Bun.spawnSync` against the public entry point. Assert literal
exit, stdout, stderr, command identity, outcome, cause, effect class, transaction
state, effect inventory, retry policy, and guidance. Exercise:

- human help;
- machine success;
- full discovery;
- selected-command discovery;
- missing or unknown command refusal;
- closed and held-open non-TTY stdin; and
- every applicable strict checker row.

Run the generated CI sequence from a clean fresh checkout. The generated project
passes with its own lockfile and has no template or plugin runtime dependency.
Qualify its static policy through the skill's `admit:static` route; a
changed-files Fallow audit does not replace the complete whole-project and
production-dependency passes.
