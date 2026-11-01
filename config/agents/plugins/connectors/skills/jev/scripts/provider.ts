import { providerProcess } from "../../../bin/provider-process.ts";
import { contextItem, readCredential } from "./custody/index.ts";
import { inferenceInput, inferenceResponse, modelsResponse, operationInput, record, WIRE_TOOL_SCHEMAS } from "./catalogue.ts";
import { API_ORIGIN, HTTP_TIMEOUT_MS } from "./endpoint.ts";
import { claimSend, save } from "./ledger.ts";
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const proc = providerProcess("jev-provider");
const fail: typeof proc.fail = proc.fail;
const write = (message: unknown) => {
	process.stdout.write(`${JSON.stringify(message)}\n`);
};
const requestIdOf = (response: Response) => {
	const id = response.headers.get("x-typesafe-request-id");
	return id !== null && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
};
async function http(route: string, credential: string, body?: string): Promise<Response> {
	return fetch(`${API_ORIGIN}${route}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			authorization: `Bearer ${credential}`,
			"content-type": "application/json",
		},
		...(body === undefined ? {} : { body }),
		redirect: "error",
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
	});
}
async function responseJson(response: Response): Promise<unknown> {
 const chunks: Uint8Array[] = []; let size = 0;
 if (!response.body) throw new Error("reply-empty");
 const reader = response.body.getReader();
 try {
  while (true) {
   const next = await reader.read(); if (next.done) break;
   size += next.value.byteLength;
   if (size > MAX_REPLY_BYTES) throw new Error("reply-too-large");
   chunks.push(next.value);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
 } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function wireInput(name: string, value: unknown): unknown {
 if (name !== "system_one") return value;
 if (!record(value) || Object.keys(value).length !== 1 || typeof value.requestJson !== "string") return null;
 try { return JSON.parse(value.requestJson); } catch { return null; }
}
async function inference(input: unknown, credential: string): Promise<unknown> {
	if (!inferenceInput(input)) return { outcome: "refused", cause: "input-invalid" };
	const sending = claimSend(process.env, input);
	if (sending === null) return { outcome: "refused", cause: "replay-blocked" };
	let requestId: string | null = null;
	try {
		const response = await http(
			"/v1/systemone",
			credential,
			JSON.stringify({
				model: input.model,
				state: input.state,
				questions: input.questions,
			}),
		);
		requestId = requestIdOf(response);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error("http-rejected");
		}
		const data = inferenceResponse(await responseJson(response), input, requestId);
		if (
			data !== null &&
			save(process.env, {
				...sending,
				status: "answered",
				requestId,
				usage: data.usage,
			})
		)
			return { outcome: "answered", ...data };
	} catch {
		/* A sent request can be billed even if no valid reply arrives. */
	}
	save(process.env, { ...sending, status: "unknown", requestId });
	return {
		outcome: "unknown",
		cause: "inference-outcome-unknown",
		runId: sending.runId,
		requestId,
	};
}
async function tool(name: string, input: unknown, credential: string): Promise<unknown> {
	if (!operationInput(name, input)) return { outcome: "refused", cause: "input-invalid" };
	if (name === "system_one") return inference(input, credential);
	try {
		const response = await http("/v1/models", credential);
		if (!response.ok) {
			await response.body?.cancel();
			return { outcome: "refused", cause: "models-http-rejected" };
		}
		const models = modelsResponse(await responseJson(response));
		return models === null ? { outcome: "refused", cause: "models-reply-malformed" } : { outcome: "listed", models, requestId: requestIdOf(response) };
	} catch {
		return { outcome: "refused", cause: "models-unavailable" };
	}
}
async function handle(line: string, credential: string): Promise<void> {
	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (!record(message) || !(typeof message.id === "number" || typeof message.id === "string")) return;
	const reply = (result: unknown) => write({ jsonrpc: "2.0", id: message.id, result });
	if (message.method === "initialize") {
		reply({
			protocolVersion: record(message.params) ? message.params.protocolVersion : "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: { name: "connectors-jev", version: "1" },
		});
		return;
	}
	if (message.method === "tools/list") {
		reply({ tools: WIRE_TOOL_SCHEMAS });
		return;
	}
	if (message.method !== "tools/call" || !record(message.params) || typeof message.params.name !== "string") {
		write({
			jsonrpc: "2.0",
			id: message.id,
			error: { code: -32601, message: "method-not-admitted" },
		});
		return;
	}
	const result = await tool(message.params.name, wireInput(message.params.name, message.params.arguments), credential);
	reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
}
export async function runProvider(argv: readonly string[]): Promise<void> {
	const preflight = argv.length === 1 && argv[0] === "--preflight";
	if (!preflight) proc.refuseArguments([...argv]);
	const item = contextItem(process.env);
	if (item === null) fail("context-invalid", "restart through connectors run jev", 2);
	const read = readCredential(item, process.env);
	if (!read.ok) fail(read.cause, "JEV custody could not produce the credential", 3);
	if (preflight) return;
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of Bun.stdin.stream()) {
		buffered += decoder.decode(chunk, { stream: true });
		let newline = buffered.indexOf("\n");
		while (newline !== -1) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			await handle(line, read.credential);
			newline = buffered.indexOf("\n");
		}
	}
	if (buffered.trim() !== "") await handle(buffered, read.credential);
}
