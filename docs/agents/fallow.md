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

### Per-package zero proof

The root audit never traverses `.agents/**` (dot-directory). Run each package
rooted instead; this gates on the same terms as the full-repository proof:

```sh
node_modules/.bin/fallow audit --root .agents/runtime/<package> --config .fallowrc.json --format json --quiet --type-aware --type-aware-require best-effort --gate all --base "$(git rev-list --max-parents=0 HEAD | tail -1)"
```

Or run all five packages in one pass with `tooling/fallow-runtime-audit.ts`,
which forwards any extra flags to each rooted `fallow audit` call:

```sh
bun run quality:fallow:runtime -- --gate all --base "$(git rev-list --max-parents=0 HEAD | tail -1)"
```

Expect the repository baseline and every package to have zero dead-code and
zero complexity findings with `verdict: pass` or `verdict: warn`. Treat
`verdict: fail` as a regression. Report duplication clone groups as warn-tier
findings; they are not gated. Hold this zero-proof result as the repository
baseline from this change onward; do not save a count baseline.

Dead-code and complexity are both zero across all five `.agents/runtime/*`
packages as of 2026-09-12. `quality:fallow:runtime` runs inside `bun run
check`, so this gate is enforced on every check, not only a manual run.

## Configuration

- `.fallowrc.json` `entry` globs own runtime roots. Add a glob when a new script family appears.
- A `*` in an entry glob crosses `/` (`bin/*/*.ts` matched `bin/teams/lib/lines.ts`), so name entries as precise roots or prove a broader glob with `fallow list --entry-points` before adding it.
- `.fallowrc.json` `ignorePatterns` owns generated bundles and vendored trees.
- `.fallowrc.json` `health.maxCrap` stays `0` because there is no first-party path to real coverage. Bun 1.4 `bun test --coverage` emits `text` and `lcov` only; Fallow `health.coverage` reads Istanbul `coverage-final.json` only. Wire an lcov-to-Istanbul conversion and merge across 13 workspace test runs before restoring CRAP enforcement. Keep `health.maxCrap` at `0` until that path exists; the schema documents `0` as "disable CRAP enforcement entirely".
- `.fallowrc.json` `ignoreDependencies` holds `vscode` because the VS Code extension host supplies it and unlisted-dependency findings have no inline suppression path. Keep `@logtape/logtape` and `@logtape/redaction` because the playground's nested, independently locked recovery-observability package is never registered by root workspace discovery. Fallow `workspaces.patterns` was tested with the playground root and with `packages/*` on 2026-09-12; `fallow list --workspaces` reported the same 13 workspaces with no diagnostic. Keep the playground `entry` glob because Fallow does not read `bun build <path>` script arguments as entries. Registering the playground under root `workspaces` remains untested and would change its independent lock ownership.
- Keep `.agents/**` in `.fallowrc.json` `ignorePatterns`: Fallow never traverses dot-prefixed directories. The five `.agents/runtime/*` packages are invisible to the root audit; `tooling/fallow-runtime-audit.ts` (`bun run quality:fallow:runtime`) runs each one rooted instead, per the Per-package zero proof above. Their own check contract (Biome, tsc, bun test) measures neither dead code nor complexity, so the rooted run is the only gate for those two categories in this tree.
- Keep `config/opencode/herdr-tui-session.js` and `config/opencode/plugins/herdr-agent-state.js` in `.fallowrc.json` `ignorePatterns`: both are herdr-installed assets (see their own "installed by herdr" header and `HERDR_INTEGRATION_ID`/`HERDR_INTEGRATION_VERSION` markers) that the `herdr` CLI overwrites on reinstall or integration update, so they are ignored rather than refactored or marked with an inline suppression that would not survive the next overwrite.
- A rooted run resolves `.fallowrc.json` `entry` globs and `framework[].detection`/`usedExports` patterns relative to `--root`, not the repo root. Declare a package-local runtime root (a manually invoked dev script, a tsc-program-root type-test file) as an `entry` glob in the shared root `.fallowrc.json`; it is a no-op outside that package's own rooted run.
- Use `framework[].usedExports` for a symbol in a generator-emitted file that is guarded by its own drift check (regenerating the file must reproduce the committed output byte-for-byte). Gate the plugin on `detection: { type: "fileExists", pattern: <a file the generator always produces> }` so it activates only inside that package's rooted run, then list the exact export names under `usedExports`. A value export may additionally be read only by dynamic property access (`module[name]`), which a type export never is (types are erased at runtime); either reason alone justifies the declaration, since un-exporting desyncs the file from its drift check regardless.
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
