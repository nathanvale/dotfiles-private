import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateReport, validateBudget } from '../skills/bake-off/scripts/report-closeout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const closeout = join(pluginRoot, 'skills/bake-off/scripts/report-closeout.mjs');

function completeReport(phase = 'complete') {
  return `# Report

## Coordinator checkpoint

- Phase and last checkpoint time: ${phase}
- Consumed/skipped allocation and next eligible pair: 4 / 4; none
- Active worker: released after setup inputs, qualification, and baseline
- Next permitted action: report-only closeout

## Attempts

| Adapter / attempt | Outcome | Active / elapsed time | Changed technique | Run IDs / evidence | Assertions | Reset / cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| agent-browser / 1 | successful after observed control | 1 / 1 | initial | receipt-a | passed | confirmed |
| playwright / 1 | failed, no effect | 1 / 1 | form fallback | receipt-b | observed | unknown prior cleanup |
| puppeteer / 1 | timed out | 1 / 1 | fixed action | receipt-c | incomplete | confirmed |
| chrome-devtools / 1 | blocked by capability | 1 / 1 | diagnostic | receipt-d | none | confirmed |

## Runbook comparison

- Optional comparison: pending after acceptance

## Delivery

- Recipe and script locations/hashes, checked from the promoted destination: candidate hashes recorded
- Remaining qualification gaps: real-browser acceptance pending
- Final operator and worker outcome: complete
- Final lane custody, lease, and attended handoff outcome: complete
- Final adapter cleanup outcome: confirmed for final worker; prior unknown retained in attempt row
- Final application-state outcome: complete
`;
}

test('closeout counts verbose populated attempt outcomes as actual attempts', () => {
  const result = validateReport(completeReport());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.summary.attemptRows, 4);
  assert.equal(result.summary.actualAttemptRows, 4);
});

test('closeout rejects a stale current checkpoint but permits pending optional comparison', () => {
  const stale = validateReport(completeReport('setup; no attempts yet'));
  assert.equal(stale.valid, false);
  assert.ok(stale.errors.some((entry) => entry.code === 'stale-checkpoint'));
  assert.equal(validateReport(completeReport('pending')).valid, false);
});

test('the closeout CLI is a read-only validation seam', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'browser-lanes-report-'));
  try {
    const report = join(temporaryRoot, 'report.md');
    writeFileSync(report, completeReport());
    const output = execFileSync(process.execPath, [closeout, '--file', report], { encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.valid, true);
    assert.equal(result.summary.actualAttemptRows, 4);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

const budgetRecord = (overrides = {}) => ({ phase: 'dispatch', setupSeconds: 240, remainingSeconds: 1500, reserveSeconds: 300, attemptCapsSeconds: [300, 300, 300, 300], ...overrides });
const withBudget = (budget) => completeReport() + '\n## Budget\n\n```browser-lanes-budget\n' + JSON.stringify(budget) + '\n```\n';

test('budget guard rejects observed setup overrun and compressed contender caps', () => {
  const result = validateReport(withBudget(budgetRecord({ phase: 'closeout', setupSeconds: 540, remainingSeconds: 0, attemptCapsSeconds: [180, 180, 180, 180], priorProvenSeconds: 272 })), { requireBudget: true });
  assert.deepEqual(result.errors.map(error => error.code), ['setup-budget-overrun', 'attempt-budget-compressed']);
});

test('dispatch reduces contenders instead of compressing caps and preserves prior viability', () => {
  assert.equal(validateBudget(budgetRecord({ remainingSeconds: 900, attemptCapsSeconds: [300, 300] })).valid, true);
  assert.ok(validateBudget(budgetRecord({ remainingSeconds: 900 })).errors.some(error => error.code === 'insufficient-run-budget'));
  assert.ok(validateBudget(budgetRecord({ priorProvenSeconds: 360 })).errors.some(error => error.code === 'attempt-budget-compressed'));
  assert.equal(validateReport(withBudget(budgetRecord())).valid, true); // Actual one-minute outcomes do not change the five-minute caps.
});

test('budget evidence is explicit and user overrides require authority', () => {
  assert.equal(validateReport(completeReport(), { requireBudget: true }).errors[0].code, 'missing-budget');
  assert.equal(validateReport(completeReport()).summary.budgetEvidence, 'unverified-legacy');
  assert.equal(validateBudget(budgetRecord({ setupSeconds: -1 })).valid, false);
  assert.equal(validateBudget(budgetRecord({ userAttemptCapSeconds: 180, attemptCapsSeconds: [180] })).valid, false);
  assert.equal(validateBudget(budgetRecord({ userAttemptCapSeconds: 180, attemptCapsSeconds: [180], userBudgetEvidence: 'explicit user instruction in task checkpoint' })).valid, true);
});

test('public closeout refuses missing and unsafe budget records without editing reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-lanes-budget-'));
  try {
    const file = join(dir, 'report.md');
    writeFileSync(file, withBudget(budgetRecord({ setupSeconds: 540, attemptCapsSeconds: [180] })));
    assert.throws(() => execFileSync(process.execPath, [closeout, '--file', file, '--require-budget'], { encoding: 'utf8' }), error => {
      assert.equal(error.status, 1);
      assert.ok(JSON.parse(error.stdout).errors.some(row => row.code === 'attempt-budget-compressed'));
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
