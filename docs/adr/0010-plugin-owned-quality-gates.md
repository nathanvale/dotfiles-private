---
status: proposed
---

# Plugin-owned quality gates

## Context and Problem

The Biome quality gate lived as two `settings.json` hook declarations
(`config/agents/claude/hooks/biome/biome-ci.ts` on `Stop`,
`biome-check.ts` on `PostToolUse`). It was Claude-only: `config/agents/codex/hooks.json`
has no Biome hook at all. It was also unversioned and edited in place: a change took effect
immediately with no release boundary and no way to roll back to a prior
behaviour short of `git revert`. ADR 0009 named a Gate follow-up: ship Biome,
Fallow, and TypeScript as self-gating hooks in a personal plugin, with event
placement informed by `docs/research/2026-09-12-agent-hook-timing.md`.

What delivery mechanism gives both harnesses a versioned, self-disabling
quality gate without adding a build step or a runtime dependency?

The ADR 0008 decision "Biome Stop hook: a delta gate, changed files only, repo-local binary only" is superseded by this plugin.

## Decision Drivers

- Work in both Claude Code and Codex, not just Claude Code.
- Self-gate per repository: never block a repository that lacks the tool
  the hook checks.
- Deliver through a versioned release, not an in-place edit with no
  boundary.
- Stay dependency-free: the hook sources run with `bun run` from the
  installed plugin cache, which has no `node_modules`.

## Considered Options

- Option A: extend `config/agents/claude/settings.json` and
  `config/agents/codex/hooks.json` in place with the two new tools.
- Option B: ship a personal `proof` plugin with `hooks/claude/hooks.json` and
  `hooks/codex/hooks.json`. Chosen option.
- Option C: a per-repository `.claude/hooks/` and `.codex/hooks.json` pair,
  installed into each repository that wants the gate.
- Option D: compiled executables per the `my-second-brain-plugin` PR #64
  pattern (rejected for now: a 61 MiB committed binary for what are
  dependency-free scripts; revisit when a hook needs a real dependency).

## Decision

We will choose Option B because it is the only option that gives both
harnesses a versioned release boundary (a plugin install or marketplace
update) while keeping the hook sources dependency-free and self-gating per
repository, matching every named driver.

## Consequences

- Positive: `claude plugin marketplace update personal` and a Codex
  remove-then-add refresh the gate from a single reviewed source, instead of
  an in-place edit that takes effect immediately with no rollback boundary.
- Positive: the gate now runs on Codex, not just Claude Code.
- Positive: the plugin is dependency-free, so no build step exists yet; a
  future hook that needs a real dependency will need one.
- Negative: Codex hashes each hook command and stores a `trusted_hash`; every
  source edit is a re-approval step on Codex, or the hook silently stops
  running there while continuing to run on Claude Code.
- Negative: `typecheck-ci` checks only the root `tsconfig.json` project, and
  an error in a file the current change did not touch is reported only as
  `suppressedCount`, never surfaced as a blocking finding. `bun run check`
  remains the complete gate; this hook is a fast, partial signal at `Stop`.
- Neutral: this change removes the old `config/agents/claude/hooks/biome/*`
  scripts and their `settings.json` registrations after the plugin live proof.
- Deferred: relocating `tooling/repository-quality`'s test-runner ownership
  is out of scope for this change.

## Options and Tradeoffs

### Option A: extend `settings.json` in place

- Both harnesses: fails for Claude alone without also touching
  `config/agents/codex/hooks.json`, and either way stays two separately
  maintained files with no shared release boundary.
- Self-gating: meets the driver; the guard logic is orthogonal to delivery.
- Versioned release: fails; an edit takes effect immediately with no
  install or update step and no rollback boundary.
- Dependency-free: meets the driver; nothing about in-place editing requires
  a dependency.

### Option B: a personal `proof` plugin

- Both harnesses: meets the driver with `hooks/claude/hooks.json` and
  `hooks/codex/hooks.json` sharing one source tree.
- Self-gating: meets the driver; each hook still resolves the repo-local
  tool and marker file before running.
- Versioned release: meets the driver; a plugin version bump is the release
  boundary, refreshed with `claude plugin marketplace update personal` or a
  Codex remove-then-add.
- Dependency-free: meets the driver; the plugin's `package.json` carries no
  `dependencies`, verified by a test.

### Option C: per-repository `.claude/hooks/` and `.codex/hooks.json`

- Both harnesses: meets the driver in each repository it is installed into,
  but the source has to be copied or vendored into every repository
  separately.
- Self-gating: meets the driver.
- Versioned release: fails; there is no single source of truth, so a fix
  has to be re-applied per repository with no shared version.
- Dependency-free: meets the driver.

### Option D: compiled executables (PR #64 pattern)

- Both harnesses: meets the driver.
- Self-gating: meets the driver.
- Versioned release: meets the driver.
- Dependency-free: fails the spirit of the driver even though the binary
  itself needs no `node_modules`; a 61 MiB committed artefact for scripts
  that only need `node:*` modules and Bun globals is disproportionate. Keep
  this option in reserve for the day a hook needs a real dependency.

## Confirmation

Run, from the plugin root (`config/agents/plugins/proof`):

```sh
bun run lint && bun run test && bun run typecheck
```

And from the repository root:

```sh
bun install --frozen-lockfile
bun run check
```

Confirm `claude plugin validate --strict config/agents/plugins/proof` passes,
and that a scratch-repo live proof (see the lane spec's verification section)
shows `fallow-ci` and `typecheck-ci` blocking a `Stop` with the expected
envelope, `biome-ci` informing on `PostToolUse`, and every hook exiting 0
quickly in a repository that carries none of the three tools.

- Live proof on 2026-09-12: harness (Claude Code, Sonnet 5 via Foundry) and
  harness (Codex, gpt-6-astra) both ran the plugin. Adding an unused export
  blocked `Stop` with the plugin's `fallow-ci` envelope. The plugin's
  `biome-ci` fired alongside the old repository Biome hook before this change.
  Codex recorded five trusted hook entries, `proof@personal:hooks.json:*`, in
  `~/.codex/config.toml`. This PR removes the old repository Biome hooks.

Revisit trigger: revisit plugin gate ownership if a future live proof shows
that a quality gate no longer runs reliably in either harness.

## References

- [ADR 0009 Fallow zero baseline](0009-fallow-zero-baseline.md): named this
  plugin as its Gate follow-up.
- [`docs/research/2026-09-12-agent-hook-timing.md`](../research/2026-09-12-agent-hook-timing.md):
  event placement and blocking-behaviour research this decision follows.
- [`docs/agents/hooks.md`](../agents/hooks.md): the Codex `trusted_hash`
  asymmetry and general hook-authoring guidance.
