import { readFile } from "node:fs/promises";
import path from "node:path";

/** Parsed YAML metadata for one durable note. */
export type Frontmatter = Record<string, unknown>;

/** Machine-readable metadata, status, routing, and safety rules. */
export interface VaultContract {
  version: number;
  required: string[];
  optional: string[];
  identityFields: string[];
  fieldShapes: Record<
    string,
    "non-empty-string" | "date" | "non-empty-string-list" | "non-empty-string-map"
  >;
  forbiddenFields: string[];
  unknownFieldsPolicy: {
    validation: "allow";
    scopedUpdate: "preserve";
    migration: "preserve";
  };
  conditionalRequirements: Record<
    string,
    {
      requiredWhen: string[];
      exemptWhen: string[];
      enforcement: "semantic-review";
    }
  >;
  markdownFilenames: {
    uppercaseBasenameAllowlist: string[];
    ignoredDirectories: string[];
  };
  summaryMaxLength: number;
  statusesByType: Record<string, string[]>;
  requiredByType: Record<string, string[]>;
  typeExtensions: Record<
    string,
    { required: string[]; optional: string[]; identity: string[] }
  >;
  routing: {
    repositoryFiles: Record<string, string>;
    repositoryPrefixes: Record<string, string>;
    rootReadme: string;
    familyReadmes: Record<string, string>;
    familyNotes: Record<string, string>;
    projectFiles: Record<string, string>;
    projectDirectories: Record<string, string>;
    projectLocalTypes: string[];
  };
  ignored: string[];
}

/** Load the vault's machine-readable frontmatter and routing contract. */
export async function loadContract(root: string): Promise<VaultContract> {
  const source = await readFile(
    path.join(root, "schemas", "frontmatter-contract.json"),
    "utf8",
  );
  return JSON.parse(source) as VaultContract;
}

/** Return true when a YAML value is empty and should have been omitted. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}
