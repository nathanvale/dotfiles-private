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

Set `SKILL_DIR` to this `SKILL.md`'s directory, then derive the plugin root
once:

```bash
SKILL_DIR=/absolute/path/to/skills/cli-design
PLUGIN_ROOT=$(cd -- "$SKILL_DIR/../.." && pwd -P)
```

`--source-packet PATH_OR_URL` names the project's vault packet as an absolute
path or HTTP(S) URL. HTTP(S) URLs must contain no username, password, or query.
The bootstrap also refuses newline, carriage-return, and backtick characters.
Both record accepted values verbatim in the generated `README.md` or
`.cli-design-template.json`; neither reads the packet. Packet placement: dotfiles
`docs/agents/work-placement.md`.

### New repository

Run the canonical `bun-typescript-template` public bootstrap from that
repository's root:

```bash
bun run bootstrap --profile durable --starter simple --destination PATH --source-packet PATH_OR_URL
bun run bootstrap --profile durable --starter complex --destination PATH --source-packet PATH_OR_URL
```

Use an empty destination. Add `--name NAME` to replace the name derived from
the destination and `--json` for the machine result. Generated projects own
their dependencies, lockfile, checks, tests, and CI.

### Existing Bun project

Run the plugin's preservation-safe composer from `PLUGIN_ROOT`:

```bash
bun run --cwd "$PLUGIN_ROOT" cli-design compose-existing --project-root PATH --package PATH --starter simple --source-packet PATH_OR_URL
bun run --cwd "$PLUGIN_ROOT" cli-design compose-existing --project-root PATH --package PATH --starter complex --source-packet PATH_OR_URL
```

Pass an absolute `--project-root` and select the package explicitly; add
`--json` for the machine result. Resolve ownership conflicts instead of
replacing current source, scripts, dependencies, tests, lockfile, or quality
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

Human output stays concise. Except for SIGINT and SIGTERM, machine mode emits
exactly one 2.0 envelope on stdout and nothing on stderr. Before output, SIGINT
and SIGTERM exit 130 and 143, respectively, after the bounded diagnostics flush
with no envelope and empty stdout and stderr. After output starts, a signal may
leave a partial stdout stream; once the stream is fully drained, the complete
stdout envelope may remain. Keep stderr empty and preserve the observed stream
without emitting a replacement envelope. Non-TTY stdin never prompts. Unknown
effects are transaction state, never an outcome, and never authorize automatic
replay.

Completion criterion: every public path returns through the typed result and
validated serializer.

## Qualify the static policy

### New repository

From the canonical `bun-typescript-template` root, admit the materialized CLI
and store receipts outside the generated project:

```bash
bun run admit:static /absolute/project/path simple /absolute/evidence/path
bun run admit:static /absolute/project/path complex /absolute/evidence/path
```

Choose the command matching the selected profile. The admission interface
checks the resolved pins, authored-file inventory, Biome, TypeScript, tests, and
both Fallow passes. `quality:fallow` must cover the whole project, including
tests, with complete required semantic evidence. The separate production
dependency pass must also succeed. A changed-files or `new-only` audit is useful
review evidence, but cannot qualify a new starter or hide an inherited finding.
Stop when a required semantic query is unavailable or incomplete; distinguish
that failure from a run that proves no semantic query was necessary.

Keep the focused Fallow policy enabled for unused files, exports and types;
unused, unlisted, unresolved and misclassified dependencies; circular imports
and re-export cycles; declared module-boundary violations with complete file
coverage; and unexplained or stale Fallow suppressions. Keep Biome responsible
for stray console output, explicit `any`, non-null assertions, and the scoped
restricted imports defined by the canonical profile.

Completion criterion: the profile's static-admission result is `admitted`, both
whole-project Fallow passes have complete evidence, and the generated
repository's own `bun run check` passes.

### Existing Bun project

Preserve the host's TypeScript, Biome, Fallow, package, lockfile, script, test,
and source owners. Review only an explicit scoped policy delta for the added CLI
paths. The composer adds no Fallow dependency: the host must already provide
`node_modules/.bin/fallow`. Confirm it exists before composing; when absent,
stop and add Fallow through the host's own dependency owner first. Then run the
accepted gradual-adoption review from the host root:

```bash
node_modules/.bin/fallow audit --format json --quiet --gate new-only --type-aware --type-aware-require complete
```

Keep the host's existing quality commands visible and run them. This review
must fail when required semantic evidence is missing, but it does not qualify
inherited findings away or claim that the whole existing project is clean.

Completion criterion: the preservation diff contains only the selected owner
paths and reviewed additive deltas, host checks pass, and the new-only review
passes with complete required evidence for the changed CLI paths.

## Change commands and stations

For a new or changed command:

1. Add its canonical identity, route, effect class, and help.
2. Add implementation and public process tests.
3. For a complex CLI, add every possible station with its outcome, cause,
   effect state, retry policy, and recovery guidance.
4. Exercise the target CLI's `--discover-command COMMAND_IDENTITY --json` and
   compare it with the same typed catalogue used by tests.
5. Reject a new observed station that is undeclared or a declared required
   station that is never reached.

New CLIs use strict catalogue enforcement. Existing CLIs may retain a reviewed
baseline of old gaps; every new or changed station needs matching code,
catalogue, and tests.

Completion criterion: code, help, discovery, catalogue, and process tests agree
for every changed route.

## Prove the result

Read public help first. Human help prints `[options]` only; JSON help lists
every option with its value name:

```bash
"${PLUGIN_ROOT}/bin/cli-design-check" --help --json
```

Run the strict checker with its required 2.0 rows:

```bash
"${PLUGIN_ROOT}/bin/cli-design-check" --cwd DIR --command "ARGV WORDS" --success-args "ARGS" --missing-args "ARGS" --internal-args "ARGS" --schema-args "ARGS" --transient-args "ARGS" --json
```

Add each optional row the CLI supports: `--effect-args "ARGS"` (authority
refusal), `--secret-args "ARGS"` with `--secret-marker STRING` (redaction;
supplied together), `--malformed-args "ARGS"` (malformed value), and
`--large-args "ARGS"` (large envelope). `--timeout-ms N` bounds every spawned
scenario and `--retain-streams-dir ABSOLUTE_DIR` retains raw streams; both are
options, not rows. The matrix covers help, `--discover`, refusal, success,
missing-input, and failure-class rows on the target; it has no
`--discover-command` row and rejects that flag on itself, so the project's own
catalogue and process tests prove command-scoped discovery (reference:
`packages/cli-design-exemplar/tests/catalog/command-discovery.test.ts`). Run
the generated or host repository's complete checks. For complex CLIs, run unit,
integration, catalogue, recovery, and lifecycle process tests.

Completion criterion: every applicable checker row and repository check passes;
the proof report names why each `skippedRows` entry is unavailable, because the
checker records skipped scenario names only.

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
