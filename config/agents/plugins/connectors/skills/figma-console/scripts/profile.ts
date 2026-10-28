import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ownedDirectory, publishPrivateFileOnce, readPrivateFile, stateRoot } from "../../../bin/private-state.ts";
import type { EnvironmentSource } from "../../../bin/safe-environment.ts";
import pins from "./pins.json";
import { ACCOUNT, bare, canonical, ConsoleRefusal, type Data, FILE_KEY, hash, record } from "./model.ts";

export interface Profile {
	account: string;
	fileKey: string;
	itemId: string;
	email: string;
	userId: string;
	runtimeRoot: string;
	nodeFile: string;
	nodeSha256: string;
}
export const VERSIONS = { server: pins.server, bridge: pins.bridge } as const;
export const CANONICAL_PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function selection(selectors: Readonly<Record<string, string>>): { account: string; fileKey: string } {
	const account = selectors.account, fileKey = selectors.file;
	if (!bare(account, ACCOUNT) || !bare(fileKey, FILE_KEY)) throw new ConsoleRefusal("selection-invalid");
	return { account, fileKey };
}

export function profileRoot(env: EnvironmentSource, selected: { account: string; fileKey: string }): string {
	return path.join(stateRoot(env), "connectors", "figma-console", selected.account, selected.fileKey);
}

export function namespace(env: EnvironmentSource, profile: Profile): string {
	// macOS UNIX sockets have a short pathname limit. This owner-only root does
	// not inherit arbitrary XDG path length or share the production daemon.
	return `/tmp/connectors-fc-${os.userInfo().uid}-${hash(`${stateRoot(env)}:${profile.account}:${profile.fileKey}`).slice(0, 12)}`;
}

function fileDigest(file: string): string {
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== os.userInfo().uid || (stat.mode & 0o022) !== 0) throw new ConsoleRefusal("payload-invalid");
	return hash(readFileSync(file));
}

// Bind the evaluated npm dependency closure, not just package.json's label.
// npm's location-specific hidden lock is metadata, not executable content.
function treeEntries(root: string, relative = ""): string[] {
	const entries: string[] = [];
	const metadata = lstatSync(path.join(root, relative));
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== os.userInfo().uid || (metadata.mode & 0o022) !== 0) throw new ConsoleRefusal("payload-invalid");
	for (const name of readdirSync(path.join(root, relative)).sort()) {
		const rel = relative ? `${relative}/${name}` : name;
		if (rel === ".package-lock.json") continue;
		const file = path.join(root, rel), stat = lstatSync(file);
		if (stat.isSymbolicLink()) {
			if (!realpathSync(file).startsWith(`${realpathSync(root)}${path.sep}`)) throw new ConsoleRefusal("payload-invalid");
			entries.push(`${rel}\0link:${readlinkSync(file)}`);
		} else if (stat.isDirectory()) entries.push(...treeEntries(root, rel));
		else entries.push(`${rel}\0${fileDigest(file)}`);
	}
	return entries;
}

export function verifyPayload(profile: Profile, skillsRoot: string): void {
	if (hash(treeEntries(profile.runtimeRoot).sort().join("\n")) !== pins.runtimeTreeSha256) throw new ConsoleRefusal("runtime-pin-mismatch");
	if (fileDigest(profile.nodeFile) !== profile.nodeSha256) throw new ConsoleRefusal("node-pin-mismatch");
	for (const [name, expected] of Object.entries(pins.payload)) {
		if (fileDigest(path.join(skillsRoot, "figma-console", "payload", name)) !== expected) throw new ConsoleRefusal("bridge-pin-mismatch");
	}
}

function asProfile(value: unknown): Profile | null {
	if (!record(value) || Object.keys(value).sort().join(",") !== "account,email,fileKey,itemId,nodeFile,nodeSha256,runtimeRoot,userId") return null;
	if (!bare(value.account, ACCOUNT) || !bare(value.fileKey, FILE_KEY) || !bare(value.itemId, /^[a-z0-9]{26}$/)) return null;
	if (!bare(value.email, /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/) || !bare(value.userId, /^[0-9]{1,25}$/)) return null;
	if (typeof value.runtimeRoot !== "string" || !path.isAbsolute(value.runtimeRoot) || typeof value.nodeFile !== "string" || !path.isAbsolute(value.nodeFile) || !bare(value.nodeSha256, /^[a-f0-9]{64}$/)) return null;
	return value as unknown as Profile;
}

export function configured(env: EnvironmentSource, selectors: Readonly<Record<string, string>>): Profile {
	const selected = selection(selectors), read = readPrivateFile(path.join(profileRoot(env, selected), "profile.json"));
	if (!read.ok) throw new ConsoleRefusal("profile-unconfigured");
	let value: unknown;
	try { value = JSON.parse(read.text) as unknown; } catch { throw new ConsoleRefusal("profile-invalid"); }
	const profile = asProfile(value);
	if (!profile || profile.account !== selected.account || profile.fileKey !== selected.fileKey) throw new ConsoleRefusal("profile-invalid");
	return profile;
}

export function configurationInput(input: Data): boolean {
	return Object.keys(input).sort().join(",") === "email,itemId,nodeFile,runtimeRoot,userId" && asProfile({ account: "validation", fileKey: "validation", ...input, nodeSha256: "0".repeat(64) }) !== null;
}

export function configure(env: EnvironmentSource, selectors: Readonly<Record<string, string>>, input: Data, skillsRoot: string): { profile: Profile; published: boolean } {
	const selected = selection(selectors);
	if (!configurationInput(input)) throw new ConsoleRefusal("configuration-input-invalid");
	if (typeof input.nodeFile !== "string" || !path.isAbsolute(input.nodeFile)) throw new ConsoleRefusal("configuration-input-invalid");
	const profile = asProfile({ ...selected, ...input, nodeSha256: fileDigest(input.nodeFile) });
	if (!profile) throw new ConsoleRefusal("configuration-input-invalid");
	verifyPayload(profile, skillsRoot);
	const root = profileRoot(env, profile), file = path.join(root, "profile.json");
	if (!ownedDirectory(root).ok) throw new ConsoleRefusal("state-root-invalid");
	// The first publication wins; an existing registration is only ever
	// confirmed byte for byte, never replaced.
	const content = `${canonical(profile)}\n`, result = publishPrivateFileOnce(file, content);
	if (!result.ok) throw new ConsoleRefusal("registration-failed");
	if (!result.published && result.existing !== content) throw new ConsoleRefusal("profile-immutable");
	return { profile, published: result.published };
}
