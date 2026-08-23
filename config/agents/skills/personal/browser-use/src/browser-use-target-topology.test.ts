import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { runForTest, type BrowserUseRuntime } from "./browser-use";
import { verifiedHandoffEnvelope } from "./browser-connect-handoff-fixtures";
import {
	runScopedKey,
	SELECTED_TARGET_STATE_TTL_MS,
} from "./browser-use-selection";
import { openBrowserUsePaths } from "./browser-use-paths";
import {
	acquireTargetOperationLease,
	browserAuthorityIdOf,
	releaseRunTargetOwnership,
	releaseTargetOperationLease,
} from "./browser-use-browser-custody";
import { makeRuntime, parseJson } from "./browser-use-test-helpers";
import {
	fixedClock,
	makeVolatileOverlayFs,
} from "./browser-use-platform-test-helpers";
import type { McporterCommandResult } from "./mcporter-transport";

const HANDOFF_PATH = "/private/handoff.json";
const STATE_PATH = "/private/selected-target.json";
const RUN_ID = "fixture-run";
const REQUESTED_URL =
	"https://storybook.example.test/?path=/story/button--docs";

type NativeTab = {
	tabId: string;
	targetId: string;
	url: string;
	title?: string;
};

type Harness = ReturnType<typeof topologyHarness>;
const disposers: Array<() => void> = [];

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

function ok(data: unknown): McporterCommandResult {
	return {
		exitCode: 0,
		stdout: JSON.stringify({ success: true, data, error: null }),
		stderr: "",
	};
}

function failed(
	input: Partial<McporterCommandResult> = {},
): McporterCommandResult {
	return {
		exitCode: input.exitCode ?? 1,
		stdout: input.stdout ?? "",
		stderr: input.stderr ?? "native failure",
		...(input.timedOut === undefined ? {} : { timedOut: input.timedOut }),
	};
}

function tab(
	targetId: string,
	url: string,
	input: { tabId?: string; title?: string } = {},
): NativeTab {
	return {
		tabId: input.tabId ?? `tab-${targetId}`,
		targetId,
		url,
		...(input.title === undefined ? {} : { title: input.title }),
	};
}

function agentBrowserHandoff(
	mutate?: (envelope: Record<string, any>) => void,
): string {
	return verifiedHandoffEnvelope((envelope) => {
		envelope.data.attachment.adapter_id = "agent-browser";
		envelope.data.attachment.probe_executable =
			"/opt/side-quest/browser-connect/adapters/agent-browser";
		mutate?.(envelope);
	});
}

function topologyHarness(
	input: {
		handoff?: string;
		now?: number;
		env?: Record<string, string | undefined>;
	} = {},
) {
	const overlay = makeVolatileOverlayFs();
	disposers.push(overlay.dispose);
	const clock = fixedClock(input.now ?? 10_000);
	const calls: string[][] = [];
	const commandVectors: string[][] = [];
	const inventories: McporterCommandResult[] = [];
	const creates: McporterCommandResult[] = [];
	const closes: McporterCommandResult[] = [];
	const nativeThrows: string[] = [];
	let lastInventoryTabs: NativeTab[] = [];
	let pinnedTargetId: string | undefined;
	let sessionCloseResult: McporterCommandResult = ok({});
	let sessionCloseCalls = 0;
	let sessionListResult: McporterCommandResult = ok({ sessions: [] });
	let pinResult: McporterCommandResult | undefined;
	const handoffs = new Map<string, string>([
		[HANDOFF_PATH, input.handoff ?? agentBrowserHandoff()],
	]);
	let stateLockMutation: (() => void) | undefined;
	let custodyRegistryWritesToFail = 0;
	let selectedStateSyncFailure:
		{ directory: string; beforeThrow?: () => void } | undefined;
	let selectedStateUnlinkFailures = 0;
	let throwClockFrom: string | undefined;

	const platformFs = {
		...overlay.fs,
		async writeFileDurable(path: string, contents: string, mode: number) {
			if (
				custodyRegistryWritesToFail > 0 &&
				path.includes("/browser-custody/registry.json.tmp-")
			) {
				custodyRegistryWritesToFail -= 1;
				throw Object.assign(new Error("injected custody write failure"), {
					code: "EIO",
				});
			}
			await overlay.fs.writeFileDurable(path, contents, mode);
		},
		async unlink(path: string) {
			if (path === STATE_PATH && selectedStateUnlinkFailures > 0) {
				selectedStateUnlinkFailures -= 1;
				throw Object.assign(new Error("injected state unlink failure"), {
					code: "EIO",
				});
			}
			await overlay.fs.unlink(path);
		},
		async syncDirectory(path: string) {
			if (selectedStateSyncFailure?.directory === path) {
				const failure = selectedStateSyncFailure;
				selectedStateSyncFailure = undefined;
				failure.beforeThrow?.();
				throw Object.assign(
					new Error("injected state directory sync failure"),
					{
						code: "EIO",
					},
				);
			}
			await overlay.fs.syncDirectory(path);
		},
		async linkFileNoReplace(existingPath: string, newPath: string) {
			await overlay.fs.linkFileNoReplace(existingPath, newPath);
			if (newPath === `${STATE_PATH}.lock` && stateLockMutation !== undefined) {
				const mutate = stateLockMutation;
				stateLockMutation = undefined;
				mutate();
			}
		},
	};
	const runtime: BrowserUseRuntime = makeRuntime({
		env: {
			HOME: "/home/tester",
			XDG_CONFIG_HOME: "/xdg/config",
			XDG_DATA_HOME: "/xdg/data",
			XDG_STATE_HOME: "/xdg/state",
			XDG_CACHE_HOME: "/xdg/cache",
			XDG_RUNTIME_DIR: "/xdg/runtime",
			...(input.env ?? {}),
		},
		now: () => {
			if (
				throwClockFrom !== undefined &&
				new Error().stack?.includes(throwClockFrom)
			) {
				throwClockFrom = undefined;
				throw new Error("injected unexpected clock failure");
			}
			return clock.now();
		},
		platformFs,
		ensureDirectory: async (path) => {
			await platformFs.mkdir(path, { recursive: true, mode: 0o700 });
		},
		readTextFile: async (path) => {
			const handoff = handoffs.get(path);
			if (handoff !== undefined) return handoff;
			return await platformFs.readTextFile(path);
		},
		writeTextFile: async (path, contents) => {
			await platformFs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await platformFs.writeFileDurable(path, contents, 0o600);
		},
		runCommand: async (command) => {
			commandVectors.push([command.command, ...command.args]);
			const tabIndex = command.args.indexOf("tab");
			if (tabIndex < 0) {
				if (command.args.includes("close")) {
					sessionCloseCalls += 1;
					pinnedTargetId = undefined;
					return sessionCloseResult;
				}
				if (command.args[0] === "session" && command.args[1] === "list") {
					return sessionListResult;
				}
				if (command.args.includes("snapshot")) return ok("Root\nButton");
				if (command.args.includes("get") && command.args.includes("url")) {
					return ok({
						url: lastInventoryTabs.find(
							(tab) => tab.targetId === pinnedTargetId,
						)?.url,
					});
				}
				return ok({});
			}
			const semantic = command.args.slice(tabIndex);
			calls.push(semantic);
			if (nativeThrows[0] === semantic[1]) {
				nativeThrows.shift();
				throw new Error(`injected native ${semantic[1]} failure`);
			}
			if (semantic[1] === "list") {
				if (command.args.includes("--pin-tab")) {
					return ok({
						tabs: lastInventoryTabs.map((tab) => ({
							...tab,
							active: tab.targetId === pinnedTargetId,
						})),
					});
				}
				const result =
					inventories.shift() ?? failed({ stdout: "missing inventory fixture" });
				try {
					const envelope = JSON.parse(result.stdout) as {
						data?: { tabs?: NativeTab[] };
					};
					if (Array.isArray(envelope.data?.tabs)) {
						lastInventoryTabs = envelope.data.tabs;
					}
				} catch {
					// The production parser owns malformed inventory classification.
				}
				return result;
			}
			if (semantic[1] === "new") {
				return creates.shift() ?? ok({ targetId: "target-new" });
			}
			if (semantic[1] === "close") {
				return closes.shift() ?? ok({});
			}
			if (
				semantic.length === 2 ||
				(semantic.length === 3 && semantic[2] === "--json")
			) {
				if (command.args.includes("--pin-tab")) {
					if (pinResult !== undefined) {
						const result = pinResult;
						pinResult = undefined;
						return result;
					}
					pinnedTargetId = semantic[1];
				}
				return ok({});
			}
			return failed({ stdout: "unexpected topology command" });
		},
	});

	return {
		runtime,
		clock,
		calls,
		commandVectors,
		get sessionCloseCalls() {
			return sessionCloseCalls;
		},
		overlay,
		platformFs,
		setHandoff(value: string) {
			handoffs.set(HANDOFF_PATH, value);
		},
		addHandoff(path: string, value: string) {
			handoffs.set(path, value);
		},
		list(...tabs: NativeTab[]) {
			inventories.push(ok({ tabs }));
		},
		listResult(result: McporterCommandResult) {
			inventories.push(result);
		},
		create(result: McporterCommandResult) {
			creates.push(result);
		},
		close(result: McporterCommandResult) {
			closes.push(result);
		},
		throwNextNative(operation: "new" | "close") {
			nativeThrows.push(operation);
		},
		failSessionRelease(result: McporterCommandResult) {
			sessionCloseResult = result;
		},
		failPin(result: McporterCommandResult) {
			pinResult = result;
		},
		setSessionInventory(result: McporterCommandResult) {
			sessionListResult = result;
		},
		mutateWhenStateLockAcquired(mutate: () => void) {
			stateLockMutation = mutate;
		},
		failNextCustodyRegistryWrite() {
			custodyRegistryWritesToFail = 1;
		},
		failCustodyRegistryWrites(count: number) {
			custodyRegistryWritesToFail = count;
		},
		failNextSelectedStateDirectorySync(
			directory = dirname(STATE_PATH),
			beforeThrow?: () => void,
		) {
			selectedStateSyncFailure = { directory, beforeThrow };
		},
		failNextSelectedStateUnlink() {
			selectedStateUnlinkFailures = 1;
		},
		throwWhenClockCalledFrom(owner: string) {
			throwClockFrom = owner;
		},
	};
}

async function openTarget(
	harness: Harness,
	input: {
		before?: NativeTab[];
		after?: NativeTab[];
		url?: string;
		create?: McporterCommandResult;
	} = {},
) {
	const url = input.url ?? REQUESTED_URL;
	const before = input.before ?? [];
	const after = input.after ?? [
		...before,
		tab("target-new", url, { title: "Button docs" }),
	];
	harness.list(...before);
	harness.create(input.create ?? ok({ targetId: "target-new" }));
	harness.list(...after);
	return await runOpen(harness, url);
}

async function runOpen(
	harness: Harness,
	url = REQUESTED_URL,
	outputMode: "--json" | "--plain" = "--json",
) {
	await harness.platformFs.mkdir(dirname(STATE_PATH), {
		recursive: true,
		mode: 0o700,
	});
	return await runForTest(
		[
			"targets",
			"open",
			"--url",
			url,
			"--handoff",
			HANDOFF_PATH,
			"--state",
			STATE_PATH,
			"--run-id",
			RUN_ID,
			outputMode,
		],
		harness.runtime,
	);
}

async function runOpenAt(
	harness: Harness,
	input: {
		runId: string;
		handoffPath: string;
		statePath?: string;
		url?: string;
	},
) {
	const argv = [
		"targets",
		"open",
		"--url",
		input.url ?? REQUESTED_URL,
		"--handoff",
		input.handoffPath,
		"--run-id",
		input.runId,
	];
	if (input.statePath !== undefined) argv.push("--state", input.statePath);
	argv.push("--json");
	if (input.statePath !== undefined) {
		await harness.platformFs.mkdir(dirname(input.statePath), {
			recursive: true,
			mode: 0o700,
		});
	}
	return await runForTest(argv, harness.runtime);
}

function expectSuccess(result: Awaited<ReturnType<typeof openTarget>>): void {
	if (result.exitCode !== 0) {
		throw new Error(
			`Expected topology success, received: ${result.stdout || result.stderr}`,
		);
	}
}

function expectExit(
	result: Awaited<ReturnType<typeof runForTest>>,
	expected: number,
): void {
	if (result.exitCode !== expected) {
		throw new Error(
			`Expected exit ${expected}, received ${result.exitCode}: ${result.stdout || result.stderr}`,
		);
	}
}

async function closeTarget(
	harness: Harness,
	tabs: NativeTab[],
	postCloseInventory?: McporterCommandResult,
	outputMode: "--json" | "--plain" = "--json",
) {
	harness.list(...tabs);
	if (postCloseInventory !== undefined) {
		harness.listResult(postCloseInventory);
	}
	return await runForTest(
		[
			"targets",
			"close",
			"--state",
			STATE_PATH,
			"--handoff",
			HANDOFF_PATH,
			"--run-id",
			RUN_ID,
			outputMode,
		],
		harness.runtime,
	);
}

async function runCloseAt(
	harness: Harness,
	input: {
		runId: string;
		handoffPath: string;
		statePath?: string;
	},
) {
	const argv = [
		"targets",
		"close",
		"--handoff",
		input.handoffPath,
		"--run-id",
		input.runId,
	];
	if (input.statePath !== undefined) argv.push("--state", input.statePath);
	argv.push("--json");
	return await runForTest(argv, harness.runtime);
}

async function readState(harness: Harness): Promise<Record<string, any>> {
	return JSON.parse(await harness.platformFs.readTextFile(STATE_PATH));
}

async function stateExists(harness: Harness): Promise<boolean> {
	return (await harness.platformFs.lstat(STATE_PATH)) !== undefined;
}

function envelopeData(stdout: string): Record<string, any> {
	return parseJson(stdout).data as Record<string, any>;
}

function envelopeError(stdout: string): Record<string, any> {
	return parseJson(stdout).error as Record<string, any>;
}

function allFileContents(root: string): string[] {
	const output: string[] = [];
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		if (statSync(path).isDirectory()) output.push(...allFileContents(path));
		else output.push(readFileSync(path, "utf8"));
	}
	return output;
}

function allLogicalFiles(harness: Harness): string[] {
	const root = harness.overlay.currentBackingDir();
	const visit = (directory: string): string[] =>
		readdirSync(directory).flatMap((name) => {
			const path = join(directory, name);
			return statSync(path).isDirectory() ? visit(path) : [path];
		});
	return visit(root)
		.map((path) => `/${relative(root, path)}`)
		.sort();
}

function logicalFileSnapshot(harness: Harness): Record<string, string> {
	const root = harness.overlay.currentBackingDir();
	return Object.fromEntries(
		allLogicalFiles(harness).map((logicalPath) => [
			logicalPath,
			readFileSync(join(root, logicalPath.slice(1)), "utf8"),
		]),
	);
}

function selectedStateLogicalFiles(harness: Harness): string[] {
	return allLogicalFiles(harness).filter((logicalPath) => {
		try {
			return readFileSync(
				join(harness.overlay.currentBackingDir(), logicalPath.slice(1)),
				"utf8",
			).includes('"contract":"browser-use.selected-target-state"');
		} catch {
			return false;
		}
	});
}

function liveTopologyCleanupLeases(
	harness: Harness,
): Array<Record<string, any>> {
	const root = harness.overlay.currentBackingDir();
	return allLogicalFiles(harness).flatMap((logicalPath) => {
		try {
			const parsed = JSON.parse(
				readFileSync(join(root, logicalPath.slice(1)), "utf8"),
			) as Record<string, any>;
			const payload =
				parsed.record === "run-lease" ? parsed.payload : undefined;
			return payload?.scope?.topology_cleanup === "adapter-creation" &&
				payload.expires_at_epoch_ms > harness.clock.now()
				? [payload]
				: [];
		} catch {
			return [];
		}
	});
}

function liveRunLeases(harness: Harness): Array<Record<string, any>> {
	const root = harness.overlay.currentBackingDir();
	return allLogicalFiles(harness).flatMap((logicalPath) => {
		try {
			const parsed = JSON.parse(
				readFileSync(join(root, logicalPath.slice(1)), "utf8"),
			) as Record<string, any>;
			const payload = parsed.record === "run-lease" ? parsed.payload : undefined;
			return payload?.expires_at_epoch_ms > harness.clock.now() ? [payload] : [];
		} catch {
			return [];
		}
	});
}

function installLiveTopologyCleanupLease(
	harness: Harness,
	input: { runId: string; targetRef: string },
): void {
	const root = harness.overlay.currentBackingDir();
	for (const logicalPath of allLogicalFiles(harness)) {
		const livePath = join(root, logicalPath.slice(1));
		let parsed: Record<string, any>;
		try {
			parsed = JSON.parse(readFileSync(livePath, "utf8"));
		} catch {
			continue;
		}
		const payload = parsed.record === "run-lease" ? parsed.payload : undefined;
		if (
			payload?.scope?.target_id !== input.targetRef ||
			!String(payload?.holder_id).startsWith("lease-released:")
		) {
			continue;
		}
		payload.holder_id = `browser-target-run:${input.runId}`;
		payload.heartbeat_at_epoch_ms = harness.clock.now();
		payload.expires_at_epoch_ms =
			harness.clock.now() + SELECTED_TARGET_STATE_TTL_MS;
		payload.scope.topology_cleanup = "adapter-creation";
		harness.overlay.tamperFile(logicalPath, `${JSON.stringify(parsed)}\n`);
		return;
	}
	throw new Error("Expected one released target operation lease to revive");
}

function custodyRecord(harness: Harness): {
	logicalPath: string;
	value: Record<string, any>;
} {
	const root = harness.overlay.currentBackingDir();
	const visit = (directory: string): string[] =>
		readdirSync(directory).flatMap((name) => {
			const path = join(directory, name);
			return statSync(path).isDirectory() ? visit(path) : [path];
		});
	for (const path of visit(root)) {
		const contents = readFileSync(path, "utf8");
		if (!contents.includes('"contract":"browser-use.browser-custody"'))
			continue;
		return {
			logicalPath: `/${relative(root, path)}`,
			value: JSON.parse(contents),
		};
	}
	throw new Error("Expected one browser custody registry record");
}

function writeCustodyRecord(
	harness: Harness,
	record: ReturnType<typeof custodyRecord>,
): void {
	harness.overlay.tamperFile(
		record.logicalPath,
		`${JSON.stringify(record.value)}\n`,
	);
}

async function openWithPrimaryAndReleaseDebt(
	harness: Harness,
	outputMode: "--json" | "--plain",
) {
	const target = tab("target-new", REQUESTED_URL);
	harness.list();
	harness.create(ok({ targetId: target.targetId }));
	harness.list(target);
	harness.failNextSelectedStateDirectorySync(dirname(STATE_PATH), () => {
		const livePath = join(
			harness.overlay.currentBackingDir(),
			STATE_PATH.slice(1),
		);
		const replacement = JSON.parse(readFileSync(livePath, "utf8"));
		replacement.target_candidate_id = "replacement-candidate";
		replacement.revision = 2;
		delete replacement.ownership;
		harness.overlay.tamperFile(STATE_PATH, `${JSON.stringify(replacement)}\n`);
	});
	harness.close(ok({}));
	harness.list();
	harness.failSessionRelease(failed({ exitCode: 7 }));
	return await runOpen(harness, REQUESTED_URL, outputMode);
}

describe("targets topology public admission", () => {
	test.each(["released", "expired"] as const)(
		"public new-authority open rehomes a %s old registry and canonical close leaves no live residue",
		async (oldBindingState) => {
			const oldHandoff = agentBrowserHandoff();
			const newHandoff = agentBrowserHandoff((envelope) => {
				envelope.data.endpoint.http = "http://127.0.0.1:9333";
				envelope.data.endpoint.ws =
					"ws://127.0.0.1:9333/devtools/browser/11111111-2222-4333-8444-555555555555";
			});
			const harness = topologyHarness({ handoff: oldHandoff });
			const openedPaths = await openBrowserUsePaths(
				harness.runtime.platformFs,
				harness.runtime.env,
			);
			if (!openedPaths.ok) throw new Error("fixture Browser Use paths refused");
			const deps = {
				fs: harness.runtime.platformFs,
				paths: openedPaths.paths,
				clock: harness.runtime.now,
			};
			const oldEnvelope = JSON.parse(oldHandoff) as Record<string, any>;
			const oldRawTargetId = `old-${oldBindingState}-public`;
			const oldLease = await acquireTargetOperationLease(deps, {
				authorityId: browserAuthorityIdOf({
					environmentName: oldEnvelope.data.environment.name,
					environmentProfile: oldEnvelope.data.environment.profile,
					endpointHttp: oldEnvelope.data.endpoint.http,
					endpointWs: oldEnvelope.data.endpoint.ws,
				}),
				runId: "old-public-run",
				adapterId: "agent-browser",
				rawTargetId: oldRawTargetId,
				operation: "read",
				ttlMs: oldBindingState === "expired" ? 100 : 30_000,
				ownershipEvidence: {
					kind: "adapter-creation-receipt",
					adapter_id: "agent-browser",
					run_id: "old-public-run",
					raw_target_id: oldRawTargetId,
				},
			});
			if (!oldLease.ok) throw new Error("old public authority setup failed");
			await releaseTargetOperationLease(deps, oldLease.lease);
			if (oldBindingState === "released") {
				expect(
					await releaseRunTargetOwnership(deps, "old-public-run"),
				).toEqual({ ok: true, released: 1 });
			} else {
				harness.clock.advance(101);
			}

			harness.setHandoff(newHandoff);
			const target = tab("target-new", REQUESTED_URL);
			const opened = await openTarget(harness, { after: [target] });
			expectSuccess(opened);
			const registryAfterOpen = custodyRecord(harness).value;
			expect(registryAfterOpen.authority_id).toBe(
				"ac999106a19f10117fa6811a98f6359201c22f88844e3d64ba8a40618f78044a",
			);
			expect(Object.keys(registryAfterOpen.targets)).toEqual([
				"6afadbc29610be3e225f3e973d278d3f364903c0d878967902f0d89447537beb",
			]);
			expect(
				registryAfterOpen.targets[
					"6afadbc29610be3e225f3e973d278d3f364903c0d878967902f0d89447537beb"
				],
			).toMatchObject({ owner_run_id: RUN_ID, status: "owned" });

			harness.close(ok({}));
			expectSuccess(await closeTarget(harness, [target], ok({ tabs: [] })));
			expect(await stateExists(harness)).toBe(false);
			expect(liveRunLeases(harness)).toHaveLength(0);
			const registryAfterClose = custodyRecord(harness).value;
			expect(
				Object.values(registryAfterClose.targets).filter(
					(binding: any) =>
						binding.status === "owned" &&
						binding.expires_at_epoch_ms > harness.clock.now(),
				),
			).toHaveLength(0);
			expect(
				harness.calls.filter((call) => call[1] === "new"),
			).toHaveLength(1);
			expect(
				harness.calls.filter((call) => call[1] === "close"),
			).toHaveLength(1);
		},
	);

	test("the public argv parser requires the exact open inputs", async () => {
		const harness = topologyHarness();
		const result = await runForTest(
			["targets", "open", "--handoff", HANDOFF_PATH, "--json"],
			harness.runtime,
		);

		expect(result.exitCode).toBe(2);
		expect(result.stdout).toContain("targets open requires --url");
		expect(harness.calls).toHaveLength(0);
	});

	test("rejects a verified handoff for an unsupported adapter before browser I/O", async () => {
		const harness = topologyHarness({
			handoff: verifiedHandoffEnvelope(),
		});
		const result = await openTarget(harness);

		expectExit(result, 20);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_adapter_unsupported",
		);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "not_started",
			target_mutated: false,
		});
		expect(harness.calls).toHaveLength(0);
	});

	test("rejects an Agent Browser envelope without verified-live explicit-CDP proof", async () => {
		const harness = topologyHarness({
			handoff: agentBrowserHandoff((envelope) => {
				envelope.data.proof.route_evidence = "declared";
			}),
		});
		const result = await openTarget(harness);

		expectExit(result, 20);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_handoff_invalid",
		);
		expect(harness.calls).toHaveLength(0);
	});

	test("rejects non-HTTP URLs without invoking Agent Browser", async () => {
		const harness = topologyHarness();
		const result = await openTarget(harness, { url: "file:///private/secret" });

		expectExit(result, 20);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_url_invalid",
		);
		expect(harness.calls).toHaveLength(0);
	});
});

describe("targets open inventory oracle and identity", () => {
	test("persists a private canonical candidate ordinal after filtering non-pages ahead of the created tab", async () => {
		const harness = topologyHarness();
		const before = [
			tab("blank", "about:blank"),
			tab("existing", "https://existing.example.test/app", {
				title: "Existing",
			}),
			tab("devtools", "devtools://devtools/bundled/inspector.html"),
		];
		const created = tab("target-new", REQUESTED_URL, { title: "Button docs" });
		const result = await openTarget(harness, {
			before,
			after: [...before, created],
		});

		expectSuccess(result);
		expect(result.stderr).toBe("");
		const data = envelopeData(result.stdout);
		const state = await readState(harness);
		expect(state.selected_candidate_ordinal).toBe(2);
		expect(state.target_candidate_id).toBe(data.target_candidate_id);
		expect(data).toMatchObject({
			binding: {
				outer_run_id: RUN_ID,
				run_id: RUN_ID,
				handoff_evidence_id: "031e64f2b1efff034e247b0c0fd80644",
			},
			target_ref:
				"6afadbc29610be3e225f3e973d278d3f364903c0d878967902f0d89447537beb",
			normalized_origin: "https://storybook.example.test",
			custody: {
				browser_lane: {
					acquired_at_epoch_ms: expect.any(Number),
					released_at_epoch_ms: expect.any(Number),
				},
			},
		});
		expect(state.display).toEqual({ origin: "https://storybook.example.test" });
		expect(JSON.stringify(state)).not.toContain("target-new");
		expect(JSON.stringify(state)).not.toContain(REQUESTED_URL);
		expect(state.ownership).toMatchObject({
			kind: "created-target",
			retained_lifecycle: {
				adapter_id: "agent-browser",
				capability_id: "agent-browser.exact-target-no-focus.v1",
				lifecycle_ref: `browser-use-${RUN_ID}`,
			},
		});
		expect(
			harness.commandVectors.some(
				(vector) =>
					vector.includes("--pin-tab") &&
					vector.includes("tab") &&
					vector.includes("target-new"),
			),
		).toBe(true);
		expect(harness.sessionCloseCalls).toBe(0);
	});

	test("requires the exact requested URL rather than accepting an origin-only match", async () => {
		const harness = topologyHarness();
		const wrong = tab(
			"target-new",
			"https://storybook.example.test/?path=/story/input--docs",
		);
		harness.list();
		harness.create(ok({ targetId: "target-new" }));
		harness.list(wrong);
		const result = await runForTest(
			[
				"targets",
				"open",
				"--url",
				REQUESTED_URL,
				"--handoff",
				HANDOFF_PATH,
				"--state",
				STATE_PATH,
				"--run-id",
				RUN_ID,
				"--json",
			],
			harness.runtime,
		);

		expect(result.exitCode).toBe(20);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_create_binding_failed",
		);
		expect(envelopeData(result.stdout).target_present).toBe("unknown");
		expect(harness.calls.some((call) => call[1] === "close")).toBe(false);
		expect(await stateExists(harness)).toBe(false);
	});

	test("confirms open from exact inventory after a nonzero garbled create result", async () => {
		const harness = topologyHarness();
		const created = tab("target-new", REQUESTED_URL);
		const result = await openTarget(harness, {
			after: [created],
			create: failed({ exitCode: 9, stdout: "garbled-create-output" }),
		});

		expectSuccess(result);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "confirmed",
			target_present: true,
			command_outcome: "inventory-confirmed",
			transport_warning: "native-create-output-unconfirmed",
		});
		expect((await readState(harness)).ownership.kind).toBe("created-target");
	});

	test("pinning failure rolls back the exact target and releases the run session", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		harness.list();
		harness.create(ok({ targetId: target.targetId }));
		harness.list(target);
		harness.failPin(failed({ exitCode: 1 }));
		harness.close(ok({}));
		harness.list();

		const result = await runOpen(harness);

		expectExit(result, 1);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_create_binding_failed",
		);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "confirmed",
			target_present: false,
		});
		expect(await stateExists(harness)).toBe(false);
		expect(harness.sessionCloseCalls).toBe(1);
	});

	test("treats malformed post-create inventory as an unknown effect", async () => {
		const harness = topologyHarness();
		harness.list();
		harness.create(ok({ targetId: "target-new" }));
		harness.listResult(
			ok({
				tabs: [
					{ tabId: "tab-new", targetId: "bad target id", url: REQUESTED_URL },
				],
			}),
		);
		const result = await runForTest(
			[
				"targets",
				"open",
				"--url",
				REQUESTED_URL,
				"--handoff",
				HANDOFF_PATH,
				"--state",
				STATE_PATH,
				"--run-id",
				RUN_ID,
				"--json",
			],
			harness.runtime,
		);

		expect(result.exitCode).toBe(1);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "unknown",
			target_mutated: true,
			target_present: "unknown",
		});
		expect(await stateExists(harness)).toBe(false);
	});

	test("does not mark two new tabs retryable when only one exact tab was cleaned up", async () => {
		const harness = topologyHarness();
		const exact = tab("target-new", REQUESTED_URL);
		const unexplained = tab("target-extra", "https://unexpected.example.test/");
		harness.list();
		harness.create(ok({ targetId: "target-new" }));
		harness.list(exact, unexplained);
		harness.close(ok({}));
		harness.list(unexplained);
		const result = await runForTest(
			[
				"targets",
				"open",
				"--url",
				REQUESTED_URL,
				"--handoff",
				HANDOFF_PATH,
				"--state",
				STATE_PATH,
				"--run-id",
				RUN_ID,
				"--json",
			],
			harness.runtime,
		);

		expect(result.exitCode).toBe(20);
		expect(envelopeData(result.stdout).cleanup).toMatchObject({
			attempted: true,
			closed: true,
		});
		expect(envelopeError(result.stdout)).toMatchObject({ retryable: false });
		expect(envelopeData(result.stdout).repair_hint).toContain(
			"Stop and inspect",
		);
	});

	test("does not mark collateral disappearance retryable after exact cleanup", async () => {
		const harness = topologyHarness();
		const prior = tab("prior", "https://prior.example.test/");
		const exact = tab("target-new", REQUESTED_URL);
		harness.list(prior);
		harness.create(ok({ targetId: "target-new" }));
		harness.list(exact);
		harness.close(ok({}));
		harness.list();
		const result = await runForTest(
			[
				"targets",
				"open",
				"--url",
				REQUESTED_URL,
				"--handoff",
				HANDOFF_PATH,
				"--state",
				STATE_PATH,
				"--run-id",
				RUN_ID,
				"--json",
			],
			harness.runtime,
		);

		expect(result.exitCode).toBe(20);
		expect(envelopeData(result.stdout).cleanup.closed).toBe(true);
		expect(envelopeError(result.stdout).retryable).toBe(false);
	});

	test("blocks a second open before native mutation when adapter-created ownership remains", async () => {
		const harness = topologyHarness();
		expectSuccess(await openTarget(harness));
		await harness.platformFs.unlink(STATE_PATH);
		const callsBeforeRetry = harness.calls.length;
		const result = await openTarget(harness, {
			after: [tab("target-second", REQUESTED_URL)],
			create: ok({ targetId: "target-second" }),
		});

		expectExit(result, 20);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_persistent_owner_exists",
		);
		expect(harness.calls).toHaveLength(callsBeforeRetry);
	});

	test("uses command identity for cleanup-only custody when post-create inventory is unavailable", async () => {
		const harness = topologyHarness();
		harness.list();
		harness.create(ok({ targetId: "target-new" }));
		harness.listResult(
			ok({ tabs: [{ targetId: "malformed", url: REQUESTED_URL }] }),
		);
		harness.close(ok({}));
		harness.list();
		const result = await runOpen(harness);

		expectExit(result, 1);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_inventory_unavailable",
		);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "confirmed",
			target_present: false,
			cleanup: { attempted: true, closed: true },
		});
		expect(harness.calls).toContainEqual([
			"tab",
			"close",
			"target-new",
			"--json",
		]);
		expect(await stateExists(harness)).toBe(false);
	});

	test("retains cleanup-only ownership when post-close absence is unknown", async () => {
		const harness = topologyHarness();
		harness.list();
		harness.create(ok({ targetId: "target-new" }));
		harness.listResult(
			ok({ tabs: [{ targetId: "malformed", url: REQUESTED_URL }] }),
		);
		harness.close(failed({ exitCode: 124, timedOut: true }));
		harness.listResult(failed({ stdout: "inventory unavailable" }));
		const result = await runOpen(harness);

		expectExit(result, 1);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "unknown",
			target_present: "unknown",
			cleanup: { attempted: true, closed: "unknown" },
		});
		const registry = custodyRecord(harness).value;
		expect(Object.values(registry.targets)).toContainEqual(
			expect.objectContaining({
				owner_run_id: RUN_ID,
				status: "owned",
				ownership_provenance: "adapter-creation-receipt",
			}),
		);
	});

	test("does not attempt exact cleanup when both command identity and inventory are unavailable", async () => {
		const harness = topologyHarness();
		harness.list();
		harness.create(failed({ exitCode: 9, stdout: "garbled" }));
		harness.listResult(failed({ stdout: "inventory unavailable" }));
		const result = await runOpen(harness);

		expectExit(result, 1);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "unknown",
			target_present: "unknown",
		});
		expect(harness.calls.some((call) => call[1] === "close")).toBe(false);
	});
});

describe("targets close inventory oracle and cleanup", () => {
	test.each([
		["nonzero", failed({ exitCode: 9, stdout: "garbled" })],
		["timeout", failed({ exitCode: 124, timedOut: true })],
	] as const)(
		"confirms close from absence after a %s command result and clears local state",
		async (_label, closeResult) => {
			const harness = topologyHarness();
			const target = tab("target-new", REQUESTED_URL);
			expect((await openTarget(harness, { after: [target] })).exitCode).toBe(0);
			harness.close(closeResult);
			const result = await closeTarget(harness, [target], ok({ tabs: [] }));

			expect(result.exitCode).toBe(0);
			expect(envelopeData(result.stdout)).toMatchObject({
				effect: "confirmed",
				target_present: false,
				ownership_released: true,
				binding: {
					outer_run_id: RUN_ID,
					run_id: RUN_ID,
					handoff_evidence_id: "031e64f2b1efff034e247b0c0fd80644",
				},
				target_ref:
					"6afadbc29610be3e225f3e973d278d3f364903c0d878967902f0d89447537beb",
				normalized_origin: "https://storybook.example.test",
				custody: {
					browser_lane: {
						acquired_at_epoch_ms: expect.any(Number),
						released_at_epoch_ms: expect.any(Number),
					},
				},
			});
			expect(await stateExists(harness)).toBe(false);
		},
	);

	test("closes an owned target by target_ref after it navigates to about:blank", async () => {
		const harness = topologyHarness();
		const opened = tab("target-new", REQUESTED_URL);
		expectSuccess(await openTarget(harness, { after: [opened] }));
		const navigated = tab("target-new", "about:blank");
		harness.close(ok({}));
		const result = await closeTarget(harness, [navigated], ok({ tabs: [] }));

		expect(result.exitCode).toBe(0);
		expect(harness.calls).toContainEqual([
			"tab",
			"close",
			"target-new",
			"--json",
		]);
		expect(envelopeData(result.stdout).already_absent).toBe(false);
	});

	test("reports close unconfirmed when the exact target remains visible", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expect((await openTarget(harness, { after: [target] })).exitCode).toBe(0);
		harness.close(failed({ stdout: "not-json" }));
		const result = await closeTarget(harness, [target], ok({ tabs: [target] }));

		expect(result.exitCode).toBe(1);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_close_unconfirmed",
		);
		expect(envelopeData(result.stdout).cleanup).toMatchObject({
			closed: false,
			cause: "native-close-failed-and-target-remains-visible",
		});
		expect(await stateExists(harness)).toBe(true);
	});

	test("reports an unknown effect when post-close inventory is malformed", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expect((await openTarget(harness, { after: [target] })).exitCode).toBe(0);
		harness.close(ok({}));
		const result = await closeTarget(
			harness,
			[target],
			ok({ tabs: [{ targetId: "missing-tab-id", url: REQUESTED_URL }] }),
		);

		expect(result.exitCode).toBe(1);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "unknown",
			target_present: "unknown",
			cleanup: {
				closed: "unknown",
				cause: "post-close-inventory-unavailable",
			},
		});
		expect(await stateExists(harness)).toBe(true);
	});

	test("confirms the exact close when unrelated targets remain in inventory", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		const unrelated = tab("unrelated", "https://unrelated.example.test/");
		expectSuccess(
			await openTarget(harness, {
				before: [unrelated],
				after: [unrelated, target],
			}),
		);
		harness.close(ok({}));
		const result = await closeTarget(
			harness,
			[unrelated, target],
			ok({ tabs: [unrelated] }),
		);

		expect(result.exitCode).toBe(0);
		expect(envelopeData(result.stdout).target_present).toBe(false);
		expect(await stateExists(harness)).toBe(false);
	});

	test("reports a close transport warning when inventory confirms the effect", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expectSuccess(await openTarget(harness, { after: [target] }));
		harness.close(failed({ exitCode: 9, stdout: "garbled-close-output" }));
		const result = await closeTarget(harness, [target], ok({ tabs: [] }));

		expect(result.exitCode).toBe(0);
		expect(envelopeData(result.stdout)).toMatchObject({
			command_outcome: "inventory-confirmed",
			transport_warning: "native-close-transport-failed-after-confirmed-effect",
		});
	});

	test("cleans local state and custody when the exact owned target is already absent", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expectSuccess(await openTarget(harness, { after: [target] }));
		const callsBeforeClose = harness.calls.length;
		const result = await closeTarget(harness, []);

		expect(result.exitCode).toBe(0);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "not_started",
			target_mutated: false,
			target_present: false,
			already_absent: true,
			ownership_released: true,
			qualification_eligible: false,
		});
		expect(harness.calls).toHaveLength(callsBeforeClose + 1);
		expect(await stateExists(harness)).toBe(false);
	});

	test("normal close publishes confirmed Browser Lane and Target Lease release intervals", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expectSuccess(await openTarget(harness, { after: [target] }));
		harness.close(ok({}));
		const result = await closeTarget(harness, [target], ok({ tabs: [] }));

		expect(result.exitCode).toBe(0);
		expect(envelopeData(result.stdout)).toMatchObject({
			custody: {
				browser_lane: {
					acquired_at_epoch_ms: expect.any(Number),
					released_at_epoch_ms: expect.any(Number),
				},
				target_operation_lease: {
					acquired_at_epoch_ms: expect.any(Number),
					released_at_epoch_ms: expect.any(Number),
				},
			},
		});
	});

	test("repairs a missing selected state from exactly one adapter-created owned ref", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expectSuccess(await openTarget(harness, { after: [target] }));
		await harness.platformFs.unlink(STATE_PATH);
		harness.close(ok({}));
		const result = await closeTarget(harness, [target], ok({ tabs: [] }));

		expect(result.exitCode).toBe(0);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "confirmed",
			target_present: false,
			ownership_released: true,
		});
		expect(await stateExists(harness)).toBe(false);
	});

	test("repairs one adapter-created owner while preserving unrelated replacement state", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expectSuccess(await openTarget(harness, { after: [target] }));
		const replacement = await readState(harness);
		delete replacement.ownership;
		replacement.target_candidate_id = "unrelated-replacement-state";
		replacement.revision += 1;
		const replacementRaw = `${JSON.stringify(replacement)}\n`;
		harness.overlay.tamperFile(STATE_PATH, replacementRaw);
		harness.close(ok({}));
		const result = await closeTarget(harness, [target], ok({ tabs: [] }));

		expect(result.exitCode).toBe(0);
		expect(await harness.platformFs.readTextFile(STATE_PATH)).toBe(
			replacementRaw,
		);
		expect(envelopeData(result.stdout)).toMatchObject({
			ownership_released: true,
		});
	});

	test("fails closed when missing state has no adapter-created owner", async () => {
		const harness = topologyHarness();
		await harness.platformFs.mkdir(dirname(STATE_PATH), {
			recursive: true,
			mode: 0o700,
		});
		const result = await closeTarget(harness, []);

		expectExit(result, 20);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_recovery_owner_mismatch",
		);
		expect(harness.calls).toHaveLength(0);
	});

	test("fails closed when missing state has ambiguous adapter-created owners", async () => {
		const harness = topologyHarness();
		expectSuccess(await openTarget(harness));
		await harness.platformFs.unlink(STATE_PATH);
		const registry = custodyRecord(harness);
		const first = Object.values(registry.value.targets)[0] as Record<
			string,
			unknown
		>;
		registry.value.targets["f".repeat(64)] = {
			...first,
			revision: Number(first.revision) + 1,
		};
		registry.value.revision += 1;
		writeCustodyRecord(harness, registry);
		const callsBeforeClose = harness.calls.length;
		const result = await closeTarget(harness, []);

		expectExit(result, 20);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_recovery_owner_mismatch",
		);
		expect(harness.calls).toHaveLength(callsBeforeClose);
	});

	test.each(["explicit-adoption", "legacy-unknown"] as const)(
		"does not qualify %s ownership for missing-state repair",
		async (provenance) => {
			const harness = topologyHarness();
			expectSuccess(await openTarget(harness));
			await harness.platformFs.unlink(STATE_PATH);
			const registry = custodyRecord(harness);
			const binding = Object.values(registry.value.targets)[0] as Record<
				string,
				unknown
			>;
			if (provenance === "legacy-unknown") delete binding.ownership_provenance;
			else binding.ownership_provenance = provenance;
			writeCustodyRecord(harness, registry);
			const callsBeforeClose = harness.calls.length;
			const result = await closeTarget(harness, []);

			expectExit(result, 20);
			expect(envelopeError(result.stdout).code).toBe(
				"target_topology_recovery_owner_mismatch",
			);
			expect(harness.calls).toHaveLength(callsBeforeClose);
		},
	);

	test("JSON release debt preserves the primary close cleanup oracle", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expectSuccess(await openTarget(harness, { after: [target] }));
		harness.close(failed({ exitCode: 9, stdout: "garbled" }));
		harness.failSessionRelease(failed({ exitCode: 7 }));
		const result = await closeTarget(harness, [target], ok({ tabs: [target] }));

		expectExit(result, 1);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_release_incomplete",
		);
		expect(envelopeData(result.stdout)).toMatchObject({
			primary_cause: "target_topology_close_unconfirmed",
			primary_cleanup: {
				attempted: true,
				closed: false,
				cause: "native-close-failed-and-target-remains-visible",
			},
			cleanup_debt: ["command-failed"],
		});
	});

	test("plain release debt preserves the primary close cleanup oracle", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expectSuccess(await openTarget(harness, { after: [target] }));
		harness.close(failed({ exitCode: 9, stdout: "garbled" }));
		harness.failSessionRelease(failed({ exitCode: 7 }));
		const result = await closeTarget(
			harness,
			[target],
			ok({ tabs: [target] }),
			"--plain",
		);

		expectExit(result, 1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			"primary_cause=target_topology_close_unconfirmed",
		);
		expect(result.stderr).toContain(
			"primary_cleanup=attempted:true,closed:false,cause:native-close-failed-and-target-remains-visible",
		);
		expect(result.stderr).toContain("cleanup_debt=command-failed");
		expect(result.stderr.trim().split("\n")).toHaveLength(1);
	});

	test("JSON release debt composes with existing local debt without duplication", async () => {
		const harness = topologyHarness();
		const result = await openWithPrimaryAndReleaseDebt(harness, "--json");

		expectExit(result, 1);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_release_incomplete",
		);
		const data = envelopeData(result.stdout);
		expect(data).toMatchObject({
			primary_cause: "target_topology_state_write_failed",
			primary_cleanup: { attempted: true, closed: true },
			cleanup_debt: ["selected-state-replacement-preserved", "command-failed"],
		});
		expect(new Set(data.cleanup_debt as string[]).size).toBe(2);
		expect(
			result.stdout
				.trim()
				.split("\n")
				.filter((line) => line === "{"),
		).toHaveLength(1);
	});

	test("plain release debt composes with existing local debt on one stable line", async () => {
		const harness = topologyHarness();
		const result = await openWithPrimaryAndReleaseDebt(harness, "--plain");

		expectExit(result, 1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			"primary_cause=target_topology_state_write_failed",
		);
		expect(result.stderr).toContain(
			"primary_cleanup=attempted:true,closed:true",
		);
		expect(result.stderr).toContain(
			"cleanup_debt=selected-state-replacement-preserved,command-failed",
		);
		expect(
			result.stderr.match(/selected-state-replacement-preserved/g),
		).toHaveLength(1);
		expect(result.stderr.match(/command-failed/g)).toHaveLength(1);
		expect(result.stderr.trim().split("\n")).toHaveLength(1);
	});

	test("permits expired created-target state only for exact cleanup", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expect((await openTarget(harness, { after: [target] })).exitCode).toBe(0);
		harness.clock.advance(SELECTED_TARGET_STATE_TTL_MS + 1);
		harness.close(ok({}));
		const result = await closeTarget(harness, [target], ok({ tabs: [] }));

		expect(result.exitCode).toBe(0);
		expect(await stateExists(harness)).toBe(false);
	});

	test("treats the owned target as absent without closing an unrelated replacement", async () => {
		const harness = topologyHarness();
		const original = tab("target-new", REQUESTED_URL);
		expect((await openTarget(harness, { after: [original] })).exitCode).toBe(0);
		const replacement = tab("target-replacement", REQUESTED_URL);
		const result = await closeTarget(harness, [replacement]);

		expect(result.exitCode).toBe(0);
		expect(envelopeData(result.stdout)).toMatchObject({
			target_mutated: false,
			target_present: false,
			already_absent: true,
		});
		expect(harness.calls.some((call) => call[1] === "close")).toBe(false);
		expect(await stateExists(harness)).toBe(false);
	});

	test("refuses a forged created-target ref that custody does not own", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expectSuccess(await openTarget(harness, { after: [target] }));
		const forged = await readState(harness);
		forged.ownership.target_ref = "e".repeat(64);
		harness.overlay.tamperFile(STATE_PATH, `${JSON.stringify(forged)}\n`);
		const callsBeforeClose = harness.calls.length;
		const result = await closeTarget(harness, [target]);

		expect(result.exitCode).toBe(20);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_recovery_owner_mismatch",
		);
		expect(harness.calls).toHaveLength(callsBeforeClose);
		expect(await stateExists(harness)).toBe(true);
	});

	test("reports a CAS conflict after confirmed close and preserves replacement state", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expect((await openTarget(harness, { after: [target] })).exitCode).toBe(0);
		const replacement = { ...(await readState(harness)), revision: 2 };
		harness.mutateWhenStateLockAcquired(() => {
			harness.overlay.tamperFile(
				STATE_PATH,
				`${JSON.stringify(replacement)}\n`,
			);
		});
		harness.close(ok({}));
		const result = await closeTarget(harness, [target], ok({ tabs: [] }));

		expect(result.exitCode).toBe(1);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_local_cleanup_failed",
		);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "confirmed",
			target_present: false,
			cleanup: { cause: "selected-state-remove-failed" },
		});
		expect((await readState(harness)).revision).toBe(2);
	});

	test("successful close leaves no selected state, lock, raw target id, or live ownership residue", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expect((await openTarget(harness, { after: [target] })).exitCode).toBe(0);
		const targetRef = (await readState(harness)).ownership.target_ref as string;
		harness.close(ok({}));
		expect(
			(await closeTarget(harness, [target], ok({ tabs: [] }))).exitCode,
		).toBe(0);

		expect(await stateExists(harness)).toBe(false);
		expect(
			await harness.platformFs.lstat(`${STATE_PATH}.lock`),
		).toBeUndefined();
		const residue = allFileContents(harness.overlay.currentBackingDir()).join(
			"\n",
		);
		expect(residue).toContain(targetRef);
		expect(residue.replaceAll(/\s/g, "")).not.toContain(
			`"owner_run_id":"${RUN_ID}"`,
		);
		expect(residue).not.toContain("target-new");
	});
});

describe("targets topology ownership failure and run composition", () => {
	test.each(["target-present", "already-absent"] as const)(
		"dual-source %s close clears registry owner and cleanup lease while preserving another run",
		async (scenario) => {
			const harness = topologyHarness();
			const runA = "dual-source-a";
			const runB = "dual-source-b";
			const handoffA = "/private/dual-source-a-handoff.json";
			const handoffB = "/private/dual-source-b-handoff.json";
			const stateAPath = "/private/dual-source-a-state.json";
			const stateBPath = "/private/dual-source-b-state.json";
			const targetA = tab("dual-target-a", "https://dual-a.example.test/");
			const targetB = tab("dual-target-b", "https://dual-b.example.test/");
			harness.addHandoff(
				handoffA,
				agentBrowserHandoff((envelope) => {
					envelope.run_id = runA;
				}),
			);
			harness.addHandoff(
				handoffB,
				agentBrowserHandoff((envelope) => {
					envelope.run_id = runB;
				}),
			);

			harness.list();
			harness.create(ok({ targetId: targetB.targetId }));
			harness.list(targetB);
			expectSuccess(
				await runOpenAt(harness, {
					runId: runB,
					handoffPath: handoffB,
					statePath: stateBPath,
					url: targetB.url,
				}),
			);
			harness.list(targetB);
			harness.create(ok({ targetId: targetA.targetId }));
			harness.list(targetB, targetA);
			expectSuccess(
				await runOpenAt(harness, {
					runId: runA,
					handoffPath: handoffA,
					statePath: stateAPath,
					url: targetA.url,
				}),
			);
			const stateA = JSON.parse(
				await harness.platformFs.readTextFile(stateAPath),
			) as Record<string, any>;
			const stateBRaw = await harness.platformFs.readTextFile(stateBPath);
			installLiveTopologyCleanupLease(harness, {
				runId: runA,
				targetRef: stateA.ownership.target_ref,
			});
			expect(liveTopologyCleanupLeases(harness)).toHaveLength(1);
			const closeCallsBefore = harness.calls.filter(
				(call) => call[1] === "close",
			).length;

			let closed: Awaited<ReturnType<typeof runForTest>>;
			if (scenario === "target-present") {
				harness.close(ok({}));
				harness.list(targetB, targetA);
				harness.list(targetB);
				closed = await runCloseAt(harness, {
					runId: runA,
					handoffPath: handoffA,
					statePath: stateAPath,
				});
			} else {
				harness.list(targetB);
				closed = await runCloseAt(harness, {
					runId: runA,
					handoffPath: handoffA,
					statePath: stateAPath,
				});
			}

			expectSuccess(closed);
			expect(await harness.platformFs.lstat(stateAPath)).toBeUndefined();
			expect(await harness.platformFs.readTextFile(stateBPath)).toBe(stateBRaw);
			expect(liveTopologyCleanupLeases(harness)).toHaveLength(0);
			const registry = custodyRecord(harness).value;
			expect(registry.targets[stateA.ownership.target_ref]).toMatchObject({
				owner_run_id: null,
				status: "released",
			});
			expect(
				Object.values(registry.targets).filter(
					(binding: any) =>
						binding.owner_run_id === runB && binding.status === "owned",
				),
			).toHaveLength(1);
			const closeCallsAfter = harness.calls.filter(
				(call) => call[1] === "close",
			).length;
			expect(closeCallsAfter - closeCallsBefore).toBe(
				scenario === "target-present" ? 1 : 0,
			);
		},
	);

	test("targets open dry-run leaves logical files and native commands unchanged", async () => {
		const harness = topologyHarness();
		const filesBefore = logicalFileSnapshot(harness);
		const commandsBefore = [...harness.commandVectors];
		const result = await runForTest(
			[
				"targets",
				"open",
				"--url",
				REQUESTED_URL,
				"--handoff",
				HANDOFF_PATH,
				"--dry-run",
				"--json",
			],
			harness.runtime,
		);

		expectSuccess(result);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "not_started",
			target_mutated: false,
			state_path_source: "run-scoped-xdg",
		});
		expect(logicalFileSnapshot(harness)).toEqual(filesBefore);
		expect(harness.commandVectors).toEqual(commandsBefore);
	});

	test("targets close dry-run leaves logical files and native commands unchanged", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		harness.list();
		harness.create(ok({ targetId: target.targetId }));
		harness.list(target);
		expectSuccess(
			await runForTest(
				[
					"targets",
					"open",
					"--url",
					REQUESTED_URL,
					"--handoff",
					HANDOFF_PATH,
					"--json",
				],
				harness.runtime,
			),
		);
		const filesBefore = logicalFileSnapshot(harness);
		const commandsBefore = [...harness.commandVectors];
		const result = await runForTest(
			["targets", "close", "--handoff", HANDOFF_PATH, "--dry-run", "--json"],
			harness.runtime,
		);

		expectSuccess(result);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "not_started",
			target_mutated: false,
			recovery_mode: false,
			state_path_source: "run-scoped-xdg",
		});
		expect(logicalFileSnapshot(harness)).toEqual(filesBefore);
		expect(harness.commandVectors).toEqual(commandsBefore);
	});

	test("first-ownership registry write failure keeps cleanup custody through exact confirmed close", async () => {
		const harness = topologyHarness();
		const created = tab("target-new", REQUESTED_URL);
		harness.list();
		harness.create(ok({ targetId: "target-new" }));
		harness.list(created);
		harness.failNextCustodyRegistryWrite();
		harness.close(ok({}));
		harness.list();
		const result = await runOpen(harness);

		expectExit(result, 1);
		expect(envelopeError(result.stdout).code).toBe("target_lease_store_failed");
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "confirmed",
			target_mutated: true,
			target_present: false,
			cleanup: { attempted: true, closed: true },
		});
		expect(harness.calls).toContainEqual([
			"tab",
			"close",
			"target-new",
			"--json",
		]);
		expect(await stateExists(harness)).toBe(false);
		const residue = allFileContents(harness.overlay.currentBackingDir())
			.join("\n")
			.replaceAll(/\s/g, "");
		expect(residue).not.toContain(`"owner_run_id":"${RUN_ID}"`);
		expect(residue).not.toContain('"status":"owned"');
	});

	test("unexpected open helper throw still releases short leases, Browser Lane, and native session", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		harness.list();
		harness.create(ok({ targetId: target.targetId }));
		harness.list(target);
		harness.throwWhenClockCalledFrom("persistCreatedSelectedTargetState");

		const result = await runOpen(harness);

		expectExit(result, 1);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_runtime_failed",
		);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "unknown",
			target_mutated: "unknown",
		});
		expect(liveRunLeases(harness)).toHaveLength(0);
		expect(
			harness.commandVectors.some(
				(vector) => vector.includes("close") && !vector.includes("tab"),
			),
		).toBe(true);
	});

	test("unexpected close store throw still releases short leases, Browser Lane, and native session", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expectSuccess(await openTarget(harness, { after: [target] }));
		harness.throwWhenClockCalledFrom("removeSelectedTargetStateIfRevision");

		const result = await closeTarget(harness, [target], ok({ tabs: [] }));

		expectExit(result, 1);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_runtime_failed",
		);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "unknown",
			target_mutated: "unknown",
		});
		expect(liveRunLeases(harness)).toHaveLength(0);
		expect(
			harness.commandVectors.some(
				(vector) => vector.includes("close") && !vector.includes("tab"),
			),
		).toBe(true);
	});

	test("thrown native create is contained and releases Browser Lane plus session", async () => {
		const harness = topologyHarness();
		harness.list();
		harness.throwNextNative("new");
		harness.list();

		const result = await runOpen(harness);

		expectExit(result, 20);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_create_binding_failed",
		);
		expect(liveRunLeases(harness)).toHaveLength(0);
		expect(
			harness.commandVectors.some(
				(vector) => vector.includes("close") && !vector.includes("tab"),
			),
		).toBe(true);
	});

	test("thrown native close uses inventory truth and releases all short custody", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		expectSuccess(await openTarget(harness, { after: [target] }));
		harness.throwNextNative("close");

		const result = await closeTarget(harness, [target], ok({ tabs: [] }));

		expectSuccess(result);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "confirmed",
			target_mutated: true,
			target_present: false,
			command_outcome: "inventory-confirmed",
			transport_warning:
				"native-close-transport-failed-after-confirmed-effect",
		});
		expect(liveRunLeases(harness)).toHaveLength(0);
	});

	test("public A/B topology composition preserves the other run until its own close", async () => {
		const harness = topologyHarness();
		const handoffAPath = "/private/handoff-a.json";
		const handoffBPath = "/private/handoff-b.json";
		const stateAPath = "/private/state-a.json";
		const stateBPath = "/private/state-b.json";
		const runA = "run-a";
		const runB = "run-b";
		harness.addHandoff(
			handoffAPath,
			agentBrowserHandoff((envelope) => {
				envelope.run_id = runA;
			}),
		);
		harness.addHandoff(
			handoffBPath,
			agentBrowserHandoff((envelope) => {
				envelope.run_id = runB;
			}),
		);
		const targetA = tab(
			"target-a",
			"http://localhost:6123/?path=/story/button--a",
		);
		const targetB = tab(
			"target-b",
			"http://localhost:6124/?path=/story/button--b",
		);

		const filesBeforeMismatch = allLogicalFiles(harness);
		const callsBeforeHandoffMismatch = harness.calls.length;
		const handoffRunMismatch = await runForTest(
			[
				"targets",
				"open",
				"--url",
				targetB.url,
				"--handoff",
				handoffAPath,
				"--state",
				"/private/mismatch-state.json",
				"--run-id",
				runB,
				"--json",
			],
			harness.runtime,
		);
		expectExit(handoffRunMismatch, 20);
		expect(envelopeError(handoffRunMismatch.stdout).code).toBe(
			"target_discovery_run_mismatch",
		);
		expect(envelopeData(handoffRunMismatch.stdout)).toMatchObject({
			effect: "not_started",
			target_mutated: false,
		});
		expect(harness.calls).toHaveLength(callsBeforeHandoffMismatch);
		expect(allLogicalFiles(harness)).toEqual(filesBeforeMismatch);

		harness.list();
		harness.create(ok({ targetId: "target-a" }));
		harness.list(targetA);
		expectSuccess(
			await runOpenAt(harness, {
				runId: runA,
				handoffPath: handoffAPath,
				statePath: stateAPath,
				url: targetA.url,
			}),
		);
		harness.list(targetA);
		harness.create(ok({ targetId: "target-b" }));
		harness.list(targetA, targetB);
		expectSuccess(
			await runOpenAt(harness, {
				runId: runB,
				handoffPath: handoffBPath,
				statePath: stateBPath,
				url: targetB.url,
			}),
		);

		const stateA = JSON.parse(
			await harness.platformFs.readTextFile(stateAPath),
		) as Record<string, any>;
		const stateBRaw = await harness.platformFs.readTextFile(stateBPath);
		const stateB = JSON.parse(stateBRaw) as Record<string, any>;
		expect(stateA.run_id).toBe(runA);
		expect(stateB.run_id).toBe(runB);
		const registryAfterOpen = custodyRecord(harness).value;
		expect(
			registryAfterOpen.targets[stateA.ownership.target_ref],
		).toMatchObject({
			owner_run_id: runA,
			status: "owned",
		});
		expect(
			registryAfterOpen.targets[stateB.ownership.target_ref],
		).toMatchObject({
			owner_run_id: runB,
			status: "owned",
		});

		const callsBeforeCrossUse = harness.calls.length;
		const crossUse = await runCloseAt(harness, {
			runId: runB,
			handoffPath: handoffBPath,
			statePath: stateAPath,
		});
		expectExit(crossUse, 20);
		expect(envelopeError(crossUse.stdout).code).toBe("target_state_cross_run");
		expect(harness.calls).toHaveLength(callsBeforeCrossUse);

		harness.list(targetA, targetB);
		harness.close(ok({}));
		harness.list(targetB);
		expectSuccess(
			await runCloseAt(harness, {
				runId: runA,
				handoffPath: handoffAPath,
				statePath: stateAPath,
			}),
		);
		expect(await harness.platformFs.lstat(stateAPath)).toBeUndefined();
		expect(await harness.platformFs.readTextFile(stateBPath)).toBe(stateBRaw);
		const registryAfterA = custodyRecord(harness).value;
		expect(registryAfterA.targets[stateA.ownership.target_ref]).toMatchObject({
			owner_run_id: null,
			status: "released",
		});
		expect(registryAfterA.targets[stateB.ownership.target_ref]).toMatchObject({
			owner_run_id: runB,
			status: "owned",
		});

		harness.list(targetB);
		harness.close(ok({}));
		harness.list();
		expectSuccess(
			await runCloseAt(harness, {
				runId: runB,
				handoffPath: handoffBPath,
				statePath: stateBPath,
			}),
		);
		expect(await harness.platformFs.lstat(stateBPath)).toBeUndefined();
		const finalRegistry = custodyRecord(harness).value;
		expect(
			Object.values(finalRegistry.targets).filter(
				(binding: any) => binding.status === "owned",
			),
		).toHaveLength(0);
	});

	test("documented open and close argv share one canonical private XDG state path", async () => {
		const harness = topologyHarness();
		expect(harness.runtime.env.BROWSER_USE_RUN_ID).toBeUndefined();
		expect(harness.runtime.env.BROWSER_USE_TARGET_STATE_DIR).toBeUndefined();
		const target = tab("target-new", REQUESTED_URL);
		const canonicalPath = join(
			"/xdg/state/browser-use/target-selections",
			`browser-use-target-state-${runScopedKey(RUN_ID)}.json`,
		);
		harness.list();
		harness.create(ok({ targetId: "target-new" }));
		harness.list(target);
		const opened = await runForTest(
			[
				"targets",
				"open",
				"--url",
				REQUESTED_URL,
				"--handoff",
				HANDOFF_PATH,
				"--json",
			],
			harness.runtime,
		);
		expectSuccess(opened);
		const canonicalState = await harness.platformFs.lstat(canonicalPath);
		if (canonicalState === undefined) {
			throw new Error(
				`Expected canonical state ${canonicalPath}; selected=${selectedStateLogicalFiles(harness).join(",")}`,
			);
		}
		expect(canonicalState).toMatchObject({ kind: "file", mode: 0o600 });

		harness.list(target);
		harness.close(ok({}));
		harness.list();
		const closed = await runForTest(
			["targets", "close", "--handoff", HANDOFF_PATH, "--json"],
			harness.runtime,
		);
		expectSuccess(closed);
		expect(await harness.platformFs.lstat(canonicalPath)).toBeUndefined();
	});

	test("documented default open, operate, and close share state while preserving another same-run owner", async () => {
		const harness = topologyHarness();
		const handoffRaw = agentBrowserHandoff();
		harness.setHandoff(handoffRaw);
		const handoff = JSON.parse(handoffRaw) as Record<string, any>;
		const openedPaths = await openBrowserUsePaths(
			harness.runtime.platformFs,
			harness.runtime.env,
		);
		if (!openedPaths.ok) throw new Error("fixture Browser Use paths refused");
		const deps = {
			fs: harness.runtime.platformFs,
			paths: openedPaths.paths,
			clock: harness.runtime.now,
		};
		const standingTargetRef =
			"5b63180c75b262c3110df419b015a7240bf215651fd84f184e102cf9b8f65373";
		const target = tab("target-new", REQUESTED_URL, { title: "Button docs" });
		harness.list();
		harness.create(ok({ targetId: target.targetId }));
		harness.list(target);
		const opened = await runForTest(
			[
				"targets",
				"open",
				"--url",
				REQUESTED_URL,
				"--handoff",
				HANDOFF_PATH,
				"--json",
			],
			harness.runtime,
		);
		expectSuccess(opened);
		const standing = await acquireTargetOperationLease(deps, {
			authorityId: browserAuthorityIdOf({
				environmentName: handoff.data.environment.name,
				environmentProfile: handoff.data.environment.profile,
				endpointHttp: handoff.data.endpoint.http,
				endpointWs: handoff.data.endpoint.ws,
			}),
			runId: RUN_ID,
			adapterId: "agent-browser",
			rawTargetId: "target-b-standing",
			operation: "read",
			ttlMs: 30_000,
			ownershipEvidence: {
				kind: "adapter-creation-receipt",
				adapter_id: "agent-browser",
				run_id: RUN_ID,
				raw_target_id: "target-b-standing",
			},
		});
		if (!standing.ok) throw new Error("fixture standing ownership failed");
		await releaseTargetOperationLease(deps, standing.lease);

		const operated = await runForTest(
			["operate", "snapshot", "--handoff", HANDOFF_PATH, "--json"],
			harness.runtime,
		);
		expectSuccess(operated);
		expect(envelopeData(operated.stdout)).toMatchObject({
			operation: "snapshot",
			target_source: "selected_state",
			execution: { scope: "target-local", focus: false },
			side_effects: { focus: false },
		});
		expect(harness.sessionCloseCalls).toBe(0);

		harness.list(target);
		harness.close(ok({}));
		harness.list();
		const closed = await runForTest(
			["targets", "close", "--handoff", HANDOFF_PATH, "--json"],
			harness.runtime,
		);
		expectSuccess(closed);
		expect(harness.sessionCloseCalls).toBe(1);
		expect(custodyRecord(harness).value.targets[standingTargetRef]).toMatchObject({
			owner_run_id: RUN_ID,
			status: "owned",
		});
	});

	test.each([
		[
			"target remains visible",
			ok({
				tabs: [
					tab("target-other", "https://other.example.test/"),
					tab("target-new", REQUESTED_URL),
				],
			}),
			false,
		],
		[
			"inventory is unavailable",
			failed({ exitCode: 9, stdout: "inventory unavailable" }),
			"unknown",
		],
	] as const)(
		"retains exactly one cleanup lease when ownership retry fails and rollback %s",
		async (_label, rollbackInventory, expectedClosed) => {
			const harness = topologyHarness();
			const otherRun = "other-run";
			const otherHandoff = "/private/handoff-other.json";
			const otherState = "/private/state-other.json";
			const otherTarget = tab("target-other", "https://other.example.test/");
			harness.addHandoff(
				otherHandoff,
				agentBrowserHandoff((envelope) => {
					envelope.run_id = otherRun;
				}),
			);
			harness.list();
			harness.create(ok({ targetId: otherTarget.targetId }));
			harness.list(otherTarget);
			expectSuccess(
				await runOpenAt(harness, {
					runId: otherRun,
					handoffPath: otherHandoff,
					statePath: otherState,
					url: otherTarget.url,
				}),
			);
			const otherStateRaw = await harness.platformFs.readTextFile(otherState);

			const target = tab("target-new", REQUESTED_URL);
			harness.list(otherTarget);
			harness.create(ok({ targetId: target.targetId }));
			harness.list(otherTarget, target);
			harness.failCustodyRegistryWrites(2);
			harness.close(ok({}));
			harness.listResult(rollbackInventory);
			const failedOpen = await runOpen(harness);

			expectExit(failedOpen, 1);
			expect(envelopeError(failedOpen.stdout).code).toBe(
				"target_lease_store_failed",
			);
			expect(envelopeData(failedOpen.stdout)).toMatchObject({
				effect: "unknown",
				target_present: "unknown",
				cleanup: { attempted: true, closed: expectedClosed },
				cleanup_debt: ["cleanup-operation-lease-retained"],
			});
			const retained = liveTopologyCleanupLeases(harness);
			expect(retained).toHaveLength(1);
			expect(retained[0]).toMatchObject({
				holder_id: `browser-target-run:${RUN_ID}`,
				scope: { topology_cleanup: "adapter-creation" },
			});
			expect(await stateExists(harness)).toBe(false);
			expect(await harness.platformFs.readTextFile(otherState)).toBe(
				otherStateRaw,
			);

			harness.close(ok({}));
			const repaired = await closeTarget(
				harness,
				[otherTarget, target],
				ok({ tabs: [otherTarget] }),
			);
			expectSuccess(repaired);
			expect(liveTopologyCleanupLeases(harness)).toHaveLength(0);
			expect(await harness.platformFs.readTextFile(otherState)).toBe(
				otherStateRaw,
			);
			const registry = custodyRecord(harness).value;
			const otherOwner = Object.values(registry.targets).filter(
				(binding: any) =>
					binding.owner_run_id === otherRun && binding.status === "owned",
			);
			expect(otherOwner).toHaveLength(1);
		},
	);

	test("post-rename state sync failure plus confirmed rollback removes the exact state by CAS", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		harness.list();
		harness.create(ok({ targetId: target.targetId }));
		harness.list(target);
		harness.failNextSelectedStateDirectorySync();
		harness.close(ok({}));
		harness.list();
		const result = await runOpen(harness);

		expectExit(result, 1);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_state_write_failed",
		);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "confirmed",
			target_present: false,
			primary_cause: "selected-state-removed",
		});
		expect(await stateExists(harness)).toBe(false);
		const residue = allFileContents(harness.overlay.currentBackingDir())
			.join("\n")
			.replaceAll(/\s/g, "");
		expect(residue).not.toContain(`"owner_run_id":"${RUN_ID}"`);
	});

	test("post-rename state sync failure retains exact state and owner when rollback is unknown", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		harness.list();
		harness.create(ok({ targetId: target.targetId }));
		harness.list(target);
		harness.failNextSelectedStateDirectorySync();
		harness.close(failed({ exitCode: 124, timedOut: true }));
		harness.listResult(
			failed({ exitCode: 9, stdout: "inventory unavailable" }),
		);
		const result = await runOpen(harness);

		expectExit(result, 1);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "unknown",
			target_present: "unknown",
		});
		expect(await stateExists(harness)).toBe(true);
		const registry = custodyRecord(harness).value;
		expect(Object.values(registry.targets)).toContainEqual(
			expect.objectContaining({ owner_run_id: RUN_ID, status: "owned" }),
		);
	});

	test("post-rename state sync failure preserves replacement state and reports local conflict", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		let replacementRaw = "";
		harness.list();
		harness.create(ok({ targetId: target.targetId }));
		harness.list(target);
		harness.failNextSelectedStateDirectorySync(dirname(STATE_PATH), () => {
			const livePath = join(
				harness.overlay.currentBackingDir(),
				STATE_PATH.slice(1),
			);
			const replacement = JSON.parse(readFileSync(livePath, "utf8"));
			replacement.target_candidate_id = "replacement-candidate";
			replacement.revision = 2;
			delete replacement.ownership;
			replacementRaw = `${JSON.stringify(replacement)}\n`;
			harness.overlay.tamperFile(STATE_PATH, replacementRaw);
		});
		harness.close(ok({}));
		harness.list();
		const result = await runOpen(harness);

		expectExit(result, 1);
		expect(envelopeError(result.stdout).code).toBe(
			"target_topology_state_write_failed",
		);
		expect(envelopeData(result.stdout)).toMatchObject({
			effect: "confirmed",
			target_present: false,
			primary_cause: "selected-state-replacement-preserved",
			cleanup_debt: ["selected-state-replacement-preserved"],
		});
		expect(await harness.platformFs.readTextFile(STATE_PATH)).toBe(
			replacementRaw,
		);
	});

	test("failed exact state CAS removal retains ownership for a later local-only close", async () => {
		const harness = topologyHarness();
		const target = tab("target-new", REQUESTED_URL);
		harness.list();
		harness.create(ok({ targetId: target.targetId }));
		harness.list(target);
		harness.failNextSelectedStateDirectorySync();
		harness.failNextSelectedStateUnlink();
		harness.close(ok({}));
		harness.list();
		const failedOpen = await runOpen(harness);

		expectExit(failedOpen, 1);
		expect(envelopeData(failedOpen.stdout)).toMatchObject({
			effect: "confirmed",
			target_present: false,
			primary_cause: "selected-state-remove-failed",
			cleanup_debt: ["selected-state-remove-failed"],
		});
		expect(await stateExists(harness)).toBe(true);
		const ownedAfterFailure = Object.values(
			custodyRecord(harness).value.targets,
		).filter(
			(binding: any) =>
				binding.owner_run_id === RUN_ID && binding.status === "owned",
		);
		expect(ownedAfterFailure).toHaveLength(1);

		const callsBeforeRepair = harness.calls.length;
		harness.list();
		const repaired = await runForTest(
			[
				"targets",
				"close",
				"--state",
				STATE_PATH,
				"--handoff",
				HANDOFF_PATH,
				"--run-id",
				RUN_ID,
				"--json",
			],
			harness.runtime,
		);
		expectSuccess(repaired);
		expect(envelopeData(repaired.stdout)).toMatchObject({
			target_mutated: false,
			target_present: false,
			already_absent: true,
		});
		expect(harness.calls).toHaveLength(callsBeforeRepair + 1);
		expect(await stateExists(harness)).toBe(false);
		const ownersAfterRepair = Object.values(
			custodyRecord(harness).value.targets,
		).filter(
			(binding: any) =>
				binding.owner_run_id !== null && binding.status === "owned",
		);
		expect(ownersAfterRepair).toHaveLength(0);
	});
});
