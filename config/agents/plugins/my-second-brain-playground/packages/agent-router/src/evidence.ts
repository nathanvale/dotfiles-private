// Read-only evidence probes. Each probe names its owner and source, reports what it observed or why it could not,
// and never reads a credential: Monash through its installed snapshot (never --refresh), the host role from the
// manifest beside the resolved monash executable, harness presence through --version, and Model Guides from the
// Playground plugin's Stage Manager skill.
import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { StationError } from "./contract.ts"
import { HARNESSES, type Harness, readOptionalFile } from "./declarations.ts"

interface ProbeOutput {
	exitCode: number
	stdout: string
}

async function probe(executable: string, args: string[], timeoutMs: number): Promise<ProbeOutput> {
	const child = Bun.spawn([executable, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		child.kill("SIGKILL")
	}, timeoutMs)
	const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
	clearTimeout(timer)
	if (timedOut) throw new StationError("probeTimeout", `${basename(executable)} ${args.join(" ")} did not answer within ${timeoutMs} ms.`)
	return { exitCode, stdout }
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1)
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function parseJsonFile(path: string): Record<string, unknown> | null {
	const contents = readOptionalFile(path)
	if (contents === null) return null
	try {
		return asRecord(JSON.parse(contents))
	} catch {
		return null
	}
}

// ---- host role (Monash Foundry installation owner) ----

export interface HostEvidence {
	status: "observed" | "unknown"
	role: string | null
	reason: string
	profiles: string[]
	source: string
}

function hostEvidence(installDir: string | null): HostEvidence {
	const source = "monash installation-manifest.json host_role and config.json host_profiles"
	if (installDir === null) return { status: "unknown", role: null, reason: "monash is not installed, so no host role is recorded", profiles: [], source }
	const profiles = Object.keys(asRecord(parseJsonFile(join(installDir, "config.json"))?.host_profiles) ?? {}).sort()
	const role = parseJsonFile(join(installDir, "installation-manifest.json"))?.host_role
	if (typeof role !== "string" || role === "") return { status: "unknown", role: null, reason: "the installation manifest records no readable host_role", profiles, source }
	if (!profiles.includes(role)) return { status: "unknown", role: null, reason: "the recorded host_role is not a configured host profile", profiles, source }
	return { status: "observed", role, reason: "recorded host_role matches a configured host profile", profiles, source }
}

// ---- Monash Foundry snapshot ----

const MONASH_AGENTS: Record<string, Harness> = { claude: "claude-code", codex: "codex", opencode: "opencode" }

export interface MonashRoute {
	id: string
	harness: Harness
	modelId: string
	displayName: string
	availability: string
	protocols: string[]
	qualifiedHosts: string[]
	unmappedEvidenceHosts: number
}

export interface MonashEvidence {
	status: "observed" | "not-installed" | "failed" | "invalid"
	snapshotObservedAt: string | null
	readAt: string
	source: string
	routes: MonashRoute[]
	unqualifiedCombinations: number
}

function normaliseHost(value: unknown, host: HostEvidence): string | null {
	if (typeof value !== "string") return null
	if (host.profiles.includes(value)) return value
	const local = hostname().replace(/\.local$/i, "").toLowerCase()
	// A raw hostname counts only when it is this machine and this machine's recorded role is known.
	if (host.role !== null && value.replace(/\.local$/i, "").toLowerCase() === local) return host.role
	return null
}

function evidenceHosts(evidence: unknown, host: HostEvidence): { hosts: string[]; unmapped: number } {
	const rows = Array.isArray(evidence) ? evidence.map(asRecord).filter((row) => row !== null && row.observed === true) : []
	const mapped = rows.map((row) => normaliseHost(row?.host, host))
	const hosts = [...new Set(mapped.filter((value): value is string => value !== null))].sort()
	return { hosts, unmapped: mapped.filter((value) => value === null).length }
}

function protocolsFor(bindings: unknown, resourceId: unknown): string[] {
	const rows = Array.isArray(bindings) ? bindings.map(asRecord) : []
	const matches = rows.filter((row) => row !== null && row.resource_id === resourceId && row.availability === "available")
	return [...new Set(matches.map((row) => String(row?.protocol)))].sort()
}

function monashRoute(model: Record<string, unknown>, raw: Record<string, unknown>, host: HostEvidence): MonashRoute | null {
	const harness = MONASH_AGENTS[String(raw.agent)]
	if (harness === undefined || raw.status !== "qualified" || raw.implemented !== true) return null
	const { hosts, unmapped } = evidenceHosts(raw.evidence, host)
	return {
		id: `monash-foundry-${String(raw.agent)}-${String(model.id)}`,
		harness,
		modelId: String(model.id),
		displayName: String(model.display_name ?? model.id),
		availability: String(model.availability),
		protocols: protocolsFor(model.bindings, raw.binding_resource_id),
		qualifiedHosts: hosts,
		unmappedEvidenceHosts: unmapped,
	}
}

function monashRoutes(snapshot: Record<string, unknown>, host: HostEvidence): { routes: MonashRoute[]; unqualified: number } | null {
	if (!Array.isArray(snapshot.models)) return null
	const routes: MonashRoute[] = []
	let unqualified = 0
	for (const model of snapshot.models.map(asRecord)) {
		if (model === null || typeof model.id !== "string" || !Array.isArray(model.routes)) return null
		for (const raw of model.routes.map(asRecord)) {
			const route = raw === null ? null : monashRoute(model, raw, host)
			if (route === null) unqualified += 1
			else routes.push(route)
		}
	}
	return { routes, unqualified }
}

async function monashEvidence(executable: string | null, host: HostEvidence, timeoutMs: number): Promise<MonashEvidence> {
	const readAt = new Date().toISOString()
	const source = "monash models --json (installed snapshot; never --refresh)"
	const empty = { snapshotObservedAt: null, readAt, source, routes: [], unqualifiedCombinations: 0 }
	if (executable === null) return { status: "not-installed", ...empty }
	const output = await probe(executable, ["models", "--json"], timeoutMs)
	if (output.exitCode !== 0) return { status: "failed", ...empty }
	let snapshot: Record<string, unknown> | null = null
	try {
		snapshot = asRecord(JSON.parse(output.stdout))
	} catch {
		snapshot = null
	}
	const parsed = snapshot === null ? null : monashRoutes(snapshot, host)
	const observedAt = snapshot?.observed_at
	if (parsed === null || typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt))) return { status: "invalid", ...empty }
	return { status: "observed", snapshotObservedAt: observedAt, readAt, source, routes: parsed.routes, unqualifiedCombinations: parsed.unqualified }
}

// ---- harness presence ----

const HARNESS_EXECUTABLES: Record<Harness, string> = { "claude-code": "claude", codex: "codex", opencode: "opencode" }

export interface HarnessEvidence {
	status: "observed" | "not-found" | "failed"
	version: string | null
	observedAt: string
	source: string
}

async function harnessEvidence(harness: Harness, timeoutMs: number): Promise<HarnessEvidence> {
	const name = HARNESS_EXECUTABLES[harness]
	const source = `${name} --version`
	const observedAt = new Date().toISOString()
	const executable = Bun.which(name)
	if (executable === null) return { status: "not-found", version: null, observedAt, source }
	const output = await probe(executable, ["--version"], timeoutMs)
	const version = /\d+\.\d+\.\d+/.exec(output.stdout)?.[0] ?? null
	if (output.exitCode !== 0 || version === null) return { status: "failed", version: null, observedAt, source }
	return { status: "observed", version, observedAt, source }
}

// ---- Model Guides (Stage Manager skill, S2) ----

export interface GuideEvidence {
	status: "reviewed" | "missing" | "unreviewed"
	path: string
	sha256: string | null
	harnessMinVersion: string | null
	reason: string
}

function pluginRoot(): string | null {
	let directory = import.meta.dir
	for (;;) {
		if (existsSync(join(directory, "skills", "stage-manager", "guides"))) return directory
		const parent = dirname(directory)
		if (parent === directory) return null
		directory = parent
	}
}

function frontmatter(contents: string): Record<string, string> {
	const block = /^---\n([\s\S]*?)\n---\n/.exec(contents)?.[1] ?? ""
	const fields: Record<string, string> = {}
	for (const line of block.split("\n")) {
		const match = /^([a-z_0-9]+):\s*(\S.*)$/.exec(line)
		if (match?.[1] !== undefined && match[2] !== undefined) fields[match[1]] = match[2].trim()
	}
	return fields
}

function guideEvidence(root: string | null, harness: Harness, modelId: string): GuideEvidence {
	const path = join("skills", "stage-manager", "guides", harness, `${modelId}.md`)
	const absent = { path, sha256: null, harnessMinVersion: null }
	if (root === null) return { status: "missing", ...absent, reason: "the Playground plugin's Stage Manager guides were not found" }
	const guide = readOptionalFile(join(root, path))
	if (guide === null) return { status: "missing", ...absent, reason: `no Model Guide exists for ${harness} and ${modelId}` }
	const sha256 = createHash("sha256").update(guide).digest("hex")
	const fields = frontmatter(guide)
	const minimum = fields.harness_min_version ?? null
	if (fields.model_id !== modelId || fields.harness !== harness) {
		return { status: "unreviewed", path, sha256, harnessMinVersion: minimum, reason: "the guide's model_id or harness does not match the route" }
	}
	const review = readOptionalFile(join(root, path.replace(/\.md$/, ".review.md")))
	const verdict = review === null ? {} : frontmatter(review)
	if (verdict.verdict !== "accepted" || verdict.guide_sha256 !== sha256) {
		return { status: "unreviewed", path, sha256, harnessMinVersion: minimum, reason: "no accepted review records this guide's current sha256" }
	}
	return { status: "reviewed", path, sha256, harnessMinVersion: minimum, reason: "an accepted review records this guide's sha256" }
}

// ---- Herdr Projects target ----

export interface TargetEvidence {
	status: "present" | "missing" | "not-given"
	project: string | null
	root: string | null
}

function targetEvidence(root: string | null, project: string | null): TargetEvidence {
	if (project === null || root === null) return { status: "not-given", project, root }
	return { status: existsSync(join(root, project, "PROJECT.md")) ? "present" : "missing", project, root }
}

// ---- collection ----

export interface Evidence {
	host: HostEvidence
	monash: MonashEvidence
	harnesses: Partial<Record<Harness, HarnessEvidence>>
	guide: (harness: Harness, modelId: string) => GuideEvidence
	target: TargetEvidence
}

export interface EvidenceRequest {
	harnesses: Harness[]
	timeoutMs: number
	herdrProjectsRoot: string | null
	project: string | null
}

export async function collectEvidence(request: EvidenceRequest): Promise<Evidence> {
	const monash = Bun.which("monash")
	const installDir = monash === null ? null : dirname(realpathSync(monash))
	const host = hostEvidence(installDir)
	const snapshot = await monashEvidence(monash, host, request.timeoutMs)
	const harnesses: Partial<Record<Harness, HarnessEvidence>> = {}
	const probed = new Set([...request.harnesses, ...snapshot.routes.map((route) => route.harness)])
	for (const harness of HARNESSES.filter((entry) => probed.has(entry))) harnesses[harness] = await harnessEvidence(harness, request.timeoutMs)
	const root = pluginRoot()
	return {
		host,
		monash: snapshot,
		harnesses,
		guide: (harness, modelId) => guideEvidence(root, harness, modelId),
		target: targetEvidence(request.herdrProjectsRoot, request.project),
	}
}
