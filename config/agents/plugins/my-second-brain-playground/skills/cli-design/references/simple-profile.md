# Simple profile

Use the [skill's profile decision](../SKILL.md#2-select-the-profile-before-writing).
The canonical starter lives in `bun-typescript-template/starters/simple`.
Consume it through the public bootstrap or preservation-safe composer.

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
src/commands.ts
src/commands-contract.ts
src/domains/
eslint.config.mjs
eslint-rules.mjs
tests/cli.test.ts
```

Keep one public entry point. Separate domain files are permitted in the simple
profile; splitting a file does not make the CLI complex. Keep the behavioral
entry point cohesive while it remains small. Split a module
only when one concern gains an independent contract or test seam. The simple
starter has no runtime dependency and no LogTape.

## Apply the read-only boundary

Keep every command at `effectClass: inspect` and `transactionState: unchanged`.
Use [Contract Core](contract-core.md) for help, discovery, machine output, input,
and lifecycle behavior. Change the profile before adding a complex trigger.
Use the skill's command checklist when extending the CLI.

## Tests

Use `Bun.spawn` or `Bun.spawnSync` against the public entry point. Assert literal
exit, stdout, stderr, command identity, outcome, cause, effect class, transaction
state, effect inventory, retry policy, and guidance. Exercise:

- human help;
- machine success;
- machine internal failure;
- full discovery;
- selected-command discovery;
- missing or unknown command refusal;
- closed and held-open non-TTY stdin; and
- every applicable strict checker row.

Run [Qualification](qualification.md) for static admission, the strict checker,
and the clean-checkout CI sequence. Keep the generated project independent of
template and plugin runtime dependencies.
