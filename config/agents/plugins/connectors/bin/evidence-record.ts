// Retained hosted-read observations (Spec #87 AC21). After a keyless schema
// or read succeeds on an admitted hosted route, the core keeps one current
// nonsecret record per connector and kind, overwritten atomically under
// $XDG_STATE_HOME/connectors/evidence/<connector>/<kind>.json. Status proves
// schemaQualified or liveReadProven from it only while it is well formed,
// names an admitted origin, is inside its 30-day window, and is bound to the
// same registry and manifest bytes, front-door build, MCPorter pin, and
// selection this invocation sees. Anything else is unobserved, never proven.
//
// A successful packaged fixture-auth keeps one fixture.json record beside
// them, bound only to the registry, manifest, and build it ran against: the
// command takes no selection and starts no MCPorter. It proves fixtureTested
// and nothing else; no hosted or custody state ever reads it.
//
// A loopback or private origin is never admitted, so a copied-root stub or
// fixture never retains a hosted record. The record holds no input, credential,
// Provider text, or path; its owner deletes old records, nothing here does.
// An owner-writable record can still be hand-authored: a proven verdict means
// an unmodified packaged route recorded the success, not that a Provider
// independently attested it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import type { HostedRead } from "./adapters/contract.ts";
import type { ConnectorManifest } from "./manifest.ts";
import { inspectSelectedMcporter } from "./mcporter-custody.ts";
import { MCPORTER_RELEASE } from "./mcporter-release.ts";
import { ownedDirectory, type PrivateStateReason, readPrivateFile, stateRoot, writePrivateFile } from "./private-state.ts";
import type { EnvironmentSource } from "./safe-environment.ts";

export type ObservationKind = "schema" | "read";

const VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;
const RECORD_KEYS = ["schemaVersion", "connector", "kind", "operation", "route", "binding", "observedAt", "validUntil"];
const BINDING_KEYS = ["registrySha256", "manifestSha256", "buildSha256", "mcporter", "selectionSha256"];
const FIXTURE_RECORD_KEYS = ["schemaVersion", "connector", "kind", "binding", "observedAt", "validUntil"];
const FIXTURE_BINDING_KEYS = ["registrySha256", "manifestSha256", "buildSha256"];

export interface Binding {
	readonly registrySha256: string;
	readonly manifestSha256: string;
	readonly buildSha256: string;
	readonly mcporter: { readonly version: string; readonly binarySha256: string };
	readonly selectionSha256: string;
}

export interface ObservationRecord {
	readonly schemaVersion: 1;
	readonly connector: string;
	readonly kind: ObservationKind;
	readonly operation?: string;
	readonly route: { readonly server: string; readonly endpoint: string };
	readonly binding: Binding;
	readonly observedAt: string;
	readonly validUntil: string;
}

// A public hosted origin: https, no credentials, and a DNS name that is not
// a loopback, private, or IP-literal host.
function publicHttpsOrigin(origin: string): boolean {
	if (!URL.canParse(origin)) return false;
	const url = new URL(origin);
	const host = url.hostname.replace(/^\[|\]$/g, "");
	return url.protocol === "https:" && url.username === "" && url.password === "" && isIP(host) === 0 && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local");
}

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

function recordFile(env: EnvironmentSource, connector: string, kind: ObservationKind | "fixture"): string {
	return path.join(stateRoot(env), "connectors", "evidence", connector, `${kind}.json`);
}

// The selection the route was bound to: the connector, its resolved selector
// values in name order, and the effective custody mode.
function selectionDigest(connector: string, selectors: Readonly<Record<string, string>>, custodyMode: string | null): string {
	const ordered = Object.keys(selectors).sort().map((name) => [name, selectors[name]]);
	return sha256(JSON.stringify({ connector, selectors: ordered, custody: custodyMode }));
}

export interface FixtureBinding {
	readonly registrySha256: string;
	readonly manifestSha256: string;
	readonly buildSha256: string;
}

// null when a packaged file cannot be read, which binds nothing.
function packagedBinding(manifest: ConnectorManifest): FixtureBinding | null {
	try {
		return {
			registrySha256: sha256(readFileSync(manifest.registryPath)),
			manifestSha256: sha256(readFileSync(path.join(manifest.manifestDir, "manifest.json"))),
			buildSha256: sha256(readFileSync(process.execPath)),
		};
	} catch {
		return null;
	}
}

function currentBinding(manifest: ConnectorManifest, selection: string): Binding | null {
	const packaged = packagedBinding(manifest);
	if (packaged === null) return null;
	return { ...packaged, mcporter: { version: MCPORTER_RELEASE.version, binarySha256: MCPORTER_RELEASE.binarySha256 }, selectionSha256: selection };
}

export interface RetainRequest {
	readonly manifest: ConnectorManifest;
	readonly kind: ObservationKind;
	readonly operation: string | null;
	readonly hostedRead: HostedRead;
	readonly selectors: Readonly<Record<string, string>>;
	readonly env: EnvironmentSource;
	readonly observedAt: Date;
}

export type Kept =
	| { readonly kind: "retained"; readonly observedAt: string; readonly validUntil: string }
	| { readonly kind: "not-retained"; readonly reason: PrivateStateReason | "binding-unavailable" };
export type Retained = { readonly kind: "not-admitted" } | Kept;

// Called only after the keyless read succeeded through the verified
// MCPorter. The origin must be the adapter's own hosted endpoint and public.
export function retainObservation(request: RetainRequest): Retained {
	const { hostedRead, manifest } = request;
	if (hostedRead.origin !== hostedRead.hostedEndpoint || !publicHttpsOrigin(hostedRead.origin) || hostedRead.server !== manifest.id) return { kind: "not-admitted" };
	const binding = currentBinding(manifest, selectionDigest(manifest.id, request.selectors, "keyless"));
	if (binding === null) return { kind: "not-retained", reason: "binding-unavailable" };
	const observedAt = request.observedAt.toISOString();
	const validUntil = new Date(request.observedAt.getTime() + VALIDITY_MS).toISOString();
	const record: ObservationRecord = {
		schemaVersion: 1,
		connector: manifest.id,
		kind: request.kind,
		...(request.operation === null ? {} : { operation: request.operation }),
		route: { server: hostedRead.server, endpoint: hostedRead.origin },
		binding,
		observedAt,
		validUntil,
	};
	return writeRecord(recordFile(request.env, manifest.id, request.kind), record);
}

function writeRecord(file: string, record: { readonly observedAt: string; readonly validUntil: string }): Kept {
	const { observedAt, validUntil } = record;
	const content = `${JSON.stringify(record)}\n`;
	const directory = ownedDirectory(path.dirname(file));
	if (!directory.ok) return { kind: "not-retained", reason: directory.reason };
	const written = writePrivateFile(file, content);
	if (written.ok) return { kind: "retained", observedAt, validUntil };
	// A rename can land before a failed directory sync: the record is what
	// status will read, so report it retained only when it is exactly there.
	const landed = readPrivateFile(file);
	return landed.ok && landed.text === content ? { kind: "retained", observedAt, validUntil } : { kind: "not-retained", reason: written.reason };
}

export interface FixtureRecord {
	readonly schemaVersion: 1;
	readonly connector: string;
	readonly kind: "fixture";
	readonly binding: FixtureBinding;
	readonly observedAt: string;
	readonly validUntil: string;
}

// Called only after the packaged fixture authority accepted the connector's
// fixture auth. Never admits hosted, custody, or authentication evidence.
export function retainFixtureObservation(manifest: ConnectorManifest, env: EnvironmentSource, observedAt: Date): Kept {
	const binding = packagedBinding(manifest);
	if (binding === null) return { kind: "not-retained", reason: "binding-unavailable" };
	const record: FixtureRecord = { schemaVersion: 1, connector: manifest.id, kind: "fixture", binding, observedAt: observedAt.toISOString(), validUntil: new Date(observedAt.getTime() + VALIDITY_MS).toISOString() };
	return writeRecord(recordFile(env, manifest.id, "fixture"), record);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));

function wellFormedBinding(value: unknown): value is Binding {
	if (!isObject(value) || !exactKeys(value, BINDING_KEYS, BINDING_KEYS)) return false;
	const { mcporter } = value;
	const digests = [value.registrySha256, value.manifestSha256, value.buildSha256, value.selectionSha256];
	return digests.every((digest) => typeof digest === "string" && HEX64.test(digest)) && isObject(mcporter) && exactKeys(mcporter, ["version", "binarySha256"], ["version", "binarySha256"]) && typeof mcporter.version === "string" && typeof mcporter.binarySha256 === "string";
}

function wellFormed(value: unknown, connector: string, kind: ObservationKind): value is ObservationRecord {
	if (!isObject(value) || !exactKeys(value, RECORD_KEYS, RECORD_KEYS.filter((key) => key !== "operation"))) return false;
	const { route } = value;
	const operationShape = kind === "read" ? typeof value.operation === "string" : value.operation === undefined;
	const routeShape = isObject(route) && exactKeys(route, ["server", "endpoint"], ["server", "endpoint"]) && route.server === connector && typeof route.endpoint === "string";
	const times = typeof value.observedAt === "string" && typeof value.validUntil === "string" && !Number.isNaN(Date.parse(value.observedAt)) && !Number.isNaN(Date.parse(value.validUntil));
	return value.schemaVersion === 1 && value.connector === connector && value.kind === kind && operationShape && routeShape && times && wellFormedBinding(value.binding);
}

export interface ObservationQuery {
	readonly manifest: ConnectorManifest;
	readonly kind: ObservationKind;
	readonly selectors: Readonly<Record<string, string>>;
	readonly custodyMode: string | null;
	readonly env: EnvironmentSource;
	readonly now: number;
}

export type ObservationVerdict =
	| { readonly kind: "absent" }
	| { readonly kind: "rejected"; readonly basis: "observation-invalid" | "observation-route-not-admitted" | "observation-expired" | "observation-binding-mismatch" }
	| { readonly kind: "proven"; readonly record: ObservationRecord };

function unexpired(record: { readonly observedAt: string; readonly validUntil: string }, now: number): boolean {
	const observed = Date.parse(record.observedAt);
	const until = Date.parse(record.validUntil);
	return until - observed === VALIDITY_MS && observed <= now && now <= until;
}

type Parsed = { readonly kind: "absent" } | { readonly kind: "rejected"; readonly basis: "observation-invalid" } | { readonly kind: "parsed"; readonly value: unknown };

// Read-only: status never writes, repairs, or deletes a record.
function parseRecord(file: string): Parsed {
	const read = readPrivateFile(file);
	if (!read.ok) return read.reason === "absent" ? { kind: "absent" } : { kind: "rejected", basis: "observation-invalid" };
	try {
		return { kind: "parsed", value: JSON.parse(read.text) };
	} catch {
		return { kind: "rejected", basis: "observation-invalid" };
	}
}

export function readObservation(query: ObservationQuery): ObservationVerdict {
	const { manifest, kind } = query;
	const parsed = parseRecord(recordFile(query.env, manifest.id, kind));
	if (parsed.kind !== "parsed") return parsed;
	const { value } = parsed;
	if (!wellFormed(value, manifest.id, kind)) return { kind: "rejected", basis: "observation-invalid" };
	if (!publicHttpsOrigin(value.route.endpoint)) return { kind: "rejected", basis: "observation-route-not-admitted" };
	if (!unexpired(value, query.now)) return { kind: "rejected", basis: "observation-expired" };
	const binding = currentBinding(manifest, selectionDigest(manifest.id, query.selectors, query.custodyMode));
	const selected = inspectSelectedMcporter(query.env).executable !== null;
	if (!selected || binding === null || JSON.stringify(binding) !== JSON.stringify(value.binding)) return { kind: "rejected", basis: "observation-binding-mismatch" };
	return { kind: "proven", record: value };
}

function wellFormedFixture(value: unknown, connector: string): value is FixtureRecord {
	if (!isObject(value) || !exactKeys(value, FIXTURE_RECORD_KEYS, FIXTURE_RECORD_KEYS)) return false;
	const { binding } = value;
	const bound = isObject(binding) && exactKeys(binding, FIXTURE_BINDING_KEYS, FIXTURE_BINDING_KEYS) && FIXTURE_BINDING_KEYS.every((key) => typeof binding[key] === "string" && HEX64.test(binding[key]));
	const times = typeof value.observedAt === "string" && typeof value.validUntil === "string" && !Number.isNaN(Date.parse(value.observedAt)) && !Number.isNaN(Date.parse(value.validUntil));
	return value.schemaVersion === 1 && value.connector === connector && value.kind === "fixture" && bound && times;
}

export type FixtureVerdict =
	| { readonly kind: "absent" }
	| { readonly kind: "rejected"; readonly basis: "observation-invalid" | "observation-expired" | "observation-binding-mismatch" }
	| { readonly kind: "proven"; readonly record: FixtureRecord };

// Read-only, like readObservation: proven only while the record is well
// formed, unexpired, and bound to the packaged bytes this invocation sees.
export function readFixtureObservation(manifest: ConnectorManifest, env: EnvironmentSource, now: number): FixtureVerdict {
	const parsed = parseRecord(recordFile(env, manifest.id, "fixture"));
	if (parsed.kind !== "parsed") return parsed;
	const { value } = parsed;
	if (!wellFormedFixture(value, manifest.id)) return { kind: "rejected", basis: "observation-invalid" };
	if (!unexpired(value, now)) return { kind: "rejected", basis: "observation-expired" };
	const binding = packagedBinding(manifest);
	if (binding === null || JSON.stringify(binding) !== JSON.stringify(value.binding)) return { kind: "rejected", basis: "observation-binding-mismatch" };
	return { kind: "proven", record: value };
}
