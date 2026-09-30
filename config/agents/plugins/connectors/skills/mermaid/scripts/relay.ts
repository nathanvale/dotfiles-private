// The Mermaid Provider's stdio-to-HTTP relay: MCPorter speaks newline JSON-RPC
// on stdin and stdout; each message is POSTed to the one account endpoint
// with the Authorization header, and every JSON-RPC message in the reply,
// plain JSON or server-sent events, is written back as one line. It holds no
// daemon and outlives no MCPorter: stdin's end is its exit. A failed request
// answers its id with a fixed error that carries no header, body, or token.

const ACCEPT = "application/json, text/event-stream";

type Message = { id?: unknown; method?: unknown };

function write(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function failure(message: Message, code: string): void {
	if (message.id !== undefined && message.method !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `mermaid-relay:${code}` } });
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

async function replyMessages(response: Response): Promise<unknown[]> {
	const type = response.headers.get("content-type") ?? "";
	const text = await response.text();
	if (text.trim() === "") return [];
	if (type.includes("text/event-stream")) return eventMessages(text);
	const parsed: unknown = JSON.parse(text);
	return Array.isArray(parsed) ? parsed : [parsed];
}

export async function relay(endpoint: string, authorization: string): Promise<void> {
	let session: string | null = null;
	const decoder = new TextDecoder();
	let buffered = "";
	const send = async (line: string) => {
		let message: Message;
		try {
			message = JSON.parse(line) as Message;
		} catch {
			return;
		}
		try {
			const headers: Record<string, string> = { "content-type": "application/json", accept: ACCEPT, authorization };
			if (session !== null) headers["mcp-session-id"] = session;
			const response = await fetch(endpoint, { method: "POST", headers, body: line, redirect: "error" });
			session = response.headers.get("mcp-session-id") ?? session;
			if (!response.ok) return failure(message, `http-${response.status}`);
			for (const reply of await replyMessages(response)) write(reply);
		} catch {
			failure(message, "unreachable");
		}
	};
	for await (const chunk of Bun.stdin.stream()) {
		buffered += decoder.decode(chunk, { stream: true });
		let newline = buffered.indexOf("\n");
		while (newline !== -1) {
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (line !== "") await send(line);
			newline = buffered.indexOf("\n");
		}
	}
	if (buffered.trim() !== "") await send(buffered.trim());
}
