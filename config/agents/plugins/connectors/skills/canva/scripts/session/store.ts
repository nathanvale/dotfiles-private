// Private per-account session storage under
// <state root>/connectors/canva/<account>/: an owned 0700 directory that
// outlives the session, exact-0600 session.json and registration.json, the Provider's log
// directory, and a refresh.lock that serialises every mutation of that state
// across processes. Everything below the record shape is bin/private-state.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { ownedDirectory, readPrivateFile, writePrivateFile } from "../../../../bin/private-state.ts";
import type { ClientMode } from "./config.ts";
import { isRecord } from "./validate.ts";

export const ACCOUNT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SESSION_FILE = "session.json";
const REGISTRATION_FILE = "registration.json";
const LOCK_FILE = "refresh.lock";
// The session state a logout removes; the directory and the lock stay.
// The DCR registration is an account identity and can be reused by a later
// login; removing a grant does not remove that independent identity.
const SESSION_STATE = [SESSION_FILE, "hyper-mcp-remote"] as const;
const LOCK_POLL_MS = 50;

export interface SessionRecord {
	version: 1;
	// Once set, a missing receipt is a binding failure, never a legacy migration.
	dcrReceipt?: 1;
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

export type RegistrationReceipt = Pick<SessionRecord, "account" | "issuer" | "resource" | "client"> & { version: 1 };
export type ReceiptReadResult = { ok: true; receipt: RegistrationReceipt } | { ok: false; reason: "absent" | "invalid" };

export type SessionReadResult = { ok: true; session: SessionRecord } | { ok: false; reason: "absent" | "invalid" };

export const accountDirectory = (root: string, account: string): string => path.join(root, "connectors", "canva", account);

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
	if (!isRecord(value) || value.version !== 1 || value.account !== account || (value.dcrReceipt !== undefined && value.dcrReceipt !== 1)) return null;
	const client = parseClient(value.client);
	const endpoints = parseEndpoints(value);
	const tokens = parseTokens(value);
	if (!client || !endpoints || !tokens) return null;
	return { version: 1, account, client, ...endpoints, ...tokens, ...(value.dcrReceipt === 1 ? { dcrReceipt: 1 as const } : {}) };
}

export function readRegistrationReceipt(root: string, account: string): ReceiptReadResult {
	const read = readPrivateFile(path.join(accountDirectory(root, account), REGISTRATION_FILE));
	if (!read.ok) return { ok: false, reason: read.reason === "absent" ? "absent" : "invalid" };
	let value: unknown;
	try {
		value = JSON.parse(read.text);
	} catch {
		return { ok: false, reason: "invalid" };
	}
	if (!isRecord(value) || value.version !== 1 || value.account !== account || typeof value.issuer !== "string" || typeof value.resource !== "string") return { ok: false, reason: "invalid" };
	const client = parseClient(value.client);
	if (!client || client.mode !== "dcr" || !client.clientId || !client.redirectUri) return { ok: false, reason: "invalid" };
	return { ok: true, receipt: { version: 1, account, issuer: value.issuer, resource: value.resource, client } };
}

export function writeRegistrationReceipt(root: string, session: SessionRecord): { ok: true } | { ok: false; reason: string } {
	const directory = accountDirectory(root, session.account);
	const owned = ownedDirectory(directory);
	if (!owned.ok) return { ok: false, reason: `directory-${owned.reason}` };
	const receipt: RegistrationReceipt = { version: 1, account: session.account, issuer: session.issuer, resource: session.resource, client: session.client };
	const written = writePrivateFile(path.join(directory, REGISTRATION_FILE), `${JSON.stringify(receipt)}\n`);
	return written.ok ? { ok: true } : { ok: false, reason: `file-${written.reason}` };
}

// The account directory as an owned 0700 directory, created if absent.
export const prepareAccountDirectory = (root: string, account: string): boolean => ownedDirectory(accountDirectory(root, account)).ok;

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

// Removes the session state only. The account directory and any lock inside
// it are kept, so a holder of the lock is never pulled out from under.
export function removeSession(root: string, account: string): boolean {
	const directory = accountDirectory(root, account);
	const read = readPrivateFile(path.join(directory, SESSION_FILE));
	const existed = read.ok || read.reason !== "absent";
	for (const entry of SESSION_STATE) rmSync(path.join(directory, entry), { recursive: true, force: true });
	return existed;
}

export interface LockClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

// Exclusive-create lock whose record names a random owner token. A held lock
// is never reclaimed: the caller waits a bounded number of polls and then
// reports busy, because pid liveness cannot rule out pid reuse. The wait
// counts polls rather than reading the clock, so an injected clock that
// stands still still bounds it.
async function acquireLock(lock: string, clock: LockClock, waitMs: number): Promise<string | null> {
	const owner = crypto.randomUUID();
	const polls = Math.ceil(waitMs / LOCK_POLL_MS);
	for (let attempt = 0; ; attempt += 1) {
		try {
			const fd = openSync(lock, "wx", 0o600);
			try {
				writeSync(fd, `${JSON.stringify({ pid: process.pid, at: clock.now(), owner })}\n`);
			} finally {
				closeSync(fd);
			}
			return owner;
		} catch {
			if (attempt >= polls) return null;
			await clock.sleep(LOCK_POLL_MS);
		}
	}
}

// Release removes the lock only while its record still names this owner; a
// lock that another process holds is left in place.
function releaseLock(lock: string, owner: string): void {
	try {
		const record: unknown = JSON.parse(readFileSync(lock, "utf8"));
		if (isRecord(record) && record.owner === owner) rmSync(lock, { force: true });
	} catch {
		// An unreadable or absent lock is not ours to remove.
	}
}

export async function withRefreshLock<T>(root: string, account: string, clock: LockClock, waitMs: number, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: "auth-busy" | "directory-invalid" }> {
	const directory = accountDirectory(root, account);
	if (!ownedDirectory(directory).ok) return { ok: false, reason: "directory-invalid" };
	const lock = path.join(directory, LOCK_FILE);
	const owner = await acquireLock(lock, clock, waitMs);
	if (owner === null) return { ok: false, reason: "auth-busy" };
	try {
		return { ok: true, value: await work() };
	} finally {
		releaseLock(lock, owner);
	}
}
