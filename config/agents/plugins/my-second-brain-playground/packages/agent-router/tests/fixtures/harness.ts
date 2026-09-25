// Process seam for Agent Router tests. Each fixture is a private root with its own HOME, XDG directories, and a PATH
// holding only shim executables (monash, claude, codex, opencode) plus the system directories. The shims record their
// argv to a log outside the root so tests can prove which read-only probes ran. Credential-bearing files (the Monash
// config.json and harness auth files) exist but are unreadable (mode 000): the router fails with INTERNAL_UNEXPECTED
// if it ever opens one. Nothing here imports the modules under test.
import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

export const CLI = resolve(import.meta.dir, "../../src/cli.ts")
export const SECRET_MARKER = "AGENT_ROUTER_FIXTURE_SECRET_MARKER"
const GUIDE = resolve(import.meta.dir, "../../../../skills/stage-manager/guides/claude-code/claude-opus-5-5.md")
const DAY = 86_400_000

/** The accepted Opus 5.5 guide's revision, computed by the test from the committed bytes. */
export function guideRevision(): string {
	return createHash("sha256").update(readFileSync(GUIDE)).digest("hex")
}

export function ago(milliseconds: number): string {
	return new Date(Date.now() - milliseconds).toISOString()
}

export function daysAgo(days: number): string {
	return ago(days * DAY)
}

export interface Fixture {
	root: string
	env: Record<string, string>
	routesPath: string
	probeLog: string
	credentialSentinels: string[]
}

export interface FixtureOptions {
	hostRole?: string | null
	snapshot?: unknown
	monashDelaySeconds?: number
}

function shim(path: string, log: string, body: string): void {
	writeFileSync(path, `#!/bin/sh\nprintf '%s %s\\n' "$(basename "$0")" "$*" >> '${log}'\n${body}\n`)
	chmodSync(path, 0o755)
}

/** A synthetic snapshot in the installed monash models --json shape; its references carry a secret marker. */
export function snapshot(observedAt: string, evidenceHosts: string[] = ["laptop"]): unknown {
	return {
		command: "models",
		mode: "snapshot",
		state: "snapshot",
		schema_version: 1,
		observed_at: observedAt,
		resources: [{ id: "r1", resource: SECRET_MARKER, availability: "available" }],
		models: [
			{
				id: "model-a",
				display_name: "Model A",
				availability: "available",
				bindings: [{ resource_id: "r1", resource: SECRET_MARKER, protocol: "protocol-a", availability: "available" }],
				routes: [
					{
						agent: "claude",
						binding_resource_id: "r1",
						status: "qualified",
						implemented: true,
						compatibility: "compatible",
						reason: SECRET_MARKER,
						evidence: evidenceHosts.map((host) => ({ host, kind: "fixture", observed: true, reference: SECRET_MARKER })),
					},
					{ agent: "opencode", binding_resource_id: "r1", status: "untested", implemented: false, compatibility: "incompatible", reason: "fixture", evidence: [] },
				],
			},
		],
	}
}

function sentinel(path: string): string {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify({ apiKey: SECRET_MARKER, token: SECRET_MARKER }))
	chmodSync(path, 0o000)
	return path
}

export function createFixture(options: FixtureOptions = {}): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-router-")))
	const bin = join(root, "bin")
	const home = join(root, "home")
	const install = join(home, ".local", "share", "monash-foundry")
	for (const directory of [bin, install, join(root, "config", "agent-router")]) mkdirSync(directory, { recursive: true })
	const probeLog = `${root}.probes.log`
	writeFileSync(probeLog, "")
	writeFileSync(join(install, "snapshot.json"), JSON.stringify(options.snapshot ?? snapshot(daysAgo(1))))
	const delay = options.monashDelaySeconds === undefined ? "" : `sleep ${options.monashDelaySeconds}\n`
	shim(join(install, "monash"), probeLog, `${delay}cat '${join(install, "snapshot.json")}'`)
	symlinkSync(join(install, "monash"), join(bin, "monash"))
	const role = options.hostRole === undefined ? "laptop" : options.hostRole
	writeFileSync(join(install, "installation-manifest.json"), JSON.stringify(role === null ? { format: 1 } : { format: 1, host_role: role }))
	const credentialSentinels = [join(install, "config.json"), join(home, ".codex", "auth.json"), join(home, ".claude", ".credentials.json")].map(sentinel)
	shim(join(bin, "claude"), probeLog, 'echo "2.1.282 (Claude Code)"')
	shim(join(bin, "codex"), probeLog, 'echo "codex-cli 0.156.1"')
	shim(join(bin, "opencode"), probeLog, 'echo "1.18.31"')
	return {
		root,
		probeLog,
		credentialSentinels,
		routesPath: join(root, "config", "agent-router", "routes.json"),
		env: {
			HOME: home,
			PATH: `${bin}:/usr/bin:/bin`,
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_STATE_HOME: join(root, "state"),
			HERDR_PROJECTS_ROOT: join(root, "herdr-projects"),
			// Bun's own transpiler cache would otherwise write under HOME; the no-effect proof is about the router.
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
		},
	}
}

export function removeFixture(fixture: Fixture): void {
	rmSync(fixture.root, { recursive: true, force: true })
	rmSync(fixture.probeLog, { force: true })
}

export interface RouteOptions {
	harness?: string
	model?: { id: string; alias?: string }
	ownership?: string
	hosts?: string[]
	launch?: string
}

export function route(id: string, options: RouteOptions = {}) {
	return {
		id,
		harness: options.harness ?? "claude-code",
		model: options.model ?? { id: "claude-opus-5-5", alias: "opus" },
		effort: "high",
		account: { alias: "personal", ownership: options.ownership ?? "personal", plan: "Claude Max" },
		hosts: options.hosts ?? ["laptop"],
		launch: options.launch ?? "allowed",
	}
}

export function writeRoutes(fixture: Fixture, routes: unknown[]): void {
	writeFileSync(fixture.routesPath, JSON.stringify({ schemaVersion: 1, routes }))
}

export interface Invocation {
	exitCode: number
	stdout: string
	stderr: string
}

export function invoke(fixture: Fixture, args: string[], preload?: string): Invocation {
	const command = preload === undefined ? [process.execPath, CLI, ...args] : [process.execPath, "--preload", preload, CLI, ...args]
	const result = Bun.spawnSync(command, { cwd: fixture.root, env: fixture.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

// biome-ignore lint/suspicious/noExplicitAny: tests read the validated envelope as plain JSON
export function envelope(invocation: Invocation): any {
	expect(invocation.stderr).toBe("")
	expect(invocation.stdout.trim().split("\n")).toHaveLength(1)
	return JSON.parse(invocation.stdout)
}

function describeEntry(path: string): string {
	const stat = statSync(path)
	if (stat.isDirectory()) return `${path}/ ${stat.mode}`
	if ((stat.mode & 0o444) === 0) return `${path} ${stat.mode} ${stat.mtimeMs} unreadable ${stat.size}`
	return `${path} ${stat.mode} ${stat.mtimeMs} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`
}

/** Path, mode, mtime and content hash (size for unreadable files) of every entry, for no-effect comparison. */
export function tree(directory: string): string[] {
	const rows: string[] = []
	const walk = (path: string): void => {
		for (const name of readdirSync(path).sort()) {
			const child = join(path, name)
			rows.push(describeEntry(child))
			if (statSync(child).isDirectory()) walk(child)
		}
	}
	walk(directory)
	return rows
}
