import { type Dirent, existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"
import type {
	SessionFile,
	SessionRoots,
	SessionSource,
	SourceScanState,
} from "./model.ts"

type JsonlScanResult = {
	paths: string[]
	unreadableDirectories: number
}

function isPermissionDenied(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code
	return code === "EACCES" || code === "EPERM"
}

async function readDirectoryEntries(directory: string): Promise<Dirent[] | undefined> {
	try {
		return await readdir(directory, { withFileTypes: true })
	} catch (error) {
		if (isPermissionDenied(error)) return

		throw error
	}
}

function isJsonlFile(entry: Dirent): boolean {
	return entry.isFile() && entry.name.endsWith(".jsonl")
}

function recordDirectoryEntry(
	current: string,
	entry: Dirent,
	pending: string[],
	results: string[],
): void {
	const path = resolve(current, entry.name)
	if (entry.isDirectory()) {
		pending.push(path)
		return
	}
	if (isJsonlFile(entry)) results.push(path)
}

async function scanJsonlTree(root: string): Promise<JsonlScanResult> {
	const results: string[] = []
	let unreadableDirectories = 0
	const pending = [root]
	while (pending.length > 0) {
		const current = pending.pop()
		if (!current) continue
		const entries = await readDirectoryEntries(current)
		if (entries) {
			for (const entry of entries) recordDirectoryEntry(current, entry, pending, results)
		} else {
			unreadableDirectories += 1
		}
	}
	return { paths: results.sort(), unreadableDirectories }
}

async function listJsonl(root: string): Promise<{
	paths: string[]
	unreadableDirectories: number
}> {
	if (!existsSync(root)) return { paths: [], unreadableDirectories: 0 }
	return scanJsonlTree(root)
}

/**
 * Resolve standard private session roots with test-only environment overrides.
 *
 * @param home - User home used for standard runtime locations
 * @returns Claude Code, active Codex, and archived Codex roots
 *
 * @example
 * ```ts
 * const roots = defaultSessionRoots()
 * ```
 */
export function defaultSessionRoots(home = homedir()): SessionRoots {
	return {
		claude: process.env.SESSION_CORPUS_CLAUDE_ROOT ?? resolve(home, ".claude", "projects"),
		codexActive: process.env.SESSION_CORPUS_CODEX_ROOT ?? resolve(home, ".codex", "sessions"),
		codexArchived: process.env.SESSION_CORPUS_CODEX_ARCHIVE_ROOT ?? resolve(home, ".codex", "archived_sessions"),
	}
}

/**
 * Discover source files while retaining explicit missing-root evidence.
 *
 * @param roots - Private roots to inspect
 * @returns Private file locators plus path-free availability states
 *
 * @example
 * ```ts
 * const { files, states } = await listSessionFiles(defaultSessionRoots())
 * ```
 */
export async function listSessionFiles(roots: SessionRoots): Promise<{
	files: SessionFile[]
	states: SourceScanState[]
}> {
	const groups: Array<{
		source: SessionSource
		location: SourceScanState["location"]
		root: string
	}> = [
		{ source: "claude", location: "active", root: roots.claude },
		{ source: "codex", location: "active", root: roots.codexActive },
		{ source: "codex", location: "archive", root: roots.codexArchived },
	]
	const files: SessionFile[] = []
	const states: SourceScanState[] = []
	for (const group of groups) {
		const found = await listJsonl(group.root)
		states.push({
			source: group.source,
			location: group.location,
			state: existsSync(group.root) ? "available" : "missing",
			files: found.paths.length,
			unreadable_directories: found.unreadableDirectories,
		})
		for (const path of found.paths) files.push({ source: group.source, path })
	}
	return { files, states }
}
