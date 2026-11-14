---
name: cli-design
description: Build, maintain, debug, or verify a Bun and TypeScript CLI for humans and agents. Use for new or existing CLIs, profile selection, commands and Branch Stations, behavior changes, and Contract Core 2.0 qualification.
---

# CLI design

Build a human-first, agent-native CLI around Contract Core 2.0. Use the canonical
Bun template for starters. Keep each generated project independent of the
template and plugin at runtime.

## 1. Define the job

In the owning task brief, record:

- The CLI name, purpose, users, and smoke command.
- Each command's input and observable result.
- Each command's effect class, `inspect`, `repository-local`, or `external`.
- The route, new repository, existing-project composition, or maintenance.

Use one first-party application CLI per repository, including workspace packages.
Put domain commands in separate internal files under that entry point. Extend
the existing CLI when one exists. If its registration cannot be integrated safely,
stop with the conflict and repair path; never generate a second application CLI.
Third-party tools and ordinary build/test scripts are separate tooling.

For an existing CLI, inspect its public help, command contract, profile, typed
catalogue, and process tests. Preserve its adopted contract owner, including
`@side-quest/cli-command-facade` where present.

Completion criterion: the brief names the purpose, users, route, smoke command,
and each in-scope command's inputs, effect class, and observable result.

## 2. Select the profile before writing

Use simple only when every command is read-only and no complex trigger applies.
Select complex for any of these triggers:

- Changes to user data or configuration, including one deterministic local file.
- Identity, authentication, approval, or handoff.
- Ordered effects, recovery, or partial or unknown state.
- Durable diagnostics or diagnostic history needed across steps.

Read [Simple profile](references/simple-profile.md) or
[Complex profile](references/complex-profile.md). Complex does not imply a
monorepo. Keep the current profile during maintenance unless a new behavior
crosses a complex trigger. Add LogTape only when its diagnostic triggers apply.

Completion criterion: the brief names the profile and its selecting trigger.

## 3. Prepare the selected route

Set `SKILL_DIR` to this `SKILL.md`'s directory. Derive the plugin root once:

```bash
SKILL_DIR=/absolute/path/to/skills/cli-design
PLUGIN_ROOT=$(cd -- "$SKILL_DIR/../.." && pwd -P)
```

Before either existing-project composition or maintenance, confirm the host
supplies `node_modules/.bin/fallow`. If absent, stop and add it through the
host's dependency owner before implementation. This prerequisite supports the
required existing-project qualification.

### New repository

Read the canonical `bun-typescript-template` README and public bootstrap help
before generation. From that repository's root, run the selected profile:

```bash
bun run bootstrap --profile durable --starter simple --destination PATH --source-packet PATH_OR_URL
bun run bootstrap --profile durable --starter complex --destination PATH --source-packet PATH_OR_URL
```

Use an empty destination. Add `--name NAME` to replace its derived name and
`--json` for the machine result. The generated project owns its dependencies,
lockfile, checks, tests, and CI.

### Existing Bun project

Read `bin/cli-design --help` from `PLUGIN_ROOT`, then run the selected profile:

```bash
bun run --cwd "$PLUGIN_ROOT" cli-design compose-existing --project-root PATH --package PATH --starter simple --source-packet PATH_OR_URL
bun run --cwd "$PLUGIN_ROOT" cli-design compose-existing --project-root PATH --package PATH --starter complex --source-packet PATH_OR_URL
```

Use an absolute `--project-root`. Set `--package` relative to that root, either
`.` or a declared workspace member. Add `--json` for the machine result. The composer inventories application CLIs across the repository. It creates one
when none exists and extends a supported existing CLI through its declared command
owner. Multiple CLIs, route collisions and unsupported registration refuse before
publication. Preserve the public invocation and existing commands. Resolve
ownership conflicts before changing source, scripts, dependencies, tests,
lockfiles, or quality configuration.

### Maintain or extend

Work through the existing owners. Preserve host tooling, source, and reviewed
baseline gaps. Change only the selected commands and their necessary contracts,
catalogue declarations, help, and process tests.

For generation and composition, `--source-packet PATH_OR_URL` records an absolute
vault-packet path or HTTP(S) URL verbatim in the generated README or
`.cli-design-template.json`. Neither command reads the packet. URLs admit no
username, password, or query. The bootstrap also rejects newline,
carriage-return, and backtick characters. Dotfiles `docs/agents/work-placement.md` owns packet placement.

Completion criterion: the selected route's public help confirms the invocation,
prerequisites pass, and the resulting diff preserves existing owners.

## 4. Select diagnostics when needed

For multi-step or asynchronous ordering, partial or unknown history, structured
secret redaction, or material cross-step correlation, read
[LogTape diagnostics](references/logtape.md) before choosing an adapter.

Prefer LogTape's bounded async admission, loss notifications, job drains, and
fingers-crossed job buffers where their guarantees fit. Keep application-owned
byte limits, file custody, retention, and shutdown deadlines. Keep the recovery
journal authoritative and separate from diagnostics.

The admitted template and composer retain their own dependency pins. A new or
scoped diagnostics integration applies the reference's pin through its package
owner and reruns the affected checks. This skill revision does not upgrade or
requalify the canonical starter.

Completion criterion: the brief names the selected APIs, limits, loss reporting,
cleanup boundary, and any application-owned guarantees they cannot supply.

## 5. Implement commands and their contract

Use the existing typed command declarations for domain routing, help and discovery.
Keep provider setup inside the selected command so unavailable integrations do not
block root help or unrelated domains. File count does not select the effect profile.

Read [Contract Core](references/contract-core.md). Keep one typed owner for
identities, routes, causes, exit meanings, result correlations, and serialization.
Validate external input as unknown. Validate the final machine envelope before
writing it. Keep human output concise and non-TTY stdin non-interactive.

For each new or changed command:

1. Update its canonical identity, route, effect class, and help.
2. Implement the behavior and public-process expectations together.
3. For complex, declare each Branch Station's outcome, cause, effect state,
   retry policy, reachability, and recovery guidance.
4. Exercise `--discover-command COMMAND_IDENTITY --json` against the same typed
   catalogue used by tests.
5. Reject observed undeclared stations and unreachable required stations.

New CLIs use strict catalogue enforcement. Existing CLIs may preserve a reviewed
baseline of old gaps. New or changed stations remain strict.

Completion criterion: implementation, help, discovery, catalogue, and process
expectations agree for each changed command. Every ordinary application-controlled
machine completion emits one validated 2.0 envelope and empty stderr. Preserve
and separately prove Contract Core's signal, crash, and transport exceptions.

## 6. Qualify and hand back

Read [Qualification](references/qualification.md) after implementation. Run the
selected route's static-policy admission, profile process tests, applicable
strict-checker rows, and repository checks. Keep independent literal oracles and
explain every skipped scenario. Checker success alone does not qualify
command-scoped discovery, recovery, or lifecycle behavior.

Report the candidate, route, profile, observed results, retained evidence, and
remaining gaps. Distinguish source checks, packaged execution, installation,
and activation. A passing source check proves no later state.

Completion criterion: every applicable check passes and each proof limit is
explicit. Stop on incomplete required evidence rather than treating it as clean.

## Owners

Contract and generation convention are `2.0.0`. The product supports only 2.0.
A 1.0 specimen is historical or an unsupported-format refusal.

- `bun-typescript-template` owns canonical starters and new-project admission.
- `bin/cli-design` owns preservation-safe composition.
- `bin/cli-design-check` owns the strict process-checker interface.
- `packages/cli-design-exemplar` owns the local complex reference implementation.
- [Contract Core](references/contract-core.md) owns portable result invariants.
