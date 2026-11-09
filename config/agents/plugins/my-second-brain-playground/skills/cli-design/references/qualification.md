# Qualify a CLI

Run this after implementing the selected route. Profile references own their
process-test matrices. [Contract Core](contract-core.md) owns observable results.
Use `PLUGIN_ROOT` resolved by the skill entrypoint.

## Admit the static policy

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

### Existing or maintained Bun project

Preserve the host's TypeScript, Biome, Fallow, package, lockfile, script, test,
and source owners. Review an explicit scoped policy delta for the added or
changed CLI paths. Run the accepted gradual-adoption review from the host root:

```bash
node_modules/.bin/fallow audit --format json --quiet --gate new-only --type-aware --type-aware-require complete
```

Keep the host's existing quality commands visible and run them. This review
must fail when required semantic evidence is missing, but it does not qualify
inherited findings away or claim that the whole existing project is clean.

Completion criterion: the preservation diff contains only the selected owner
paths and reviewed additive deltas, host checks pass, and the new-only review
passes with complete required evidence for the changed CLI paths. For maintenance,
run this branch without bootstrap or composition.

## Run the process checks

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
scenario. `--retain-streams-dir ABSOLUTE_DIR` retains raw streams in an existing
private directory. Both are options, not rows. The matrix covers help, `--discover`, refusal, success,
missing-input, and failure-class rows on the target; it has no
`--discover-command` row and rejects that flag on itself, so the project's own
catalogue and process tests prove command-scoped discovery (reference:
`packages/cli-design-exemplar/tests/catalog/command-discovery.test.ts`). Run
the generated or host repository's complete checks. For complex CLIs, run unit,
integration, catalogue, recovery, and lifecycle process tests.

Completion criterion: every required and applicable optional checker row passes,
as do the repository checks and profile process tests. Explain each `skippedRows`
entry, because the checker records only scenario names. Supply fixtures or fault
injection for required failure-class rows; a generated starter does not by
itself prove every row reachable. Run the complete generated CI sequence from a
clean checkout. Keep retained streams outside the repository.
