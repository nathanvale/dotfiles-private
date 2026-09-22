// Generic Provider process plumbing below MCPorter: fixed-prefix refusals,
// argument refusal, PATH lookup, environment scrubbing, and process
// replacement. It names no service and never prints a secret value.
import { existsSync } from "node:fs";
import path from "node:path";
import { type EnvironmentSource, safeEnvironment } from "./safe-environment.ts";

// Exit meanings follow Contract Core 2.0 for refusals: 2 usage, 3 domain, 4 schema.
export type RefusalExit = 2 | 3 | 4;

export interface ProviderProcess {
	fail(code: string, message: string, exitCode?: RefusalExit): never;
	refuseArguments(argv: string[]): void;
	executableOnPath(name: string): string;
	cleanEnvironment(): Record<string, string>;
	// Replace this process so no resident parent sits between MCPorter and the
	// credential-bearing child.
	replaceProcess(file: string, argv: string[], environment: Record<string, string>): never;
}

export function singleLine(value: string | undefined): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\n") && !value.includes("\r");
}

// `fail` carries an explicit annotation so its callers narrow on `never`.
export function providerProcess(program: string, env: EnvironmentSource = process.env): ProviderProcess {
	const fail: ProviderProcess["fail"] = (code, message, exitCode = 4) => {
		process.stderr.write(`${program}:error:${code}:${message}\n`);
		process.exit(exitCode);
	};
	return {
		fail,
		refuseArguments(argv) {
			if (argv.length !== 0) fail("arguments-invalid", "no provider arguments are accepted", 2);
		},
		executableOnPath(name) {
			const found = Bun.which(name, { PATH: env.PATH ?? "" });
			if (!found || !existsSync(found)) fail("executable-missing", `${name} is not available on PATH`);
			return found;
		},
		cleanEnvironment() {
			return safeEnvironment(env);
		},
		replaceProcess(file, argv, environment) {
			const execve = process.execve;
			if (!execve) fail("execve-unavailable", "this Bun runtime cannot replace the process");
			execve(file, argv, environment);
			fail("exec-failed", `${path.basename(file)} did not start`);
		},
	};
}
