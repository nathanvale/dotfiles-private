// Vault Catalogue: the one owner of which Markdown files are vault notes, where each note sits (family, owning
// project, governed artifact folder, index role) and which note types the contract routes to its path. check, list
// and inventory read notes only through it, so a discovery or routing change lands here once.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type Frontmatter, loadContract, type VaultContract } from "./vault-contract";

/** Project folders whose notes follow a governed document contract and need a stable folder map. */
const ARTIFACT_FOLDERS = ["specs", "tickets", "proofs"] as const;

/**
 * What a note is to its owning project:
 * - `packet`: a project file the contract routes by name at the project root (README, GOAL, result);
 * - `folder-map`: a README below the project root, either a nested navigation README or a governed artifact
 *   folder's own map;
 * - `artifact`: any other note inside a governed artifact folder;
 * - `routed`: a note in a project directory that `routing.projectDirectories` routes to a type outside
 *   `routing.projectLocalTypes`;
 * - `note`: every other project note, which the contract routes to its project-local types.
 */
export type ProjectRole = "packet" | "folder-map" | "artifact" | "routed" | "note";

/**
 * Where a note sits in the vault, derived from its path alone. `isIndex` and `expectedTypes` read the contract's
 * routing only when accessed, so a consumer that never reads them never depends on `contract.routing`.
 */
export interface NotePlacement {
  /** First path segment of a nested note; null for a file at the vault root. */
  family: string | null;
  /** Owning project slug for a note inside `projects/<slug>/`, at any depth; null elsewhere. */
  project: string | null;
  /** Governed artifact folder directly under the owning project that holds this note, at any depth; null elsewhere. */
  artifactFolder: (typeof ARTIFACT_FOLDERS)[number] | null;
  /** Path inside the owning project's folder, for example `research/deep/finding.md`; null outside a project. */
  projectPath: string | null;
  /** Folder of `projectPath`, `""` at the project root; it groups a project's notes. Null outside a project. */
  projectFolder: string | null;
  /** The note's role in its owning project; null outside a project. Reads `contract.routing` only when accessed. */
  readonly projectRole: ProjectRole | null;
  /** True for the vault root README and each contract family's README. */
  readonly isIndex: boolean;
  /** Note types the contract routes to this path; empty when the path is unrouted. */
  readonly expectedTypes: string[];
}

/** One governed Markdown file, its parsed frontmatter, and its placement. */
export interface MarkdownNote {
  absolutePath: string;
  relativePath: string;
  content: string;
  frontmatter: Frontmatter | null;
  frontmatterError?: string;
  placement: NotePlacement;
}

/** The vault's contract-bound view of its notes. Only the contract is read when the catalogue opens. */
export interface VaultCatalogue {
  contract: VaultContract;
  /**
   * Governed notes, sorted by path. The walk skips `.git` and every name in the contract's `ignored` list, at any
   * depth and as a first path segment. `include` selects by placement before any note is read, so an excluded note
   * can never fail the read. Notes are read one at a time in path order, so the first unreadable selected note is
   * the one reported.
   */
  notes(include?: (placement: NotePlacement) => boolean): Promise<MarkdownNote[]>;
  /**
   * Every governed note plus the vault-relative paths the filename policy governs, both sorted. That policy
   * deliberately differs: it skips only the contract's `markdownFilenames.ignoredDirectories`. Both walks finish
   * before any note is read, so a folder-read error is reported ahead of a note-read error; notes are then read
   * concurrently.
   */
  notesWithFilenamePolicy(): Promise<{ notes: MarkdownNote[]; filenamePolicyPaths: string[] }>;
}

/** Open the catalogue of the vault at `root`. Rejects when the contract is missing or unreadable. */
export async function openCatalogue(root: string): Promise<VaultCatalogue> {
  const contract = await loadContract(root);
  return {
    contract,
    async notes(include = () => true) {
      const notes: MarkdownNote[] = [];
      for (const file of placeNotes(root, await walkNotes(root, contract), contract)) {
        if (include(file.placement)) notes.push(await readNote(file));
      }
      return notes;
    },
    async notesWithFilenamePolicy() {
      const [noteFiles, policyFiles] = await Promise.all([walkNotes(root, contract), walkFilenamePolicy(root, contract)]);
      return {
        notes: await Promise.all(placeNotes(root, noteFiles, contract).map(readNote)),
        filenamePolicyPaths: policyFiles.map((absolutePath) => toVaultPath(root, absolutePath)),
      };
    },
  };
}

interface PlacedFile {
  absolutePath: string;
  relativePath: string;
  placement: NotePlacement;
}

function walkNotes(root: string, contract: VaultContract): Promise<string[]> {
  return collectMarkdownFiles(root, (relativePath, name) => isIgnoredNotePath(relativePath, name, contract));
}

function walkFilenamePolicy(root: string, contract: VaultContract): Promise<string[]> {
  return collectMarkdownFiles(
    root,
    (_relativePath, name, isDirectory) => isDirectory && contract.markdownFilenames.ignoredDirectories.includes(name),
  );
}

function placeNotes(root: string, files: string[], contract: VaultContract): PlacedFile[] {
  return files.map((absolutePath) => {
    const relativePath = toVaultPath(root, absolutePath);
    return { absolutePath, relativePath, placement: placeNote(relativePath, contract) };
  });
}

function isIgnoredNotePath(relativePath: string, name: string, contract: VaultContract): boolean {
  const firstSegment = relativePath.split(path.sep)[0];
  return name === ".git" || contract.ignored.includes(name) || contract.ignored.includes(firstSegment ?? "");
}

function toVaultPath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
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

/** Place one vault-relative path. Ownership follows the storage path, never frontmatter. */
function placeNote(relativePath: string, contract: VaultContract): NotePlacement {
  const segments = relativePath.split("/");
  const family = relativePath.includes("/") ? (segments[0] ?? null) : null;
  const project = segments[0] === "projects" && segments.length >= 3 ? (segments[1] ?? null) : null;
  const folder = project !== null && segments.length >= 4 ? segments[2] : undefined;
  const artifactFolder = ARTIFACT_FOLDERS.find((name) => name === folder) ?? null;
  const projectSegments = project === null ? null : segments.slice(2);
  return {
    family,
    project,
    artifactFolder,
    projectPath: projectSegments?.join("/") ?? null,
    projectFolder: projectSegments?.slice(0, -1).join("/") ?? null,
    get projectRole() {
      return projectSegments === null ? null : projectRoleFor(projectSegments, artifactFolder, contract);
    },
    get isIndex() {
      return (
        relativePath === "README.md" ||
        Object.keys(contract.routing.familyReadmes).some((name) => relativePath === `${name}/README.md`)
      );
    },
    get expectedTypes() {
      return routeTypes(relativePath, segments, artifactFolder, contract);
    },
  };
}

/** Role of a note from its path inside the project folder; see `ProjectRole`. */
function projectRoleFor(
  projectSegments: string[],
  artifactFolder: NotePlacement["artifactFolder"],
  contract: VaultContract,
): ProjectRole {
  const filename = projectSegments.at(-1) ?? "";
  if (projectSegments.length === 1) return Object.hasOwn(contract.routing.projectFiles, filename) ? "packet" : "note";
  const isReadme = filename === "README.md";
  if (artifactFolder === null) {
    if (isReadme) return "folder-map";
    const folder = projectSegments[0] ?? "";
    const { projectDirectories, projectLocalTypes } = contract.routing;
    const directoryType = Object.hasOwn(projectDirectories, folder) ? projectDirectories[folder] : undefined;
    return directoryType === undefined || projectLocalTypes.includes(directoryType) ? "note" : "routed";
  }
  return isReadme && projectSegments.length === 2 ? "folder-map" : "artifact";
}

/** Resolve the note types the contract's routing allows at a path. */
function routeTypes(
  relativePath: string,
  segments: string[],
  artifactFolder: NotePlacement["artifactFolder"],
  contract: VaultContract,
): string[] {
  const repositoryTypes = repositoryTypesForPath(relativePath, contract);
  if (repositoryTypes) return repositoryTypes;

  const family = segments[0];
  const filename = segments.at(-1);
  if (!family || !filename) return [];

  if (segments.length === 2 && filename === "README.md") {
    const type = contract.routing.familyReadmes[family];
    return type ? [type] : [];
  }

  if (family === "projects" && segments.length >= 3) {
    return projectTypesForPath(segments, filename, artifactFolder, contract);
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
function projectTypesForPath(
  segments: string[],
  filename: string,
  artifactFolder: NotePlacement["artifactFolder"],
  contract: VaultContract,
): string[] {
  if (segments.length === 4 && filename === "README.md" && artifactFolder) return ["reference"];
  if (filename === "README.md" && segments.length > 3) return contract.routing.projectLocalTypes;
  const packetType = contract.routing.projectFiles[filename];
  if (packetType) return [packetType];
  const directoryType = contract.routing.projectDirectories[segments[2] ?? ""];
  return directoryType ? [directoryType] : contract.routing.projectLocalTypes;
}

/** Read one Markdown file and parse its YAML frontmatter. */
async function readNote({ absolutePath, relativePath, placement }: PlacedFile): Promise<MarkdownNote> {
  const content = await readFile(absolutePath, "utf8");
  const note = { absolutePath, relativePath, content, placement };
  const match = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);

  if (!match?.[1]) {
    return { ...note, frontmatter: null };
  }

  try {
    const parsed = Bun.YAML.parse(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...note, frontmatter: null, frontmatterError: "frontmatter must be a YAML object" };
    }
    return { ...note, frontmatter: parsed as Frontmatter };
  } catch (error) {
    return { ...note, frontmatter: null, frontmatterError: error instanceof Error ? error.message : String(error) };
  }
}
