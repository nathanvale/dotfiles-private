import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { RESOURCES_FINDING_IDS, resourcesFindings } from "./resources-index";
import { type MarkdownNote, openCatalogue } from "./vault-catalogue";
import { type Frontmatter, isEmptyValue, type VaultContract } from "./vault-contract";

/** Stable machine-readable finding identifiers. Consumers match on these, never on message text. */
export const VAULT_FINDING_IDS = [
  "frontmatter-invalid-yaml",
  "frontmatter-missing",
  "required-field-missing",
  "type-required-field-missing",
  "type-unknown",
  "status-invalid",
  "path-unrouted",
  "type-path-mismatch",
  "optional-field-empty",
  "forbidden-field-present",
  "field-shape-invalid",
  "summary-too-long",
  "body-secret-shaped-value",
  "identity-duplicate",
  "link-missing-target",
  "filename-uppercase",
  "ticket-placement-invalid",
  "ticket-spec-invalid",
  "artifact-map-missing",
  ...RESOURCES_FINDING_IDS,
] as const;

/** Stable finding identifier. */
export type VaultFindingId = (typeof VAULT_FINDING_IDS)[number];

/** One file-specific vault repair. */
export interface ValidationIssue {
  file: string;
  message: string;
  /** Stable machine-readable finding id; never parse message text. */
  id: VaultFindingId;
  /** Registry repair that fixes this finding deterministically, when one exists. */
  repairId?: string;
  /** Structured repair input for the registry; never parsed from message text. */
  detail?: Record<string, string>;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Validate all governed notes and return repair-oriented issues. */
export interface CheckVaultOptions {
  /** Canonical vault checkout used only to prove existence of link targets that escape `root`. */
  canonicalRoot?: string;
}

export async function checkVault(root: string, options: CheckVaultOptions = {}): Promise<ValidationIssue[]> {
  const canonicalRoot = path.resolve(options.canonicalRoot ?? root);
  const catalogue = await openCatalogue(root);
  const { contract } = catalogue;
  const { notes, filenamePolicyPaths } = await catalogue.notesWithFilenamePolicy();
  const issues: ValidationIssue[] = validateMarkdownFilenames(filenamePolicyPaths, contract);

  for (const note of notes) {
    issues.push(...validateFrontmatter(note, contract));
    issues.push(...validateBodySecrets(note, contract));
    issues.push(...(await validateLinks(note, root, canonicalRoot)));
  }
  issues.push(...validateUniqueIdentities(notes, contract));
  issues.push(...validateTicketOwnership(notes));
  issues.push(...validateArtifactMaps(notes));
  issues.push(...resourcesFindings(notes, contract));

  return issues;
}

function validateArtifactMaps(notes: MarkdownNote[]): ValidationIssue[] {
  const paths = new Set(notes.map((note) => note.relativePath));
  const missing = new Set<string>();
  for (const { placement } of notes) {
    if (!placement.artifactFolder) continue;
    const map = `projects/${placement.project}/${placement.artifactFolder}/README.md`;
    if (!paths.has(map)) missing.add(map);
  }
  return [...missing].map((file) => ({ file, id: "artifact-map-missing",
    message: "create this stable folder map from templates/project/folder-map.md" }));
}

function validateTicketOwnership(notes: MarkdownNote[]): ValidationIssue[] {
  const byPath = new Map(notes.map((note) => [note.absolutePath, note]));
  const issues: ValidationIssue[] = [];
  for (const note of notes) {
    if (note.frontmatter?.type !== "project-ticket") continue;
    const parts = note.relativePath.split("/");
    const specPath = note.frontmatter.spec_path;
    const spec = typeof specPath === "string"
      ? byPath.get(path.resolve(path.dirname(note.absolutePath), specPath)) : undefined;
    const specParts = spec?.relativePath.split("/");
    const validSpec = spec?.frontmatter?.type === "project-spec" && specParts?.length === 4
      && specParts[0] === "projects" && specParts[1] === parts[1] && specParts[2] === "specs";
    if (!validSpec) issues.push({
      file: note.relativePath, id: "ticket-spec-invalid",
      message: "set spec_path to an existing project-spec in this project's specs folder",
    });
    if (parts.length !== 5 || parts[0] !== "projects" || parts[2] !== "tickets"
      || (validSpec && parts[3] !== path.basename(spec!.relativePath, ".md"))) {
      issues.push({ file: note.relativePath, id: "ticket-placement-invalid",
        message: "move this ticket to tickets/<owning-spec-slug>/<ticket-slug>.md and preserve its identities" });
    }
  }
  return issues;
}

function validateMarkdownFilenames(
  files: string[],
  contract: VaultContract,
): ValidationIssue[] {
  const allowlist = new Set(contract.markdownFilenames.uppercaseBasenameAllowlist);
  return files.flatMap((file) => {
    const basename = path.posix.basename(file);
    if (!/[A-Z]/.test(basename) || allowlist.has(basename)) return [];
    return [{
      file,
      id: "filename-uppercase" as const,
      message: `rename Markdown filename to '${basename.toLowerCase()}'; uppercase is reserved for ${Array.from(allowlist).map((value) => `'${value}'`).join(", ")}`,
    }];
  });
}

function validateBodySecrets(
  note: MarkdownNote,
  contract: VaultContract,
): ValidationIssue[] {
  const lines = note.content.split("\n");
  const frontmatterEnd =
    lines[0]?.trim() === "---"
      ? lines.findIndex((line, index) => index > 0 && line.trim() === "---")
      : -1;
  const labels = contract.forbiddenFields
    .map((field) => field.split("_").map(escapeRegExp).join("[ _-]?"))
    .sort((left, right) => right.length - left.length)
    .join("|");
  const secretAssignment = new RegExp(
    "\\b(?:" + labels + ")\\b\\s*(?:[:=]|\\bis\\b)\\s*[\"'`]?[^\\s\"'`]{12,}",
    "i",
  );
  const issues: ValidationIssue[] = [];

  for (let index = frontmatterEnd + 1; index < lines.length; index += 1) {
    if (!secretAssignment.test(lines[index] ?? "")) continue;
    issues.push({
      file: note.relativePath,
      id: "body-secret-shaped-value",
      message:
        `remove secret-shaped value from note body at line ${index + 1}; ` +
        "keep the value with its source owner and retain only a reference",
    });
  }

  return issues;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Records one finding for the note under validation. */
type AddIssue = (
  id: VaultFindingId,
  message: string,
  repair?: { repairId: string; detail: Record<string, string> },
) => void;

function validateFrontmatter(
  note: MarkdownNote,
  contract: VaultContract,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add: AddIssue = (id, message, repair) =>
    issues.push({ file: note.relativePath, id, message, ...(repair ?? {}) });

  if (note.frontmatterError) {
    add("frontmatter-invalid-yaml", `fix invalid YAML frontmatter: ${note.frontmatterError}`);
    return issues;
  }
  if (!note.frontmatter) {
    add("frontmatter-missing", "add YAML frontmatter bounded by --- lines");
    return issues;
  }

  const metadata = note.frontmatter;
  const type = typeof metadata.type === "string" ? metadata.type : "";
  validateRequiredFields(metadata, type, contract, add);
  validateTypeStatus(metadata, type, contract, add);
  validatePathRoute(note.placement.expectedTypes, type, add);
  validateEmptyAndForbiddenFields(metadata, contract, add);

  validateFieldShapes(metadata, contract, (field, message) =>
    issues.push({
      file: note.relativePath,
      id: "field-shape-invalid",
      message,
      detail: { field },
    }),
  );

  if (
    typeof metadata.summary === "string" &&
    metadata.summary.length > contract.summaryMaxLength
  ) {
    add("summary-too-long", `shorten 'summary' to ${contract.summaryMaxLength} characters or fewer`);
  }

  return issues;
}

function validateRequiredFields(
  metadata: Frontmatter,
  type: string,
  contract: VaultContract,
  add: AddIssue,
): void {
  for (const field of contract.required) {
    if (isEmptyValue(metadata[field])) {
      add("required-field-missing", `add required frontmatter field '${field}'`);
    }
  }

  for (const field of contract.requiredByType[type] ?? []) {
    if (isEmptyValue(metadata[field])) {
      add("type-required-field-missing", `add required ${type} field '${field}'`);
    }
  }
}

function validateTypeStatus(
  metadata: Frontmatter,
  type: string,
  contract: VaultContract,
  add: AddIssue,
): void {
  const allowedStatuses = contract.statusesByType[type];
  if (type && !allowedStatuses) {
    add("type-unknown", `replace unknown type '${type}' with a contract type`);
  } else if (
    allowedStatuses &&
    typeof metadata.status === "string" &&
    !allowedStatuses.includes(metadata.status)
  ) {
    add(
      "status-invalid",
      `use a valid status for '${type}': ${allowedStatuses.map((value) => `'${value}'`).join(", ")}`,
    );
  }
}

function validatePathRoute(
  expectedTypes: string[],
  type: string,
  add: AddIssue,
): void {
  if (expectedTypes.length === 0) {
    add(
      "path-unrouted",
      "move this note into a routed family or add an approved routing contract",
    );
  } else if (type && !expectedTypes.includes(type)) {
    add(
      "type-path-mismatch",
      `change type to ${expectedTypes.map((value) => `'${value}'`).join(" or ")} for this path`,
    );
  }
}

function validateEmptyAndForbiddenFields(
  metadata: Frontmatter,
  contract: VaultContract,
  add: AddIssue,
): void {
  for (const field of contract.optional) {
    if (field in metadata && isEmptyValue(metadata[field])) {
      add("optional-field-empty", `remove empty optional field '${field}'`, {
        repairId: "remove-empty-optional-field",
        detail: { field },
      });
    }
  }

  for (const field of contract.forbiddenFields) {
    if (field in metadata) {
      add("forbidden-field-present", `remove forbidden secret-bearing field '${field}'`);
    }
  }
}

type FieldShape = VaultContract["fieldShapes"][string];

/** Each declared shape's test and repair wording; any other declared shape is judged as a string map, as before. */
const FIELD_SHAPE_RULES: Record<FieldShape, { holds: (value: unknown) => boolean; wording: string }> = {
  "non-empty-string": {
    holds: (value) => typeof value === "string" && value.trim() !== "",
    wording: "a non-empty string",
  },
  date: {
    holds: (value) => typeof value === "string" && DATE_PATTERN.test(value),
    wording: "YYYY-MM-DD",
  },
  "non-empty-string-list": {
    holds: (value) =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => typeof entry === "string" && entry.trim() !== ""),
    wording: "a non-empty list of strings",
  },
  "non-empty-string-map": {
    holds: (value) =>
      Boolean(value) &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as object).length > 0 &&
      Object.entries(value as object).every(
        ([key, entry]) => key.trim() !== "" && typeof entry === "string" && entry.trim() !== "",
      ),
    wording: "a non-empty string map",
  },
};

function validateFieldShapes(
  metadata: Frontmatter,
  contract: VaultContract,
  add: (field: string, message: string) => void,
): void {
  for (const [field, shape] of Object.entries(contract.fieldShapes)) {
    if (!(field in metadata) || isEmptyValue(metadata[field])) continue;
    const rule = Object.hasOwn(FIELD_SHAPE_RULES, shape)
      ? FIELD_SHAPE_RULES[shape]
      : FIELD_SHAPE_RULES["non-empty-string-map"];
    if (!rule.holds(metadata[field])) add(field, `format '${field}' as ${rule.wording}`);
  }
}

function validateUniqueIdentities(
  notes: MarkdownNote[],
  contract: VaultContract,
): ValidationIssue[] {
  const seen = new Map<string, string>();
  const issues: ValidationIssue[] = [];

  for (const note of notes) {
    for (const field of contract.identityFields) {
      issues.push(...validateIdentity(note, field, seen));
    }
  }

  return issues;
}

/** One identity field of one note; the first note to use a value claims it in `seen`. */
function validateIdentity(
  note: MarkdownNote,
  field: string,
  seen: Map<string, string>,
): ValidationIssue[] {
  const value = note.frontmatter?.[field];
  if (typeof value !== "string" || value.trim() === "") return [];
  if (field === "task_identity" && value === "historical"
    && note.frontmatter?.type === "project-ticket") {
    if (note.frontmatter.status === "superseded") return [];
    if (note.frontmatter.status === "adopted") {
      return [{
        file: note.relativePath,
        id: "field-shape-invalid",
        message: "replace 'historical' task_identity with a real Task identity for adopted project-ticket",
        detail: { field: "task_identity" },
      }];
    }
  }
  const key = `${field}:${value}`;
  const existing = seen.get(key);
  if (!existing) {
    seen.set(key, note.relativePath);
    return [];
  }
  return [{
    file: note.relativePath,
    id: "identity-duplicate",
    message: `replace duplicate ${field} '${value}'; first used by '${existing}'`,
  }];
}

async function validateLinks(
  note: MarkdownNote,
  root: string,
  canonicalRoot: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const matches = note.content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);

  for (const match of matches) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget || /^(?:https?:|mailto:|qmd:|#)/.test(rawTarget)) continue;

    const target = rawTarget.split("#", 1)[0];
    if (!target) continue;
    const decodedTarget = decodeURIComponent(target);
    if (await linkTargetFound(path.dirname(note.absolutePath), decodedTarget, root, canonicalRoot)) continue;

    issues.push({
      file: note.relativePath,
      id: "link-missing-target",
      message: `repair missing local link '${rawTarget}'`,
    });
  }

  return issues;
}

/** True when a decoded local link target exists in the checked root or, for a candidate, is proven by the canonical checkout. */
async function linkTargetFound(
  noteDirectory: string,
  decodedTarget: string,
  root: string,
  canonicalRoot: string,
): Promise<boolean> {
  const resolved = path.resolve(noteDirectory, decodedTarget);
  if (await exists(resolved)) return true;
  if (canonicalRoot === path.resolve(root)) return false;

  const canonicalDirectory = path.resolve(canonicalRoot, path.relative(root, noteDirectory));
  const canonicalTarget = path.resolve(canonicalDirectory, decodedTarget);
  if (escapesRoot(root, resolved)) {
    // A sibling-repository link (AGENTS.md permits `../` paths) escapes the checked root. A
    // candidate worktree has no siblings, so prove existence from the canonical checkout instead.
    return exists(canonicalTarget);
  }
  // An in-root target can name a deliberately untracked local artifact (for example
  // Obsidian's per-machine Bases views under a gitignored directory). Only the canonical
  // checkout's own .gitignore proves that; an ordinary missing in-root link still reports.
  return (
    (await exists(canonicalTarget)) &&
    isGitIgnored(canonicalRoot, path.relative(canonicalRoot, canonicalTarget))
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the canonical checkout's own `.gitignore` matches this path and it is not tracked;
 * never throws. Deliberately omits `--no-index`: that flag disables git's default protection that
 * a tracked file can never be reported as ignored, which would let a genuinely tracked, merely
 * missing-from-the-candidate link silently pass.
 */
function isGitIgnored(canonicalRoot: string, relativePath: string): boolean {
  const result = spawnSync("git", ["check-ignore", "-q", "--", relativePath], {
    cwd: canonicalRoot,
    shell: false,
  });
  return result.status === 0;
}

function escapesRoot(root: string, resolved: string): boolean {
  const relative = path.relative(path.resolve(root), resolved);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function parseRoot(args: string[]): string {
  const value = args[args.indexOf("--root") + 1];
  return args.includes("--root") && value ? path.resolve(value) : process.cwd();
}

/**
 * Canonical vault root for escaping-link existence: `--canonical-root`, then `VAULT_CANONICAL_ROOT`,
 * then `vault.json` under the XDG config home, else `root` (which disables the fallback).
 */
async function resolveCanonicalRoot(
  args: string[],
  env: NodeJS.ProcessEnv,
  root: string,
): Promise<string> {
  const flagIndex = args.indexOf("--canonical-root");
  const flag = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  if (flag) return path.resolve(flag);
  if (env.VAULT_CANONICAL_ROOT) return path.resolve(env.VAULT_CANONICAL_ROOT);
  const configHome = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? homedir(), ".config");
  try {
    const config = JSON.parse(
      await readFile(path.join(configHome, "my-second-brain-playground", "vault.json"), "utf8"),
    ) as { schemaVersion?: unknown; vault?: unknown };
    if (config.schemaVersion === 1 && typeof config.vault === "string") {
      if (path.isAbsolute(config.vault)) return config.vault;
      const home = env.HOME ?? homedir();
      if (config.vault.startsWith("~/") && path.isAbsolute(home)) return path.resolve(home, config.vault.slice(2));
    }
  } catch {
    // No usable config: the checked root stands in for itself.
  }
  return path.resolve(root);
}

/** Machine-readable check result emitted by `--json`. */
interface VaultCheckJsonResult {
  schema_version: 1;
  findings: {
    id: VaultFindingId;
    file: string;
    message: string;
    repair_id: string | null;
    detail?: Record<string, string>;
  }[];
}

/** Project issues into the stable `--json` contract shape. */
function toJsonResult(issues: ValidationIssue[]): VaultCheckJsonResult {
  return {
    schema_version: 1,
    findings: issues.map((issue) => ({
      id: issue.id,
      file: issue.file,
      message: issue.message,
      repair_id: issue.repairId ?? null,
      ...(issue.detail ? { detail: issue.detail } : {}),
    })),
  };
}

/** Legacy `check` command: frozen human and `--json` output; unknown arguments are ignored, as before. */
export async function runCheck(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const root = parseRoot(args);
  const issues = await checkVault(root, { canonicalRoot: await resolveCanonicalRoot(args, env, root) });
  if (args.includes("--json")) {
    console.log(JSON.stringify(toJsonResult(issues)));
    if (issues.length > 0) process.exitCode = 1;
  } else if (issues.length === 0) {
    console.log("Vault check passed.");
  } else {
    for (const issue of issues) console.error(`${issue.file}: ${issue.message}`);
    console.error(`\n${issues.length} issue${issues.length === 1 ? "" : "s"} found.`);
    process.exitCode = 1;
  }
}
