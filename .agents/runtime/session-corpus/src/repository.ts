import { existsSync } from "node:fs"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import type { RepositoryMatchKind, SessionMetadata } from "./model.ts"

/**
 * Path-free result that preserves uncertainty for fail-closed repository filters.
 *
 * @example
 * ```ts
 * const assessment = matcher.assess(metadata)
 * if (assessment.status === "unresolved") blockApproval()
 * ```
 */
export type RepositoryMatchAssessment =
	| { status: "matched"; kind: RepositoryMatchKind }
	| { status: "mismatch" }
	| { status: "unresolved" }

function git(path: string, args: string[]): string | undefined {
	const result = Bun.spawnSync(["git", "-C", path, ...args], {
		stdout: "pipe",
		stderr: "ignore",
	})
	if (result.exitCode !== 0) return undefined
	return new TextDecoder().decode(result.stdout).trim() || undefined
}

interface RepositoryLocation {
	authority: string
	pathname: string
}

const repositoryProtocols = new Set(["http:", "https:", "ssh:"])

function parseStandardRepositoryLocation(value: string): RepositoryLocation | undefined {
	let parsed: URL
	try {
		parsed = new URL(value)
	} catch {
		return undefined
	}
	if (!repositoryProtocols.has(parsed.protocol)) return undefined
	const port = parsed.protocol === "ssh:" && parsed.port === "22" ? "" : parsed.port
	return {
		authority: parsed.hostname + (port ? ":" + port : ""),
		pathname: parsed.pathname,
	}
}

function parseScpRepositoryLocation(value: string): RepositoryLocation | undefined {
	const scp = value.match(/^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^/:\s]+):(.+)$/)
	if (!scp?.[1] || !scp[2]) return undefined
	return { authority: scp[1], pathname: scp[2] }
}

function parseRepositoryLocation(value: string): RepositoryLocation | undefined {
	return value.includes("://")
		? parseStandardRepositoryLocation(value)
		: parseScpRepositoryLocation(value)
}

function normalizeRepositoryLocation(location: RepositoryLocation | undefined): string | undefined {
	if (!location) return undefined
	const normalizedPath = location.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
	const parts = normalizedPath.split("/").filter(Boolean)
	return parts.length >= 2
		? (location.authority + "/" + parts.join("/")).toLowerCase()
		: undefined
}

function canonicalRepositoryIdentity(url: string | undefined): string | undefined {
	if (!url) return undefined
	return normalizeRepositoryLocation(parseRepositoryLocation(url.trim()))
}

function pathInside(candidate: string, parent: string): boolean {
	const value = relative(parent, candidate)
	return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
}

type CandidateRepositoryIdentity = {
	commonDir?: string
	remoteIdentity?: string
}

function assessDirectMatch(
	metadata: SessionMetadata,
	root: string,
	remoteIdentity: string | undefined,
	metadataRemote: string | undefined,
): RepositoryMatchAssessment | undefined {
	if (metadata.cwd && pathInside(resolve(metadata.cwd), root)) {
		return { status: "matched", kind: "path" }
	}
	if (metadataRemote && metadataRemote === remoteIdentity) {
		return { status: "matched", kind: "repository_url" }
	}
	return undefined
}

function assessWithoutCwd(metadataRemote: string | undefined): RepositoryMatchAssessment {
	return metadataRemote ? { status: "mismatch" } : { status: "unresolved" }
}

function assessMissingCwd(
	metadataRemote: string | undefined,
	remoteIdentity: string | undefined,
): RepositoryMatchAssessment {
	return metadataRemote !== undefined && metadataRemote !== remoteIdentity
		? { status: "mismatch" }
		: { status: "unresolved" }
}

function readCandidateRepositoryIdentity(path: string): CandidateRepositoryIdentity {
	const candidateRoot = git(path, ["rev-parse", "--show-toplevel"])
	const candidateCommon = git(path, ["rev-parse", "--git-common-dir"])
	return {
		commonDir: candidateRoot && candidateCommon
			? resolve(candidateRoot, candidateCommon)
			: undefined,
		remoteIdentity: canonicalRepositoryIdentity(
			git(path, ["remote", "get-url", "origin"]),
		),
	}
}

function cachedCandidateRepositoryIdentity(
	cache: Map<string, CandidateRepositoryIdentity>,
	path: string,
): CandidateRepositoryIdentity {
	const cached = cache.get(path)
	if (cached) return cached
	const identity = readCandidateRepositoryIdentity(path)
	cache.set(path, identity)
	return identity
}

function assessCandidateRepository(
	identity: CandidateRepositoryIdentity,
	commonDir: string | undefined,
	remoteIdentity: string | undefined,
): RepositoryMatchAssessment {
	if (identity.commonDir && commonDir) {
		return identity.commonDir === commonDir
			? { status: "matched", kind: "git_common_dir" }
			: { status: "mismatch" }
	}
	if (identity.remoteIdentity && remoteIdentity) {
		return identity.remoteIdentity === remoteIdentity
			? { status: "matched", kind: "repository_url" }
			: { status: "mismatch" }
	}
	return { status: "mismatch" }
}

/** Repository filter resolved once and reused across session metadata. */
export interface RepositoryMatcher {
	/** Canonical Git worktree root retained for repository-owned results. */
	root: string
	/** Path-free repository name safe for result metadata. */
	name: string
	/**
	 * Preserve the distinction between a proven mismatch and unavailable evidence.
	 *
	 * @param metadata - Private session locator to compare
	 * @returns Matched evidence, proven mismatch, or unresolved ownership
	 */
	assess: (metadata: SessionMetadata) => RepositoryMatchAssessment
	/**
	 * Return the evidence kind linking session metadata to this repository.
	 *
	 * @param metadata - Private session locator to compare
	 * @returns Match evidence, or undefined when the session belongs elsewhere
	 */
	match: (metadata: SessionMetadata) => RepositoryMatchKind | undefined
	/**
	 * Test whether session metadata belongs to the resolved repository.
	 *
	 * @param metadata - Private session locator to compare
	 * @returns True when path, git-common-dir, or remote identity agrees
	 */
	matches: (metadata: SessionMetadata) => boolean
}

/**
 * Resolve one Git repository into a reusable private session matcher.
 *
 * @param repoPath - Git checkout or linked worktree
 * @returns Path-free name and metadata matcher
 * @throws {Error} When the path is not a Git repository
 *
 * @example
 * ```ts
 * const repository = createRepositoryMatcher(process.cwd())
 * ```
 */
export function createRepositoryMatcher(repoPath: string): RepositoryMatcher {
	const rootText = git(repoPath, ["rev-parse", "--show-toplevel"])
	if (!rootText) throw new Error(`Not a Git repository: ${repoPath}`)
	const root = resolve(rootText)
	const common = git(root, ["rev-parse", "--git-common-dir"])
	const commonDir = common ? resolve(root, common) : undefined
	const remoteIdentity = canonicalRepositoryIdentity(git(root, ["remote", "get-url", "origin"]))
	const name = basename(root).toLowerCase()
	const cache = new Map<string, CandidateRepositoryIdentity>()
	const assess = (metadata: SessionMetadata): RepositoryMatchAssessment => {
		const metadataRemote = canonicalRepositoryIdentity(metadata.repositoryUrl)
		const directMatch = assessDirectMatch(metadata, root, remoteIdentity, metadataRemote)
		if (directMatch) return directMatch
		if (!metadata.cwd) return assessWithoutCwd(metadataRemote)
		if (!existsSync(metadata.cwd)) return assessMissingCwd(metadataRemote, remoteIdentity)
		const identity = cachedCandidateRepositoryIdentity(cache, metadata.cwd)
		return assessCandidateRepository(identity, commonDir, remoteIdentity)
	}
	const match = (metadata: SessionMetadata): RepositoryMatchKind | undefined => {
		const assessment = assess(metadata)
		return assessment.status === "matched" ? assessment.kind : undefined
	}

	return {
		root,
		name,
		assess,
		match,
		matches: (metadata) => match(metadata) !== undefined,
	}
}
