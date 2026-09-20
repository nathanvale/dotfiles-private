// Beads read Adapter: the only path to native `bd`, and it is read-only. The executable is the one named by the
// caller (MSB_WORKFLOW_BD_EXECUTABLE or the binding); PATH discovery never happens, and the named path must be the
// accepted pin, byte for byte, before it is spawned. Every reply is translated into an observation; a JSON `error`
// field is classified by its value, never by the exit code, because the pinned bd exits 1 for both an absent Bead
// and an absent store (observed on the previous pin and re-verified on 1.3.0).

import { createHash } from "node:crypto"
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { collectSecretValues } from "../command-contract.ts"
import type { BeadComment, BeadDependency, BeadFacts, GateFacts, StoreFacts } from "../model.ts"
import { describeFailure, isRecord, parseJson, type ProcessResult, runBounded, stringField } from "./native-process.ts"

/** The verified Beads source for this rollout: any other version or revision refuses the store. The one owner of the
 * version and revision text; the user-facing repair strings and the station catalog derive from these. */
export const PINNED_BD_VERSION = "1.3.0"
export const PINNED_BD_REVISION = "f45b249ce6b4"
/** `bd version <version> (<build>: [<branch>@]<revision>)`: the revision is the hex field after the last `@` inside
 * the parentheses, so the branch text bd appends inside a Git directory never reaches the pin. */
const VERSION_LINE = /^bd version (\S+) \(\S+: (?:.*@)?([0-9a-f]+)\)$/
/** Every JSON `error` value the pinned bd was observed to emit for an absent issue
 * (specification/evidence/bd-reads/show-missing.out, re-verified unchanged on 1.3.0); any other value, a missing store
 * included, is unavailable. */
const ABSENT_ISSUE_VALUES: ReadonlySet<string> = new Set(["no issues found matching the provided IDs"])
const REASON_LIMIT = 200

/** The accepted native bd: its exact absolute path and the SHA-256 of its bytes. Any other path or digest refuses before any bd read. */
export interface BeadsPin {
	readonly executable: string
	readonly sha256: string
}

export type StoreRead = { readonly status: "verified"; readonly store: StoreFacts } | { readonly status: "executable-invalid" | "mismatch" | "unavailable"; readonly reason: string }
export type BeadRead = { readonly status: "found"; readonly bead: BeadFacts } | { readonly status: "missing"; readonly reason: string } | { readonly status: "unavailable"; readonly reason: string }
export type GatesRead = { readonly status: "available"; readonly gates: readonly GateFacts[] } | { readonly status: "unavailable"; readonly reason: string }

export interface BeadsReader {
	readonly executable: string
	readonly storePath: string
	verifyStore(cwdIsGitRepository: boolean): Promise<StoreRead>
	readBead(id: string): Promise<BeadRead>
	readGates(): Promise<GatesRead>
	/** The bounded `bd prime --readonly --hook-json` additionalContext, or null when that read fails; never a refusal. */
	readPrime(): Promise<string | null>
	/** Every value observed under a secret-pattern key in any bd reply during this run. */
	knownSecretValues(): readonly string[]
}

interface ExecutableCheck {
	readonly status: "valid" | "invalid"
	readonly reason: string | null
	readonly digest: string | null
}

/** Absolute, the pinned path, canonical, regular, executable, and the pinned SHA-256: all decided before any spawn.
 * The version pin is decided afterwards by `bd version`. */
function checkExecutable(executable: string | null, pin: BeadsPin): ExecutableCheck {
	if (executable === null || executable.length === 0) return { status: "invalid", reason: "MSB_WORKFLOW_BD_EXECUTABLE is not set; PATH discovery is never used", digest: null }
	if (!isAbsolute(executable)) return { status: "invalid", reason: "bd executable path must be absolute", digest: null }
	if (executable !== pin.executable) return { status: "invalid", reason: `bd executable ${executable} is not the accepted ${pin.executable}`, digest: null }
	let digest: string
	try {
		if (realpathSync(executable) !== executable) return { status: "invalid", reason: "bd executable path must be canonical (no symlinks)", digest: null }
		if (!statSync(executable).isFile()) return { status: "invalid", reason: "bd executable is not a regular file", digest: null }
		accessSync(executable, constants.X_OK)
		digest = createHash("sha256").update(readFileSync(executable)).digest("hex")
	} catch {
		return { status: "invalid", reason: "bd executable is missing or not executable", digest: null }
	}
	if (digest !== pin.sha256) return { status: "invalid", reason: `bd executable ${executable} hashes ${digest}, not the accepted ${pin.sha256}`, digest: null }
	return { status: "valid", reason: null, digest }
}

/** The pinned version and revision from the first line of `bd version`, or null when the line has another shape. */
function parseVersionLine(stdout: string): { readonly version: string; readonly revision: string } | null {
	const match = VERSION_LINE.exec(stdout.split("\n")[0] ?? "")
	return match === null ? null : { version: match[1] as string, revision: match[2] as string }
}

function bounded(text: string): string {
	return text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT)}…` : text
}

function errorValue(parsed: unknown): string | null {
	return isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : null
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** An issue-like reply entry with its identity and the fields every listed issue carries, or null when unusable. */
function identified(value: unknown): { readonly id: string; readonly record: Record<string, unknown>; readonly title: string; readonly status: string; readonly awaitType: string | null } | null {
	if (!isRecord(value)) return null
	const id = stringField(value, "id")
	if (id === null) return null
	return { id, record: value, title: stringField(value, "title") ?? "", status: stringField(value, "status") ?? "", awaitType: stringField(value, "await_type") }
}

function dependencyOf(value: unknown): BeadDependency | null {
	const entry = identified(value)
	if (entry === null) return null
	return { id: entry.id, title: entry.title, status: entry.status, issueType: stringField(entry.record, "issue_type") ?? "", dependencyType: stringField(entry.record, "dependency_type") ?? "", awaitType: entry.awaitType }
}

function commentOf(value: unknown): BeadComment | null {
	if (!isRecord(value)) return null
	return { author: stringField(value, "author") ?? "", createdAt: stringField(value, "created_at") ?? "", text: stringField(value, "text") ?? "" }
}

function beadOf(issue: Record<string, unknown>, id: string): BeadFacts {
	return {
		id,
		title: stringField(issue, "title") ?? "",
		status: stringField(issue, "status") ?? "",
		assignee: stringField(issue, "assignee"),
		parent: stringField(issue, "parent"),
		labels: stringList(issue.labels),
		specId: stringField(issue, "spec_id"),
		externalRef: stringField(issue, "external_ref"),
		updatedAt: stringField(issue, "updated_at"),
		dependencies: (Array.isArray(issue.dependencies) ? issue.dependencies : []).map(dependencyOf).filter((item): item is BeadDependency => item !== null),
		comments: (Array.isArray(issue.comments) ? issue.comments : []).map(commentOf).filter((item): item is BeadComment => item !== null),
	}
}

function gateOf(value: unknown): GateFacts | null {
	const entry = identified(value)
	return entry === null ? null : { id: entry.id, title: entry.title, status: entry.status, awaitType: entry.awaitType }
}

export interface BeadsConfiguration {
	readonly executable: string
	readonly workspace: string
	readonly cwd: string
	readonly pin: BeadsPin
}

export function createBeadsReader(configuration: BeadsConfiguration): BeadsReader {
	const storePath = join(configuration.workspace, ".beads")
	const secrets: string[] = []
	const observe = (parsed: unknown): void => {
		for (const value of collectSecretValues(parsed)) if (!secrets.includes(value)) secrets.push(value)
	}
	const bd = (args: readonly string[]): Promise<ProcessResult> => runBounded([configuration.executable, ...args], { cwd: configuration.cwd, env: { BEADS_DIR: storePath } })

	// One native JSON read: the parsed object, or the classified reason it cannot be used. A JSON `error` value that
	// names no absent Bead is unavailable, whatever the exit code was.
	type Reply = { readonly kind: "json"; readonly value: unknown } | { readonly kind: "error"; readonly value: string } | { readonly kind: "unavailable"; readonly reason: string }
	type ObjectRead = { readonly kind: "object"; readonly value: Record<string, unknown> } | { readonly kind: "stop"; readonly read: { readonly status: "unavailable"; readonly reason: string } }
	const readJson = async (args: readonly string[]): Promise<Reply> => {
		const result = await bd(args)
		if (result.status !== "exited") return { kind: "unavailable", reason: `bd ${args[0]} ${describeFailure(result)}` }
		const parsed = parseJson(result.stdout)
		if (parsed === undefined) return { kind: "unavailable", reason: `bd ${args[0]} returned no JSON (${describeFailure(result)})` }
		observe(parsed)
		const error = errorValue(parsed)
		if (error !== null) return { kind: "error", value: error }
		return { kind: "json", value: parsed }
	}
	const readObject = async (args: readonly string[]): Promise<ObjectRead> => {
		const reply = await readJson(args)
		if (reply.kind === "error") return { kind: "stop", read: { status: "unavailable", reason: `bd ${args.slice(0, 2).join(" ")}: ${bounded(reply.value)}` } }
		if (reply.kind === "unavailable") return { kind: "stop", read: { status: "unavailable", reason: reply.reason } }
		return isRecord(reply.value) ? { kind: "object", value: reply.value } : { kind: "stop", read: { status: "unavailable", reason: `bd ${args[0]} returned no JSON object` } }
	}

	// The parenthesised suffix of `bd version` carries the current Git branch inside a repository; only the parsed
	// version and revision fields are pinned, so a branch spelled like the revision never satisfies the pin.
	async function checkVersion(): Promise<StoreRead | null> {
		const version = await bd(["version"])
		if (version.status !== "exited" || version.exit !== 0) return { status: "unavailable", reason: `bd version ${describeFailure(version)}` }
		const parsed = parseVersionLine(version.stdout)
		if (parsed === null || parsed.version !== PINNED_BD_VERSION || parsed.revision !== PINNED_BD_REVISION) return { status: "mismatch", reason: `bd executable is not the verified ${PINNED_BD_VERSION} at ${PINNED_BD_REVISION}` }
		return null
	}

	// `where.path` must equal the selected store exactly: a missing store silently falls back to ~/.beads.
	async function checkWhere(): Promise<{ readonly prefix: string } | StoreRead> {
		const where = await readObject(["where", "--readonly", "--json"])
		if (where.kind === "stop") return where.read
		const wherePath = stringField(where.value, "path")
		if (wherePath !== storePath) return { status: "mismatch", reason: `bd resolved store ${wherePath ?? "(none)"} instead of ${storePath}` }
		return { prefix: stringField(where.value, "prefix") ?? "" }
	}

	async function checkConfig(prefix: string): Promise<StoreRead | null> {
		const config = await readObject(["config", "list", "--readonly", "--json"])
		if (config.kind === "stop") return config.read
		const configuredPrefix = stringField(config.value, "issue_prefix")
		if (prefix.length === 0 || configuredPrefix !== prefix) return { status: "mismatch", reason: `store prefix ${prefix || "(none)"} and effective configuration ${configuredPrefix ?? "(none)"} disagree` }
		return null
	}

	async function checkContext(): Promise<StoreRead | null> {
		const context = await readObject(["context", "--readonly", "--json"])
		if (context.kind === "stop") return context.read
		const beadsDir = stringField(context.value, "beads_dir")
		if (context.value.is_redirected === true) return { status: "mismatch", reason: "bd context reports a redirected store" }
		if (beadsDir !== storePath) return { status: "mismatch", reason: `bd context names store ${beadsDir ?? "(none)"} instead of ${storePath}` }
		return null
	}

	async function verifyStore(cwdIsGitRepository: boolean): Promise<StoreRead> {
		const executable = checkExecutable(configuration.executable, configuration.pin)
		if (executable.status === "invalid") return { status: "executable-invalid", reason: executable.reason ?? "bd executable is invalid" }
		const version = await checkVersion()
		if (version !== null) return version
		const where = await checkWhere()
		if ("status" in where) return where
		const config = await checkConfig(where.prefix)
		if (config !== null) return config
		const context = cwdIsGitRepository ? await checkContext() : null
		if (context !== null) return context
		return { status: "verified", store: { executable: configuration.executable, executableDigest: executable.digest ?? "", version: `${PINNED_BD_VERSION}@${PINNED_BD_REVISION}`, storePath, prefix: where.prefix } }
	}

	async function readBead(id: string): Promise<BeadRead> {
		const reply = await readJson(["show", id, "--readonly", "--json", "--include-comments"])
		if (reply.kind === "unavailable") return { status: "unavailable", reason: reply.reason }
		if (reply.kind === "error") return ABSENT_ISSUE_VALUES.has(reply.value.trim()) ? { status: "missing", reason: bounded(reply.value) } : { status: "unavailable", reason: `bd show: ${bounded(reply.value)}` }
		const issue = Array.isArray(reply.value) ? reply.value[0] : reply.value
		if (!isRecord(issue) || stringField(issue, "id") !== id) return { status: "missing", reason: `bd show returned no issue with id ${id}` }
		return { status: "found", bead: beadOf(issue, id) }
	}

	async function readGates(): Promise<GatesRead> {
		const reply = await readJson(["gate", "list", "--all", "--readonly", "--json"])
		if (reply.kind === "unavailable") return { status: "unavailable", reason: reply.reason }
		if (reply.kind === "error") return { status: "unavailable", reason: `bd gate list: ${bounded(reply.value)}` }
		return { status: "available", gates: (Array.isArray(reply.value) ? reply.value : []).map(gateOf).filter((gate): gate is GateFacts => gate !== null) }
	}

	// `--readonly` is the global bd flag that blocks write operations; the pinned bd accepts it on `prime`.
	async function readPrime(): Promise<string | null> {
		const result = await bd(["prime", "--readonly", "--hook-json"])
		if (result.status !== "exited" || result.exit !== 0) return null
		const parsed = parseJson(result.stdout)
		if (!isRecord(parsed)) return null
		observe(parsed)
		const specific = parsed.hookSpecificOutput
		return isRecord(specific) ? stringField(specific, "additionalContext") : null
	}

	return { executable: configuration.executable, storePath, verifyStore, readBead, readGates, readPrime, knownSecretValues: () => [...secrets] }
}
