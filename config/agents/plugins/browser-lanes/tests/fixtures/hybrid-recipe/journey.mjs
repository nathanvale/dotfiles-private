import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { recipeDigest, repairRecipe, verifyIndependentReceipt } from '../../../skills/bake-off/scripts/recipe-contract.mjs';

const transport = 'deterministic-local-process';
const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));

function runJourney({ statePath, title, recipe }) {
  if (typeof statePath !== 'string' || statePath.length === 0) throw new TypeError('statePath is required');
  if (typeof title !== 'string' || title.length === 0) throw new TypeError('title is required');
  if (!recipe || !Array.isArray(recipe.steps)) throw new TypeError('recipe is required');

  const repaired = repairRecipe(recipe, {
    stepId: 'enter-draft-title',
    fallbackAdapter: 'playwright',
    observation: { kind: 'verified-failure', stepId: 'enter-draft-title', effect: 'none', authority: 'verified', custody: 'verified', evidenceId: 'fixture-ab-control-no-effect' },
    fallbackEvidence: { kind: 'verified-success', stepId: 'enter-draft-title', adapter: 'playwright', passed: true, effect: 'control', authority: 'verified', custody: 'verified', evidenceId: 'fixture-pw-control-pass' },
  });
  const adapters = repaired.steps.map((step) => step.preferredAdapter);
  const state = {
    transport,
    title,
    events: [
      { type: 'step', id: 'observe-task-page', adapter: adapters[0], passed: true },
      { type: 'failed-step', id: 'enter-draft-title', adapter: 'agent-browser', effect: 'none' },
      { type: 'step', id: 'enter-draft-title', adapter: adapters[1], passed: true },
      { type: 'step', id: 'save-draft', adapter: adapters[2], passed: true },
      { type: 'step', id: 'read-back-draft', adapter: adapters[3], passed: true },
      { type: 'save', title },
    ],
    submitted: false,
  };
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

  const simulatedReceipt = {
    kind: 'independent-workflow-receipt', receiptId: 'fixture-receipt', recipeId: repaired.id, recipeRevision: repaired.revision,
    recipeSha256: recipeDigest(repaired),
    scriptHashes: repaired.steps.filter((step) => step.script).map((step) => step.script),
    orderedSteps: repaired.steps.map((step) => ({ id: step.id, adapter: step.preferredAdapter, successAssertion: step.successAssertion, passed: true })),
    unresolvedEffects: [],
    finalState: { status: 'saved', observed: true, passed: true, scope: ['local-fixture/draft'] },
    identity: { runId: 'fixture-run', discovery: 'fixture-discovery', author: 'fixture-acceptance' },
    proof: { source: transport, complete: true, provider: 'node-test' },
  };
  const promotion = verifyIndependentReceipt(repaired, simulatedReceipt, { scriptRoot: pluginRoot });
  return {
    transport, saveCount: 1, submitCount: 0, repairedRevision: repaired.revision, adapters,
    promotionValid: promotion.valid, rejectionCodes: promotion.errors.map((entry) => entry.code),
  };
}

function main() {
  const stateIndex = process.argv.indexOf('--state');
  const titleIndex = process.argv.indexOf('--title');
  const recipeIndex = process.argv.indexOf('--recipe');
  if (stateIndex < 0 || titleIndex < 0 || recipeIndex < 0) {
    console.error('usage: journey.mjs --state PATH --title TITLE --recipe RECIPE.json');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(runJourney({
      statePath: process.argv[stateIndex + 1],
      title: process.argv[titleIndex + 1],
      recipe: JSON.parse(readFileSync(process.argv[recipeIndex + 1], 'utf8')),
    }))}\n`);
  } catch (cause) {
    console.error(`journey: ${cause.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('/journey.mjs')) main();
