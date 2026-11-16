# Standards Lessons

The witnessed evidence that admitted each rule in
[CODING_STANDARDS.md](CODING_STANDARDS.md). Add a lesson here when a rule
enters or a violation recurs after admission.

## Independent oracle: no tautological tests
Lesson: four packages carried this defect on one audit day. ASMG review caught
a hoist that replaced a test's literal list with the predicate under test;
vault-git and warm-chrome each compared a catalog to itself through copied
expected fields; browser-connect recomputed expectations by calling the
production function.

## Observed evidence crosses a real boundary
Lesson: warm-chrome shipped an eighteen-station manifest reporting full
observed coverage with zero processes run, on its public API. browser-connect
solved the identical problem honestly with real spawns, pinned counts, and
per-skip rationales.

## One owner per sealed vocabulary and per test fake
Lesson: ASMG declared its baseline exit codes in two files and restated a
sealed mutation list in three fixtures; browser-connect's two copies of one
fake runtime drifted on probe stderr; browser-use-security duplicated a
manifest byte-for-byte across two test files.

## Creation is not readiness
Lesson: frontier-runner called `herdr agent start` 8ms after `pane split`
returned ok; the split proved the pane existed, not that its shell was at a
prompt. The same pane was ready in 5ms in one run and 220ms in another, so the
race passed every local check and failed a native receipt-backed run with a
misclassified unknown startup effect. (Admitted with single-package evidence
on Nathan's instruction, 2026-08-24; two call sites witnessed.)
## Tests wait on events

bun-typescript-template PR #6 repaired sleep and load races in b077b0b,
4386b03 and 2b2907a (a race test caught its planted fault in 48 of 50 runs).
Nathan asked for flaky-test repairs in four other sessions across work SDK
and Herdr work. A laptop at load 38 to 120 failed timing bounds that a quiet
Mac mini passed.

## Independent oracle: regression RED

Nathan restated "prove regression tests fail before and pass after" for a bug
fix that the new-or-disputed wording did not cover.

## Rules with no recorded evidence

Test execution, Import aliases are resolver contracts, and the Fallow
judgement bullets predate this file and have no witnessed evidence recorded
here. The Fallow rules restate what `.fallowrc.json` and `fallow-gate.sh`
enforce. Record a witness here the next time one of these rules catches or
misses a defect; until then, treat them as unproven.
