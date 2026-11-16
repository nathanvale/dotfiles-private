# Coding Standards

Cross-package rules. A rule enters only with witnessed evidence in two or more
packages; a single-package rule lives in that package's `CODING_STANDARDS.md`,
which points here instead of restating. Delete a rule the moment tooling and
its configuration fully confess it.

Each rule's admitting evidence lives in [lessons](lessons.md). Candidates route
through a fit review before entering this file or any package standards file.

| Rule | Enforced by |
| --- | --- |
| Test execution | `test-runner` skill |
| Independent oracle | Review; planted-fault RED/GREEN |
| Observed evidence crosses a real boundary | Pinned covered/skipped counts |
| Tests wait on events | Review |
| One owner per sealed vocabulary and fake | Review |
| Import aliases are resolver contracts | Typecheck plus architecture tooling |
| Creation is not readiness | Review |
| Exports, type leaks, complexity, suppressions | Fallow config and `fallow-gate.sh` |

## Rules

### Test execution

- Before changing tests, complete the owning test-design brief. Prove the
  public, process, or durable-state seam named by the requirement; helper-only
  proof does not substitute for it.
- After a broad suite failure, inventory every failing row, partition failures
  by cause, and reproduce one representative per group before editing. Never
  mass-update expectations.
- Before rerunning an expensive suite, name the new evidence sought, retain its
  complete output, and pass focused proof for the changed cause.
- Bun test, coverage, repair, or triage: use `test-runner`.

### Fallow

Fallow's configuration and gate output are the rule. Judgement it cannot make:

- Declare every script invoked by a hook, `SKILL.md`, `package.json` script, launchd job, or shell as a runtime root in `.fallowrc.json` `entry`; a dead-code report on it means a missing root, not dead code.
- Extract by responsibility when a health threshold fails; a complexity suppression hides the problem from the gate.

### Independent oracle: no tautological tests

A test's expected value comes from a source independent of the code that
produced the actual value: a literal, a test-owned table, or a separately
admitted constant. A catalog or sealed vocabulary supplies the domain to
enumerate, never the expected value. Mark a deliberately restated constant as
an independent oracle so a dedupe pass does not hoist it into the code under
test.

Assert test-owned expected identities before checking each returned row, or
assert an independently expected count when identities do not matter. An empty
collection must not pass a row-by-row check vacuously.

Name the observable behavior each test proves and one plausible wrong behavior
that makes it fail. A matching helper result or mock call count alone does not
prove a public outcome. For a regression test, or a new or disputed proof
claim, demonstrate RED with a disposable perturbation (or on the unfixed code),
then restore GREEN in the same harness.

### Tests wait on events

Drive time with a fake clock, or wait on a ready file, log line, or barrier.
A sleep or a wall-clock tolerance passes on an idle machine and races under
load. Treat a flaky test as a race to fix, never as a retry to add.

### Observed evidence crosses a real boundary

An evidence row claims coverage only when a real process produced its observed
values. Scaffolds default to a non-covered status; each skip carries a
rationale the test asserts non-empty; covered and skipped counts are pinned
exactly, so downgrading a proven row is a reviewable edit.

### One owner per sealed vocabulary and per test fake

A sealed list, fixture, or fake exists once; every consumer imports it. Treat
a second copy as a defect: copies drift, and each consumer then proves a
different contract while claiming the same one.

### Import aliases are resolver contracts

- Admit an alias through repository architecture before use.
- Map a cross-Module alias only to the Module Interface.
- Prefer runtime-owned package imports or self-references.
- Use `compilerOptions.paths` only when the runtime or bundler owns the same
  mapping.
- Keep one canonical import spelling per seam.
- Prove typecheck, tests, production build or execution, and architecture
  tooling.
- Preserve an accepted relative-import rule until its owning decision changes.

### Creation is not readiness

A reply that proves a resource exists never proves it can accept the next
dependent call. Before dispatching to a just-created resource, prove readiness
through an owned observable, or treat the dependency's structured "not ready"
rejection as a bounded same-identity retry, admitted only with evidence the
rejection is pre-launch and side-effect-free. A rejection that outlives the
bound is a classified failure, never an unknown outcome.
