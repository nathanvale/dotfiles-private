// The loopback redirect listener for one attended login: 127.0.0.1 only, one
// callback path, single use, exact state match, error parameter honoured, a
// bounded wait, and a fixed response body that never echoes a code or token.
export type CallbackFailure = "state-mismatch" | "authorization-denied" | "callback-timeout" | "callback-invalid";
export type CallbackResult = { ok: true; code: string } | { ok: false; reason: CallbackFailure };

export interface CallbackListener {
	redirectUri: string;
	port: number;
	result: Promise<CallbackResult>;
	close(): void;
}

const CALLBACK_PATH = "/callback";
const DONE_BODY = "<!doctype html><title>Canva login</title><p>Login received. You can close this window.</p>";
const FAILED_BODY = "<!doctype html><title>Canva login</title><p>Login was not completed. Return to the terminal.</p>";
const html = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

function classify(url: URL, state: string): CallbackResult {
	if (url.searchParams.has("error")) return { ok: false, reason: "authorization-denied" };
	const code = url.searchParams.get("code");
	const observedState = url.searchParams.get("state");
	if (observedState !== state) return { ok: false, reason: "state-mismatch" };
	if (!code || code.length > 4096 || /[\r\n]/.test(code)) return { ok: false, reason: "callback-invalid" };
	return { ok: true, code };
}

export function listenForCallback(options: { port: number; state: string; timeoutMs: number }): CallbackListener {
	let settle: (result: CallbackResult) => void = () => undefined;
	const result = new Promise<CallbackResult>((resolve) => {
		settle = resolve;
	});
	let consumed = false;
	const finish = (outcome: CallbackResult) => {
		if (consumed) return;
		consumed = true;
		clearTimeout(timer);
		settle(outcome);
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port,
		fetch(request) {
			const url = new URL(request.url);
			if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) return html(FAILED_BODY, 404);
			if (consumed) return html(FAILED_BODY, 410);
			const outcome = classify(url, options.state);
			finish(outcome);
			return html(outcome.ok ? DONE_BODY : FAILED_BODY, outcome.ok ? 200 : 400);
		},
	});
	const timer = setTimeout(() => finish({ ok: false, reason: "callback-timeout" }), options.timeoutMs);
	const port = server.port ?? options.port;
	return {
		redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
		port,
		result,
		close() {
			finish({ ok: false, reason: "callback-timeout" });
			server.stop(true);
		},
	};
}
