---
status: proposed
---

# Adopt the agent-plugin-kit toolchain: native Fallow, TypeScript 7, one per-package check contract

## Context and Problem

The workspace registered by [ADR-0002](0002-workspace-membership.md) had no
shared compiler or check contract: packages pinned different TypeScript
versions and declared `lint`, `test`, and `typecheck` inconsistently. A
7,200-line personal `fallow` skill wrapped the Fallow binary behind a façade
with its own runner, command contract, and result vocabulary, and drifted on
every release. Dead skills, runtimes, and hooks lingered. agent-plugin-kit
solved these problems for a sibling repository. What is adopted and retired?

## Decision Drivers

- One pinned toolchain whose parts are known to work together.
- One check contract per package so `bun run check` means the same everywhere.
- Changed-code quality by pinned binary: no façade, normaliser, baseline, MCP.
- Retirements leave nothing discoverable; git history is the recovery owner.

## Considered Options

- Option A: mirror the kit exactly, zones and repository contract test included.
- Option B: mirror pins and gate contract; defer zones; retire the façade.
- Option C: keep the façade skill and bump versions only.

## Decision

We will choose Option B because it satisfies every driver without importing a
zone graph this repository has not needed. Facts below were decided 2026-09-11.

- Pins: Bun 1.4.0 via `packageManager`, `bunfig.toml` `auto = "disable"`;
  TypeScript 7.0.2 stable (nightly and preview rejected); `@types/bun` 1.4.0
  via `catalog`; Biome exactly 2.4.15 (2.5 changed the schema); Fallow exactly
  3.19.0. TypeScript and Fallow move as a pair: Fallow's type-aware sidecar is
  `typescript-go` 7.0.2; drift is a hard `native-output-schema-mismatch`.
- Compiler contract: one root `tsconfig.base.json` carries the kit's compiler
  options verbatim; every TypeScript workspace package extends it. Root
  `tsconfig.json` covers `tooling/` and `config/agents/claude/hooks/`. Every
  member declares `lint` and `test`; TypeScript members also `typecheck`.
  Test-less `cli-author` and `cli-test-fixtures` use
  `bun test --pass-with-no-tests`; the JS-only VS Code extension has `lint`
  and `test` only. `strict` and `verbatimModuleSyntax` are never relaxed.
- Strictness debt, as `package: exactOptionalPropertyTypes errors /
  noUncheckedIndexedAccess errors`, each listed flag false in that package's
  own tsconfig: agent-native-state-machine-generator kept/17; agent-worktree
  57/11; cli-command-facade kept/7; session-corpus 11/kept; bitbucket 3/67;
  classic-cinema 1/33; cli-author kept/7; session-recovery 17/kept;
  test-runner 8/20; vault-git kept/4 (since retired); worktree 61/21;
  cli-test-fixtures and xero needed nothing. `cli-command-facade` typechecks
  `src` only; its `tests/` carry 28 errors for a follow-up.
- Root scripts: `biome:check`, `typecheck`, `test` (`bun run --filter '*'`,
  never bare root `bun test`: it discovers `.claude/worktrees/**` copies),
  `test:hooks`, `test:quality:repository`, `quality:fallow`, composite
  `check`; `validate` adds shell and workflow lint.
- Biome: the root config lints every `.agents/runtime/*` package (per-package
  opt-in gone); `noUndeclaredDependencies` is `error`, scoped off for
  `apps/vscode/**/*.js` (VS Code host module); vendored `last30days` excluded.
- Fallow: native binary replaces the façade. Root `.fallowrc.json`:
  `typeAware.require: "complete"`, `audit.gate: "new-only"`, the kit's 32
  rules all `error`, `ignorePatterns` for worktree copies and vendored trees;
  `boundaries` deliberately absent. No repo helper, normaliser, MCP, global
  install, baselines, or broad suppressions. Pointer skills come from
  `fallow agent install --harness claude --harness codex --without guide
  --without mcp --without hooks` at project scope only; no user-scope links.
- Gate: `quality:fallow` passes `--type-aware-require best-effort` as a script
  flag while the rc keeps `complete` for interactive use (the kit's rc/script
  split). Exit code follows `verdict` (introduced findings); `_meta.type_aware`
  incompleteness is advisory. Reason: Fallow 3.19.0 marks a whole project
  `unavailable` on any inherited `attached-comment` or `dynamic-behavior`
  abstention and builds an `<inferred>` project from unowned files with
  unprinted blocking diagnostics, so `complete` refuses clean deltas.
- Retirements: personal skills `fallow` (façade), `skill-feedback`,
  `cli-execution-auditor`, `vault-git`; runtimes `vault-git-transaction-manager`
  and `setup` (vault-git enrolment only); hooks `codex-notify-dispatcher.ts`
  (never registered), `skill-feedback-stop.ts`, `skill-feedback-runtime.ts`,
  `skill-feedback-codex-stop.ts`; vault-git janitor scripts and launchd
  template; user-scope links and dead Bun shims.
- Topology: `topology.json` moves `skill-feedback`, `cli-execution-auditor`,
  and `vault-git` to `retired`; `fallow` becomes `projectOnly` (source
  `.claude/skills/fallow`, Tracking Link `.agents/skills/fallow`).
- Biome Stop hook: a delta gate, changed files only, repo-local binary only.

## Consequences

- Positive: `bun run check` proves one contract in every package;
  `tooling/repository-quality/workspace-manifest.test.ts` refuses omissions.
- Positive: one pinned binary and one rc own Fallow; the façade, three dead
  skills, two runtimes, and four hooks leave every discovery surface.
- Negative: eleven packages carry relaxed strictness flags with named counts;
  abstention-hidden type-aware findings are advisory; no import policy until
  `boundaries` lands.
- Neutral: kit inline predicate not copied: it targets another incompleteness.

## Options and Tradeoffs

### Option A: mirror the kit exactly

- Good: zero divergence; zones give import policy today.
- Bad: a zone graph with no dispute to settle; the kit's contract test encodes
  export shapes this repo lacks.
- Bad: `typeAware.projects` listing the 20 tsconfigs was tried: removes
  `<inferred>`, 4 to 6 times slower, reintroduces `type-coupling` evidence
  truncation, still does not make `complete` attainable.

### Option B: pins and gate now, zones deferred, façade retired

- Good: every driver met; `complete` for humans, deterministic verdict for gate.
- Bad: import policy and complete type-aware evidence deferred with triggers.

### Option C: keep the façade, bump versions

- Good: smallest diff.
- Bad: façade re-drifts on the next release; dead runtimes, hooks, and
  user-scope links stay discoverable; no per-package contract.

## Confirmation

- `bun install --frozen-lockfile` converges first run; `bun run check` and
  `bun run test:quality:repository` pass (`workspace-manifest.test.ts`).
- `bin/agent-skills-inventory --json` shows three names under `retired`,
  `fallow` as `projectOnly`, and no user-scope Fallow links; `git check-ignore`
  proves worktree copies and vendored trees are ignored.
- Claude direct-discovery canaries pass against project-scope pointer skills.
  The Codex canary returned the exact retired marker, but its protected-harness
  fence moved because Codex refreshed its own `.system` skills and plugin cache
  during the run; the baseline is not rebaselined and the canary is re-run
  before acceptance.
- Revisit `boundaries` on the first import policy dispute; `best-effort` once
  every TS file has a tsconfig owner or Fallow accepts inherited abstentions.

## References

- [ADR-0002](0002-workspace-membership.md): workspace membership.
- [ADR-0003](0003-agent-skills-topology.md): skill ownership and retirement.
- agent-plugin-kit `docs/adr/0005-simple-repository-quality-ownership.md`.
- `docs/agents/fallow.md`: running and diagnosing `quality:fallow`.
- `docs/agents/skills.md`: skill topology and retirement routing.
