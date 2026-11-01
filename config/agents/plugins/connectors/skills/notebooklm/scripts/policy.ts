import { createHash } from "node:crypto";
import snapshot from "../config/catalogue.json";

export const CATALOGUE = snapshot;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function canonical(value: unknown): unknown {
	return Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
}
export const operation = (name: string) => CATALOGUE.operations.find((item) => item.name === name);
export const admittedNames = CATALOGUE.operations.filter((item) => item.admission === "admitted").map((item) => item.name);

function matches(value: unknown, schema: unknown): boolean {
	if (!record(schema)) return false;
	if (Array.isArray(schema.anyOf)) return schema.anyOf.some((item) => matches(value, item));
	if (schema.type === "object") return objectMatches(value, schema);
	if (schema.type === "null") return value === null;
	if (schema.type === "string") return typeof value === "string" && value.length <= 10000 && !value.includes("\0");
	if (schema.type === "boolean") return typeof value === "boolean";
	if (schema.type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
	if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
	if (schema.type === "array") return Array.isArray(value) && value.length <= 100 && value.every((item) => matches(item, schema.items));
	return false;
}
function objectMatches(value: unknown, schema: Record<string, unknown>): boolean {
	if (!record(value) || !record(schema.properties)) return false;
	const properties = schema.properties;
	const required = Array.isArray(schema.required) ? schema.required : [];
	return required.every((key) => typeof key === "string" && Object.hasOwn(value, key)) && Object.entries(value).every(([key, item]) => Object.hasOwn(properties, key) && matches(item, properties[key]));
}

const bounded = (value: unknown, min: number, max: number): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
function stableTargets(args: Readonly<Record<string, unknown>>): boolean {
	return ["notebook_id", "source_id"].every((key) => args[key] === undefined || typeof args[key] === "string" && UUID.test(args[key]));
}
function studioInput(args: Readonly<Record<string, unknown>>): boolean {
	if (args.action !== undefined && args.action !== "status" || args.new_title !== undefined || args.include_details === true) return false;
	if (args.limit !== undefined && !bounded(args.limit, 1, 20) || args.offset !== undefined && !bounded(args.offset, 0, 100000)) return false;
	return args.artifact_id === undefined || typeof args.artifact_id === "string" && UUID.test(args.artifact_id);
}
const INPUT_POLICY: Record<string, (args: Readonly<Record<string, unknown>>) => boolean> = {
	notebook_list: (args) => bounded(args.max_results, 1, 20),
	studio_status: studioInput,
	source_get_content: (args) => args.wait !== true && args.wait_timeout === undefined && args.poll_interval === undefined,
};

export function inputFor(name: string, input: Readonly<Record<string, unknown>> | null): Record<string, unknown> | null {
	const spec = operation(name);
	const args = input ?? {};
	if (!spec || !matches(args, spec.inputSchema) || !stableTargets(args)) return null;
	if (INPUT_POLICY[name]?.(args) === false) return null;
	return { ...args };
}
