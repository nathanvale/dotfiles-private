# Test-pruning campaign

Adapted from [OpenClaw test-audit](https://github.com/openclaw/openclaw/tree/main/.agents/skills/test-audit) under its MIT license; see [LICENSE](LICENSE).

Prune one plugin package or workflow area's whole test surface as one coherent
change. Apply the value bar, retention bar, candidate evidence, and validation
in [SKILL.md](SKILL.md) to every candidate. Finish each criterion before
advancing.

## 1. Baseline

Record test and support line counts and every in-scope test file's pass or fail
state at a pinned baseline commit. Diagnose baseline failures separately as
possible product defects.

Done when every test file has a baseline result.

## 2. Lanes

Divide the surface by production owner boundaries. Include shared boundary
tests, CLI process tests, qualification scenarios, and live proof owned by the
subsystem. Assign each to exactly one lane.

Done when every in-scope test and scenario has one lane.

## 3. Read-only ledger

Read each test, its parameter rows, production owner, entry points, callers,
history, and CI routing. Use independent read-only reviewers when the active
workflow authorizes them. Mark each test declaration, or each parameter row
when rows need different marks:

- `R`: retain; name the contract and regression it catches.
- `F`: retain the contract; repair an ineffective assertion.
- `C`: consolidate; name the stronger owner that absorbs it.
- `D`: delete; name remaining proof or why no contract exists.

Done when every declaration has one mark and an evidence line.

## 4. Layer plan

Review the ledger for redundant layers. Name the keeper suite for each contract,
prefer the real boundary over a mocked collaborator, and correct ledger errors.

Done when every lane names retired tests, keeper suites, assertions to carry
forward, and test-only production seams that can be removed.

## 5. Cutover

Edit one owner lane at a time. Coordinate shared harness edits through one
owner. Remove obsolete test-only seams. Update test inventories and CI routing.
Add a durable local rule to existing guidance only when repeated evidence
justifies it.

Done when every lane plan is applied and its keepers pass.

## 6. Preservation review

Compare deleted coverage against keepers with independent review when
available. Check for lost contracts and assertions that cannot fail for the
claimed reason. For each restored contract, perturb its production owner and
confirm the keeper goes red; restore the source byte for byte afterward.

Done when every reported gap is restored or rejected with source evidence,
and each restored contract has a caught mutation.

## 7. Product defects

Treat a baseline failure retained in a keeper as a possible product bug. Repair
it at its owner as a separate commit. Show a failing control and a passing
candidate through the same user flow. Record unrelated defects as follow-ups.

Done when each repaired defect has both control and candidate evidence.

## 8. Reconcile and hand back

If the baseline advances, reconcile every new regression with the keeper
suites. Rerun the full subsystem suite and relevant live proof on the final
head. Inspect the complete changed-file list if review tooling truncates it.

Hand back the [SKILL.md](SKILL.md) report, baseline and final line counts,
lanes and keepers, preservation gaps and mutations, and product defect proof.
