#!/usr/bin/env node
// Internal executor for the public browser-lane Playwright plan contract.
// Own every CLI/daemon process group until retirement. Only the daemon receives
// the one-use endpoint. Caller function source goes exclusively to page eval.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { siteFromUrl } = require('./browser-lane-site');

const env = { ...process.env };
const endpoint = env.AGENT_BROWSER_CDP;
delete env.AGENT_BROWSER_CDP;
delete env.PLAYWRIGHT_MCP_CDP_ENDPOINT;
const cli = env.BROWSER_LANE_PLAYWRIGHT_CLI;
const daemonPath = env.BROWSER_LANE_PLAYWRIGHT_DAEMON;
const session = env.BROWSER_LANE_PLAYWRIGHT_SESSION;
const expectedHash = env.BROWSER_LANE_PAGE_URL_SHA256;
const ttl = Number(env.BROWSER_LANE_PLAYWRIGHT_TTL_SECONDS || 900);
const deadline = performance.now() + ttl * 1000;
const owned = new Set();
const abort = new AbortController();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fault = (status, code) => Object.assign(new Error(code), { status, code });
const siteHash = url => {
  const site = siteFromUrl(url);
  return site === null ? null : crypto.createHash('sha256').update(site).digest('hex');
};
const interrupted = fault(130, 'playwright_interrupted');
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => abort.abort(interrupted));
}

function groupAlive(pid) {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function signalGroup(pid, signal) {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}
function launch(command, args, childEnv = env) {
  const child = spawn(command, args, { env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { child, stdout: '', stderr: '', done: false, status: null, overflow: false };
  owned.add(run);
  run.closed = new Promise(resolve => {
    child.once('error', () => { run.status = 1; });
    child.once('close', code => { run.status = code ?? 1; run.done = true; resolve(); });
  });
  for (const stream of ['stdout', 'stderr']) {
    child[stream].setEncoding('utf8');
    child[stream].on('data', chunk => {
      if (run[stream].length + chunk.length > 16 * 1024 * 1024) run.overflow = true;
      else run[stream] += chunk;
    });
  }
  return run;
}
async function retire(run) {
  if (!run) return true;
  if (groupAlive(run.child.pid)) {
    signalGroup(run.child.pid, 'SIGTERM');
    const grace = performance.now() + 500;
    while (groupAlive(run.child.pid) && performance.now() < grace) await delay(20);
    if (groupAlive(run.child.pid)) signalGroup(run.child.pid, 'SIGKILL');
  }
  const end = performance.now() + 1000;
  while ((!run.done || groupAlive(run.child.pid)) && performance.now() < end) await delay(20);
  if (!run.done || groupAlive(run.child.pid)) return false;
  owned.delete(run);
  return true;
}
async function waitForCommandCompletion(run, cleanup, end) {
  while (!run.done) {
    if (!cleanup && abort.signal.aborted) throw abort.signal.reason;
    if (performance.now() >= end) throw fault(124, 'playwright_timeout');
    if (run.overflow) throw fault(1, 'playwright_response_too_large');
    await delay(20);
  }
}
function parseCommandResponse(run) {
  let response;
  try { response = JSON.parse(run.stdout); } catch { throw fault(1, 'playwright_response_invalid'); }
  if (!response || Array.isArray(response) || typeof response !== 'object' ||
      ('isError' in response && typeof response.isError !== 'boolean')) {
    throw fault(1, 'playwright_response_invalid');
  }
  return response;
}
async function command(args, cleanup = false) {
  const end = cleanup ? performance.now() + 3000 : deadline;
  if (!cleanup && abort.signal.aborted) throw abort.signal.reason;
  if (performance.now() >= end) throw fault(124, 'playwright_timeout');
  const run = launch(cli, [`-s=${session}`, '--json', ...args]);
  let response, failure;
  try {
    await waitForCommandCompletion(run, cleanup, end);
    if (run.status !== 0) throw fault(run.status, 'playwright_command_failed');
    response = parseCommandResponse(run);
  } catch (error) { failure = error; }
  // Include descendants, even when the command leader exited first.
  if (!await retire(run)) throw fault(17, 'playwright_process_retirement_unproved');
  if (failure) throw failure;
  return response;
}
async function assertPage() {
  // Fixed host code. No caller interpolation and no page globals or titles.
  const response = await command(['run-code', '(page) => ({selectedUrl: page.url(), pageUrls: page.context().pages().map(candidate => candidate.url())})']);
  let evidence;
  try { evidence = JSON.parse(response.result); } catch { throw fault(16, 'playwright_page_unreadable'); }
  if (response.isError || typeof evidence?.selectedUrl !== 'string' ||
      !Array.isArray(evidence.pageUrls) || evidence.pageUrls.some(url => typeof url !== 'string')) {
    throw fault(16, 'playwright_page_unreadable');
  }
  const hashes = evidence.pageUrls.map(siteHash);
  const matchCount = hashes.filter(hash => hash === expectedHash).length;
  const selectedHash = siteHash(evidence.selectedUrl);
  if (selectedHash === null) throw fault(16, 'playwright_page_unreadable');
  if (selectedHash === expectedHash) return;
  if (matchCount > 1) throw fault(16, 'playwright_page_ambiguous');
  if (matchCount === 0) {
    throw fault(16, 'playwright_page_changed');
  }
  throw fault(16, 'playwright_page_not_selected');
}
function render(response) {
  for (const [key, value] of Object.entries(response)) {
    if (key !== 'isError') process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  }
}
function diagnose(error) {
  const messages = {
    playwright_action_failed: 'Playwright reported an action error. Inspect its diagnostic and any partial page effects before retrying.',
    playwright_page_ambiguous: 'More than one admitted page matches the task site without a selected match. Select one task page before retrying.',
    playwright_page_changed: 'The admitted page left the task site at an action boundary. Inspect the intended page and any uncertain effects before retrying.',
    playwright_page_not_selected: 'The unique page on the task site is no longer the selected page. Select it before retrying.',
    playwright_page_unreadable: 'The admitted page became unreadable or ambiguous. Inspect the intended page before retrying.',
    playwright_timeout: 'The Playwright run reached its deadline. Inspect partial page effects before retrying.',
    playwright_interrupted: 'The Playwright run was interrupted. Inspect partial page effects before retrying.',
    playwright_lifecycle_unresolved: 'Playwright could not prove clean detach. Inspect the exact run-scoped session before retrying.'
  };
  const code = error.code || 'playwright_runner_failed';
  process.stderr.write(JSON.stringify({status: 'error', run_id: env.BROWSER_LANE_RUN_ID || 'unknown', error: {
    code, retry_safe: false, message: messages[code] || 'Playwright failed to complete its command safely.',
    next: ['playwright_page_ambiguous', 'playwright_page_changed', 'playwright_page_not_selected', 'playwright_page_unreadable', 'playwright_action_failed'].includes(code)
      ? "Observe the intended tab's current ordinary URL in the declared profile, then inspect that page and verify the action's effect. Do not replay an uncertain mutation or re-admit solely because navigation ended the old attachment. Honor Stop or revoked access."
      : 'Inspect the intended page and run-scoped session before retrying.'
  }}) + '\n');
}
async function waitForDaemonReady(daemon) {
  const readyEnd = Math.min(deadline, performance.now() + 10_000);
  while (!daemon.stdout.includes('Daemon listening on')) {
    if (abort.signal.aborted) throw abort.signal.reason;
    if (performance.now() >= deadline) throw fault(124, 'playwright_timeout');
    if (daemon.done || performance.now() >= readyEnd) throw fault(12, 'playwright_not_ready');
    await delay(20);
  }
}
async function runPlanActions(plan) {
  await assertPage();
  for (const action of plan.actions) {
    await assertPage();
    const args = action.command === 'evaluate' ? ['eval', `(${action.args[0]}\n)`] : [action.command, ...action.args];
    const response = await command(args);
    render(response);
    if (response.isError === true) throw fault(1, 'playwright_action_failed');
    await assertPage();
  }
}
async function detachDaemon(daemon) {
  try {
    const response = await command(['detach'], true);
    const end = performance.now() + 1000;
    while (!daemon.done && performance.now() < end) await delay(20);
    return response.status === 'detached' && daemon.done;
  } catch { return false; } // Retirement below remains mandatory after failed detach.
}
async function retireOwnedRuns() {
  let allRetired = true;
  for (const run of [...owned]) {
    if (!await retire(run)) allRetired = false;
  }
  return allRetired;
}
async function finalizeRun(daemon) {
  let cleanup = 'unconfirmed';
  if (daemon && await detachDaemon(daemon)) cleanup = 'confirmed';
  if (!await retireOwnedRuns()) cleanup = 'unconfirmed';
  return cleanup;
}
function reportActivityOutcome(failure, cleanup, status) {
  if (!env.BROWSER_LANE_ACTIVITY_OUTCOME) return;
  try {
    fs.writeFileSync(env.BROWSER_LANE_ACTIVITY_OUTCOME, JSON.stringify({
      actionOutcome: failure ? 'failed' : 'completed', cleanupOutcome: cleanup, exitCode: status
    }), {mode: 0o600});
  } catch { /* Activity publication is advisory. */ }
}
async function main() {
  let daemon, failure, cleanup = 'unconfirmed';
  try {
    const plan = JSON.parse(fs.readFileSync(env.BROWSER_LANE_PLAYWRIGHT_PLAN, 'utf8'));
    daemon = launch(env.BROWSER_LANE_PLAYWRIGHT_NODE, [daemonPath, session], { ...env, PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint });
    await waitForDaemonReady(daemon);
    await runPlanActions(plan);
  } catch (e) { failure = e; }
  finally {
    cleanup = await finalizeRun(daemon);
  }
  if (abort.signal.aborted) failure = abort.signal.reason;
  const status = failure?.status || (cleanup === 'confirmed' ? 0 : 17);
  reportActivityOutcome(failure, cleanup, status);
  if (failure) diagnose(failure);
  else if (cleanup !== 'confirmed') diagnose(fault(17, 'playwright_lifecycle_unresolved'));
  // All owned process groups were retired above. No browser.close() is used.
  process.exitCode = status;
}
main().catch(e => { diagnose(e); process.exitCode = 17; });
