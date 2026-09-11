# Fallow Quality Gate

Goal: audit the current code-changing delta through Fallow's native JSON
contract. `quality:fallow` re-emits that JSON unchanged; there is no repository
helper, wrapper, or replacement report format.

## Start

1. Read `.agents/skills/fallow/SKILL.md`, then its version-matched owner at
   `node_modules/fallow/skills/fallow/SKILL.md`.
2. Resolve flags from `node_modules/.bin/fallow --help`, never from memory.
3. Keep MCP, global installation, PATH overrides, and broad suppressions out of
   this owner.

## Commands

Dirty code-changing turn:

```sh
bun run --silent quality:fallow --changed-since HEAD
```

Review or handoff: replace `HEAD` with the immutable task-start commit. A clean
comparison to `HEAD` is only an empty-delta smoke check.

Complete repository gate:

```sh
bun run check
```

Its Fallow step passes no comparison base, so Fallow selects the branch
upstream or remote-default merge-base.

Full-repository zero proof:

```sh
node_modules/.bin/fallow audit --format json --quiet --type-aware --type-aware-require best-effort --gate all --base "$(git rev-list --max-parents=0 HEAD | tail -1)"
```

### Per-package measurement (non-gating)

```sh
node_modules/.bin/fallow audit --root .agents/runtime/<package> --config .fallowrc.json --format json --quiet --type-aware --type-aware-require best-effort --gate all --base "$(git rev-list --max-parents=0 HEAD | tail -1)"
```

This measures a package the root audit cannot see; root-relative `ignorePatterns`
do not apply inside it, so record its findings without gating them until the
follow-up lands.

Expect the repository baseline to have zero dead-code and zero complexity
findings with `verdict: pass` or `verdict: warn`. Treat `verdict: fail` as a
regression. Report duplication clone groups as warn-tier findings; they are not
gated. Hold this zero-proof result as the repository baseline from this change
onward; do not save a count baseline.

## Configuration

- `.fallowrc.json` `entry` globs own runtime roots. Add a glob when a new script family appears.
- A `*` in an entry glob crosses `/` (`bin/*/*.ts` matched `bin/teams/lib/lines.ts`), so name entries as precise roots or prove a broader glob with `fallow list --entry-points` before adding it.
- `.fallowrc.json` `ignorePatterns` owns generated bundles and vendored trees.
- `.fallowrc.json` `health.maxCrap` stays `0` because there is no first-party path to real coverage. Bun 1.4 `bun test --coverage` emits `text` and `lcov` only; Fallow `health.coverage` reads Istanbul `coverage-final.json` only. Wire an lcov-to-Istanbul conversion and merge across 13 workspace test runs before restoring CRAP enforcement. Keep `health.maxCrap` at `0` until that path exists; the schema documents `0` as "disable CRAP enforcement entirely".
- `.fallowrc.json` `ignoreDependencies` holds `vscode` because the VS Code extension host supplies it and unlisted-dependency findings have no inline suppression path. Keep `@logtape/logtape` and `@logtape/redaction` because the playground's nested, independently locked recovery-observability package is never registered by root workspace discovery. Fallow `workspaces.patterns` was tested with the playground root and with `packages/*` on 2026-09-12; `fallow list --workspaces` reported the same 13 workspaces with no diagnostic. Keep the playground `entry` glob because Fallow does not read `bun build <path>` script arguments as entries. Registering the playground under root `workspaces` remains untested and would change its independent lock ownership.
- Keep `.agents/**` in `.fallowrc.json` `ignorePatterns`: Fallow never traverses dot-prefixed directories and no config adds one. The five `.agents/runtime/*` packages (140 files, 2,340 functions, measured 2026-09-12) are unmeasured by the root audit. Their own check contract is Biome, tsc, and bun test, which measure neither dead code nor complexity. Rooted runs with the repo rc (`fallow audit --root <pkg> --config .fallowrc.json`) found 23 dead-code and 40 complexity findings on 2026-09-12. A follow-up owns measurement and repair. Until it lands, the zero baseline covers 149 of 289 files. Root-relative `ignorePatterns` do not apply inside a rooted run.
- `.fallowrc.json` `audit.cacheMaxAgeDays` is `7` because worker worktrees each leave a base-snapshot cache under the temp directory (37 caches, 412 MB on 2026-09-12); `fallow audit-cache prune --dry-run` reports them.

## Decisions

Fallow prints JSON on stdout on every exit, including a refusal. Preserve it as
tool evidence; read `verdict`, `attribution`, and `_meta.type_aware` before
acting.

| Exit | Meaning |
| ---: | --- |
| 0 | `verdict` passed: no introduced finding failed policy. |
| 1 | An introduced finding failed policy. |
| 2 | Operational error such as an invalid comparison base; no audit ran. |

- `quality:fallow` passes `--type-aware-require best-effort`: the exit code
  follows `verdict`; `_meta.type_aware` incompleteness is advisory.
- `.fallowrc.json` pins `new-only` attribution and promotes every applicable
  warn-default rule to `error`. Its `require: complete` applies only to a
  direct `node_modules/.bin/fallow audit` run, which then refuses on any
  `unavailable` project or `partial` query.
- Treat `blocking-diagnostics`, `attached-comment`, and `dynamic-behavior` in
  `_meta` as advisory: repair them when you own the file, never to make the
  gate pass. ADR 0008 names the revisit triggers for restoring `complete`.

## Comparison bases

- Complete gate: leave the CLI base unset so native merge-base detection owns
  selection. Treat a zero-file result as an empty-delta smoke, not changed-code
  review evidence.
- Dirty turn: use `HEAD` so tracked and untracked work remains in scope.
- Review and handoff: use the immutable task-start commit.
- Remote integration: use a freshly resolved remote ref only after that remote
  action is authorized.
- Never disable type-aware analysis or save a count baseline to make a gate
  pass.

## Boundaries

- `boundaries` is deliberately absent from `.fallowrc.json`; `fallow guard` and
  zones stay unconfigured until a zone graph is accepted.

## Editor resolution

- VS Code resolves `node_modules/.bin/fallow` and `node_modules/.bin/fallow-lsp`
  from this repository; one root `.fallowrc.json` governs every workspace.
- If project-binary resolution fails, stop. Never change global PATH, set
  `fallow.lspPath` or `fallow.configPath`, or add another editor override.

## Runtime state and repair

- Fallow may create `.fallow/` caches; the root `.gitignore` excludes them.
  Inspect them when diagnosing, never commit them or place source inside them.
- Repair only the reported finding. Never weaken a test, add a broad ignore, or
  turn the repository into a suppression baseline.
- TypeScript remains authoritative for compilation; Fallow type-aware
  completeness is quality evidence only.
