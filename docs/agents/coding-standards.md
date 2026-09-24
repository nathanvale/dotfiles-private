# Coding Standards

Cross-package rules. A rule enters only with witnessed evidence in two or more
packages; a single-package rule lives in that package's `CODING_STANDARDS.md`,
which points here instead of restating. Delete a rule the moment tooling and
its configuration fully confess it.

Evidence archive: the `receipts/standards-research*.md` files (issue-55 feature
branch until merge). Candidates route through a fit review before entering this
file or any package standards file.

## Rules

### Fallow enforces

- Export only symbols another module imports; unused exports are errors.
- Export every type that appears in a public signature; private type leaks are errors.
- Keep functions at or below cyclomatic 20 and cognitive 15; extract by responsibility when a health threshold fails; never suppress it, because suppression hides complexity from the gate.
- Declare every script invoked by a hook, `SKILL.md`, `package.json` script, launchd job, or shell as a runtime root in `.fallowrc.json` `entry`; never delete it as dead, because doing so breaks its invoking path.
- Place committed build bundles under an `ignorePatterns` glob.
- Give every inline `fallow-ignore` a human-readable reason; use it only for a genuine false positive.
- Close out each code-changing turn per the `AGENTS.md` Proof section.

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

Lesson: four packages carried this defect on one audit day. ASMG review caught
a hoist that replaced a test's literal list with the predicate under test;
vault-git and warm-chrome each compared a catalog to itself through copied
expected fields; browser-connect recomputed expectations by calling the
production function.

### Observed evidence crosses a real boundary

An evidence row claims coverage only when a real process produced its observed
values. Scaffolds default to a non-covered status; each skip carries a
rationale the test asserts non-empty; covered and skipped counts are pinned
exactly, so downgrading a proven row is a reviewable edit.

Lesson: warm-chrome shipped an eighteen-station manifest reporting full
observed coverage with zero processes run, on its public API. browser-connect
solved the identical problem honestly with real spawns, pinned counts, and
per-skip rationales.

### One owner per sealed vocabulary and per test fake

A sealed list, fixture, or fake exists once; every consumer imports it. Treat
a second copy as a defect: copies drift, and each consumer then proves a
different contract while claiming the same one.

Lesson: ASMG declared its baseline exit codes in two files and restated a
sealed mutation list in three fixtures; browser-connect's two copies of one
fake runtime drifted on probe stderr; browser-use-security duplicated a
manifest byte-for-byte across two test files.

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

Lesson: frontier-runner called `herdr agent start` 8ms after `pane split`
returned ok; the split proved the pane existed, not that its shell was at a
prompt. The same pane was ready in 5ms in one run and 220ms in another, so the
race passed every local check and failed a native receipt-backed run with a
misclassified unknown startup effect. (Admitted with single-package evidence
on Nathan's instruction, 2026-08-24; two call sites witnessed.)
