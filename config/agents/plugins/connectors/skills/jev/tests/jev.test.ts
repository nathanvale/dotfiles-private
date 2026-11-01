import { execFileSync } from "node:child_process";
import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { record } from "../scripts/catalogue.ts";
import { API_ORIGIN } from "../scripts/endpoint.ts";
import { JevMachine, ITEM_ID, OFFICIAL_MCPORTER, PROVIDER_TOKEN, SERVICE_TOKEN, type Envelope } from "./fixtures/account-fixture.ts";
if (process.env.CI && !OFFICIAL_MCPORTER) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for JEV packaged process proof");
// Match the existing account qualification convention: local runs without
// the verified release fixture skip provider-dependent cases; CI requires it.
// Each case compiles a private plugin copy and starts the real pinned MCPorter.
// Budget includes those processes; the fixture HTTP and stdin deadlines stay bounded.
const qualifiedTest = test.skipIf(!OFFICIAL_MCPORTER);
const INPUT = {
	requestKey: "fixture-one",
	model: "jev-1.14.0",
	state: { text: "Synthetic apples" },
	questions: {
		fruit: {
			type: "choice",
			instructions: "Choose fruit",
			criteria: { apple: "An apple", pear: "A pear" },
		},
		yes: {
			type: "noul",
			instructions: "Is this an apple?",
			criteria: { true: "Yes", false: "No" },
		},
	},
};
const ANSWER = {
	model: "jev-1.14.0",
	answers: {
		fruit: {
			type: "choice",
			choice: "apple",
			confidence: 0.88,
			probabilities: { apple: 0.9, pear: 0.1 },
		},
		yes: { type: "noul", noul: 0.97 },
	},
	usage: { input_tokens: 41, output_tokens: 17 },
};
type Mode = "extras" | "oversized" | "hold" | "success" | "http-429" | "http-529" | "http-500" | "malformed" | "mismatch" | "timeout";
async function fixture(
	body: (context: {
		machine: JevMachine;
		requests: {
			method: string;
			route: string;
			body: unknown;
			authorized: boolean;
		}[];
		mode(value: Mode): void;
		run(args: string[], input?: string): Promise<Envelope["result"]>;
        seen(): Promise<void>;
        release(): void;
	}) => Promise<void>,
	register = true,
): Promise<void> {
	const requests: {
		method: string;
		route: string;
		body: unknown;
		authorized: boolean;
	}[] = [];
	let mode: Mode = "success";
    let onSeen: () => void = () => undefined;
    let release: () => void = () => undefined;
    const seen = new Promise<void>((resolve) => { onSeen = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const route = new URL(request.url).pathname;
			requests.push({
				method: request.method,
				route,
				body: request.method === "POST" ? await request.json() : null,
				authorized: request.headers.get("authorization") === `Bearer ${PROVIDER_TOKEN}`,
			});
			if (route === "/v1/models")
				return Response.json(
					{
						models: [
							{
								name: "jev-1.14.0",
								description: "Synthetic fixture",
								release_date: "2026-10-14",
							},
						],
					},
					{ headers: { "x-typesafe-request-id": "fixture-models" } },
				);
            onSeen();
            if (mode === "hold") await held;
            if (mode === "oversized") return new Response("x".repeat(2 * 1024 * 1024 + 1));
            if (mode === "extras") return Response.json({ ...ANSWER, private_extra: "SENTINEL_REPLY_EXTRA", answers: { fruit: { ...ANSWER.answers.fruit, hidden: "SENTINEL_REPLY_EXTRA" }, yes: { ...ANSWER.answers.yes, hidden: "SENTINEL_REPLY_EXTRA" } } });
			if (mode.startsWith("http-"))
				return new Response("secret error body must never be echoed", {
					status: Number(mode.slice(5)),
				});
			if (mode === "timeout") await Bun.sleep(700);
			if (mode === "malformed") return new Response("{broken");
			return Response.json(mode === "mismatch" ? { ...ANSWER, model: "jev-latest" } : ANSWER, { headers: { "x-typesafe-request-id": "fixture-answer" } });
		},
	});
	const machine = new JevMachine(`http://127.0.0.1:${server.port}`).installCustody();
    writeFileSync(path.join(machine.root, "jev-http-timeout"), "30000");
	const outputs: string[] = [];
	async function run(args: string[], input?: string) {
		const result = await machine.run(args, input);
		outputs.push(result.stdout, result.stderr);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		const envelope: Envelope = JSON.parse(result.stdout);
		expect(result.code).toBe(envelope.result.exitCode);
		return envelope.result;
	}
	try {
		if (register) expect((await run(["auth", "configure", "jev", "--input", JSON.stringify({ item: ITEM_ID })])).causeCode).toBe("SUCCESS_RUN_RECORDED");
		await body({
			machine,
			requests,
			mode: (value) => {
				mode = value;
                writeFileSync(path.join(machine.root, "jev-http-timeout"), value === "timeout" ? "200" : "30000");
			},
			run, seen: () => seen, release,
		});
		const sweep = machine.sweepText();
		for (const secret of [
			PROVIDER_TOKEN,
			SERVICE_TOKEN,
			"SENTINEL_AMBIENT_TYPESAFE_TOKEN",
			"SENTINEL_REJECTED_INPUT_SECRET",
			"secret error body must never be echoed", "SENTINEL_PRIVATE_EMAIL_EXCERPT", "SENTINEL_REPLY_EXTRA",
		])
			for (const surface of [...outputs, sweep]) expect(surface).not.toContain(secret);
		expect(machine.lines("hostile-recorders.jsonl")).toEqual([]);
		expect(machine.lines("hostile-mcporter.jsonl")).toEqual([]);
	} finally {
        release();
		machine.dispose();
		server.stop(true);
	}
}
const infer = (input: unknown = INPUT) => ["run", "jev", "system_one", "--input", JSON.stringify(input)];
test("JEV declares exactly two owned tools without acquiring capability", async () => {
	expect(API_ORIGIN).toBe("https://api.typesafe.ai");
	await fixture(async ({ run, requests }) => {
		const schema = await run(["schema", "jev"]);
		expect(Array.isArray(schema.data?.tools) ? schema.data.tools.map((tool) => (record(tool) ? tool.name : null)) : null).toEqual([
			"list_models",
			"system_one",
		]);
		expect(schema.data?.schemaSource).toBe("packaged-declaration");
		const config = JSON.parse(readFileSync(path.join(import.meta.dir, "../config/mcporter.json"), "utf8"));
		expect(config.imports).toEqual([]);
		expect(config.mcpServers.jev.allowedTools).toEqual(["list_models", "system_one"]);
		expect(requests).toHaveLength(0);
	}, false);
}, 30000);
test("JEV malformed input refuses before custody, dependency or state creation", async () => {
	await fixture(async ({ run, machine, requests }) => {
        let nested: unknown = "synthetic leaf";
        for (let i = 0; i < 64; i++) nested = { child: nested };
		for (const input of [
			{},
			{ ...INPUT, model: "jev-latest" },
            { ...INPUT, questions: { fruit: { type: "choice", criteria: { apple: nested } } } },
			{ ...INPUT, assets: {}, hidden: "SENTINEL_REJECTED_INPUT_SECRET" },
			{ ...INPUT, questions: { score: { type: "score", criteria: ["low"] } } },
			{ ...INPUT, state: "x".repeat(262145) },
		]) {
			const result = await run(infer(input));
			expect(result.causeCode).toBe("SCHEMA_ADAPTER_REFUSED");
			expect(result.data?.connectorCause).toBe("input-invalid");
		}
		expect(requests).toHaveLength(0);
		expect(machine.lines("op-calls.jsonl")).toEqual([]);
		expect(existsSync(path.join(machine.state, "connectors/jev"))).toBe(false);
	}, false);
}, 30000);
qualifiedTest("JEV configured custody check and models read have distinct meanings", async () => {
	await fixture(async ({ run, requests }) => {
		const check = await run(["auth", "check", "jev"]);
		expect(check.data).toMatchObject({
			custodyChecked: true,
			authenticated: false,
		});
		expect(requests).toHaveLength(0);
		const models = await run(["run", "jev", "list_models"]);
		expect(models.data).toMatchObject({
			models: [
				{
					name: "jev-1.14.0",
					description: "Synthetic fixture",
					release_date: "2026-10-14",
				},
			],
			requestId: "fixture-models",
		});
		expect(requests).toEqual([{ method: "GET", route: "/v1/models", body: null, authorized: true }]);
	});
}, 30000);
qualifiedTest("JEV returns typed choice/noul, distributions, confidence, usage and request ID once", async () => {
	await fixture(async ({ run, requests, machine }) => {
		const result = await run(infer());
		expect(result.causeCode).toBe("SUCCESS_INFERENCE_COMPLETED");
		expect(result.effects).toMatchObject({
			completed: ["mcporter-bootstrap", "inference-receipt", "paid-inference"],
			uncertain: [],
		});
		expect(result.data).toMatchObject({
			...ANSWER,
			requestId: "fixture-answer",
			outcome: "answered",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({
			method: "POST",
			route: "/v1/systemone",
			body: {
				model: INPUT.model,
				state: INPUT.state,
				questions: INPUT.questions,
			},
			authorized: true,
		});
		const repeat = await run(infer());
		expect(repeat.data?.noCall).toBe(true);
		expect(requests).toHaveLength(1);
		const mismatch = await run(infer({ ...INPUT, state: "other" }));
		expect(mismatch.data?.connectorCause).toBe("request-key-mismatch");
		const directory = path.join(machine.state, "connectors/jev/inferences");
		expect(statSync(directory).mode & 0o777).toBe(0o700);
		const files = readdirSync(directory);
		expect(files).toHaveLength(2);
		for (const name of files) {
			expect(statSync(path.join(directory, name)).mode & 0o777).toBe(0o600);
			expect(readFileSync(path.join(directory, name), "utf8")).not.toContain("Synthetic apples");
		}
	});
}, 30000);
for (const failure of ["http-429", "http-529", "http-500", "malformed", "mismatch", "timeout"] as const)
	qualifiedTest(`JEV ${failure} remains unknown and same-key replay never sends again`, async () => {
		await fixture(async ({ run, mode, requests }) => {
			mode(failure);
			const result = await run(infer());
			expect(result.causeCode).toBe("DOMAIN_INFERENCE_UNKNOWN");
			expect(result).toMatchObject({ outcome: "failed", exitCode: 3, effectClass: "external", transactionState: "unknown", failureClass: "domain", retryable: false, nextAction: "connectors.recover" });
			expect(result.effects.uncertain).toEqual(["paid-inference"]);
			expect(result.effects.completed).not.toContain("provider-write");
			expect(requests).toHaveLength(1);
			const blocked = await run(infer());
			expect(blocked.data?.connectorCause).toBe("inference-replay-blocked");
			expect(requests).toHaveLength(1);
			const recovery = await run(["recover", "jev", "--run", String(result.data?.runId)]);
			expect(recovery.data).toMatchObject({
				remoteOutcomeResolved: false,
				replayPermitted: false,
			});
			expect(recovery.data?.receipts).toHaveLength(1);
			expect((await run(["recover", "jev", "--run", String(result.data?.runId), "--unlock"])).data?.connectorCause).toBe("inference-inspect-only");
		});
	}, 30000);
test("JEV inference stations are declared in public discovery", async () => {
	await fixture(async ({ run }) => {
		const discovered = await run(["--discover-command", "connectors.run", "--json"]);
		expect(JSON.stringify(discovered.data)).toContain("SUCCESS_INFERENCE_COMPLETED");
		expect(JSON.stringify(discovered.data)).toContain("DOMAIN_INFERENCE_UNKNOWN");
	});
}, 30000);

qualifiedTest("JEV concurrent callers of one request key make at most one inference", async () => {
	await fixture(async ({ run, requests }) => {
		// Establish MCPorter selection before racing only the inference reservation.
		await run(["run", "jev", "list_models"]);
		const results = await Promise.all([run(infer()), run(infer())]);
		expect(requests.filter((request) => request.route === "/v1/systemone")).toHaveLength(1);
		expect(results.filter((result) => result.causeCode === "SUCCESS_INFERENCE_COMPLETED")).toHaveLength(1);
		expect(
			results.some(
				(result) =>
					result.data?.noCall === true ||
					result.data?.connectorCause === "ledger-reservation-refused" ||
					result.data?.connectorCause === "inference-replay-blocked",
			),
		).toBe(true);
	});
}, 30000);
qualifiedTest("JEV surviving reserved/sending receipts block replay and malformed receipts fail closed", async () => {
	await fixture(async ({ run, requests, machine }) => {
		const completed = await run(infer());
		const receiptFile = path.join(machine.state, "connectors/jev/inferences", `${String(completed.data?.runId)}.json`);
		const saved = JSON.parse(readFileSync(receiptFile, "utf8"));
		for (const status of ["reserved", "sending"]) {
			writeFileSync(receiptFile, JSON.stringify({ ...saved, status }), {
				mode: 0o600,
			});
			expect((await run(infer())).data?.connectorCause).toBe("inference-replay-blocked");
		}
		writeFileSync(receiptFile, "{malformed", { mode: 0o600 });
		expect((await run(infer())).data?.connectorCause).toBe("ledger-reservation-refused");
		expect((await run(["recover", "jev"])).data?.connectorCause).toBe("ledger-unavailable");
		expect(requests).toHaveLength(1);
	});
}, 30000);

const PRIVATE_MARKER = "SENTINEL_PRIVATE_EMAIL_EXCERPT";
function privateFile(machine: JevMachine, input: unknown = { ...INPUT, state: { text: PRIVATE_MARKER } }): string {
 const file = path.join(machine.root, "private-input.json");
 writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
 return file;
}
qualifiedTest("JEV private file input reaches the provider without a payload in any process arguments", async () => {
 await fixture(async ({ run, mode, machine, requests, seen, release }) => {
  mode("hold");
  const file = privateFile(machine);
  const proc = machine.start(["run", "jev", "system_one", "--input-file", file]); proc.stdin.end();
  const output = new Response(proc.stdout).text(); const errors = new Response(proc.stderr).text();
  try {
   await Promise.race([seen(), Bun.sleep(15000).then(() => { throw new Error("fixture request did not arrive"); })]);
   expect(requests).toHaveLength(1);
   expect(requests[0]?.body).toEqual({ model: "jev-1.14.0", state: { text: PRIVATE_MARKER }, questions: INPUT.questions });
   const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((row) => row.trim().split(/\s+/).map(Number));
   const selected = new Set([proc.pid]);
   for (let i = 0; i < rows.length; i++) for (const [pid, parent] of rows) if (pid !== undefined && parent !== undefined && selected.has(parent)) selected.add(pid);
   expect(selected.size).toBeGreaterThan(1);
   const argv = execFileSync("/bin/ps", ["-p", [...selected].join(","), "-o", "args="], { encoding: "utf8" });
   expect(argv).toContain("requestJson=@"); expect(argv).not.toContain(PRIVATE_MARKER);
   const staged = path.join(machine.state, "connectors/private-input");
   const files = readdirSync(staged); expect(files).toHaveLength(1);
   for (const name of files) expect(statSync(path.join(staged, name)).mode & 0o777).toBe(0o600);
   release();
   expect(await proc.exited).toBe(0); expect(await errors).toBe("");
   const result: Envelope = JSON.parse(await output); expect(result.result.causeCode).toBe("SUCCESS_INFERENCE_COMPLETED");
   expect(JSON.stringify(result)).not.toContain(PRIVATE_MARKER); expect(readdirSync(staged)).toEqual([]);
   expect((await run(["run", "jev", "system_one", "--input-file", file])).data?.noCall).toBe(true);
   expect(requests).toHaveLength(1);
  } finally { release(); if (proc.exitCode === null) proc.kill(); await proc.exited; }
 });
}, 30000);
qualifiedTest("JEV stdin input preserves private structured state and exactly one inference", async () => {
 await fixture(async ({ run, requests }) => {
  const input = { ...INPUT, state: { text: PRIVATE_MARKER } };
  const args = ["run", "jev", "system_one", "--input-file", "-"];
  expect((await run(args, JSON.stringify(input))).causeCode).toBe("SUCCESS_INFERENCE_COMPLETED");
  expect(requests).toHaveLength(1); expect(requests[0]?.body).toEqual({ model: input.model, state: input.state, questions: input.questions });
  expect((await run(args, JSON.stringify(input))).data?.noCall).toBe(true); expect(requests).toHaveLength(1);
 });
}, 30000);
test("private file and stdin refusals acquire no custody or provider capability", async () => {
 await fixture(async ({ run, machine, requests }) => {
  const file = privateFile(machine);
  const invoke = (target: string) => run(["run", "jev", "system_one", "--input-file", target]);
  for (const text of ["{SENTINEL_PRIVATE_EMAIL_EXCERPT", "[]", "null", "x".repeat(262145)]) {
   writeFileSync(file, text); expect((await invoke(file)).data?.connectorCause).toBe("private-input-invalid");
  }
  writeFileSync(file, JSON.stringify(INPUT)); chmodSync(file, 0o644);
  expect((await invoke(file)).data?.connectorCause).toBe("private-input-invalid"); chmodSync(file, 0o600);
  symlinkSync(file, path.join(machine.root, "input-link")); expect((await invoke(path.join(machine.root, "input-link"))).data?.connectorCause).toBe("private-input-invalid");
  const fifo = path.join(machine.root, "input-fifo");
  execFileSync("/usr/bin/mkfifo", [fifo]);
  expect((await invoke(fifo)).data?.connectorCause).toBe("private-input-invalid");
  for (const target of [machine.root, path.join(machine.root, "missing")]) expect((await invoke(target)).data?.connectorCause).toBe("private-input-invalid");
  writeFileSync(file, Buffer.from([0xff, 0xfe])); expect((await invoke(file)).data?.connectorCause).toBe("private-input-invalid");
  expect((await run(["run", "jev", "system_one", "--input-file", "-"], "")).data?.connectorCause).toBe("private-input-invalid");
  expect((await run(["run", "jev", "system_one", "--input-file", "-"], "x".repeat(262145))).data?.connectorCause).toBe("private-input-invalid");
  expect((await run(["run", "jev", "system_one", "--input", "{}", "--input-file", file])).causeCode).toBe("USAGE_MALFORMED_ARGUMENTS");
  expect(requests).toHaveLength(0); expect(machine.lines("op-calls.jsonl")).toEqual([]);
  expect(existsSync(path.join(machine.state, "connectors/jev"))).toBe(false);
 }, false);
}, 30000);
test("held-open private stdin times out without starting an inference", async () => {
 await fixture(async ({ machine, requests }) => {
  const proc = machine.start(["run", "jev", "system_one", "--input-file", "-"]);
  const output = new Response(proc.stdout).text(); const error = new Response(proc.stderr).text();
  try {
   proc.stdin.write(JSON.stringify(INPUT));
   expect(await proc.exited).toBe(4);
   const envelope: Envelope = JSON.parse(await output); expect(envelope.result.data?.connectorCause).toBe("private-input-invalid");
   expect(await error).toBe(""); expect(requests).toHaveLength(0); expect(machine.lines("op-calls.jsonl")).toEqual([]);
  } finally { proc.stdin.end(); if (proc.exitCode === null) proc.kill(); await proc.exited; }
 }, false);
}, 10000);
qualifiedTest("JEV answer projections discard extra fields instead of returning arbitrary provider data", async () => {
 await fixture(async ({ run, mode }) => {
  mode("extras"); const result = await run(infer());
  expect(result.causeCode).toBe("SUCCESS_INFERENCE_COMPLETED");
  expect(result.data?.answers).toEqual(ANSWER.answers);
  expect(JSON.stringify(result)).not.toContain("SENTINEL_REPLY_EXTRA");
 });
}, 30000);
qualifiedTest("JEV oversized reply remains unknown and never replays", async () => {
 await fixture(async ({ run, mode, requests }) => {
  mode("oversized"); const result = await run(infer()); expect(result.causeCode).toBe("DOMAIN_INFERENCE_UNKNOWN");
  expect((await run(infer())).data?.connectorCause).toBe("inference-replay-blocked"); expect(requests).toHaveLength(1);
 });
}, 30000);
test("run discovery declares private file or stdin without acquiring capability", async () => {
 await fixture(async ({ run, requests }) => {
  const result = await run(["--discover-command", "connectors.run", "--json"]);
  const command = result.data?.command;
  if (!record(command) || !Array.isArray(command.input)) throw new Error("run command discovery missing");
  expect(command.effectClass).toBe("external");
  expect(command.input.find((entry) => record(entry) && entry.token === "--input-file")).toEqual({ position: 4, kind: "option", token: "--input-file", value: { type: "string" }, required: false, repeatable: false, onlyWhen: "instead of --input" });
  expect(requests).toHaveLength(0);
 }, false);
}, 30000);
