// Connector Manifest loader and validator (T2, Ticket #89 under Spec #87).
// A manifest is the sole selector/adapter/requirements declaration a
// Connector Skill needs to be reached through the generic command core in
// bin/connectors.ts; adding one never requires a change to that file.
//
// The registry-shape check below (imports: [], explicit allowedTools) is
// intentionally independent from bin/provider-route.ts's own copy: unifying
// them would touch the shared launcher every existing Skill (Atlassian,
// Canva) still depends on, which stays out of this Ticket's owned paths.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export type ManifestErrorCode =
	| "manifest-missing"
	| "manifest-invalid"
	| "schema-version-unsupported"
	| "adapter-unknown"
	| "registry-missing"
	| "registry-invalid"
	| "selector-invalid"
	| "requirements-invalid";

export class ManifestError extends Error {
	readonly code: ManifestErrorCode;
	constructor(code: ManifestErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export interface SelectorDeclaration {
	readonly pattern?: string;
	readonly enum?: readonly string[];
	readonly required?: boolean;
	readonly default?: string;
}

export interface ConnectorManifest {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly transportRegistry: string;
	readonly selectors: Readonly<Record<string, SelectorDeclaration>>;
	readonly requirements: readonly string[];
	readonly adapter: string | null;
	readonly credentials: { readonly reference?: string } | null;
	readonly manifestDir: string;
	readonly registryPath: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SELECTOR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RESERVED_RESOLVED_FIELDS = new Set(["connector", "adapter", "custodyMode", "transportRegistry", "requirements"]);
export const SELECTOR_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUPPORTED_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRegex(source: string): boolean {
	try {
		new RegExp(source);
		return true;
	} catch {
		return false;
	}
}

function checkSelectorPattern(name: string, raw: Record<string, unknown>): string | undefined {
	if (raw.pattern === undefined) return undefined;
	if (typeof raw.pattern !== "string" || !validRegex(raw.pattern)) {
		throw new ManifestError("selector-invalid", `selector ${name} pattern must be a valid regular expression`);
	}
	return raw.pattern;
}

function checkSelectorEnum(name: string, raw: Record<string, unknown>): readonly string[] | undefined {
	if (raw.enum === undefined) return undefined;
	if (!Array.isArray(raw.enum) || !raw.enum.every((value) => typeof value === "string")) {
		throw new ManifestError("selector-invalid", `selector ${name} enum must be an array of strings`);
	}
	return raw.enum;
}

function checkSelectorRequired(name: string, raw: Record<string, unknown>): boolean | undefined {
	if (raw.required === undefined) return undefined;
	if (typeof raw.required !== "boolean") throw new ManifestError("selector-invalid", `selector ${name} required must be a boolean`);
	return raw.required;
}

function checkSelectorDefault(name: string, raw: Record<string, unknown>, enumValues: readonly string[] | undefined, pattern: string | undefined): string | undefined {
	if (raw.default === undefined) return undefined;
	if (typeof raw.default !== "string") throw new ManifestError("selector-invalid", `selector ${name} default must be a string`);
	if (SELECTOR_VALUE_PATTERN.exec(raw.default)?.[0] !== raw.default || (pattern !== undefined && !new RegExp(pattern).test(raw.default))) {
		throw new ManifestError("selector-invalid", `selector ${name} default does not match its declared value pattern`);
	}
	if (enumValues !== undefined && !enumValues.includes(raw.default)) {
		throw new ManifestError("selector-invalid", `selector ${name} default must be one of its own enum`);
	}
	return raw.default;
}

function checkSelectorDeclaration(name: string, raw: unknown): SelectorDeclaration {
	if (!isRecord(raw)) throw new ManifestError("selector-invalid", `selector ${name} must be an object`);
	const pattern = checkSelectorPattern(name, raw);
	const enumValues = checkSelectorEnum(name, raw);
	const required = checkSelectorRequired(name, raw);
	const defaultValue = checkSelectorDefault(name, raw, enumValues, pattern);
	const declaration: { pattern?: string; enum?: readonly string[]; required?: boolean; default?: string } = {};
	if (pattern !== undefined) declaration.pattern = pattern;
	if (enumValues !== undefined) declaration.enum = enumValues;
	if (required !== undefined) declaration.required = required;
	if (defaultValue !== undefined) declaration.default = defaultValue;
	return declaration;
}

function checkSelectors(selectors: unknown): Record<string, SelectorDeclaration> {
	if (selectors === undefined) return {};
	if (!isRecord(selectors)) throw new ManifestError("selector-invalid", "selectors must be an object");
	const result: Record<string, SelectorDeclaration> = {};
	for (const [name, raw] of Object.entries(selectors)) {
		if (SELECTOR_NAME_PATTERN.exec(name)?.[0] !== name || RESERVED_RESOLVED_FIELDS.has(name)) {
			throw new ManifestError("selector-invalid", "selector name is invalid or reserved for resolved configuration");
		}
		result[name] = checkSelectorDeclaration(name, raw);
	}
	return result;
}

function checkRegistryShape(registryPath: string): void {
	if (!existsSync(registryPath)) throw new ManifestError("registry-missing", `${registryPath} is missing`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(registryPath, "utf8"));
	} catch {
		throw new ManifestError("registry-invalid", `${registryPath} is not valid JSON`);
	}
	if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
		throw new ManifestError("registry-invalid", `${registryPath} must declare mcpServers`);
	}
	if (!Array.isArray(parsed.imports) || parsed.imports.length !== 0) {
		throw new ManifestError("registry-invalid", `${registryPath} must set imports: []`);
	}
	for (const [name, entry] of Object.entries(parsed.mcpServers)) {
		if (!isRecord(entry) || !Array.isArray(entry.allowedTools) || !entry.allowedTools.every((tool) => typeof tool === "string" && tool.length > 0)) {
			throw new ManifestError("registry-invalid", `${registryPath} server ${name} must declare an explicit allowedTools array`);
		}
	}
}

function readManifestJson(manifestPath: string): Record<string, unknown> {
	if (!existsSync(manifestPath)) throw new ManifestError("manifest-missing", `${manifestPath} is missing`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		throw new ManifestError("manifest-invalid", `${manifestPath} is not valid JSON`);
	}
	if (!isRecord(parsed)) throw new ManifestError("manifest-invalid", `${manifestPath} must be a JSON object`);
	return parsed;
}

function checkSchemaVersion(parsed: Record<string, unknown>, manifestPath: string): void {
	if (parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
		throw new ManifestError("schema-version-unsupported", `${manifestPath} schemaVersion must be ${SUPPORTED_SCHEMA_VERSION}`);
	}
}

function checkManifestId(parsed: Record<string, unknown>, manifestPath: string, skillDir: string): string {
	const id = parsed.id;
	if (typeof id !== "string" || !ID_PATTERN.test(id) || id !== path.basename(skillDir)) {
		throw new ManifestError("manifest-invalid", `${manifestPath} id must match its own directory name and ${ID_PATTERN.source}`);
	}
	return id;
}

function checkTransport(parsed: Record<string, unknown>, manifestPath: string): { registry: string } {
	const transport = parsed.transport;
	if (!isRecord(transport) || typeof transport.registry !== "string") {
		throw new ManifestError("manifest-invalid", `${manifestPath} must declare transport.registry`);
	}
	return { registry: transport.registry };
}

function checkRequirements(parsed: Record<string, unknown>, manifestPath: string): readonly string[] {
	const requirements = parsed.requirements === undefined ? [] : parsed.requirements;
	if (!Array.isArray(requirements) || !requirements.every((entry) => typeof entry === "string")) {
		throw new ManifestError("manifest-invalid", `${manifestPath} requirements must be an array of strings`);
	}
	return requirements;
}

function checkAdapterField(parsed: Record<string, unknown>, manifestPath: string, adapterIds: ReadonlySet<string>): string | null {
	const adapter = parsed.adapter === undefined ? null : parsed.adapter;
	if (adapter !== null && (typeof adapter !== "string" || !adapterIds.has(adapter))) {
		throw new ManifestError("adapter-unknown", `${manifestPath} adapter ${JSON.stringify(adapter)} is not a packaged adapter`);
	}
	return adapter as string | null;
}

function checkCredentialsField(parsed: Record<string, unknown>, manifestPath: string): { reference?: string } | null {
	const credentials = parsed.credentials === undefined ? null : parsed.credentials;
	if (credentials === null) return null;
	if (!isRecord(credentials) || (credentials.reference !== undefined && typeof credentials.reference !== "string")) {
		throw new ManifestError("manifest-invalid", `${manifestPath} credentials.reference must be a string when present`);
	}
	return credentials as { reference?: string };
}

function loadManifest(skillDir: string, adapterIds: ReadonlySet<string>): ConnectorManifest {
	const manifestPath = path.join(skillDir, "config", "manifest.json");
	const parsed = readManifestJson(manifestPath);
	checkSchemaVersion(parsed, manifestPath);
	const id = checkManifestId(parsed, manifestPath, skillDir);
	const transport = checkTransport(parsed, manifestPath);
	const registryPath = path.resolve(path.dirname(manifestPath), transport.registry);
	checkRegistryShape(registryPath);
	const selectors = checkSelectors(parsed.selectors);
	const requirements = checkRequirements(parsed, manifestPath);
	const adapter = checkAdapterField(parsed, manifestPath, adapterIds);
	const credentials = checkCredentialsField(parsed, manifestPath);
	return {
		schemaVersion: 1,
		id,
		transportRegistry: transport.registry,
		selectors,
		requirements,
		adapter,
		credentials,
		manifestDir: path.dirname(manifestPath),
		registryPath,
	};
}

export interface DiscoveredManifest {
	readonly id: string;
	readonly manifest: ConnectorManifest | null;
	readonly error: ManifestError | null;
}

// Scans <skillsRoot>/*/config/manifest.json only; a Skill without one (still
// Atlassian's and Canva's case in T2) simply does not appear here yet.
export function discoverManifests(skillsRoot: string, adapterIds: ReadonlySet<string>): DiscoveredManifest[] {
	if (!existsSync(skillsRoot)) return [];
	const entries = readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const discovered: DiscoveredManifest[] = [];
	for (const id of entries) {
		const skillDir = path.join(skillsRoot, id);
		if (!existsSync(path.join(skillDir, "config", "manifest.json"))) continue;
		try {
			discovered.push({ id, manifest: loadManifest(skillDir, adapterIds), error: null });
		} catch (error) {
			discovered.push({ id, manifest: null, error: error instanceof ManifestError ? error : new ManifestError("manifest-invalid", String(error)) });
		}
	}
	return discovered;
}

export function loadOneManifest(skillsRoot: string, id: string, adapterIds: ReadonlySet<string>): ConnectorManifest {
	const skillDir = path.join(skillsRoot, id);
	if (!ID_PATTERN.test(id) || !existsSync(path.join(skillDir, "config", "manifest.json"))) {
		throw new ManifestError("manifest-missing", `no manifest declared for connector ${JSON.stringify(id)}`);
	}
	return loadManifest(skillDir, adapterIds);
}

// The plugin-wide Requirements Manifest: the single owner of accepted,
// already-published dependency version pins (Spec AC24). T2 only reports
// through this file; it never installs, verifies, or invents a pin.
//
// Absence is a distinct, honest fact from invalidity: a missing file simply
// means no dependency is pinned yet, so every declared requirement resolves
// to "not yet effective". A *present* file that is unparsable, carries an
// unsupported schemaVersion, or declares a non-string pin value is a real
// configuration defect and must refuse before any further work, never
// silently collapse to the same "no pins" state as absence.
export function loadRequirementsPins(pluginRoot: string): Readonly<Record<string, string>> {
	const requirementsPath = path.join(pluginRoot, "requirements.json");
	if (!existsSync(requirementsPath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(requirementsPath, "utf8"));
	} catch {
		throw new ManifestError("requirements-invalid", `${requirementsPath} is not valid JSON`);
	}
	if (!isRecord(parsed)) throw new ManifestError("requirements-invalid", `${requirementsPath} must be a JSON object`);
	if (parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
		throw new ManifestError("requirements-invalid", `${requirementsPath} schemaVersion must be ${SUPPORTED_SCHEMA_VERSION}`);
	}
	if (!isRecord(parsed.pins)) throw new ManifestError("requirements-invalid", `${requirementsPath} must declare pins as an object`);
	const pins: Record<string, string> = {};
	for (const [name, value] of Object.entries(parsed.pins)) {
		if (typeof value !== "string") throw new ManifestError("requirements-invalid", `${requirementsPath} pin ${name} must be a string`);
		pins[name] = value;
	}
	return pins;
}
