# Coding Standards

Cross-package rules. A rule enters only with witnessed evidence in two or more
packages; a single-package rule lives in that package's `CODING_STANDARDS.md`,
which points here instead of restating. Delete a rule the moment tooling
enforces it.

Evidence archive: the `receipts/standards-research*.md` files (issue-55 feature
branch until merge). Candidates route through a fit review before entering this
file or any package standards file.

## Rules

### Independent oracle

A test's expected value comes from a source independent of the code that
produced the actual value: a literal, a test-owned table, or a separately
admitted constant. A catalog or sealed vocabulary supplies the domain to
enumerate, never the expected value. Mark a deliberately restated constant as
an independent oracle so a dedupe pass does not hoist it into the code under
test.

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
