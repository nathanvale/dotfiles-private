import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

/** Invalid input file content: maps to SCHEMA_INVALID_INPUT. */
export class InputError extends Error {}

/** A named input file or directory is absent: maps to DOMAIN_PRECONDITION_UNMET. */
export class MissingInputError extends Error {}

export type JsonRecord = Record<string, unknown>;

export function readJson(path: string): unknown {
  const text = readText(path);
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(`${path} is not valid JSON.`);
  }
}

export function readText(path: string): string {
  if (!existsSync(path)) throw new MissingInputError(`${path} does not exist.`);
  if (!statSync(path).isFile()) throw new InputError(`${path} is not a file.`);
  return readFileSync(path, "utf8");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Digest of a file on disk, or null when it is absent. */
export function sha256File(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function record(value: unknown, where: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError(`${where} must be an object.`);
  }
  return value as JsonRecord;
}

export function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new InputError(`${where} must be an array.`);
  return value;
}

export function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InputError(`${where} must be a non-empty string.`);
  }
  return value;
}

export function anyText(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new InputError(`${where} must be a string.`);
  }
  return value;
}

export function integer(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new InputError(`${where} must be an integer.`);
  }
  return value;
}

export function numeric(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InputError(`${where} must be a number.`);
  }
  return value;
}

export function flag(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") {
    throw new InputError(`${where} must be a boolean.`);
  }
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new InputError(`${where} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function optional<T>(
  value: unknown,
  read: (value: unknown) => T,
): T | undefined {
  return value === undefined ? undefined : read(value);
}

/** Native geometric bounds: [top, left, bottom, right] in points. */
export type Bounds = [number, number, number, number];

export function bounds(value: unknown, where: string): Bounds {
  const items = list(value, where);
  if (items.length !== 4) throw new InputError(`${where} must have 4 numbers.`);
  return items.map((item, index) =>
    numeric(item, `${where}[${index}]`),
  ) as Bounds;
}

export type FileIdentity = { path: string; sha256: string };
export type ArtBinding = FileIdentity & { id: string };
export type SourceRevision = { repository: string; commit: string };

export function fileIdentity(value: unknown, where: string): FileIdentity {
  const item = record(value, where);
  return {
    path: text(item.path, `${where}.path`),
    sha256: text(item.sha256, `${where}.sha256`),
  };
}

export function artBindings(value: unknown, where: string): ArtBinding[] {
  return list(value, where).map((entry, index) => ({
    ...fileIdentity(entry, `${where}[${index}]`),
    id: text(record(entry, `${where}[${index}]`).id, `${where}[${index}].id`),
  }));
}

export function sourceRevision(value: unknown, where: string): SourceRevision {
  const item = record(value, where);
  return {
    commit: text(item.commit, `${where}.commit`),
    repository: text(item.repository, `${where}.repository`),
  };
}
