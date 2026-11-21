// Linux pilot credential custody. A pilot worker never holds the 1Password
// service-account token, so on Linux an account key reaches Connectors only
// through the pilot operator's credential delivery: a host process outside
// the container reads one 1Password item and stores its value, on stdin, in
// a git credential-cache receiver behind a private socket, under a lease the
// sender keeps refreshing. That receiver holds the value in memory only.
//
// This module asks that receiver once, at call time, from the Provider role
// that needs the key. A get never starts a receiver, never calls op, and
// never reads a file. The answer must name the registered item ID as its
// username, so a value delivered for another item is never used. The value
// returns to the caller process as the same item record shape a 1Password
// read returns, so each Provider keeps its own credential-field rules.
// Nothing here prints, logs, stores, or returns the value elsewhere. Read
// docs/adr/0009-run-connectors-in-the-linux-pilot.md before changing it.
import { spawnSync } from "node:child_process";
import { lstatSync, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isItemId } from "./account-key/registration.ts";
import type { EnvironmentSource } from "./safe-environment.ts";

const RECEIVER_GIT = "/usr/bin/git";

// Nonsecret coordinates the operator's sender targets for one connector.
const receiverDirectory = (home: string, connectorId: string): string => path.join(home, ".cache", "connectors", connectorId);
export const receiverSocket = (home: string, connectorId: string): string => path.join(receiverDirectory(home, connectorId), "socket");
export const receiverHost = (connectorId: string): string => `${connectorId}.connectors.invalid`;

export type DeliveredFailure = "credential-not-delivered" | "receiver-invalid" | "credential-invalid";
export type DeliveredRead = { ok: true; item: { id: string; fields: [{ label: "credential"; value: string }] } } | { ok: false; cause: DeliveredFailure };
export type ReceiverRun = (argv: readonly string[], input: string, env: Record<string, string>) => { status: number | null; stdout: string | null };

const nativeRun: ReceiverRun = (argv, input, env) => {
	const [command, ...args] = argv;
	const read = spawnSync(command!, args, { input, env, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
	return { status: read.status, stdout: typeof read.stdout === "string" ? read.stdout : null };
};

// How a receiver path is inspected: lstat, so a symlink is seen as one.
export type ReceiverInspect = (target: string) => Stats;

const CONNECTOR_ID = /^[a-z][a-z0-9-]{0,31}$/;

// The receiver directory must be this user's own private 0700 directory, as
// the operator's sender requires before it stores anything.
function privateDirectory(directory: string, inspect: ReceiverInspect): "absent" | "private" | "invalid" {
	try {
		const entry = inspect(directory);
		return entry.isDirectory() && !entry.isSymbolicLink() && entry.uid === os.userInfo().uid && (entry.mode & 0o777) === 0o700 ? "private" : "invalid";
	} catch {
		return "absent";
	}
}

function socketPresent(socket: string, inspect: ReceiverInspect): "absent" | "socket" | "invalid" {
	try {
		const entry = inspect(socket);
		return entry.isSocket() && entry.uid === os.userInfo().uid ? "socket" : "invalid";
	} catch {
		return "absent";
	}
}

// git credential-cache answers a get with key=value lines, or nothing when no
// live entry matches. As git's credential protocol requires, attributes this
// reader does not use (an expiry, capabilities) are ignored. Exactly one
// username, the registered item ID, and exactly one nonempty password pass.
function deliveredValue(stdout: string, itemId: string): { kind: "empty" } | { kind: "value"; value: string } | { kind: "invalid" } {
	if (stdout === "") return { kind: "empty" };
	const lines = stdout.endsWith("\n") ? stdout.slice(0, -1).split("\n") : stdout.split("\n");
	const usernames: string[] = [];
	const passwords: string[] = [];
	for (const line of lines) {
		const at = line.indexOf("=");
		if (at < 1) return { kind: "invalid" };
		const key = line.slice(0, at);
		if (key === "username") usernames.push(line.slice(at + 1));
		else if (key === "password") passwords.push(line.slice(at + 1));
	}
	const [username] = usernames;
	const [value] = passwords;
	if (usernames.length !== 1 || passwords.length !== 1 || username !== itemId || !value) return { kind: "invalid" };
	return { kind: "value", value };
}

export function readDeliveredItem(connectorId: string, itemId: string, env: EnvironmentSource, run: ReceiverRun = nativeRun, inspect: ReceiverInspect = lstatSync): DeliveredRead {
	const home = env.HOME ?? "";
	if (!CONNECTOR_ID.test(connectorId) || !isItemId(itemId) || !path.isAbsolute(home)) return { ok: false, cause: "receiver-invalid" };
	const directory = privateDirectory(receiverDirectory(home, connectorId), inspect);
	if (directory === "absent") return { ok: false, cause: "credential-not-delivered" };
	if (directory === "invalid") return { ok: false, cause: "receiver-invalid" };
	const socket = receiverSocket(home, connectorId);
	const present = socketPresent(socket, inspect);
	if (present === "absent") return { ok: false, cause: "credential-not-delivered" };
	if (present === "invalid") return { ok: false, cause: "receiver-invalid" };
	// No user or system git configuration can redirect the helper.
	const gitEnv = { HOME: home, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
	const read = run([RECEIVER_GIT, "credential-cache", "--socket", socket, "get"], `protocol=https\nhost=${receiverHost(connectorId)}\nusername=${itemId}\n\n`, gitEnv);
	if (read.status !== 0 || read.stdout === null) return { ok: false, cause: "receiver-invalid" };
	const answer = deliveredValue(read.stdout, itemId);
	if (answer.kind === "empty") return { ok: false, cause: "credential-not-delivered" };
	if (answer.kind === "invalid") return { ok: false, cause: "credential-invalid" };
	return { ok: true, item: { id: itemId, fields: [{ label: "credential", value: answer.value }] } };
}

// The bounded handoff for a delivery refusal, or null for any other cause.
// It names the operator and the nonsecret coordinates, never a value.
export function deliveredRepair(cause: string, label: string, connectorId: string, itemId: string): string | null {
	if (cause === "credential-not-delivered") return `the pilot operator has not delivered the ${label} key for 1Password item ${itemId}, or its lease expired; ask the operator to deliver it to the ${connectorId} Connectors receiver, then retry. Connectors never reads 1Password in the pilot`;
	if (cause === "receiver-invalid") return `the ${label} Connectors receiver is not this user's private 0700 directory holding a live socket; ask the pilot operator to restore delivery for ${connectorId}, then retry`;
	if (cause === "credential-invalid" && usesDeliveredCredentials()) return `the ${label} receiver did not answer with one usable key for 1Password item ${itemId}; ask the pilot operator to check that item's credential field and deliver it again`;
	return null;
}

export const usesDeliveredCredentials = (platform: string = process.platform): boolean => platform === "linux";
