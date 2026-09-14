#!/usr/bin/env node
// Lane-owned Puppeteer executor for `browser-lane puppeteer`.
//
// This process runs only inside MCPorter's one-use `chrome-relay exec` handoff,
// launched by `browser-lane __puppeteer-child`. Its whole interface is the
// environment the router hands it:
//
//   AGENT_BROWSER_CDP                  one-use loopback CDP endpoint (from MCPorter)
//   BROWSER_LANE_PUPPETEER_PLAN        private mode-600 plan snapshot path
//   BROWSER_LANE_PAGE_URL_SHA256       digest of the admitted page site
//   BROWSER_LANE_PUPPETEER_TTL_SECONDS lease TTL; bounds the whole run
//   BROWSER_LANE_RUN_ID                run correlation for stderr envelopes
//
// It connects, binds one unique page whose URL digest matches, rechecks that
// binding before every action while leaving unrelated pages untouched, runs
// the allowlisted in-page actions in order
// through fixed Puppeteer API calls, prints one JSON line per action on stdout,
// and always disconnects. It never calls browser.close(), never navigates,
// never opens pages. Schema-2 evaluate executes trusted task code in the page;
// it is not a hostile-code sandbox and cannot undo script effects.
//
// Time budget: connect, page discovery, and each action are bounded by the
// smaller of their own cap and the time left on the lease TTL, and no step
// starts once the TTL has passed. Only the disconnect cleanup may run past the
// TTL, under its own bound. The process always exits explicitly so a held
// socket cannot keep Node or the relay broker alive.
//
// Diagnostics are fixed strings plus the action index, command name, and
// engine error class. Selectors, typed text, URLs, endpoints, and page content
// never reach stderr.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { siteFromUrl } = require('./browser-lane-site');

const PROGRAM = 'browser-lane';
const EXIT_USAGE = 2;
const EXIT_RELAY_UNAVAILABLE = 12;
const EXIT_INVALID_REGISTRY = 14;
const EXIT_PAGE_UNRESOLVED = 16;
const EXIT_LIFECYCLE_UNRESOLVED = 17;
const EXIT_ACTION_FAILED = 18;
const EXIT_INTERRUPTED = 130;

const CONNECT_TIMEOUT_MS = 15_000;
const PAGES_TIMEOUT_MS = 5_000;
const ACTION_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_SECONDS = 900;

const siteHash = (url) => {
	const site = siteFromUrl(url);
	return site === null ? null : sha256(site);
};

// Exact arity per command. The router validates the same table before the
// lease; this copy is the executor's own guard on the bytes it actually runs.
const ARITY = {
	title: [0, 0],
	snapshot: [0, 0],
	text: [1, 1],
	click: [1, 1],
	hover: [1, 1],
	type: [2, 2],
	press: [1, 1],
	select: [2, 10],
	wait: [1, 1],
	evaluate: [1, 1],
};

// Each action maps to a page API. Caller code reaches only page.evaluate,
// never host eval or a caller-supplied module.
const ACTIONS = {
	evaluate: (page, [source]) => page.evaluate(`(${source}\n)()`),
	title: (page) => page.title(),
	snapshot: (page) => page.accessibility.snapshot(),
	text: async (page, [selector]) => {
		const handle = await page.$(selector);
		if (!handle) {
			throw new Error('no element matches the selector');
		}
		try {
			return await handle.evaluate((element) => element.textContent ?? '');
		} finally {
			await handle.dispose();
		}
	},
	click: async (page, [selector]) => {
		await page.click(selector);
		return null;
	},
	hover: async (page, [selector]) => {
		await page.hover(selector);
		return null;
	},
	type: async (page, [selector, text]) => {
		await page.type(selector, text);
		return null;
	},
	press: async (page, [key]) => {
		await page.keyboard.press(key);
		return null;
	},
	select: (page, [selector, ...values]) => page.select(selector, ...values),
	wait: async (page, [selector]) => {
		const handle = await page.waitForSelector(selector);
		if (handle) {
			await handle.dispose();
		}
		return true;
	},
};

class LaneFailure extends Error {
	constructor(exitCode, code, message, next, retrySafe = false) {
		super(message);
		this.exitCode = exitCode;
		this.code = code;
		this.next = next;
		this.retrySafe = retrySafe;
	}
}

class StepTimeout extends Error {}

const state = {
	runId: process.env.BROWSER_LANE_RUN_ID || 'unknown',
	browser: null,
	deadline: Number.POSITIVE_INFINITY,
	interrupted: false,
};

function writeOut(line) {
	fs.writeSync(1, `${line}\n`);
}

function writeErr(line) {
	fs.writeSync(2, `${line}\n`);
}

function report(failure) {
	writeErr(`${PROGRAM}: ${failure.message}`);
	writeErr(
		JSON.stringify({
			status: 'error',
			run_id: state.runId,
			error: {
				code: failure.code,
				retry_safe: failure.retrySafe,
				message: failure.message,
				next: failure.next,
			},
		}),
	);
}

// Only these Puppeteer and JavaScript error class names may appear in a
// diagnostic; any other name collapses to Error, and the message body is
// never repeated.
const ADMITTED_ERROR_CLASSES = new Set([
	'Error',
	'TypeError',
	'TimeoutError',
	'ProtocolError',
	'TargetCloseError',
	'UnsupportedOperation',
]);

function errorClass(error) {
	const name = error?.name;
	return typeof name === 'string' && ADMITTED_ERROR_CLASSES.has(name) ? name : 'Error';
}

function sha256(text) {
	return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function remainingMs() {
	return state.deadline - Date.now();
}

// A work step gets the smaller of its own cap and the time left on the lease.
function stepBudget(cap) {
	return Math.max(0, Math.min(cap, remainingMs()));
}

function assertRunActive(phase) {
	if (remainingMs() <= 0) {
		throw new LaneFailure(
			EXIT_ACTION_FAILED,
			'puppeteer_run_expired',
			`the lease TTL expired before ${phase}`,
			'Shorten the plan or raise --ttl, then retry with a fresh admission.',
		);
	}
}

function withTimeout(promise, ms) {
	let timer;
	const expiry = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new StepTimeout()), Math.max(0, ms));
	});
	return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function readContract() {
	const endpoint = process.env.AGENT_BROWSER_CDP || '';
	const planPath = process.env.BROWSER_LANE_PUPPETEER_PLAN || '';
	const expectedHash = process.env.BROWSER_LANE_PAGE_URL_SHA256 || '';
	const ttlText = process.env.BROWSER_LANE_PUPPETEER_TTL_SECONDS;
	// The endpoint is read once and removed so nothing spawned from here on
	// can inherit it.
	delete process.env.AGENT_BROWSER_CDP;
	const ttlValid = ttlText === undefined || /^[1-9][0-9]*$/.test(ttlText);
	if (!endpoint || !planPath || !/^[0-9a-f]{64}$/.test(expectedHash) || !ttlValid) {
		throw new LaneFailure(
			EXIT_INVALID_REGISTRY,
			'puppeteer_child_contract_invalid',
			'the internal Puppeteer handoff is incomplete',
			'Retry through the public browser-lane puppeteer command.',
		);
	}
	const ttlSeconds = ttlText === undefined ? DEFAULT_TTL_SECONDS : Number(ttlText);
	state.deadline = Date.now() + ttlSeconds * 1000;
	return { endpoint, planPath, expectedHash };
}

function planInvalid() {
	return new LaneFailure(
		EXIT_USAGE,
		'puppeteer_plan_invalid',
		'the Puppeteer plan failed its schema or action allowlist',
		'Use schema_version 1 for fixed actions or 2 for evaluate with one function source; keep 1 through 50 actions and private mode-600 input.',
	);
}

function isPlanShape(plan) {
	return Boolean(
		plan &&
		typeof plan === 'object' &&
		!Array.isArray(plan) &&
		[1, 2].includes(plan.schema_version) &&
		Array.isArray(plan.actions) &&
		plan.actions.length >= 1 &&
		plan.actions.length <= 50,
	);
}

function isActionShape(action) {
	if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
	const keys = Object.keys(action).sort();
	return keys.length === 2 && keys[0] === 'args' && keys[1] === 'command';
}

function isEvaluateSource(source, schemaVersion) {
	return (
		schemaVersion === 2 &&
		typeof source === 'string' &&
		source.length >= 1 &&
		source.length <= 65536 &&
		!source.includes('\0')
	);
}

function isSafeActionArgument(arg) {
	return typeof arg === 'string' && arg.length <= 4096 && !/[\r\n]/.test(arg) && !arg.startsWith('-');
}

function validateAction(schemaVersion, action) {
	if (!isActionShape(action)) throw planInvalid();
	const arity = Object.hasOwn(ARITY, action.command) ? ARITY[action.command] : null;
	if (!arity || !Array.isArray(action.args)) throw planInvalid();
	if (action.args.length < arity[0] || action.args.length > arity[1]) throw planInvalid();
	if (action.command === 'evaluate') {
		if (!isEvaluateSource(action.args[0], schemaVersion)) throw planInvalid();
		return;
	}
	if (!action.args.every(isSafeActionArgument)) throw planInvalid();
}

function loadPlan(planPath) {
	let plan;
	try {
		plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
	} catch {
		throw planInvalid();
	}
	if (!isPlanShape(plan)) throw planInvalid();
	for (const action of plan.actions) validateAction(plan.schema_version, action);
	return plan.actions;
}

function loadPuppeteer() {
	try {
		// Resolved from this file's real location, so the installed symlink and
		// the checkout both reach the repository's declared puppeteer package.
		return require('puppeteer');
	} catch {
		throw new LaneFailure(
			EXIT_INVALID_REGISTRY,
			'puppeteer_dependency_missing',
			'the declared puppeteer package is unavailable inside the relay handoff',
			'Restore the dotfiles node_modules that declare puppeteer.',
		);
	}
}

function endpointOptions(endpoint) {
	if (/^wss?:\/\//i.test(endpoint)) {
		return { browserWSEndpoint: endpoint };
	}
	if (/^https?:\/\//i.test(endpoint)) {
		return { browserURL: endpoint };
	}
	throw new LaneFailure(
		EXIT_INVALID_REGISTRY,
		'puppeteer_endpoint_invalid',
		'the one-use relay endpoint is not a WebSocket or HTTP URL',
		'Retry through the public browser-lane puppeteer command.',
	);
}

async function connect(puppeteer, endpoint) {
	assertRunActive('connecting');
	const options = {
		...endpointOptions(endpoint),
		// null keeps the user's real Chrome window untouched; the default would
		// force an 800x600 emulated viewport onto the admitted tab.
		defaultViewport: null,
		protocolTimeout: ACTION_TIMEOUT_MS,
	};
	try {
		return await withTimeout(puppeteer.connect(options), stepBudget(CONNECT_TIMEOUT_MS));
	} catch (error) {
		throw new LaneFailure(
			EXIT_RELAY_UNAVAILABLE,
			'puppeteer_connect_failed',
			error instanceof StepTimeout
				? 'Puppeteer did not connect through the relay handoff within its time budget'
				: `Puppeteer could not connect through the relay handoff (${errorClass(error)})`,
			"Confirm the profile's OpenClaw popup says Connected and retry once.",
			true,
		);
	}
}

// The binding is proved from relay-reported target state alone: page identity
// and URL. No page content is touched before the digest matches.
async function assertBoundPage(browser, boundPage, expectedHash) {
	// A bound-page check may follow a completed mutation. Only initial discovery
	// can promise that replay cannot repeat an action from this command.
	const retrySafe = boundPage === null;
	if (!browser.connected) {
		throw new LaneFailure(
			EXIT_RELAY_UNAVAILABLE,
			'puppeteer_relay_disconnected',
			'the relay handoff disconnected before the run completed',
			'Confirm the lane relay is Connected, then retry with a fresh admission.',
			retrySafe,
		);
	}
	let pages;
	try {
		pages = await withTimeout(browser.pages(), stepBudget(PAGES_TIMEOUT_MS));
	} catch (error) {
		throw new LaneFailure(
			EXIT_PAGE_UNRESOLVED,
			'puppeteer_page_unresolved',
			error instanceof StepTimeout
				? 'the relay did not report its admitted page within the time budget'
				: `the relay did not report a readable admitted page (${errorClass(error)})`,
			"Confirm the lane's OpenClaw popup says Connected with Selected tabs, then retry once.",
			retrySafe,
		);
	}
	if (pages.length === 0 || boundPage?.isClosed()) {
		throw new LaneFailure(
			EXIT_PAGE_UNRESOLVED,
			'puppeteer_page_gone',
			'the admitted page is no longer reachable through the relay',
			"Admit the intended tab to the lane's OpenClaw group, then retry.",
			retrySafe,
		);
	}
	const pageSites = pages.map((page) => ({ page, hash: siteHash(page.url()) }));
	const matches = pageSites.filter(({ hash }) => hash === expectedHash).map(({ page }) => page);
	if (boundPage && matches.includes(boundPage)) return boundPage;
	if (matches.length > 1) {
		throw new LaneFailure(
			EXIT_PAGE_UNRESOLVED,
			'puppeteer_page_ambiguous',
			`the relay exposed ${matches.length} pages on the task site without a bound match`,
			'Select one task page and leave unrelated admitted pages unchanged, then retry.',
			retrySafe,
		);
	}
	if (matches.length === 0 || (boundPage && matches[0] !== boundPage)) {
		throw new LaneFailure(
			EXIT_PAGE_UNRESOLVED,
			'puppeteer_page_changed',
			boundPage
				? 'the admitted page changed between Puppeteer actions'
				: 'the admitted page changed before Puppeteer actions began',
				"Observe the intended tab's current ordinary URL in the declared profile, then inspect that page and verify the action's effect. Do not replay an uncertain mutation or re-admit solely because navigation ended the old attachment. Honor Stop or revoked access.",
			retrySafe,
		);
	}
	const page = matches[0];
	return page;
}

async function runAction(page, action, index) {
	// Rechecked here, after page discovery has already spent its own budget,
	// so a slow guard can never start an action past the lease TTL or after a
	// signal has begun teardown.
	assertRunActive(`action ${index} (${action.command})`);
	if (state.interrupted) {
		throw new LaneFailure(
			EXIT_INTERRUPTED,
			'puppeteer_run_interrupted',
			`the run was interrupted before action ${index} (${action.command})`,
			'Retry with a fresh admission.',
		);
	}
	const budget = stepBudget(ACTION_TIMEOUT_MS);
	page.setDefaultTimeout(budget);
	try {
		return await withTimeout(
			Promise.resolve().then(() => ACTIONS[action.command](page, action.args)),
			budget,
		);
	} catch (error) {
		if (error instanceof LaneFailure) {
			throw error;
		}
		if (error instanceof StepTimeout) {
			throw new LaneFailure(
				EXIT_ACTION_FAILED,
				'puppeteer_action_timeout',
				`action ${index} (${action.command}) exceeded its time budget`,
				'Shorten the plan or raise --ttl, then retry with a fresh admission.',
			);
		}
		throw new LaneFailure(
			EXIT_ACTION_FAILED,
			'puppeteer_action_failed',
			`action ${index} (${action.command}) failed (${errorClass(error)})`,
			'Inspect the admitted page, repair the plan, then retry with a fresh admission.',
		);
	}
}

// Disconnect only. close() would end the user's real Chrome profile. This is
// the one step allowed past the lease TTL, under its own fixed bound.
async function disconnect(browser) {
	try {
		await withTimeout(browser.disconnect(), DISCONNECT_TIMEOUT_MS);
		return true;
	} catch {
		return false;
	}
}

// Synchronous writes are already flushed, so an explicit exit is safe and is
// what guarantees a held connect, page, action, or disconnect promise cannot
// keep the process, and therefore the relay broker, alive.
function recordOutcome(actionOutcome, cleanupOutcome, exitCode) {
	const file = process.env.BROWSER_LANE_ACTIVITY_OUTCOME;
	if (!file) return;
	try { fs.writeFileSync(file, JSON.stringify({ actionOutcome, cleanupOutcome, exitCode }), { mode: 0o600 }); }
	catch { /* Telemetry never changes the browser command outcome. */ }
}

function exit(code) {
	process.exit(code);
}

function installSignalHandlers() {
	for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
		process.on(signal, () => {
			if (state.interrupted) {
				return;
			}
			state.interrupted = true;
			(async () => {
				const cleanupOutcome = state.browser
					? (await disconnect(state.browser) ? 'confirmed' : 'unconfirmed')
					: 'unknown';
				recordOutcome('failed', cleanupOutcome, EXIT_INTERRUPTED);
				writeErr(`${PROGRAM}: Puppeteer run interrupted by ${signal}`);
				exit(EXIT_INTERRUPTED);
			})();
		});
	}
}

function internalFailure(error) {
	return new LaneFailure(
		EXIT_LIFECYCLE_UNRESOLVED,
		'puppeteer_internal_error',
		`the Puppeteer run failed unexpectedly (${errorClass(error)})`,
		'Inspect the lane before retrying.',
	);
}

async function main() {
	const contract = readContract();
	const actions = loadPlan(contract.planPath);
	const puppeteer = loadPuppeteer();
	const browser = await connect(puppeteer, contract.endpoint);
	state.browser = browser;

	let failure = null;
	try {
		assertRunActive('page discovery');
		const page = await assertBoundPage(browser, null, contract.expectedHash);
		for (const [index, action] of actions.entries()) {
			assertRunActive(`action ${index} (${action.command})`);
			await assertBoundPage(browser, page, contract.expectedHash);
			const result = await runAction(page, action, index);
			if (action.command === 'evaluate') {
				await assertBoundPage(browser, page, contract.expectedHash);
			}
			writeOut(JSON.stringify({ index, command: action.command, status: 'ok', result: result ?? null }));
		}
	} catch (error) {
		failure = error instanceof LaneFailure ? error : internalFailure(error);
	}

	const disconnected = await disconnect(browser);
	state.browser = null;
	recordOutcome(failure ? 'failed' : 'completed', disconnected ? 'confirmed' : 'unconfirmed', failure?.exitCode ?? (disconnected ? 0 : EXIT_LIFECYCLE_UNRESOLVED));
	if (failure) {
		report(failure);
		if (!disconnected) {
			writeErr(`${PROGRAM}: Puppeteer disconnect remained unresolved after action failure`);
		}
		return failure.exitCode;
	}
	if (!disconnected) {
		report(
			new LaneFailure(
				EXIT_LIFECYCLE_UNRESOLVED,
				'puppeteer_lifecycle_unresolved',
				'Puppeteer could not prove its run-scoped connection disconnected cleanly',
				'Inspect the exact lane relay before retrying.',
			),
		);
		return EXIT_LIFECYCLE_UNRESOLVED;
	}
	return 0;
}

installSignalHandlers();
main().then(
	(code) => exit(code),
	(error) => {
		const failure = error instanceof LaneFailure ? error : internalFailure(error);
		report(failure);
		exit(failure.exitCode);
	},
);
