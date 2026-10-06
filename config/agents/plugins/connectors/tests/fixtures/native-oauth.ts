// Native MCPorter OAuth process evidence shared by packaged connector tests.
import { closeSync, constants, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

// Denies outbound network and any Keychain command. macOS refuses a nested
// sandbox with a different profile, so a runner that wraps this suite in its
// own sandbox must use this exact profile.
export const DENY_NETWORK = '(version 1)(allow default)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))(deny process-exec (literal "/usr/bin/security"))';

export function ownedVault(root: string): string {
	for (const directory of [root, path.join(root, "data"), path.join(root, "cache"), path.join(root, "data", "mcporter")]) mkdirSync(directory, { recursive: true, mode: 0o700 });
	return path.join(root, "data", "mcporter", "credentials.json");
}


// Pid to args for every process, without environments.
function processArgs(): Map<string, string> {
	const table = new Map<string, string>();
	for (const line of execFileSync("/bin/ps", ["-axww", "-o", "pid=,args="], { encoding: "utf8" }).split("\n")) {
		const row = /^\s*(\d+) (.*)$/.exec(line);
		if (row?.[1] !== undefined && row[2] !== undefined) table.set(row[1], row[2]);
	}
	return table;
}

// One process's args followed by its environment. ps reads only that pid, so
// no other process's environment is ever collected. A pid that has already
// exited yields an empty string, never ps's error text.
function processArgsWithEnv(pid: string): string {
	try {
		return execFileSync("/bin/ps", ["-Eww", "-o", "args=", "-p", pid], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

// Holds MCPorter on a FIFO vault file and reads its argv and environment from
// the process table while it waits, then releases it onto a regular grant-free
// vault so any later read finds a file. Returns the argv from `verb` on and the
// environment entries, or null when MCPorter never opened the vault. Paths and
// environment values under the fixture hold no spaces.
export async function heldMcporter(fifo: string, state: string, verb: string, done: Promise<unknown>): Promise<{ argv: string[]; env: string[] } | null> {
	let settled = false;
	void done.finally(() => { settled = true; });
	while (!settled) {
		let fd: number;
		try {
			fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
		} catch {
			await Bun.sleep(5);
			continue;
		}
		const held = [...processArgs()].find(([, args]) => args.startsWith(`${state}/`) && args.includes(` ${verb} `));
		const withEnv = held ? processArgsWithEnv(held[0]) : "";
		const empty = JSON.stringify({ version: 2, entries: {} });
		writeFileSync(`${fifo}.next`, empty, { mode: 0o600 });
		renameSync(`${fifo}.next`, fifo);
		writeSync(fd, empty);
		closeSync(fd);
		if (!held) return null;
		const args = held[1].trim();
		const argv = args.split(" ");
		return { argv: argv.slice(argv.indexOf(verb)), env: withEnv.slice(args.length).trim().split(" ") };
	}
	return null;
}

