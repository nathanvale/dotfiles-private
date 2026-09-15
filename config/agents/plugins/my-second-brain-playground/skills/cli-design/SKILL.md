---
name: cli-design
description: Build, maintain, or extend a Bun and TypeScript CLI for humans and agents. Use for a new read-only CLI, a state-changing CLI, adding a CLI to an existing Bun project, choosing simple versus complex structure, adding commands or Branch Stations, changing behavior, fixing a CLI bug, or proving Contract Core 2.0 behavior with the checker.
---

# CLI Design

Build one human-first and agent-native CLI around Contract Core 2.0. Use the
canonical Bun template for starters and keep each generated project independent
of the template and plugin at runtime.

## Capture the job

Record:

- CLI name and one-sentence purpose.
- Human, script, and agent users.
- Each command, input, and public result.
- Effect class per command: `inspect`, `repository-local`, or `external`.
- Existing-project or new-repository route.
- Smoke command.

Completion criterion: every command has an effect class and observable result.

## Choose the route

### New repository

Run the canonical `bun-typescript-template` public bootstrap from that
repository's root:

```bash
bun run bootstrap --profile durable --starter simple --destination PATH --source-packet PATH_OR_URL [--name NAME] [--json]
bun run bootstrap --profile durable --starter complex --destination PATH --source-packet PATH_OR_URL [--name NAME] [--json]
```

Use an empty destination. Generated projects own their dependencies, lockfile,
checks, tests, and CI.

### Existing Bun project

From `PLUGIN_ROOT` (`../..` from this `SKILL.md`), run the plugin's
preservation-safe composer:

```bash
bun run cli-design compose-existing --project-root PATH --package PATH --starter simple|complex --source-packet PATH_OR_URL [--json]
```

Select the package explicitly. Resolve ownership conflicts instead of replacing
current source, scripts, dependencies, tests, lockfile, or quality
configuration.

### Maintain or extend

Inspect the existing command contract, profile, typed catalogue, process tests,
and public help before editing. Keep the current profile unless a new command
crosses a complex trigger. Change code, catalogue declarations, help, and tests
as one unit when behavior changes.

Completion criterion: one route is selected and its public help confirms the
exact invocation.

## Choose the profile

| Signal | Profile |
| --- | --- |
| Every command is read-only and no complex trigger applies. | simple |
| Any command changes user data or configuration, including one deterministic local file. | complex |
| Identity, authentication, approval, handoff, partial or unknown effects, recovery, or multiple ordered effects. | complex |

Read [Simple profile](references/simple-profile.md) or
[Complex profile](references/complex-profile.md). Keep structure proportionate;
complex does not imply a monorepo. Add LogTape only for the diagnostics triggers
in the complex reference.

Completion criterion: the brief names the profile and the trigger that selected
it.

## Apply Contract Core 2.0

Read [Contract Core](references/contract-core.md). Keep one typed owner for
command identities, routes, causes, exit meanings, result correlations, and
serialization. Validate external input as unknown and validate the final
machine envelope before writing it.

Human output stays concise. Machine mode emits exactly one 2.0 envelope on
stdout and nothing on stderr. Non-TTY stdin never prompts. Unknown effects are
transaction state, never an outcome, and never authorize automatic replay.

Completion criterion: every public path returns through the typed result and
validated serializer.

## Change commands and stations

For a new or changed command:

1. Add its canonical identity, route, effect class, and help.
2. Add implementation and public process tests.
3. For a complex CLI, add every possible station with its outcome, cause,
   effect state, retry policy, and recovery guidance.
4. Exercise `--discover-command COMMAND_IDENTITY --json` and compare it with the
   same typed catalogue used by tests.
5. Reject a new observed station that is undeclared or a declared required
   station that is never reached.

New CLIs use strict catalogue enforcement. Existing CLIs may retain a reviewed
baseline of old gaps; every new or changed station needs matching code,
catalogue, and tests.

Completion criterion: code, help, discovery, catalogue, and process tests agree
for every changed route.

## Prove the result

Read public help first:

```bash
"${PLUGIN_ROOT}/bin/cli-design-check" --help
```

Run the strict checker using its required 2.0 scenario shape:

```bash
"${PLUGIN_ROOT}/bin/cli-design-check" --cwd DIR --command "ARGV WORDS" --success-args "ARGS" --missing-args "ARGS" --internal-args "ARGS" --schema-args "ARGS" --transient-args "ARGS" [options]
```

Supply optional authority, redaction, malformed-value, large-envelope, timeout,
and retained-stream rows when the CLI supports them. Run the generated or host
repository's complete checks. For complex CLIs, run unit, integration, catalogue,
recovery, and lifecycle process tests.

Completion criterion: every applicable checker row and repository check passes;
each skipped row names why the behavior is unavailable.

## Version and owners

Contract and generation convention are `2.0.0`. The product supports the 2.0
format only. A 1.0 specimen is historical or an unsupported-format refusal, not
a compatibility obligation.

- Canonical starter source: `bun-typescript-template`.
- Existing-project composition: `bin/cli-design`.
- Contract checker: `bin/cli-design-check`.
- Local complex reference implementation: `packages/cli-design-exemplar`.
- Skill references: `references/contract-core.md`,
  `references/simple-profile.md`, and `references/complex-profile.md`.
