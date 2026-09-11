---
name: cli-design
description: Build or design a Bun and TypeScript CLI that humans and agents can drive: a small read-only tool, a multi-command application with mutation and recovery, or an upgrade of an existing CLI to the shared machine contract. Use when asked to create, scaffold, or make a CLI agent-native, when choosing between a single-file and a multi-module layout, or when proving a built CLI against the contract checker.
---

# CLI Design

This skill builds a human-first, agent-native CLI around one shared semantic contract.
It provides simple and complex structural profiles, with Branch Station and LogTape depth added only when behaviour earns it.

## Capture the brief

Record the CLI name, one-sentence purpose, users (humans, scripts, agents), each command and its inputs, an effect stance per command using exactly `inspect`, `repository-local`, or `external`, and the smoke command used to exercise it.

Completion criterion: every command has an effect stance written down.

## Choose the profile

| signal | profile |
| --- | --- |
| Read-only, or exactly one deterministic local effect with one recovery branch and no multi-step ordering. | simple |
| Any command mutates or causes external effects, crosses identity, authentication, approval, or handoff, can end partially completed or unknown, or has more than one recovery branch. | complex |

The Branch Station catalog is required whenever the complex profile applies.
LogTape (`@logtape/logtape` version `2.3.1`) is required only when multi-step or asynchronous work needs ordering, partial or unknown outcomes need history, secret-bearing fields need structured redaction, or cross-step correlation is material.

Completion criterion: the profile and each triggered depth are written in the brief together with the sentence that triggered them.

## Apply the contract core

Read [Contract Core](references/contract-core.md) for the shared envelope, human mode, discovery, effects, recovery, redaction, and cause rules.
Every outcome carries identity, cause, effect class, transaction state, retry safety, and exactly one of a safe next action or a handoff, plus repair guidance; the primary result goes to stdout, diagnostics go to stderr, no prompt fires when stdin is not a TTY, secrets are redacted, and exit meanings are closed.

Completion criterion: the envelope builder and exit mapping exist in one module and every command path returns through them.

## Build in the profile layout

Read [Simple profile](references/simple-profile.md) for the single-entry layout and [Complex profile](references/complex-profile.md) for threshold-driven modules, recovery, and diagnostics. Add `src/commands/<name>.ts` only when a command body needs an independent seam; add `src/front-doors/<name>/cli.ts` only for multiple distinct CLI domains; folder depth follows behavioural ownership, never command count.

Completion criterion: the layout matches the profile table and every file has one named owner responsibility.

## Prove it

Run the checker with this command shape: `"${PLUGIN_ROOT}/bin/cli-design-check" --cwd <repo> --command "bun run src/cli.ts" --success-args "<args>" --missing-args "<args>" [--effect-args "<args>"] [--secret-args "<args>" --secret-marker <marker>]`. `PLUGIN_ROOT` is `../..` from this SKILL.md's directory.
The checker matrix assumes the stateless shape: no arguments exits 2 with one stderr line, and every `--json` invocation, usage errors included, prints one envelope and nothing on stderr.
Run the repository's own tests; for the complex profile, also run the three test layers named in the complex reference.

Completion criterion: every checker row passes or its failure is reported with its finding code; a green exit alone is not proof.

## Versioning

Discovery output pins `contractVersion` and `generationConventionVersion` (both `"1.0.0"`). Routes, fields, flags, defaults, exit meanings, effects, retry guidance, actions, recovery paths, and handoffs are compatibility-sensitive. An upgrade of an existing CLI is a separately authorized unit that records current and target versions, affected commands, allowed output differences, proof, and rollback.

## Owners

- The sibling references are `references/contract-core.md`, `references/simple-profile.md`, and `references/complex-profile.md`.
- The checker is `bin/cli-design-check`; its runnable conformant example is `packages/cli-design-check/fixtures/conformant/src/cli.ts`.
- The exact wire spelling in `references/contract-core.md` is provisional and skill-owned; an accepted change to it creates a new contract version.
