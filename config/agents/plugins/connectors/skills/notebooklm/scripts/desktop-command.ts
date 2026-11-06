import desktopSource from "./desktop-command.py" with { type: "text" };

export interface CommandReply {
	stdout: string;
	exit: number;
	cause?: string;
}

async function capture(argv: string[], env: Record<string, string>, timeout: number, limit: number, input?: string): Promise<CommandReply> {
	const child = Bun.spawn(argv, { env, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "ignore" });
	if (input !== undefined && typeof child.stdin !== "number" && child.stdin != null) {
		child.stdin.write(input);
		child.stdin.end();
	}
	const reader = child.stdout.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let cause: string | undefined;
	const stop = (reason: string) => {
		cause = reason;
		child.kill("SIGKILL");
		void reader.cancel();
	};
	// Bound inherited stdout descriptors too, even after the root process exits.
	const timer = setTimeout(() => stop("desktop-request-timeout"), timeout);
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) { stop("desktop-result-too-large"); break; }
			chunks.push(value);
		}
		const exit = await child.exited;
		return cause ? { stdout: "", exit: 1, cause } : { stdout: Buffer.concat(chunks).toString("utf8"), exit };
	} finally { clearTimeout(timer); reader.releaseLock(); }
}

function desktopReply(stdout: string): CommandReply {
	try {
		const reply: unknown = JSON.parse(stdout);
		if (typeof reply !== "object" || reply === null || !("status" in reply) || !Number.isInteger(reply.status) || typeof reply.status !== "number" || reply.status < 0 || reply.status > 255) throw new Error("invalid status");
		return {
			stdout: "stdout" in reply && typeof reply.stdout === "string" ? reply.stdout : "",
			exit: reply.status,
			...("cause" in reply && typeof reply.cause === "string" ? { cause: reply.cause } : {}),
		};
	} catch { return { stdout: "", exit: 1, cause: "desktop-route-failed" }; }
}

export async function runNotebooklmCommand(argv: string[], env: Record<string, string>): Promise<CommandReply> {
	if (process.platform !== "darwin") return capture(argv, env, 65000, 8_000_000);
	const manager = Bun.spawnSync(["/bin/launchctl", "managername"], { stdout: "pipe", stderr: "ignore", timeout: 5000, killSignal: "SIGKILL" });
	if (manager.exitCode !== 0) return { stdout: "", exit: 1, cause: "desktop-context-unavailable" };
	if (manager.stdout.toString().trim() !== "Background") return capture(argv, env, 65000, 8_000_000);
	// The explicit caller PID survives helper reparenting during startup. The
	// helper's own deadline and cleanup finish before this last-resort bound.
	const captured = await capture(["/usr/bin/python3", "-c", desktopSource], env, 85000, 50_000_000, JSON.stringify({ argv, env, owner: process.pid }));
	if (captured.exit !== 0 || captured.cause) return { stdout: "", exit: 1, cause: captured.cause ?? "desktop-route-failed" };
	return desktopReply(captured.stdout);
}
