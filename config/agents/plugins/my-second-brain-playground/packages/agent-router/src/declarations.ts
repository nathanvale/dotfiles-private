// Owner of the two user-side inputs: the version 1 routes file (Nathan's non-secret route declarations, D2) and the
// optional observations file (evidence another owner recorded). Both are validated from unknown with closed keys, so
// a secret-bearing or misspelt field is refused instead of being carried into a card.
import { readFileSync, statSync } from "node:fs"
import { StationError, type StationKey } from "./contract.ts"

export const HARNESSES = ["claude-code", "codex", "opencode"] as const
export type Harness = (typeof HARNESSES)[number]
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const
const OWNERSHIPS = ["personal", "employer", "shared"] as const
export type Ownership = (typeof OWNERSHIPS)[number]
const LAUNCH = ["allowed", "dry-run-only"] as const

const IDENTIFIER = /^[a-z0-9][a-z0-9.-]{0,62}$/
const PLAN = /^[A-Za-z0-9 .()+-]{1,40}$/

export interface DeclaredRoute {
	id: string
	harness: Harness
	model: { id: string; alias?: string }
	effort: (typeof EFFORTS)[number]
	account: { alias: string; ownership: Ownership; plan?: string }
	hosts: string[]
	launch: (typeof LAUNCH)[number]
}

export interface Observation {
	route: string
	kind: "account" | "quota"
	observedAt: string
	source: string
	observedAlias?: string
	state?: "available" | "exhausted"
}

type Json = Record<string, unknown>

class Invalid extends Error {}

function record(value: unknown, path: string, keys: { required: string[]; optional?: string[] }): Json {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Invalid(`${path} must be an object`)
	const allowed = new Set([...keys.required, ...(keys.optional ?? [])])
	const extra = Object.keys(value).find((key) => !allowed.has(key))
	if (extra !== undefined) throw new Invalid(`${path}.${extra} is not a declared field`)
	const missing = keys.required.find((key) => !(key in value))
	if (missing !== undefined) throw new Invalid(`${path}.${missing} is required`)
	return value as Json
}

function text(value: unknown, path: string, pattern: RegExp): string {
	if (typeof value !== "string" || !pattern.test(value)) throw new Invalid(`${path} must match ${pattern.source}`)
	return value
}

function choice<T extends string>(value: unknown, path: string, options: readonly T[]): T {
	if (typeof value !== "string" || !(options as readonly string[]).includes(value)) throw new Invalid(`${path} must be one of ${options.join(", ")}`)
	return value as T
}

function timestamp(value: unknown, path: string): string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
		throw new Invalid(`${path} must be a UTC ISO 8601 timestamp`)
	}
	return value
}

function model(value: unknown, path: string): DeclaredRoute["model"] {
	const raw = record(value, path, { required: ["id"], optional: ["alias"] })
	const id = text(raw.id, `${path}.id`, IDENTIFIER)
	return raw.alias === undefined ? { id } : { id, alias: text(raw.alias, `${path}.alias`, IDENTIFIER) }
}

function account(value: unknown, path: string): DeclaredRoute["account"] {
	const raw = record(value, path, { required: ["alias", "ownership"], optional: ["plan"] })
	const declared = { alias: text(raw.alias, `${path}.alias`, IDENTIFIER), ownership: choice(raw.ownership, `${path}.ownership`, OWNERSHIPS) }
	return raw.plan === undefined ? declared : { ...declared, plan: text(raw.plan, `${path}.plan`, PLAN) }
}

function hosts(value: unknown, path: string): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new Invalid(`${path} must be a non-empty array`)
	const ids = value.map((entry, index) => text(entry, `${path}[${index}]`, IDENTIFIER))
	if (new Set(ids).size !== ids.length) throw new Invalid(`${path} must not repeat a host`)
	return ids
}

function route(value: unknown, path: string): DeclaredRoute {
	const raw = record(value, path, { required: ["id", "harness", "model", "effort", "account", "hosts", "launch"] })
	return {
		id: text(raw.id, `${path}.id`, IDENTIFIER),
		harness: choice(raw.harness, `${path}.harness`, HARNESSES),
		model: model(raw.model, `${path}.model`),
		effort: choice(raw.effort, `${path}.effort`, EFFORTS),
		account: account(raw.account, `${path}.account`),
		hosts: hosts(raw.hosts, `${path}.hosts`),
		launch: choice(raw.launch, `${path}.launch`, LAUNCH),
	}
}

function parseRoutes(value: unknown): DeclaredRoute[] {
	const raw = record(value, "routes file", { required: ["schemaVersion", "routes"] })
	if (raw.schemaVersion !== 1) throw new Invalid("routes file.schemaVersion must be 1")
	if (!Array.isArray(raw.routes)) throw new Invalid("routes file.routes must be an array")
	const routes = raw.routes.map((entry, index) => route(entry, `routes[${index}]`))
	const ids = routes.map((entry) => entry.id)
	const repeated = ids.find((id, index) => ids.indexOf(id) !== index)
	if (repeated !== undefined) throw new Invalid(`route id ${repeated} is declared twice`)
	return routes
}

function observation(value: unknown, path: string): Observation {
	const raw = record(value, path, { required: ["route", "kind", "observedAt", "source"], optional: ["observedAlias", "state"] })
	const base = {
		route: text(raw.route, `${path}.route`, IDENTIFIER),
		kind: choice(raw.kind, `${path}.kind`, ["account", "quota"] as const),
		observedAt: timestamp(raw.observedAt, `${path}.observedAt`),
		source: text(raw.source, `${path}.source`, /^[A-Za-z0-9 ._:/@-]{1,120}$/),
	}
	if (base.kind === "account") {
		if (raw.state !== undefined) throw new Invalid(`${path}.state belongs to quota observations`)
		return { ...base, observedAlias: text(raw.observedAlias, `${path}.observedAlias`, IDENTIFIER) }
	}
	if (raw.observedAlias !== undefined) throw new Invalid(`${path}.observedAlias belongs to account observations`)
	return { ...base, state: choice(raw.state, `${path}.state`, ["available", "exhausted"] as const) }
}

function parseObservations(value: unknown): Observation[] {
	const raw = record(value, "observations file", { required: ["schemaVersion", "observations"] })
	if (raw.schemaVersion !== 1) throw new Invalid("observations file.schemaVersion must be 1")
	if (!Array.isArray(raw.observations)) throw new Invalid("observations file.observations must be an array")
	return raw.observations.map((entry, index) => observation(entry, `observations[${index}]`))
}

/** Reads a regular file, or returns null when nothing exists at the path. Any other read failure is internal. */
export function readOptionalFile(path: string): string | null {
	try {
		if (!statSync(path).isFile()) throw new StationError("inputUnreadable", `${path} is not a regular file.`)
		return readFileSync(path, "utf8")
	} catch (error) {
		if (error instanceof StationError) throw error
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
		throw new StationError("inputUnreadable", `${path} could not be read.`)
	}
}

function decode<T>(path: string, contents: string, station: StationKey, parse: (value: unknown) => T): T {
	try {
		return parse(JSON.parse(contents))
	} catch (error) {
		const reason = error instanceof Invalid ? error.message : "the file is not valid JSON"
		throw new StationError(station, `${path}: ${reason}.`)
	}
}

export type RoutesFile = { path: string; status: "present"; routes: DeclaredRoute[] } | { path: string; status: "missing"; routes: [] }

export function loadRoutes(path: string): RoutesFile {
	const contents = readOptionalFile(path)
	if (contents === null) return { path, status: "missing", routes: [] }
	return { path, status: "present", routes: decode(path, contents, "routesInvalid", parseRoutes) }
}

export type ObservationsFile = { path: string; status: "present" | "missing"; observations: Observation[] }

export function loadObservations(path: string): ObservationsFile {
	const contents = readOptionalFile(path)
	if (contents === null) return { path, status: "missing", observations: [] }
	return { path, status: "present", observations: decode(path, contents, "malformedInput", parseObservations) }
}
