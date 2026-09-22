// Private per-account session storage under
// <state root>/connectors/canva/<account>/: an owned 0700 directory, one
// exact-0600 session.json, and a refresh.lock that serialises rotation across
// Provider processes. Everything below the record shape is bin/private-state.
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { ownedDirectory, readPrivateFile, writePrivateFile } from "../../../../bin/private-state.ts";
import type { ClientMode } from "./config.ts";

export const ACCOUNT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SESSION_FILE = "session.json";
const LOCK_FILE = "refresh.lock";
const LOCK_POLL_MS = 50;

export interface SessionRecord {
	version: 1;
	account: string;
	client: { mode: ClientMode; clientId: string; redirectUri: string };
	issuer: string;
	resource: string;
	tokenEndpoint: string;
	revocationEndpoint: string | null;
	scope: string | null;
	accessToken: string;
	accessTokenExpiresAt: number | null;
	refreshToken: string | null;
	obtainedAt: number;
}

export type SessionReadResult = { ok: true; session: SessionRecord } | { ok: false; reason: "absent" | "invalid" };

export const accountDirectory = (root: string, account: string): string => path.join(root, "connectors", "canva", account);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const nullableNumber = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isFinite(value));
const isClientMode = (value: unknown): value is ClientMode => value === "dcr" || value === "registered" || value === "cimd";

function parseClient(value: unknown): SessionRecord["client"] | null {
	if (!isRecord(value) || !isClientMode(value.mode) || typeof value.clientId !== "string" || typeof value.redirectUri !== "string") return null;
	return { mode: value.mode, clientId: value.clientId, redirectUri: value.redirectUri };
}

function parseEndpoints(value: Record<string, unknown>): Pick<SessionRecord, "issuer" | "resource" | "tokenEndpoint" | "revocationEndpoint"> | null {
	const { issuer, resource, tokenEndpoint, revocationEndpoint } = value;
	if (typeof issuer !== "string" || typeof resource !== "string" || typeof tokenEndpoint !== "string" || !nullableString(revocationEndpoint)) return null;
	return { issuer, resource, tokenEndpoint, revocationEndpoint };
}

function parseTokens(value: Record<string, unknown>): Pick<SessionRecord, "scope" | "accessToken" | "accessTokenExpiresAt" | "refreshToken" | "obtainedAt"> | null {
	const { scope, accessToken, accessTokenExpiresAt, refreshToken, obtainedAt } = value;
	if (!nullableString(scope) || !nullableString(refreshToken) || !nullableNumber(accessTokenExpiresAt)) return null;
	if (typeof accessToken !== "string" || accessToken.length === 0 || typeof obtainedAt !== "number") return null;
	return { scope, accessToken, accessTokenExpiresAt, refreshToken, obtainedAt };
}

function parseSession(text: string, account: string): SessionRecord | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.version !== 1 || value.account !== account) return null;
	const client = parseClient(value.client);
	const endpoints = parseEndpoints(value);
	const tokens = parseTokens(value);
	if (!client || !endpoints || !tokens) return null;
	return { version: 1, account, client, ...endpoints, ...tokens };
}

export function readSession(root: string, account: string): SessionReadResult {
	const read = readPrivateFile(path.join(accountDirectory(root, account), SESSION_FILE));
	if (!read.ok) return { ok: false, reason: read.reason === "absent" ? "absent" : "invalid" };
	const session = parseSession(read.text, account);
	return session ? { ok: true, session } : { ok: false, reason: "invalid" };
}

export function writeSession(root: string, record: SessionRecord): { ok: true } | { ok: false; reason: string } {
	const directory = accountDirectory(root, record.account);
	const owned = ownedDirectory(directory);
	if (!owned.ok) return { ok: false, reason: `directory-${owned.reason}` };
	const written = writePrivateFile(path.join(directory, SESSION_FILE), `${JSON.stringify(record)}\n`);
	return written.ok ? { ok: true } : { ok: false, reason: `file-${written.reason}` };
}

// Removes the whole account directory: session, lock, and nothing else lives there.
export function removeSession(root: string, account: string): boolean {
	const directory = accountDirectory(root, account);
	const read = readPrivateFile(path.join(directory, SESSION_FILE));
	const existed = read.ok || read.reason !== "absent";
	rmSync(directory, { recursive: true, force: true });
	return existed;
}

export interface LockClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

// Exclusive-create lock. A held lock is never reclaimed: the caller waits a
// bounded number of polls and then reports busy, because pid liveness cannot
// rule out pid reuse. The wait counts polls rather than reading the clock, so
// an injected clock that stands still still bounds it.
async function acquireLock(lock: string, clock: LockClock, waitMs: number): Promise<boolean> {
	const polls = Math.ceil(waitMs / LOCK_POLL_MS);
	for (let attempt = 0; ; attempt += 1) {
		try {
			const fd = openSync(lock, "wx", 0o600);
			try {
				writeSync(fd, `${JSON.stringify({ pid: process.pid, at: clock.now() })}\n`);
			} finally {
				closeSync(fd);
			}
			return true;
		} catch {
			if (attempt >= polls) return false;
			await clock.sleep(LOCK_POLL_MS);
		}
	}
}

export async function withRefreshLock<T>(root: string, account: string, clock: LockClock, waitMs: number, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: "auth-busy" | "directory-invalid" }> {
	const directory = accountDirectory(root, account);
	if (!ownedDirectory(directory).ok) return { ok: false, reason: "directory-invalid" };
	const lock = path.join(directory, LOCK_FILE);
	if (!(await acquireLock(lock, clock, waitMs))) return { ok: false, reason: "auth-busy" };
	try {
		return { ok: true, value: await work() };
	} finally {
		rmSync(lock, { force: true });
	}
}
