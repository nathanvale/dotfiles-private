import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NON_ATTEMPT_OUTCOMES = /^(?:not started|skipped|historical|pending|setup)\b/;

export class ReportCloseoutError extends Error {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.name = 'ReportCloseoutError';
    this.code = code;
    this.path = path;
  }
}

function reportError(code, path, message) {
  return { code, path, message };
}

function section(markdown, title) {
  const heading = new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`, 'im');
  const match = heading.exec(markdown);
  if (!match) return '';
  const rest = markdown.slice(match.index + match[0].length);
  const next = /^##\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function parseAttempts(markdown) {
  const text = section(markdown, 'Attempts');
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*\|/.test(line) && /\bOutcome\b/i.test(line));
  if (headerIndex < 0 || !lines[headerIndex + 1] || !/^\s*\|?\s*:?-{3,}/.test(lines[headerIndex + 1])) return [];
  const headers = cells(lines[headerIndex]).map((header) => header.toLowerCase());
  const rows = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    if (!/^\s*\|/.test(lines[index])) continue;
    const values = cells(lines[index]);
    if (values.length === 0 || values.every((value) => !value || value === '-' || value === '—')) continue;
    const row = Object.fromEntries(headers.map((header, headerIndexValue) => [header, values[headerIndexValue] ?? '']));
    row.line = index + 1;
    rows.push(row);
  }
  return rows;
}

function normaliseOutcome(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[.!]/g, '').replace(/\s+/g, ' ');
}

function isActualRow(row) {
  const outcome = normaliseOutcome(row.outcome);
  const descriptor = `${row['adapter / attempt'] ?? ''} ${row.adapter ?? ''}`.toLowerCase();
  if (descriptor.includes('historical') || descriptor.includes('skipped')) return false;
  // Keep unknown outcome vocabulary as an actual row. A new failure status
  // must not silently turn a populated attempt into planning evidence.
  return outcome.length > 0 && !NON_ATTEMPT_OUTCOMES.test(outcome);
}

function linesWithValues(text) {
  return text.split(/\r?\n/).filter((line) => /^\s*[-*]\s+[^:]+:/i.test(line));
}

function hasStaleCheckpointClaim(line) {
  const label = line.replace(/^\s*[-*]\s*/, '').split(':', 1)[0].toLowerCase();
  if (/historical|setup evidence|optional/.test(line.toLowerCase())) return false;
  if (!/phase|consumed\/skipped allocation|active worker|next permitted action/.test(label)) return false;
  return /no\s+(?:scored\s+)?attempts?\s+yet/i.test(line)
    || /\bpending\b/i.test(line)
    || /\bsetup\s+(?:only|phase)\b/i.test(line);
}

function hasStaleDeliveryClaim(line) {
  const lower = line.toLowerCase();
  if (/runbook|historical|setup evidence|optional|candidate|acceptance|qualification gap|remaining gap/.test(lower)) return false;
  const label = line.replace(/^\s*[-*]\s*/, '').split(':', 1)[0].toLowerCase();
  if (!/final|operator|lane custody|application-state|adapter cleanup|recipe and script/.test(label)) return false;
  return /no\s+(?:scored\s+)?attempts?\s+yet/i.test(line)
    || /\bpending\b/i.test(line)
    || /\bsetup\s+(?:only|phase)\b/i.test(line);
}

function successClaim(value) {
  return /\b(?:success|successful|complete|confirmed|cleaned)\b/i.test(value);
}

function unknownClaim(value) {
  return /\b(?:unknown|unconfirmed|unresolved)\b/i.test(value);
}

export function parseReport(markdown) {
  const rows = parseAttempts(markdown);
  return {
    attempts: rows,
    actualAttempts: rows.filter(isActualRow),
    checkpoint: section(markdown, 'Coordinator checkpoint'),
    delivery: section(markdown, 'Delivery'),
    runbookComparison: section(markdown, 'Runbook comparison'),
  };
}

// Allocations are caps, not elapsed completion times. Fast successful attempts
// must never be mistaken for artificially compressed attempts.
export function validateBudget(budget) {
  const errors = [];
  const fail = (code, message) => errors.push(reportError(code, 'Budget', message));
  const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)
    || !['setup', 'dispatch', 'closeout', 'handoff'].includes(budget.phase)
    || !['setupSeconds', 'remainingSeconds', 'reserveSeconds'].every(key => number(budget[key]))
    || !Array.isArray(budget.attemptCapsSeconds) || !budget.attemptCapsSeconds.every(number)
    || (budget.priorProvenSeconds !== undefined && !number(budget.priorProvenSeconds))
    || (budget.userAttemptCapSeconds !== undefined && !number(budget.userAttemptCapSeconds))
    || (budget.userSetupCapSeconds !== undefined && !number(budget.userSetupCapSeconds))) {
    fail('invalid-budget', 'Supply phase, nonnegative setup/remaining/reserve seconds and attemptCapsSeconds.');
    return { valid: false, errors };
  }
  const override = budget.userAttemptCapSeconds !== undefined || budget.userSetupCapSeconds !== undefined;
  if (override && (typeof budget.userBudgetEvidence !== 'string' || !budget.userBudgetEvidence.trim())) {
    fail('missing-budget-authority', 'User budget overrides require a reference to the explicit instruction.');
  }
  const setupCap = budget.userSetupCapSeconds ?? 300;
  const minimum = budget.userAttemptCapSeconds ?? Math.max(300, budget.priorProvenSeconds ?? 0);
  if (budget.setupSeconds > setupCap) {
    fail('setup-budget-overrun', 'Setup exceeded its allowance; stop setup and reduce contenders or hand back the budget.');
  }
  if (budget.attemptCapsSeconds.some(cap => cap < minimum)) {
    fail('attempt-budget-compressed', `Attempt allocations must be at least ${minimum} seconds; reduce contenders or hand back, never compress every attempt.`);
  }
  if (budget.phase === 'dispatch' && budget.attemptCapsSeconds.reduce((a, b) => a + b, 0) + budget.reserveSeconds > budget.remainingSeconds) {
    fail('insufficient-run-budget', 'Allocations plus the closeout reserve exceed remaining time; reduce contenders or return a budget handoff.');
  }
  return { valid: errors.length === 0, errors, minimumAttemptSeconds: minimum };
}

function reportBudget(markdown) {
  const match = /```browser-lanes-budget\s*\n([\s\S]*?)\n```/.exec(markdown);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return false; }
}

export function validateReport(markdown, options = {}) {
  if (typeof markdown !== 'string' || markdown.trim().length === 0) {
    return { valid: false, errors: [reportError('invalid-report', '$', 'must be non-empty Markdown')] };
  }
  const parsed = parseReport(markdown);
  const errors = [];
  const budget = reportBudget(markdown);
  if (budget !== null) errors.push(...validateBudget(budget).errors);
  else if (options.requireBudget) errors.push(reportError('missing-budget', 'Budget', 'Add the browser-lanes-budget JSON record before dispatch or closeout.'));
  if (parsed.actualAttempts.length > 0) {
    for (const line of linesWithValues(parsed.checkpoint)) {
      if (hasStaleCheckpointClaim(line)) errors.push(reportError('stale-checkpoint', 'Coordinator checkpoint', 'current attempts cannot retain a no-attempts or setup claim'));
    }
    for (const line of linesWithValues(parsed.delivery)) {
      if (hasStaleDeliveryClaim(line)) errors.push(reportError('stale-delivery', 'Delivery', 'current attempts cannot retain a pending, no-attempts, or setup claim'));
    }

  }
  return {
    valid: errors.length === 0,
    errors,
    summary: {
      budgetEvidence: budget === null ? 'unverified-legacy' : 'recorded',
      attemptRows: parsed.attempts.length,
      actualAttemptRows: parsed.actualAttempts.length,
      fixtureOrLive: parsed.actualAttempts.length > 0 ? 'unspecified-by-markdown' : 'planning-or-no-scored-attempts',
    },
  };
}

export function assertReport(markdown) {
  const result = validateReport(markdown);
  if (!result.valid) {
    const first = result.errors[0];
    throw new ReportCloseoutError(first.code, first.path, first.message);
  }
  return result;
}

function runCli() {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf('--file');
  if (fileIndex < 0 || !args[fileIndex + 1]) {
    console.error('usage: report-closeout.mjs --file REPORT.md [--require-budget]');
    process.exitCode = 2;
    return;
  }
  try {
    const result = validateReport(readFileSync(args[fileIndex + 1], 'utf8'), { requireBudget: args.includes('--require-budget') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.valid ? 0 : 1;
  } catch (cause) {
    console.error(`report-closeout: ${cause.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
