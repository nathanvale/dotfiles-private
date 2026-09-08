import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acceptRecipe,
  migrateLegacyRecipe,
  recipeDigest,
  repairRecipe,
  validateRecipe,
  verifyIndependentReceipt,
} from '../skills/bake-off/scripts/recipe-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const recipePath = join(pluginRoot, 'skills/bake-off/assets/recipe.json');
const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
const fixtureScript = join(pluginRoot, 'tests/fixtures/hybrid-recipe/journey.mjs');
const pageScript = join(pluginRoot, 'tests/fixtures/hybrid-recipe/save-draft.page.js');

function completeReceipt(candidate = recipe) {
  return {
    kind: 'independent-workflow-receipt',
    receiptId: 'receipt-hybrid-001',
    recipeId: candidate.id,
    recipeRevision: candidate.revision,
    recipeSha256: recipeDigest(candidate),
    scriptHashes: candidate.steps.filter((step) => step.script).map((step) => step.script),
    orderedSteps: candidate.steps.map((step) => ({
      id: step.id,
      adapter: step.preferredAdapter,
      successAssertion: step.successAssertion,
      passed: true,
    })),
    unresolvedEffects: [],
    finalState: {
      status: 'saved-draft-read-back',
      observed: true,
      passed: true,
      scope: ['local-fixture/draft'],
    },
    identity: { runId: 'run-accept-001', discovery: 'worker-discovery-001', author: 'fresh-acceptance-001' },
    proof: { source: 'real-browser', complete: true, provider: 'recorded-browser-provider' },
  };
}

test('the v2 sample validates with exact linked script bytes', () => {
  const result = validateRecipe(recipe, { checkScripts: true, scriptRoot: pluginRoot });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(recipe.defaultAdapter, 'agent-browser');
  assert.deepEqual(recipe.steps.map((step) => step.id), [
    'observe-task-page',
    'enter-draft-title',
    'save-draft',
    'read-back-draft',
  ]);
});

test('malformed recipes return typed errors without dereferencing invalid steps', () => {
  const malformed = { schemaVersion: 2, id: 'bad', revision: 1, state: 'candidate', defaultAdapter: 'agent-browser', steps: [null] };
  const result = validateRecipe(malformed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((entry) => entry.code === 'invalid-step'));
  assert.doesNotThrow(() => verifyIndependentReceipt(null, {}));
});

test('malformed script links return typed errors before filesystem inspection', () => {
  const malformed = structuredClone(recipe);
  malformed.steps[2].script = { path: 42, sha256: 'bad' };
  assert.doesNotThrow(() => validateRecipe(malformed, { checkScripts: true, scriptRoot: '.' }));
  const validation = validateRecipe(malformed, { checkScripts: true, scriptRoot: '.' });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.code === 'invalid-script-path'));
  assert.doesNotThrow(() => verifyIndependentReceipt(malformed, {}, { scriptRoot: '.' }));
  const receipt = verifyIndependentReceipt(malformed, {}, { scriptRoot: '.' });
  assert.equal(receipt.valid, false);
  assert.ok(receipt.errors.some((entry) => entry.code === 'invalid-script-path'));
});

test('repair changes one step choice, records fallback proof, and clears acceptance', () => {
  const before = structuredClone(recipe);
  before.acceptance = { stale: true };
  const inputSnapshot = structuredClone(before);
  const repaired = repairRecipe(before, {
    stepId: 'save-draft',
    fallbackAdapter: 'playwright',
    observation: {
      kind: 'verified-failure', stepId: 'save-draft', effect: 'none', authority: 'verified', custody: 'verified', evidenceId: 'obs-save-no-effect',
    },
    fallbackEvidence: {
      kind: 'verified-success', stepId: 'save-draft', adapter: 'playwright', passed: true, effect: 'Save', authority: 'verified', custody: 'verified', evidenceId: 'obs-pw-save-pass',
    },
  });
  assert.deepEqual(before, inputSnapshot, 'repair must not mutate its input');
  assert.equal(repaired.revision, 2);
  assert.equal(repaired.state, 'candidate');
  assert.equal(repaired.steps[2].preferredAdapter, 'playwright');
  assert.deepEqual(repaired.steps[2].fallbackAdapters, ['puppeteer']);
  assert.equal(repaired.acceptance, undefined);
  assert.equal(repaired.steps[2].repairEvidence.fallback.adapter, 'playwright');
  assert.equal(validateRecipe(repaired).valid, true);
});

test('unknown effect, authority failure, custody failure, and missing fallback proof stop repair', () => {
  const base = {
    stepId: 'save-draft', fallbackAdapter: 'playwright',
    observation: { kind: 'verified-failure', stepId: 'save-draft', effect: 'none', authority: 'verified', custody: 'verified', evidenceId: 'obs' },
    fallbackEvidence: { kind: 'verified-success', stepId: 'save-draft', adapter: 'playwright', passed: true, effect: 'Save', authority: 'verified', custody: 'verified', evidenceId: 'pass' },
  };
  for (const [field, value, code] of [
    ['effect', 'unknown', 'uncertain-effect'],
    ['authority', 'failed', 'authority-failure'],
    ['custody', 'failed', 'custody-failure'],
  ]) {
    const request = structuredClone(base);
    request.observation[field] = value;
    assert.throws(() => repairRecipe(recipe, request), (error) => error.code === code);
  }
  const noProof = structuredClone(base);
  delete noProof.fallbackEvidence;
  assert.throws(() => repairRecipe(recipe, noProof), (error) => error.code === 'missing-fallback-evidence');
});

test('unknown consequential effects stop repair for Insert, Save, Delete, and Submit', () => {
  for (const effect of ['Insert', 'Save', 'Delete', 'Submit']) {
    const candidate = structuredClone(recipe);
    candidate.steps[2].authority.effect = effect;
    assert.throws(() => repairRecipe(candidate, {
      stepId: 'save-draft', fallbackAdapter: 'playwright',
      observation: { kind: 'verified-failure', stepId: 'save-draft', effect: 'unknown', authority: 'verified', custody: 'verified', evidenceId: `unknown-${effect}` },
      fallbackEvidence: { kind: 'verified-success', stepId: 'save-draft', adapter: 'playwright', passed: true, effect, authority: 'verified', custody: 'verified', evidenceId: `fallback-${effect}` },
    }), (error) => error.code === 'uncertain-effect');
  }
});

test('acceptance requires ordered passed adapters, final state, scope, and no unresolved effects', () => {
  const receipt = completeReceipt();
  const accepted = verifyIndependentReceipt(recipe, receipt, { scriptRoot: pluginRoot });
  assert.equal(accepted.valid, true, JSON.stringify(accepted.errors));
  assert.equal(accepted.recipe.state, 'independently-verified');
  assert.notEqual(accepted.candidateRecipeSha256, accepted.promotedRecipeSha256);
  assert.equal(accepted.evidenceTrust, 'recorded-not-authenticated');
  assert.equal(validateRecipe(accepted.recipe).valid, true);

  const wrongAdapter = structuredClone(receipt);
  wrongAdapter.orderedSteps[0].adapter = 'puppeteer';
  assert.equal(verifyIndependentReceipt(recipe, wrongAdapter, { scriptRoot: pluginRoot }).valid, false);
  const failedAssertion = structuredClone(receipt);
  failedAssertion.orderedSteps[1].passed = false;
  assert.equal(verifyIndependentReceipt(recipe, failedAssertion, { scriptRoot: pluginRoot }).valid, false);
  const unresolved = structuredClone(receipt);
  unresolved.unresolvedEffects = ['save-unknown'];
  assert.equal(verifyIndependentReceipt(recipe, unresolved, { scriptRoot: pluginRoot }).valid, false);
  const mocked = structuredClone(receipt);
  mocked.proof.source = 'deterministic-local-process';
  assert.equal(verifyIndependentReceipt(recipe, mocked, { scriptRoot: pluginRoot }).valid, false);
  for (const receiptId of [undefined, '', '   ']) {
    const unidentified = structuredClone(receipt);
    if (receiptId === undefined) delete unidentified.receiptId;
    else unidentified.receiptId = receiptId;
    const result = verifyIndependentReceipt(recipe, unidentified, { scriptRoot: pluginRoot });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((entry) => entry.code === 'missing-receipt-id'));
  }
  assert.equal(acceptRecipe(recipe, receipt, { scriptRoot: pluginRoot }).valid, true);
});

test('a temporary production-gate perturbation rejects the unchanged receipt', async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'browser-lanes-gate-'));
  try {
    const source = readFileSync(join(pluginRoot, 'skills/bake-off/scripts/recipe-contract.mjs'), 'utf8');
    const perturbed = source.replace('receipt.finalState.passed !== true', 'receipt.finalState.passed !== false');
    assert.notEqual(perturbed, source, 'the negative control must change the production gate');
    const copy = join(temporaryRoot, 'recipe-contract.mjs');
    writeFileSync(copy, perturbed);
    const module = await import(`${new URL(`file://${copy}`).href}?negative-control`);
    assert.equal(module.verifyIndependentReceipt(recipe, completeReceipt(), { scriptRoot: pluginRoot }).valid, false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('metadata-only revision and changed linked bytes invalidate a stored acceptance', () => {
  const accepted = verifyIndependentReceipt(recipe, completeReceipt(), { scriptRoot: pluginRoot });
  assert.equal(accepted.valid, true);
  const revised = structuredClone(accepted.recipe);
  revised.revision += 1;
  assert.equal(validateRecipe(revised).valid, false);

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'browser-lanes-recipe-'));
  const copiedScript = join(temporaryRoot, 'tests/fixtures/hybrid-recipe/save-draft.page.js');
  const copiedRecipe = structuredClone(recipe);
  const scriptBytes = readFileSync(pageScript);
  // The copy is a disposable acceptance gate. The source tree stays untouched.
  mkdirSync(dirname(copiedScript), { recursive: true });
  writeFileSync(copiedScript, scriptBytes);
  writeFileSync(copiedScript, Buffer.concat([scriptBytes, Buffer.from('\nmutation')]))
  assert.equal(verifyIndependentReceipt(copiedRecipe, completeReceipt(copiedRecipe), { scriptRoot: temporaryRoot }).valid, false);
  writeFileSync(copiedScript, scriptBytes);
  assert.equal(verifyIndependentReceipt(copiedRecipe, completeReceipt(copiedRecipe), { scriptRoot: temporaryRoot }).valid, true);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

test('legacy migration requires complete supplied contracts and retains adapter choices', () => {
  const contracts = recipe.steps.map((step) => structuredClone(step));
  const migrated = migrateLegacyRecipe({ id: 'legacy-draft', steps: contracts.map((step) => ({ id: step.id, adapter: step.preferredAdapter })) }, contracts);
  assert.equal(migrated.state, 'candidate');
  assert.deepEqual(migrated.steps.map((step) => step.preferredAdapter), recipe.steps.map((step) => step.preferredAdapter));
  assert.throws(() => migrateLegacyRecipe({ id: 'legacy-draft' }, []), (error) => error.code === 'missing-step-contracts');
  const changed = structuredClone(contracts);
  changed[0].preferredAdapter = 'playwright';
  assert.throws(() => migrateLegacyRecipe({ id: 'legacy-draft', steps: contracts.map((step) => ({ id: step.id, adapter: step.preferredAdapter })) }, changed), (error) => error.code === 'legacy-adapter-change');
});

test('the deterministic process fixture composes repair and returns to Agent Browser after fallback', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'browser-lanes-fixture-'));
  const statePath = join(temporaryRoot, 'state.json');
  const child = spawnSync(process.execPath, [fixtureScript, '--state', statePath, '--title', 'Fixture draft', '--recipe', recipePath], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    transport: 'deterministic-local-process', saveCount: 1, submitCount: 0, repairedRevision: 2,
    adapters: ['agent-browser', 'playwright', 'agent-browser', 'agent-browser'], promotionValid: false,
    rejectionCodes: ['insufficient-proof'],
  });
  const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(persisted.transport, 'deterministic-local-process');
  assert.equal(persisted.submitted, false);
  assert.deepEqual(persisted.events.map((event) => event.adapter).filter(Boolean), ['agent-browser', 'agent-browser', 'playwright', 'agent-browser', 'agent-browser']);
  assert.deepEqual(persisted.events.at(-1), { type: 'save', title: 'Fixture draft' });
  rmSync(temporaryRoot, { recursive: true, force: true });
});

test('a symlinked script that escapes the script root is rejected', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'browser-lanes-symlink-'));
  const outside = join(tmpdir(), `browser-lanes-outside-${Date.now()}.js`);
  try {
    mkdirSync(join(temporaryRoot, 'scripts'));
    writeFileSync(outside, 'export const outside = true;\n');
    symlinkSync(outside, join(temporaryRoot, 'scripts/escape.js'));
    const candidate = structuredClone(recipe);
    candidate.steps[2].script = { path: 'scripts/escape.js', sha256: 'e1b17d9a8d31436fdb0bcc7fe8372f4e14434cf37e59352907240bdbb6026b43' };
    const result = validateRecipe(candidate, { checkScripts: true, scriptRoot: temporaryRoot });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((entry) => entry.code === 'script-outside-root'));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test('the recipe CLI remains a read-only public validation seam', () => {
  const output = execFileSync(process.execPath, [join(pluginRoot, 'skills/bake-off/scripts/recipe-contract.mjs'), '--file', recipePath, '--script-root', pluginRoot], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.valid, true);
});
