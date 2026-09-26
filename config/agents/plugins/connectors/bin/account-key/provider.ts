// The account-key Provider, run only as an account-key adapter's internal
// provider role of the compiled front door. MCPorter starts it with no
// arguments; the adapter's preflight and `auth check` start it with
// --preflight alone. It reads the item named on the internal channel through
// 1Password custody, then relays MCPorter's newline JSON-RPC on stdio to the
// connector's one fixed endpoint with `Authorization: Bearer <key>`. The key
// lives only in this process's memory: never in MCPorter, an argument, an
// environment, a file, or any output, and it ends when MCPorter closes stdin.
// A request the endpoint rejects for authentication is answered with a fixed
// error naming key-rejected, and the relay never retries without the key.
import { CREDENTIAL_VAULT, type KeychainReader, readOnePasswordItem } from "../one-password-custody.ts";
import { type ProviderProcess, providerProcess } from "../provider-process.ts";
import { INTERNAL_INVOCATION_CONTEXT_ENV, type EnvironmentSource } from "../safe-environment.ts";
import { isItemId } from "./registration.ts";

export interface ProviderConnector {
	readonly id: string;
	readonly endpoint: string;
	readonly readKeychain: KeychainReader;
}

// A header-safe key: one run of visible ASCII, so no value can split or add
// a header.
const KEY_SHAPE = /^[\x21-\x7e]{1,4096}$/;
const ACCEPT = "application/json, text/event-stream";
// The fixed marker a rejected key leaves in a JSON-RPC error message; the
// adapter looks for it in MCPorter's output. It carries no header or body.
export const keyRejectedMarker = (id: string): string => `${id}-relay:key-rejected`;

// The one channel shape: exactly {"item"} with a strict item ID.
export const accountContext = (item: string): string => JSON.stringify({ item });

function contextItem(env: EnvironmentSource): string | null {
	try {
		const parsed = JSON.parse(env[INTERNAL_INVOCATION_CONTEXT_ENV] ?? "") as Record<string, unknown> | null;
		return parsed !== null && typeof parsed === "object" && Object.keys(parsed).join(",") === "item" && isItemId(parsed.item) ? parsed.item : null;
	} catch {
		return null;
	}
}

// The item's one field labelled credential, only when the item is the one
// requested and the value is header-safe.
function keyOf(item: unknown, itemId: string): string | null {
	if (typeof item !== "object" || item === null || (item as { id?: unknown }).id !== itemId) return null;
	const fields = (item as { fields?: unknown }).fields;
	if (!Array.isArray(fields)) return null;
	const values = fields.filter((field) => typeof field === "object" && field !== null && String((field as { label?: unknown }).label ?? "").toLowerCase() === "credential").map((field) => (field as { value?: unknown }).value);
	const [value] = values;
	return values.length === 1 && typeof value === "string" && KEY_SHAPE.test(value) ? value : null;
}

type Message = { id?: unknown; method?: unknown };

function write(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Every `data:` payload of an event stream, one JSON-RPC message each.
function eventMessages(text: string): unknown[] {
	const messages: unknown[] = [];
	for (const event of text.split(/\r?\n\r?\n/)) {
		const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
		if (data !== "") messages.push(JSON.parse(data));
	}
	return messages;
}

async function replies(response: Response): Promise<unknown[]> {
	const text = await response.text();
	if (text.trim() === "") return [];
	if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) return eventMessages(text);
	const parsed: unknown = JSON.parse(text);
	return Array.isArray(parsed) ? parsed : [parsed];
}

function relayTo(connector: ProviderConnector, key: string): (line: string) => Promise<void> {
	let session: string | null = null;
	const answer = (message: Message, code: string) => {
		if (message.id !== undefined && message.method !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `${connector.id}-relay:${code}` } });
	};
	return async (line) => {
		let message: Message;
		try {
			message = JSON.parse(line) as Message;
		} catch {
			return;
		}
		try {
			const headers: Record<string, string> = { "content-type": "application/json", accept: ACCEPT, authorization: `Bearer ${key}` };
			if (session !== null) headers["mcp-session-id"] = session;
			const response = await fetch(connector.endpoint, { method: "POST", headers, body: line, redirect: "error" });
			session = response.headers.get("mcp-session-id") ?? session;
			if (response.status === 401 || response.status === 403) return answer(message, "key-rejected");
			if (!response.ok) return answer(message, `http-${response.status}`);
			for (const reply of await replies(response)) write(reply);
		} catch {
			answer(message, "unreachable");
		}
	};
}

async function relay(send: (line: string) => Promise<void>): Promise<void> {
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of Bun.stdin.stream()) {
		buffered += decoder.decode(chunk, { stream: true });
		for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (line !== "") await send(line);
		}
	}
	if (buffered.trim() !== "") await send(buffered.trim());
}

export async function runProvider(connector: ProviderConnector, argv: readonly string[]): Promise<void> {
	const proc = providerProcess(`${connector.id}-provider`);
	// Annotated so its callers narrow on `never`.
	const fail: ProviderProcess["fail"] = proc.fail;
	const preflight = argv.length === 1 && argv[0] === "--preflight";
	if (!preflight) proc.refuseArguments([...argv]);
	const item = contextItem(process.env);
	if (item === null) fail("context-invalid", `restart through connectors run ${connector.id}`, 2);
	const read = readOnePasswordItem(item, process.env, connector.readKeychain);
	if (!read.ok) fail(read.cause, `account custody could not produce the ${CREDENTIAL_VAULT} key`, 3);
	const key = keyOf(read.item, item);
	if (key === null) fail("credential-invalid", "the item has no single header-safe credential field", 3);
	if (preflight) process.exit(0);
	await relay(relayTo(connector, key));
	process.exit(0);
}
