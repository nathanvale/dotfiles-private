import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBakeOffCli } from './cli-runner.mjs';

const SCHEMA_VERSION = 2;
const ADAPTERS = Object.freeze([
  'agent-browser',
  'chrome-devtools',
  'playwright',
  'puppeteer',
]);
const EFFECTS = Object.freeze([
  'read',
  'control',
  'Insert',
  'Save',
  'Delete',
  'Submit',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]*$/;

class RecipeContractError extends Error {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.name = 'RecipeContractError';
    this.code = code;
    this.path = path;
  }
}

function error(code, path, message) {
  return { code, path, message };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateSha(value, path, errors) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    errors.push(error('invalid-sha256', path, 'must be a lowercase 64-character SHA-256 digest'));
  }
}

function validateRelativePath(value, path, errors) {
  if (!nonEmptyString(value) || isAbsolute(value) || value.startsWith('~')) {
    errors.push(error('invalid-script-path', path, 'must be a non-empty relative path'));
    return;
  }
  const parts = value.split(/[\\/]+/);
  if (parts.includes('..') || parts.includes('')) {
    errors.push(error('invalid-script-path', path, 'must not escape its recipe root'));
  }
}

function validateScriptLink(link, path, errors) {
  if (!isRecord(link)) {
    errors.push(error('invalid-script', path, 'must be an object with path and sha256'));
    return;
  }
  validateRelativePath(link.path, `${path}.path`, errors);
  validateSha(link.sha256, `${path}.sha256`, errors);
}

function validateStepIdentity(step, path, stepIds, errors) {
  if (!nonEmptyString(step.id) || !ID.test(step.id)) {
    errors.push(error('invalid-step-id', `${path}.id`, 'must be a stable lowercase identifier'));
  } else if (stepIds.has(step.id)) {
    errors.push(error('duplicate-step-id', `${path}.id`, 'must be unique and ordered'));
  } else {
    stepIds.add(step.id);
  }
}

function validateStepAdapters(step, path, errors) {
  if (!ADAPTERS.includes(step.preferredAdapter)) {
    errors.push(error('invalid-adapter', `${path}.preferredAdapter`, 'must name a supported adapter'));
  }
  if (!Array.isArray(step.fallbackAdapters)) {
    errors.push(error('invalid-fallbacks', `${path}.fallbackAdapters`, 'must be an ordered array'));
    return;
  }
  const fallbackIds = new Set();
  for (const [fallbackIndex, adapter] of step.fallbackAdapters.entries()) {
    const fallbackPath = `${path}.fallbackAdapters[${fallbackIndex}]`;
    if (!ADAPTERS.includes(adapter)) errors.push(error('invalid-adapter', fallbackPath, 'must name a supported adapter'));
    if (fallbackIds.has(adapter)) errors.push(error('duplicate-fallback', fallbackPath, 'fallback adapters must be unique and ordered'));
    fallbackIds.add(adapter);
    if (adapter === step.preferredAdapter) errors.push(error('preferred-as-fallback', fallbackPath, 'must differ from preferredAdapter'));
  }
}

function validateStepAuthority(step, path, errors) {
  if (!isRecord(step.authority)) {
    errors.push(error('invalid-authority', `${path}.authority`, 'must include effect and scope'));
    return;
  }
  if (!EFFECTS.includes(step.authority.effect)) errors.push(error('unknown-effect', `${path}.authority.effect`, 'must be read, control, Insert, Save, Delete, or Submit'));
  if (!nonEmptyString(step.authority.scope)) errors.push(error('missing-authority-scope', `${path}.authority.scope`, 'must describe the bounded effect scope'));
}

function validateStepUncertainty(step, path, errors) {
  if (!isRecord(step.uncertainty)) {
    errors.push(error('invalid-uncertainty', `${path}.uncertainty`, 'must require observation before replay and refuse unknown effects'));
    return;
  }
  if (step.uncertainty.observeBeforeReplay !== true) errors.push(error('unsafe-uncertainty-policy', `${path}.uncertainty.observeBeforeReplay`, 'must be true'));
  if (step.uncertainty.noReplayIfUnknown !== true) errors.push(error('unsafe-uncertainty-policy', `${path}.uncertainty.noReplayIfUnknown`, 'must be true'));
}

function validateRecipeStep(step, index, stepIds, errors) {
  const path = `steps[${index}]`;
  if (!isRecord(step)) {
    errors.push(error('invalid-step', path, 'must be an object'));
    return;
  }
  validateStepIdentity(step, path, stepIds, errors);
  if (!nonEmptyString(step.intent)) errors.push(error('missing-intent', `${path}.intent`, 'must be a non-empty string'));
  validateStepAdapters(step, path, errors);
  if (!nonEmptyString(step.successAssertion)) errors.push(error('missing-success-assertion', `${path}.successAssertion`, 'must be a non-empty observable assertion'));
  validateStepAuthority(step, path, errors);
  validateStepUncertainty(step, path, errors);
  if (step.script !== undefined) validateScriptLink(step.script, `${path}.script`, errors);
}

function validateRecipeSteps(steps, errors) {
  const stepIds = new Set();
  for (const [index, step] of steps.entries()) validateRecipeStep(step, index, stepIds, errors);
}

function validateRecipeShape(recipe, errors) {
  if (recipe.schemaVersion !== SCHEMA_VERSION) {
    errors.push(error('unsupported-schema', 'schemaVersion', `must be ${SCHEMA_VERSION}`));
  }
  if (!nonEmptyString(recipe.id) || !ID.test(recipe.id)) {
    errors.push(error('invalid-id', 'id', 'must be a stable lowercase identifier'));
  }
  if (!Number.isInteger(recipe.revision) || recipe.revision < 1) {
    errors.push(error('invalid-revision', 'revision', 'must be a positive integer'));
  }
  if (!['candidate', 'independently-verified'].includes(recipe.state)) {
    errors.push(error('invalid-state', 'state', 'must be candidate or independently-verified'));
  }
  if (!ADAPTERS.includes(recipe.defaultAdapter)) {
    errors.push(error('invalid-adapter', 'defaultAdapter', 'must name a supported adapter'));
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    errors.push(error('missing-steps', 'steps', 'must contain at least one ordered step'));
  }
}

function expectedScopes(recipe) {
  return Array.isArray(recipe?.steps)
    ? [...new Set(recipe.steps.filter((step) => isRecord(step) && isRecord(step.authority) && nonEmptyString(step.authority.scope)).map((step) => step.authority.scope))]
    : [];
}

function scriptLinks(recipe) {
  const links = [];
  const seen = new Map();
  for (const step of (Array.isArray(recipe?.steps) ? recipe.steps : [])) {
    if (!isRecord(step)) continue;
    if (!step.script) continue;
    const prior = seen.get(step.script.path);
    if (prior && prior.sha256 !== step.script.sha256) {
      return {
        links: [],
        errors: [error('conflicting-script-hash', 'steps', `script ${step.script.path} has conflicting digests`)],
      };
    }
    if (!prior) {
      const link = { path: step.script.path, sha256: step.script.sha256 };
      seen.set(link.path, link);
      links.push(link);
    }
  }
  return { links, errors: [] };
}

function actualScriptLinks(recipe, scriptRoot) {
  const declared = scriptLinks(recipe);
  const errors = [...declared.errors];
  const actual = [];
  if (!scriptRoot) {
    return { actual, errors: [error('script-root-required', 'scripts', 'scriptRoot is required to inspect linked scripts'), ...errors] };
  }
  const root = resolve(scriptRoot);
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch (cause) {
    return { actual, errors: [error('script-root-unreadable', 'scripts', cause.message), ...errors] };
  }
  for (const link of declared.links) {
    const file = resolve(root, link.path);
    const withinRoot = relative(root, file) && !relative(root, file).startsWith('..') && !isAbsolute(relative(root, file));
    if (!withinRoot) {
      errors.push(error('invalid-script-path', `scripts.${link.path}`, 'resolves outside scriptRoot'));
      continue;
    }
    try {
      const realFile = realpathSync(file);
      const realRelative = relative(realRoot, realFile);
      const withinRealRoot = realRelative && !realRelative.startsWith('..') && !isAbsolute(realRelative);
      if (!withinRealRoot) {
        errors.push(error('script-outside-root', `scripts.${link.path}`, 'resolves outside scriptRoot through a symlink'));
        continue;
      }
      const sha256 = createHash('sha256').update(readFileSync(realFile)).digest('hex');
      actual.push({ path: link.path, sha256 });
      if (sha256 !== link.sha256) {
        errors.push(error('script-hash-mismatch', `scripts.${link.path}`, 'does not match the recipe digest'));
      }
    } catch (cause) {
      errors.push(error('script-unreadable', `scripts.${link.path}`, cause.message));
    }
  }
  return { actual, errors };
}

function validateAcceptance(recipe, path, errors) {
  const acceptance = recipe.acceptance;
  if (!isRecord(acceptance)) {
    errors.push(error('verified-without-acceptance', path, 'independently-verified recipes require an acceptance record'));
    return;
  }
  validateSha(acceptance.candidateRecipeSha256, `${path}.candidateRecipeSha256`, errors);
  if (!Number.isInteger(acceptance.candidateRevision) || acceptance.candidateRevision < 1) {
    errors.push(error('invalid-revision', `${path}.candidateRevision`, 'must be a positive integer'));
  }
  if (!nonEmptyString(acceptance.receiptId)) {
    errors.push(error('missing-receipt-id', `${path}.receiptId`, 'must identify the independent receipt'));
  }
  if (!nonEmptyString(acceptance.discoveryIdentity) || !nonEmptyString(acceptance.authorIdentity)) {
    errors.push(error('missing-independent-identities', path, 'must include discoveryIdentity and authorIdentity'));
  } else if (acceptance.discoveryIdentity === acceptance.authorIdentity) {
    errors.push(error('same-independent-identity', path, 'discovery and author identities must differ'));
  }
  if (acceptance.evidenceTrust !== 'recorded-not-authenticated') {
    errors.push(error('invalid-evidence-trust', `${path}.evidenceTrust`, 'must state recorded-not-authenticated'));
  }
  if (!Array.isArray(acceptance.candidateScriptHashes)) {
    errors.push(error('invalid-script-hashes', `${path}.candidateScriptHashes`, 'must be an array'));
  } else {
    acceptance.candidateScriptHashes.forEach((link, index) => {
      validateScriptLink(link, `${path}.candidateScriptHashes[${index}]`, errors);
    });
  }

  validateAcceptanceBinding(recipe, acceptance, path, errors);
}

function validateAcceptanceBinding(recipe, acceptance, path, errors) {
  const candidate = { ...recipe, state: 'candidate' };
  delete candidate.acceptance;
  if (typeof acceptance.candidateRecipeSha256 === 'string' && SHA256.test(acceptance.candidateRecipeSha256)) {
    const expected = recipeDigest(candidate);
    if (expected !== acceptance.candidateRecipeSha256) {
      errors.push(error('stale-acceptance', `${path}.candidateRecipeSha256`, 'does not bind the current recipe content'));
    }
  }
  if (Number.isInteger(acceptance.candidateRevision) && acceptance.candidateRevision !== recipe.revision) {
    errors.push(error('stale-acceptance', `${path}.candidateRevision`, 'does not bind the current recipe revision'));
  }
}

function validateRecipeScripts(recipe, options, errors) {
  if (options.checkScripts && errors.length === 0) {
    const checked = actualScriptLinks(recipe, options.scriptRoot);
    errors.push(...checked.errors);
    if (recipe.state === 'independently-verified' && isRecord(recipe.acceptance) && Array.isArray(recipe.acceptance.candidateScriptHashes)) {
      const expected = scriptLinks(recipe).links;
      if (JSON.stringify(recipe.acceptance.candidateScriptHashes) !== JSON.stringify(expected)) {
        errors.push(error('stale-acceptance', 'acceptance.candidateScriptHashes', 'does not bind the current linked script paths and hashes'));
      }
    }
  }
}

export function validateRecipe(recipe, options = {}) {
  const errors = [];
  if (!isRecord(recipe)) {
    return { valid: false, errors: [error('invalid-recipe', '$', 'must be an object')] };
  }
  validateRecipeShape(recipe, errors);
  if (Array.isArray(recipe.steps)) validateRecipeSteps(recipe.steps, errors);

  if (recipe.state === 'independently-verified') validateAcceptance(recipe, 'acceptance', errors);
  validateRecipeScripts(recipe, options, errors);
  return { valid: errors.length === 0, errors };
}

function assertRecipe(recipe, options = {}) {
  const result = validateRecipe(recipe, options);
  if (!result.valid) {
    const first = result.errors[0];
    throw new RecipeContractError(first.code, first.path, first.message);
  }
  return recipe;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

export function recipeDigest(recipe) {
  return createHash('sha256').update(JSON.stringify(canonicalize(recipe))).digest('hex');
}

function receiptError(code, path, message) {
  return error(code, `receipt.${path}`, message);
}

function validateReceiptIdentity(recipe, receipt, errors) {
  if (receipt.kind !== 'independent-workflow-receipt') errors.push(receiptError('invalid-receipt-kind', 'kind', 'must identify an independent workflow receipt'));
  if (receipt.recipeId !== recipe.id) errors.push(receiptError('recipe-id-mismatch', 'recipeId', 'must match the candidate'));
  if (receipt.recipeRevision !== recipe.revision) errors.push(receiptError('revision-mismatch', 'recipeRevision', 'must match the candidate'));
  const candidateHash = recipeDigest(recipe);
  if (receipt.recipeSha256 !== candidateHash) errors.push(receiptError('recipe-hash-mismatch', 'recipeSha256', 'must bind the complete candidate content'));
  return candidateHash;
}

function validateReceiptScripts(recipe, receipt, options, errors) {
  const declaredScripts = scriptLinks(recipe);
  errors.push(...declaredScripts.errors);
  if (!Array.isArray(receipt.scriptHashes)) {
    errors.push(receiptError('missing-script-hashes', 'scriptHashes', 'must cover every linked script'));
  } else if (JSON.stringify(receipt.scriptHashes) !== JSON.stringify(declaredScripts.links)) {
    errors.push(receiptError('script-hashes-mismatch', 'scriptHashes', 'must match ordered recipe script links'));
  }
  if (declaredScripts.links.length > 0) {
    if (!options.scriptRoot) errors.push(receiptError('script-root-required', 'scriptHashes', 'scriptRoot is required to verify linked script bytes'));
    else errors.push(...actualScriptLinks(recipe, options.scriptRoot).errors);
  }
  return declaredScripts;
}

function validateReceiptStep(step, observed, index, errors) {
  if (!isRecord(observed)
    || observed.id !== step.id
    || observed.adapter !== step.preferredAdapter
    || observed.successAssertion !== step.successAssertion
    || observed.passed !== true) {
    errors.push(receiptError('step-coverage-mismatch', `orderedSteps[${index}]`, 'must preserve ordered IDs, executed adapters, passed assertions, and successful assertions'));
  }
}

function validateReceiptStepCoverage(recipe, receipt, errors) {
  const orderedSteps = Array.isArray(receipt.orderedSteps) ? receipt.orderedSteps : [];
  if (orderedSteps.length !== (recipe.steps?.length ?? 0)) {
    errors.push(receiptError('incomplete-step-coverage', 'orderedSteps', 'must include each recipe step exactly once in order'));
    return;
  }
  for (const [index, step] of recipe.steps.entries()) validateReceiptStep(step, orderedSteps[index], index, errors);
}

function validateReceiptFinalState(recipe, receipt, errors) {
  if (!isRecord(receipt.finalState) || !nonEmptyString(receipt.finalState.status) || receipt.finalState.observed !== true || receipt.finalState.passed !== true) {
    errors.push(receiptError('missing-final-state', 'finalState', 'must include an observed passing final status'));
  }
  const scopes = receipt.finalState?.scope;
  if (!Array.isArray(scopes) || JSON.stringify(scopes) !== JSON.stringify(expectedScopes(recipe))) {
    errors.push(receiptError('scope-mismatch', 'finalState.scope', 'must cover the recipe authority scopes in order'));
  }
}

function validateReceiptIdentityProof(receipt, errors) {
  if (!isRecord(receipt.identity) || !nonEmptyString(receipt.identity.runId) || !nonEmptyString(receipt.identity.discovery) || !nonEmptyString(receipt.identity.author)) {
    errors.push(receiptError('missing-independent-identities', 'identity', 'must include runId, discovery, and author'));
  } else if (receipt.identity.discovery === receipt.identity.author) {
    errors.push(receiptError('same-independent-identity', 'identity', 'discovery and author must differ'));
  }
  if (!isRecord(receipt.proof) || receipt.proof.source !== 'real-browser' || receipt.proof.complete !== true || !nonEmptyString(receipt.proof.provider)) {
    errors.push(receiptError('insufficient-proof', 'proof', 'must describe a complete real-browser workflow; fixtures and mocks cannot promote'));
  }
  if (!nonEmptyString(receipt.receiptId)) {
    errors.push(receiptError('missing-receipt-id', 'receiptId', 'must identify the independent receipt'));
  }
}

export function verifyIndependentReceipt(recipe, receipt, options = {}) {
  const recipeResult = validateRecipe(recipe);
  const errors = [...recipeResult.errors];
  if (!recipeResult.valid) return { valid: false, errors, recordedEvidence: false };
  if (recipe.state !== 'candidate') errors.push(error('not-candidate', 'state', 'only a candidate can be promoted'));
  if (!isRecord(receipt)) {
    errors.push(receiptError('invalid-receipt', '$', 'must be an independent workflow receipt'));
    return { valid: false, errors };
  }
  const candidateHash = validateReceiptIdentity(recipe, receipt, errors);
  const declaredScripts = validateReceiptScripts(recipe, receipt, options, errors);
  validateReceiptStepCoverage(recipe, receipt, errors);

  if (!Array.isArray(receipt.unresolvedEffects) || receipt.unresolvedEffects.length !== 0) {
    errors.push(receiptError('unresolved-effects', 'unresolvedEffects', 'must be an empty array before promotion'));
  }
  validateReceiptFinalState(recipe, receipt, errors);
  validateReceiptIdentityProof(receipt, errors);

  if (errors.length > 0) return { valid: false, errors, recordedEvidence: false };
  const accepted = structuredClone(recipe);
  accepted.state = 'independently-verified';
  accepted.acceptance = {
    candidateRecipeSha256: candidateHash,
    candidateRevision: recipe.revision,
    candidateScriptHashes: declaredScripts.links,
    receiptId: receipt.receiptId,
    discoveryIdentity: receipt.identity.discovery,
    authorIdentity: receipt.identity.author,
    evidenceTrust: 'recorded-not-authenticated',
  };
  return {
    valid: true,
    recordedEvidence: true,
    evidenceTrust: 'recorded-not-authenticated',
    candidateRecipeSha256: candidateHash,
    scriptHashes: declaredScripts.links,
    recipe: accepted,
    promotedRecipeSha256: recipeDigest(accepted),
  };
}

export const acceptRecipe = verifyIndependentReceipt;

export function migrateLegacyRecipe(legacy, stepContracts, options = {}) {
  if (!isRecord(legacy)) throw new RecipeContractError('invalid-legacy', 'legacy', 'must be a legacy recipe record');
  if (!Array.isArray(stepContracts) || stepContracts.length === 0) {
    throw new RecipeContractError('missing-step-contracts', 'stepContracts', 'explicit complete step contracts are required for migration');
  }
  if (!Array.isArray(legacy.steps) || legacy.steps.length !== stepContracts.length) {
    throw new RecipeContractError('missing-legacy-steps', 'legacy.steps', 'a complete legacy step list is required to retain adapter choices');
  }
  legacy.steps.forEach((legacyStep, index) => {
    const legacyAdapter = legacyStep?.preferredAdapter ?? legacyStep?.adapter;
    if (!isRecord(legacyStep) || !ADAPTERS.includes(legacyAdapter)) {
      throw new RecipeContractError('invalid-legacy-adapter', `legacy.steps[${index}]`, 'must name the recorded adapter choice');
    }
    if (legacyStep.id !== stepContracts[index]?.id || legacyAdapter !== stepContracts[index]?.preferredAdapter) {
      throw new RecipeContractError('legacy-adapter-change', `stepContracts[${index}]`, 'must retain the legacy step ID and adapter choice');
    }
  });
  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    id: options.id ?? legacy.id,
    revision: 1,
    state: 'candidate',
    defaultAdapter: options.defaultAdapter ?? 'agent-browser',
    steps: structuredClone(stepContracts),
  };
  assertRecipe(candidate);
  return candidate;
}

function validateRepairObservation(observation, stepId) {
  if (!isRecord(observation) || observation.stepId !== undefined && observation.stepId !== stepId) {
    throw new RecipeContractError('invalid-observation', 'request.observation', 'must identify verified evidence for the exact failed step');
  }
  if (observation.kind !== 'verified-failure') {
    throw new RecipeContractError('unverified-failure', 'request.observation.kind', 'repair requires a verified failure observation');
  }
  if (observation.effect === 'unknown') {
    throw new RecipeContractError('uncertain-effect', 'request.observation.effect', 'unknown effect is an inspect-and-stop condition, not a fallback opportunity');
  }
  if (observation.authority !== 'verified') {
    throw new RecipeContractError('authority-failure', 'request.observation.authority', 'authority failure stops repair');
  }
  if (observation.custody !== 'verified') {
    throw new RecipeContractError('custody-failure', 'request.observation.custody', 'custody failure stops repair');
  }
  if (observation.effect !== 'none') {
    throw new RecipeContractError('effect-not-failed', 'request.observation.effect', 'repair requires an observed no-effect failure');
  }
  if (!nonEmptyString(observation.evidenceId)) {
    throw new RecipeContractError('missing-observation-evidence', 'request.observation.evidenceId', 'must point to recorded observation evidence');
  }
}

function validateRepairFallbackAdapter(step, fallbackAdapter) {
  if (!step.fallbackAdapters.includes(fallbackAdapter)) {
    throw new RecipeContractError('fallback-not-allowed', 'request.fallbackAdapter', 'must be one of the step ordered fallbackAdapters');
  }
  if (fallbackAdapter === step.preferredAdapter) {
    throw new RecipeContractError('same-adapter', 'request.fallbackAdapter', 'must change the step adapter choice');
  }
}

function validateRepairFallbackEvidence(step, stepId, fallbackAdapter, fallbackEvidence) {
  if (!isRecord(fallbackEvidence)
    || fallbackEvidence.kind !== 'verified-success'
    || fallbackEvidence.stepId !== stepId
    || fallbackEvidence.adapter !== fallbackAdapter
    || fallbackEvidence.passed !== true
    || fallbackEvidence.effect === 'unknown'
    || fallbackEvidence.effect !== step.authority.effect
    || fallbackEvidence.authority !== 'verified'
    || fallbackEvidence.custody !== 'verified'
    || !nonEmptyString(fallbackEvidence.evidenceId)) {
    throw new RecipeContractError('missing-fallback-evidence', 'request.fallbackEvidence', 'must prove the exact fallback adapter passed for the exact step');
  }
}

export function repairRecipe(recipe, request) {
  assertRecipe(recipe);
  if (!isRecord(request)) throw new RecipeContractError('invalid-repair-request', 'request', 'must include stepId, observation, and fallbackAdapter');
  const index = recipe.steps.findIndex((step) => step.id === request.stepId);
  if (index < 0) throw new RecipeContractError('unknown-step', 'request.stepId', 'must identify an exact recipe step');
  const observation = request.observation;
  validateRepairObservation(observation, request.stepId);
  const step = recipe.steps[index];
  validateRepairFallbackAdapter(step, request.fallbackAdapter);
  const fallbackEvidence = request.fallbackEvidence;
  validateRepairFallbackEvidence(step, request.stepId, request.fallbackAdapter, fallbackEvidence);
  const repaired = structuredClone(recipe);
  repaired.revision += 1;
  repaired.state = 'candidate';
  delete repaired.acceptance;
  repaired.steps[index] = {
    ...repaired.steps[index],
    preferredAdapter: request.fallbackAdapter,
    fallbackAdapters: repaired.steps[index].fallbackAdapters.filter((adapter) => adapter !== request.fallbackAdapter),
    repairEvidence: {
      failed: structuredClone(observation),
      fallback: structuredClone(fallbackEvidence),
    },
  };
  assertRecipe(repaired);
  return repaired;
}

function recipeCliResult(args, fileIndex) {
  const recipe = JSON.parse(readFileSync(args[fileIndex + 1], 'utf8'));
  const rootIndex = args.indexOf('--script-root');
  return validateRecipe(recipe, rootIndex >= 0 ? { checkScripts: true, scriptRoot: args[rootIndex + 1] } : {});
}

function runCli() {
  runBakeOffCli(process.argv.slice(2), {
    usage: 'usage: recipe-contract.mjs --file RECIPE.json [--script-root DIR]',
    prefix: 'recipe-contract',
    execute: recipeCliResult,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
