---
name: test-runner
description: "Prove or benchmark the skill-local Agent Runner."
role: quality-gate
---

# Test Runner

Agent Runner for Bun test context.

## Status

- Use for Bun pass/fail, coverage, failure repair, triage, benchmark evidence, and output-contract development.
- Use compact mode for routine Bun test gates.
- Use repair mode for hot-context failures in files already being edited.
- Use triage mode for cold-context failures from broader suites or unopened files.
- Use detail lookup when a repair or triage packet lacks enough context.
- Keep lint, format, and type gates on MCP runners.
- Treat Agent Runner as the default Bun test path.

## Owner

- Skill prose: `config/agents/skills/personal/test-runner/SKILL.md`.
- Command contract and discovery: `config/agents/skills/personal/test-runner/src/command-contract.ts`.
- CLI, parser, result model, and runtime behavior: `config/agents/skills/personal/test-runner/src/test-runner.ts`.
- Detail artifact read/write behavior: `config/agents/skills/personal/test-runner/src/test-runner.ts`.
- Repo-local front doors: `config/agents/skills/personal/test-runner/package.json#scripts`.
- Missing-runtime shell preflight: `config/agents/skills/personal/test-runner/src/test-runner.sh`.
- Tests: `config/agents/skills/personal/test-runner/src/test-runner.test.ts`.
- Runner Benchmark Harness: `config/agents/skills/personal/test-runner/src/test-runner.benchmark.ts`.
- Evidence output: `config/agents/skills/personal/test-runner/var/benchmark-output/`.

## Commands

- Inspect exact runner usage: `cd config/agents/skills/personal/test-runner`, then `bun run test-runner --help`.
- Inspect benchmark usage: `cd config/agents/skills/personal/test-runner`, then `bun run test-runner-benchmark --help`.
- Prove no-MCP Bun adoption: `cd config/agents/skills/personal/test-runner`, then `bun run test-runner-benchmark --no-mcp-baseline --local-runner ./src/test-runner.sh --mode fixed-gate --gate-preset bun-no-mcp`.
- For runner routing, read `config/agents/claude/context/bun-runner.md`.

## Verification

- Run `bun --filter test-runner-scripts test` after runner, command-contract, detail-artifact, or benchmark changes.
- Run `bun --filter test-runner-scripts typecheck` after TypeScript edits.
- Run the fixed-gate benchmark before changing normal runner guidance.

## Safety

- Pass test-target args only after the runner separator.
- Keep generated evidence under the skill-local output path unless deliberately promoted.
- Keep generated detail under `config/agents/skills/personal/test-runner/var/runner-output/` unless deliberately promoted.
- Do not copy flags, output schemas, parser states, or exit tables into this file.
- Use script help and tests for deterministic behavior.

## Next Safe Action

- Run compact mode for a routine Bun test gate; pass coverage args after `--`.
