---
status: proposed
---

# Establish a Fallow zero baseline

## Context and Problem

Main carried 121 dead-code and 424 complexity findings. The gate is
`new-only`, so every touched line re-surfaced that noise in
agent reports. Of the 424 complexity findings, 405 were
CRAP scores computed from estimated coverage; no real coverage file is wired
in. Of the 43 "unused files" dead-code findings, most were runtime roots:
scripts invoked by hooks, `SKILL.md`, `package.json` scripts, launchd, or
shell, with no manifest declaring them as entry points. The playground's
`runtime/*.js` files are committed `bun build` output bundles, not source.

What configuration and repair policy gives agents a truthful zero baseline
without hiding future findings?

## Decision Drivers

- Give agents a truthful zero baseline.
- Avoid suppression and count baselines as ways to fake a pass.
- Keep `.fallowrc.json` as the single owner of Fallow configuration.
- Keep thresholds at kit defaults; change only `health.maxCrap`.

## Considered Options

- Option A: refactor every function to satisfy estimated CRAP scores.
- Option B: wire real Istanbul coverage into `health.coverage` now, then let real CRAP govern.
- Option C: disable CRAP gating with `health.maxCrap: 0`, declare `entry` globs for runtime roots, add `ignorePatterns` for committed bundles and vendored trees, and repair remaining genuine findings in code. Chosen option.
- Option D: keep new-only attribution and declare levers only; do not repair inherited findings.

## Decision

We will choose Option C because it gives agents a truthful zero baseline,
uses no suppression or count baseline, keeps `.fallowrc.json` as the single
configuration owner, and changes only `health.maxCrap` from kit defaults while
real coverage remains unwired.

## Consequences

- Positive: the full-repository audit verdict is `pass` or `warn` with zero dead-code and zero complexity findings; `fail` is a regression.
- Positive: `bun run check` is green.
- Positive: runtime roots and committed bundles have explicit `.fallowrc.json` ownership.
- Known residue: 20 warn-tier duplication clone groups remain; 19 instances sit in `imessage-reader/scripts/query-imessage.ts`. Follow up by consolidating or accepting each group.
- Neutral: `ignorePatterns` holds `.agents/**` because Fallow never traverses dot-prefixed directories and no config adds one. The five `.agents/runtime/*` packages (140 files, 2,340 functions, measured 2026-09-12) are unmeasured by the root audit. Their own check contract is Biome, tsc, and bun test, which measure neither dead code nor complexity. Rooted runs with the repo rc (`fallow audit --root <pkg> --config .fallowrc.json`) found 23 dead-code and 40 complexity findings on 2026-09-12. A follow-up owns measurement and repair. Until then, the zero baseline covers 149 of 289 files. Root-relative `ignorePatterns` do not apply inside a rooted run.
- Negative: CRAP remains ungated until real coverage data exists.
- Revisit: there is no first-party path to real coverage. Bun 1.4 `bun test --coverage` emits `text` and `lcov` only; Fallow `health.coverage` reads Istanbul `coverage-final.json` only. Wiring needs an lcov-to-Istanbul conversion and a merge across 13 workspace test runs. `health.maxCrap` stays `0`; the schema documents `0` as "disable CRAP enforcement entirely" until that path exists.
- Revisit: add an `entry` glob when a new script family appears.
- Revisit: extend `ignorePatterns` when a newly committed bundle falls outside the ignored glob.
- Revisit: Fallow `workspaces.patterns` was tested with the playground root and with `packages/*`; `fallow list --workspaces` reported the same 13 workspaces with no diagnostic, so the nested project, with its own `bun.lock` and own `workspaces`, is never registered and `@logtape/*` stays in `ignoreDependencies`. The playground `entry` glob is required because Fallow does not read `bun build <path>` script arguments as entries. Registering the playground under root `workspaces` remains untested and would change its independent lock ownership.
- Planned follow-up consequence: the Gate ships as self-gating Biome, Fallow, and TypeScript hooks in a personal `proof` plugin, a separate change with its own ADR; event placement is that ADR's decision, informed by `docs/research/2026-09-12-agent-hook-timing.md`. A Clause decays as a session fills; a Gate does not.

## Options and Tradeoffs

### Option A: refactor every function to satisfy estimated CRAP scores

- Truthful baseline: fails because estimated CRAP remains a proxy and runtime roots and bundles still appear as dead-code noise.
- No fake pass: meets the driver because it uses neither suppression nor a count baseline, but it spends code changes on a false metric.
- Single owner: neutral because it leaves `.fallowrc.json` as the only configuration owner but does not declare the missing roots or bundles there.
- Kit thresholds: fails because it reshapes code around estimated coverage instead of changing only the `maxCrap` health lever.

### Option B: wire real Istanbul coverage into `health.coverage` now

- Truthful baseline: fails now because real coverage would make CRAP truthful later, but runtime roots, bundles, and remaining findings still block zero today.
- No fake pass: meets the driver because it uses real coverage without suppression or a count baseline.
- Single owner: meets the driver because `health.coverage` remains in `.fallowrc.json`.
- Kit thresholds: meets the driver because it preserves the kit default `maxCrap` and adds real coverage rather than changing a threshold.

### Option C: disable estimated CRAP gating and repair genuine findings

- Truthful baseline: meets the driver by declaring runtime roots, ignoring bundles and vendored trees, disabling estimated CRAP, and repairing genuine findings until the audit is zero.
- No fake pass: meets the driver because it uses no suppression or count baseline.
- Single owner: meets the driver because every Fallow configuration change stays in `.fallowrc.json`.
- Kit thresholds: meets the driver because kit defaults remain and only `health.maxCrap` changes.
- Bad: CRAP stays ungated until coverage is wired.

### Option D: keep new-only attribution and declare levers only

- Truthful baseline: fails because new-only attribution labels findings `introduced: true/false`, but any touched line re-surfaces the legacy findings in every audit report, which is the noise agents actually hit. Repair buys legibility and a `--gate all` proof at the cost of a large diff (8,775 additions, 7,092 deletions in PR 141) that needed two Fable reviews and characterization tests.
- No fake pass: meets the driver because it uses neither suppression nor a count baseline.
- Single owner: meets the driver because it keeps Fallow configuration in `.fallowrc.json`.
- Kit thresholds: meets the driver because it declares the levers without changing the kit thresholds.

## Confirmation

The measured baseline is 149 files / 3,692 functions.

Run:

```sh
node_modules/.bin/fallow audit --format json --quiet --type-aware --type-aware-require best-effort --gate all --base "$(git rev-list --max-parents=0 HEAD | tail -1)"
```

Run the rooted per-package proof too; it gates on the same terms as the root
audit, not as separate non-gating context:

```sh
bun run quality:fallow:runtime -- --gate all --base "$(git rev-list --max-parents=0 HEAD | tail -1)"
```

Confirm every JSON `verdict` (root and each of the five `.agents/runtime/*`
packages) is `pass` or `warn` with zero dead-code and zero complexity
findings; treat `fail` as a regression. Confirm `bun run check` is green.
Treat the 20 warn-tier duplication clone groups as known residue, not a
blocking condition.

Dead-code and complexity repair for all five packages landed 2026-09-12
(verified zero on a rooted audit each). `quality:fallow:runtime` runs inside
`bun run check`, so this confirmation holds on every check, not only a
manual run.

## References

- [ADR 0008 native Fallow and workspace toolchain](0008-native-fallow-and-workspace-toolchain.md): governs the pinned toolchain and the Fallow rc and script split.
- [`docs/agents/fallow.md`](../agents/fallow.md): running and diagnosing the Fallow quality gate.
