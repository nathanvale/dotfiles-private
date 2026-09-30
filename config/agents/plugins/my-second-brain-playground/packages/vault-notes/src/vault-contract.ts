import { readdir, readFile } from "node:fs/promises";
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

/** Find every repository Markdown file governed by the filename policy. */
export async function discoverRepositoryMarkdownFiles(
  root: string,
  contract: VaultContract,
): Promise<string[]> {
  return collectMarkdownFiles(root, (_relativePath, name, isDirectory) =>
    isDirectory && contract.markdownFilenames.ignoredDirectories.includes(name),
  );
}

/** One governed Markdown file and its parsed frontmatter. */
export interface MarkdownNote {
  absolutePath: string;
  relativePath: string;
  content: string;
  frontmatter: Frontmatter | null;
  frontmatterError?: string;
}

/** Load the vault's machine-readable frontmatter and routing contract. */
export async function loadContract(root: string): Promise<VaultContract> {
  const source = await readFile(
    path.join(root, "schemas", "frontmatter-contract.json"),
    "utf8",
  );
  return JSON.parse(source) as VaultContract;
}

/** Find Markdown notes governed by the vault contract. */
export async function discoverMarkdownFiles(
  root: string,
  contract: VaultContract,
): Promise<string[]> {
  return collectMarkdownFiles(root, (relativePath, name) => {
    const firstSegment = relativePath.split(path.sep)[0];
    return (
      name === ".git" ||
      contract.ignored.includes(name) ||
      contract.ignored.includes(firstSegment ?? "")
    );
  });
}

async function collectMarkdownFiles(
  root: string,
  shouldSkip: (relativePath: string, name: string, isDirectory: boolean) => boolean,
): Promise<string[]> {
  const found: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath);
      if (shouldSkip(relativePath, entry.name, entry.isDirectory())) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        found.push(absolutePath);
      }
    }
  }

  await visit(root);
  return found.sort();
}

/** Parse one Markdown file and its YAML frontmatter. */
export async function readMarkdownNote(
  root: string,
  absolutePath: string,
): Promise<MarkdownNote> {
  const content = await readFile(absolutePath, "utf8");
  const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
  const match = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);

  if (!match?.[1]) {
    return { absolutePath, relativePath, content, frontmatter: null };
  }

  try {
    const parsed = Bun.YAML.parse(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        absolutePath,
        relativePath,
        content,
        frontmatter: null,
        frontmatterError: "frontmatter must be a YAML object",
      };
    }
    return {
      absolutePath,
      relativePath,
      content,
      frontmatter: parsed as Frontmatter,
    };
  } catch (error) {
    return {
      absolutePath,
      relativePath,
      content,
      frontmatter: null,
      frontmatterError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Resolve the note type required by a file's location. */
export function expectedTypesForPath(
  relativePath: string,
  contract: VaultContract,
): string[] {
  const repositoryTypes = repositoryTypesForPath(relativePath, contract);
  if (repositoryTypes) return repositoryTypes;

  const segments = relativePath.split("/");
  const family = segments[0];
  const filename = segments.at(-1);
  if (!family || !filename) return [];

  if (segments.length === 2 && filename === "README.md") {
    const type = contract.routing.familyReadmes[family];
    return type ? [type] : [];
  }

  if (family === "projects" && segments.length >= 3) {
    return projectTypesForPath(segments, filename, contract);
  }

  const type = contract.routing.familyNotes[family];
  return type ? [type] : [];
}

/** Type fixed by a repository-level route: an exact file, a path prefix, or the root README. */
function repositoryTypesForPath(relativePath: string, contract: VaultContract): string[] | undefined {
  const repositoryFileType = contract.routing.repositoryFiles[relativePath];
  if (repositoryFileType) {
    return [repositoryFileType];
  }

  for (const [prefix, type] of Object.entries(contract.routing.repositoryPrefixes)) {
    if (relativePath.startsWith(prefix)) return [type];
  }

  return relativePath === "README.md" ? [contract.routing.rootReadme] : undefined;
}

/** Types allowed for a note at least one folder below `projects/<slug>/`. */
function projectTypesForPath(segments: string[], filename: string, contract: VaultContract): string[] {
  if (segments.length === 4 && filename === "README.md" && ["specs", "tickets", "proofs"].includes(segments[2] ?? "")) return ["reference"];
  if (filename === "README.md" && segments.length > 3) return contract.routing.projectLocalTypes;
  const packetType = contract.routing.projectFiles[filename];
  if (packetType) return [packetType];
  const directoryType = contract.routing.projectDirectories[segments[2] ?? ""];
  return directoryType ? [directoryType] : contract.routing.projectLocalTypes;
}

/** Return true when a YAML value is empty and should have been omitted. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}
