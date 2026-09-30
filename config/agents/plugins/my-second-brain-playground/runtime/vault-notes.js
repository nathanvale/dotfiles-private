// @bun
// packages/vault-notes/src/check.ts
import { spawnSync } from "child_process";
import { access, readFile as readFile3 } from "fs/promises";
import { homedir } from "os";
import path3 from "path";

// packages/vault-notes/src/vault-catalogue.ts
import { readdir, readFile as readFile2 } from "fs/promises";
import path2 from "path";

// packages/vault-notes/src/vault-contract.ts
import { readFile } from "fs/promises";
import path from "path";
async function loadContract(root) {
  const source = await readFile(path.join(root, "schemas", "frontmatter-contract.json"), "utf8");
  return JSON.parse(source);
}
function isEmptyValue(value) {
  if (value === null || value === undefined || value === "")
    return true;
  if (Array.isArray(value))
    return value.length === 0;
  if (typeof value === "object")
    return Object.keys(value).length === 0;
  return false;
}

// packages/vault-notes/src/vault-catalogue.ts
var ARTIFACT_FOLDERS = ["specs", "tickets", "proofs"];
async function openCatalogue(root) {
  const contract = await loadContract(root);
  return {
    contract,
    async notes(include = () => true) {
      const notes = [];
      for (const file of placeNotes(root, await walkNotes(root, contract), contract)) {
        if (include(file.placement))
          notes.push(await readNote(file));
      }
      return notes;
    },
    async notesWithFilenamePolicy() {
      const [noteFiles, policyFiles] = await Promise.all([walkNotes(root, contract), walkFilenamePolicy(root, contract)]);
      return {
        notes: await Promise.all(placeNotes(root, noteFiles, contract).map(readNote)),
        filenamePolicyPaths: policyFiles.map((absolutePath) => toVaultPath(root, absolutePath))
      };
    }
  };
}
function walkNotes(root, contract) {
  return collectMarkdownFiles(root, (relativePath, name) => isIgnoredNotePath(relativePath, name, contract));
}
function walkFilenamePolicy(root, contract) {
  return collectMarkdownFiles(root, (_relativePath, name, isDirectory) => isDirectory && contract.markdownFilenames.ignoredDirectories.includes(name));
}
function placeNotes(root, files, contract) {
  return files.map((absolutePath) => {
    const relativePath = toVaultPath(root, absolutePath);
    return { absolutePath, relativePath, placement: placeNote(relativePath, contract) };
  });
}
function isIgnoredNotePath(relativePath, name, contract) {
  const firstSegment = relativePath.split(path2.sep)[0];
  return name === ".git" || contract.ignored.includes(name) || contract.ignored.includes(firstSegment ?? "");
}
function toVaultPath(root, absolutePath) {
  return path2.relative(root, absolutePath).split(path2.sep).join("/");
}
async function collectMarkdownFiles(root, shouldSkip) {
  const found = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path2.join(directory, entry.name);
      const relativePath = path2.relative(root, absolutePath);
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
function placeNote(relativePath, contract) {
  const segments = relativePath.split("/");
  const family = relativePath.includes("/") ? segments[0] ?? null : null;
  const project = segments[0] === "projects" && segments.length >= 3 ? segments[1] ?? null : null;
  const folder = project !== null && segments.length >= 4 ? segments[2] : undefined;
  const artifactFolder = ARTIFACT_FOLDERS.find((name) => name === folder) ?? null;
  return {
    family,
    project,
    artifactFolder,
    get isIndex() {
      return relativePath === "README.md" || Object.keys(contract.routing.familyReadmes).some((name) => relativePath === `${name}/README.md`);
    },
    get expectedTypes() {
      return routeTypes(relativePath, segments, artifactFolder, contract);
    }
  };
}
function routeTypes(relativePath, segments, artifactFolder, contract) {
  const repositoryTypes = repositoryTypesForPath(relativePath, contract);
  if (repositoryTypes)
    return repositoryTypes;
  const family = segments[0];
  const filename = segments.at(-1);
  if (!family || !filename)
    return [];
  if (segments.length === 2 && filename === "README.md") {
    const type2 = contract.routing.familyReadmes[family];
    return type2 ? [type2] : [];
  }
  if (family === "projects" && segments.length >= 3) {
    return projectTypesForPath(segments, filename, artifactFolder, contract);
  }
  const type = contract.routing.familyNotes[family];
  return type ? [type] : [];
}
function repositoryTypesForPath(relativePath, contract) {
  const repositoryFileType = contract.routing.repositoryFiles[relativePath];
  if (repositoryFileType) {
    return [repositoryFileType];
  }
  for (const [prefix, type] of Object.entries(contract.routing.repositoryPrefixes)) {
    if (relativePath.startsWith(prefix))
      return [type];
  }
  return relativePath === "README.md" ? [contract.routing.rootReadme] : undefined;
}
function projectTypesForPath(segments, filename, artifactFolder, contract) {
  if (segments.length === 4 && filename === "README.md" && artifactFolder)
    return ["reference"];
  if (filename === "README.md" && segments.length > 3)
    return contract.routing.projectLocalTypes;
  const packetType = contract.routing.projectFiles[filename];
  if (packetType)
    return [packetType];
  const directoryType = contract.routing.projectDirectories[segments[2] ?? ""];
  return directoryType ? [directoryType] : contract.routing.projectLocalTypes;
}
async function readNote({ absolutePath, relativePath, placement }) {
  const content = await readFile2(absolutePath, "utf8");
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
    return { ...note, frontmatter: parsed };
  } catch (error) {
    return { ...note, frontmatter: null, frontmatterError: error instanceof Error ? error.message : String(error) };
  }
}

// packages/vault-notes/src/check.ts
var VAULT_FINDING_IDS = [
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
  "artifact-map-missing"
];
var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
async function checkVault(root, options = {}) {
  const canonicalRoot = path3.resolve(options.canonicalRoot ?? root);
  const catalogue = await openCatalogue(root);
  const { contract } = catalogue;
  const { notes, filenamePolicyPaths } = await catalogue.notesWithFilenamePolicy();
  const issues = validateMarkdownFilenames(filenamePolicyPaths, contract);
  for (const note of notes) {
    issues.push(...validateFrontmatter(note, contract));
    issues.push(...validateBodySecrets(note, contract));
    issues.push(...await validateLinks(note, root, canonicalRoot));
  }
  issues.push(...validateUniqueIdentities(notes, contract));
  issues.push(...validateTicketOwnership(notes));
  issues.push(...validateArtifactMaps(notes));
  return issues;
}
function validateArtifactMaps(notes) {
  const paths = new Set(notes.map((note) => note.relativePath));
  const missing = new Set;
  for (const { placement } of notes) {
    if (!placement.artifactFolder)
      continue;
    const map = `projects/${placement.project}/${placement.artifactFolder}/README.md`;
    if (!paths.has(map))
      missing.add(map);
  }
  return [...missing].map((file) => ({
    file,
    id: "artifact-map-missing",
    message: "create this stable folder map from templates/project/folder-map.md"
  }));
}
function validateTicketOwnership(notes) {
  const byPath = new Map(notes.map((note) => [note.absolutePath, note]));
  const issues = [];
  for (const note of notes) {
    if (note.frontmatter?.type !== "project-ticket")
      continue;
    const parts = note.relativePath.split("/");
    const specPath = note.frontmatter.spec_path;
    const spec = typeof specPath === "string" ? byPath.get(path3.resolve(path3.dirname(note.absolutePath), specPath)) : undefined;
    const specParts = spec?.relativePath.split("/");
    const validSpec = spec?.frontmatter?.type === "project-spec" && specParts?.length === 4 && specParts[0] === "projects" && specParts[1] === parts[1] && specParts[2] === "specs";
    if (!validSpec)
      issues.push({
        file: note.relativePath,
        id: "ticket-spec-invalid",
        message: "set spec_path to an existing project-spec in this project's specs folder"
      });
    if (parts.length !== 5 || parts[0] !== "projects" || parts[2] !== "tickets" || validSpec && parts[3] !== path3.basename(spec.relativePath, ".md")) {
      issues.push({
        file: note.relativePath,
        id: "ticket-placement-invalid",
        message: "move this ticket to tickets/<owning-spec-slug>/<ticket-slug>.md and preserve its identities"
      });
    }
  }
  return issues;
}
function validateMarkdownFilenames(files, contract) {
  const allowlist = new Set(contract.markdownFilenames.uppercaseBasenameAllowlist);
  return files.flatMap((file) => {
    const basename = path3.posix.basename(file);
    if (!/[A-Z]/.test(basename) || allowlist.has(basename))
      return [];
    return [{
      file,
      id: "filename-uppercase",
      message: `rename Markdown filename to '${basename.toLowerCase()}'; uppercase is reserved for ${Array.from(allowlist).map((value) => `'${value}'`).join(", ")}`
    }];
  });
}
function validateBodySecrets(note, contract) {
  const lines = note.content.split(`
`);
  const frontmatterEnd = lines[0]?.trim() === "---" ? lines.findIndex((line, index) => index > 0 && line.trim() === "---") : -1;
  const labels = contract.forbiddenFields.map((field) => field.split("_").map(escapeRegExp).join("[ _-]?")).sort((left, right) => right.length - left.length).join("|");
  const secretAssignment = new RegExp("\\b(?:" + labels + ")\\b\\s*(?:[:=]|\\bis\\b)\\s*[\"'`]?[^\\s\"'`]{12,}", "i");
  const issues = [];
  for (let index = frontmatterEnd + 1;index < lines.length; index += 1) {
    if (!secretAssignment.test(lines[index] ?? ""))
      continue;
    issues.push({
      file: note.relativePath,
      id: "body-secret-shaped-value",
      message: `remove secret-shaped value from note body at line ${index + 1}; ` + "keep the value with its source owner and retain only a reference"
    });
  }
  return issues;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function validateFrontmatter(note, contract) {
  const issues = [];
  const add = (id, message, repair) => issues.push({ file: note.relativePath, id, message, ...repair ?? {} });
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
  validateFieldShapes(metadata, contract, (field, message) => issues.push({
    file: note.relativePath,
    id: "field-shape-invalid",
    message,
    detail: { field }
  }));
  if (typeof metadata.summary === "string" && metadata.summary.length > contract.summaryMaxLength) {
    add("summary-too-long", `shorten 'summary' to ${contract.summaryMaxLength} characters or fewer`);
  }
  return issues;
}
function validateRequiredFields(metadata, type, contract, add) {
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
function validateTypeStatus(metadata, type, contract, add) {
  const allowedStatuses = contract.statusesByType[type];
  if (type && !allowedStatuses) {
    add("type-unknown", `replace unknown type '${type}' with a contract type`);
  } else if (allowedStatuses && typeof metadata.status === "string" && !allowedStatuses.includes(metadata.status)) {
    add("status-invalid", `use a valid status for '${type}': ${allowedStatuses.map((value) => `'${value}'`).join(", ")}`);
  }
}
function validatePathRoute(expectedTypes, type, add) {
  if (expectedTypes.length === 0) {
    add("path-unrouted", "move this note into a routed family or add an approved routing contract");
  } else if (type && !expectedTypes.includes(type)) {
    add("type-path-mismatch", `change type to ${expectedTypes.map((value) => `'${value}'`).join(" or ")} for this path`);
  }
}
function validateEmptyAndForbiddenFields(metadata, contract, add) {
  for (const field of contract.optional) {
    if (field in metadata && isEmptyValue(metadata[field])) {
      add("optional-field-empty", `remove empty optional field '${field}'`, {
        repairId: "remove-empty-optional-field",
        detail: { field }
      });
    }
  }
  for (const field of contract.forbiddenFields) {
    if (field in metadata) {
      add("forbidden-field-present", `remove forbidden secret-bearing field '${field}'`);
    }
  }
}
var FIELD_SHAPE_RULES = {
  "non-empty-string": {
    holds: (value) => typeof value === "string" && value.trim() !== "",
    wording: "a non-empty string"
  },
  date: {
    holds: (value) => typeof value === "string" && DATE_PATTERN.test(value),
    wording: "YYYY-MM-DD"
  },
  "non-empty-string-list": {
    holds: (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.trim() !== ""),
    wording: "a non-empty list of strings"
  },
  "non-empty-string-map": {
    holds: (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, entry]) => key.trim() !== "" && typeof entry === "string" && entry.trim() !== ""),
    wording: "a non-empty string map"
  }
};
function validateFieldShapes(metadata, contract, add) {
  for (const [field, shape] of Object.entries(contract.fieldShapes)) {
    if (!(field in metadata) || isEmptyValue(metadata[field]))
      continue;
    const rule = Object.hasOwn(FIELD_SHAPE_RULES, shape) ? FIELD_SHAPE_RULES[shape] : FIELD_SHAPE_RULES["non-empty-string-map"];
    if (!rule.holds(metadata[field]))
      add(field, `format '${field}' as ${rule.wording}`);
  }
}
function validateUniqueIdentities(notes, contract) {
  const seen = new Map;
  const issues = [];
  for (const note of notes) {
    for (const field of contract.identityFields) {
      issues.push(...validateIdentity(note, field, seen));
    }
  }
  return issues;
}
function validateIdentity(note, field, seen) {
  const value = note.frontmatter?.[field];
  if (typeof value !== "string" || value.trim() === "")
    return [];
  if (field === "task_identity" && value === "historical" && note.frontmatter?.type === "project-ticket") {
    if (note.frontmatter.status === "superseded")
      return [];
    if (note.frontmatter.status === "adopted") {
      return [{
        file: note.relativePath,
        id: "field-shape-invalid",
        message: "replace 'historical' task_identity with a real Task identity for adopted project-ticket",
        detail: { field: "task_identity" }
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
    message: `replace duplicate ${field} '${value}'; first used by '${existing}'`
  }];
}
async function validateLinks(note, root, canonicalRoot) {
  const issues = [];
  const matches = note.content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of matches) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget || /^(?:https?:|mailto:|qmd:|#)/.test(rawTarget))
      continue;
    const target = rawTarget.split("#", 1)[0];
    if (!target)
      continue;
    const decodedTarget = decodeURIComponent(target);
    if (await linkTargetFound(path3.dirname(note.absolutePath), decodedTarget, root, canonicalRoot))
      continue;
    issues.push({
      file: note.relativePath,
      id: "link-missing-target",
      message: `repair missing local link '${rawTarget}'`
    });
  }
  return issues;
}
async function linkTargetFound(noteDirectory, decodedTarget, root, canonicalRoot) {
  const resolved = path3.resolve(noteDirectory, decodedTarget);
  if (await exists(resolved))
    return true;
  if (canonicalRoot === path3.resolve(root))
    return false;
  const canonicalDirectory = path3.resolve(canonicalRoot, path3.relative(root, noteDirectory));
  const canonicalTarget = path3.resolve(canonicalDirectory, decodedTarget);
  if (escapesRoot(root, resolved)) {
    return exists(canonicalTarget);
  }
  return await exists(canonicalTarget) && isGitIgnored(canonicalRoot, path3.relative(canonicalRoot, canonicalTarget));
}
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
function isGitIgnored(canonicalRoot, relativePath) {
  const result = spawnSync("git", ["check-ignore", "-q", "--", relativePath], {
    cwd: canonicalRoot,
    shell: false
  });
  return result.status === 0;
}
function escapesRoot(root, resolved) {
  const relative = path3.relative(path3.resolve(root), resolved);
  return relative.startsWith("..") || path3.isAbsolute(relative);
}
function parseRoot(args) {
  const value = args[args.indexOf("--root") + 1];
  return args.includes("--root") && value ? path3.resolve(value) : process.cwd();
}
async function resolveCanonicalRoot(args, env, root) {
  const flagIndex = args.indexOf("--canonical-root");
  const flag = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  if (flag)
    return path3.resolve(flag);
  if (env.VAULT_CANONICAL_ROOT)
    return path3.resolve(env.VAULT_CANONICAL_ROOT);
  const configHome = env.XDG_CONFIG_HOME ?? path3.join(env.HOME ?? homedir(), ".config");
  try {
    const config = JSON.parse(await readFile3(path3.join(configHome, "my-second-brain-playground", "vault.json"), "utf8"));
    if (config.schemaVersion === 1 && typeof config.vault === "string" && path3.isAbsolute(config.vault)) {
      return config.vault;
    }
  } catch {}
  return path3.resolve(root);
}
function toJsonResult(issues) {
  return {
    schema_version: 1,
    findings: issues.map((issue) => ({
      id: issue.id,
      file: issue.file,
      message: issue.message,
      repair_id: issue.repairId ?? null,
      ...issue.detail ? { detail: issue.detail } : {}
    }))
  };
}
async function runCheck(args, env) {
  const root = parseRoot(args);
  const issues = await checkVault(root, { canonicalRoot: await resolveCanonicalRoot(args, env, root) });
  if (args.includes("--json")) {
    console.log(JSON.stringify(toJsonResult(issues)));
    if (issues.length > 0)
      process.exitCode = 1;
  } else if (issues.length === 0) {
    console.log("Vault check passed.");
  } else {
    for (const issue of issues)
      console.error(`${issue.file}: ${issue.message}`);
    console.error(`
${issues.length} issue${issues.length === 1 ? "" : "s"} found.`);
    process.exitCode = 1;
  }
}

// packages/vault-notes/src/contract.ts
import { randomUUID } from "crypto";
var CONTRACT_VERSION = "2.0.0";
var LEGACY_OUTCOMES = {
  "vault-notes.check": [
    {
      id: "check.passed",
      exitCode: 0,
      trigger: "No governed note has a finding.",
      human: "stdout: Vault check passed.",
      machine: 'stdout: {"schema_version":1,"findings":[]}'
    },
    {
      id: "check.findings",
      exitCode: 1,
      trigger: "One or more governed notes have a finding.",
      human: "stderr: one '<file>: <message>' line per finding, a blank line, then '<n> issue(s) found.'",
      machine: "stdout: {schema_version:1, findings:[{id, file, message, repair_id, detail?}]}"
    },
    {
      id: "check.unreadable",
      exitCode: 1,
      trigger: "schemas/frontmatter-contract.json or a note cannot be read, or a local link holds a malformed % escape (inherited URIError).",
      human: "stderr: the uncaught runtime error; no result",
      machine: "stderr: the uncaught runtime error; stdout empty"
    }
  ],
  "vault-notes.list": [
    {
      id: "list.listed",
      exitCode: 0,
      trigger: "Every selected note has title, type, status and summary.",
      human: "stdout: path, then indented title (type, status) and summary per note; or 'No notes found.'",
      machine: "stdout: {schemaVersion:1, ok:true, notes:[{path, title, type, status, summary}]}"
    },
    {
      id: "list.help",
      exitCode: 0,
      trigger: "--help or -h appears anywhere in the arguments.",
      human: "stdout: the legacy list usage text",
      machine: "stdout: the legacy list usage text"
    },
    {
      id: "list.invalid-usage",
      exitCode: 1,
      trigger: "An unknown argument, a repeated or valueless option, or an unknown family.",
      human: "stderr: INVALID_USAGE: <next action>",
      machine: "stdout: {schemaVersion:1, ok:false, code:'INVALID_USAGE', nextAction, files:[]}"
    },
    {
      id: "list.invalid-notes",
      exitCode: 1,
      trigger: "A selected note lacks title, type, status or summary.",
      human: "stderr: INVALID_NOTES: <next action>, then one file per line",
      machine: "stdout: {schemaVersion:1, ok:false, code:'INVALID_NOTES', nextAction, files}"
    },
    {
      id: "list.failed",
      exitCode: 1,
      trigger: "The vault root or its contract cannot be read.",
      human: "stderr: LIST_FAILED: <next action>",
      machine: "stdout: {schemaVersion:1, ok:false, code:'LIST_FAILED', nextAction, files:[]}"
    }
  ],
  "vault-notes.inventory": [
    {
      id: "inventory.counted",
      exitCode: 0,
      trigger: "Every governed note is counted by family, type and status.",
      human: "stdout: 'Vault notes: <n>' then By family, By type and By status sections",
      machine: "stdout: pretty-printed {total, byFamily, byType, byStatus}"
    },
    {
      id: "inventory.unreadable",
      exitCode: 1,
      trigger: "schemas/frontmatter-contract.json or a note cannot be read.",
      human: "stderr: the uncaught runtime error; no result",
      machine: "stderr: the uncaught runtime error; stdout empty"
    }
  ]
};
var COMMANDS = [
  {
    commandIdentity: "vault-notes.dispatch",
    effectClass: "inspect",
    route: [],
    summary: "Refuse a missing, unknown or malformed command selection."
  },
  {
    commandIdentity: "vault-notes.help",
    effectClass: "inspect",
    route: ["--help"],
    summary: "Show usage, commands and options."
  },
  {
    commandIdentity: "vault-notes.discovery",
    effectClass: "inspect",
    route: ["--discover"],
    summary: "Describe the contract, commands and effect exclusions."
  },
  {
    commandIdentity: "vault-notes.command-discovery",
    effectClass: "inspect",
    route: ["--discover-command"],
    summary: "Describe the possible outcomes of one command."
  },
  {
    commandIdentity: "vault-notes.check",
    effectClass: "inspect",
    route: ["check"],
    summary: "Validate governed notes: frontmatter, routing, identities, body secrets, local links, tickets and folder maps."
  },
  {
    commandIdentity: "vault-notes.list",
    effectClass: "inspect",
    route: ["list"],
    summary: "List current notes from their metadata, optionally for one family."
  },
  {
    commandIdentity: "vault-notes.inventory",
    effectClass: "inspect",
    route: ["inventory"],
    summary: "Count governed notes by family, type and status."
  }
];
var AVAILABLE_PATHS = COMMANDS.map((command) => command.commandIdentity).filter((identity) => identity !== "vault-notes.dispatch").sort();
var STATIONS = {
  usage: {
    causeCode: "USAGE_INVALID_INVOCATION",
    outcome: "refused",
    failureClass: "usage",
    exitCode: 2,
    trigger: "The arguments name no supported command, or a control option is repeated, combined or lacks its value.",
    repairAction: "Choose check, list, inventory, --help, --discover or --discover-command COMMAND_IDENTITY and retry.",
    guidance: { nextAction: "Run vault-notes --help and choose a listed command." }
  },
  serialization: {
    causeCode: "INTERNAL_RESULT_SERIALIZATION",
    outcome: "failed",
    failureClass: "internal",
    exitCode: 1,
    trigger: "The result cannot be serialized, or the serialized value fails envelope validation.",
    repairAction: "Inspect the serialization failure before retrying.",
    guidance: { nextAction: "Inspect the runtime and retry the command." }
  },
  emission: {
    causeCode: "INTERNAL_RESULT_EMISSION",
    outcome: "failed",
    failureClass: "internal",
    exitCode: 1,
    trigger: "stdout cannot be written. Machine mode then emits no envelope and nothing on stderr; human mode prints this repair on stderr.",
    repairAction: "Inspect the output stream before retrying.",
    guidance: { nextAction: "Inspect the output stream and retry the command." }
  }
};
var INSPECT_EFFECTS = { completed: [], inventoryComplete: true, remaining: [], uncertain: [] };
function envelope(message, result) {
  return { envelopeVersion: 2, contractVersion: CONTRACT_VERSION, message, availablePaths: AVAILABLE_PATHS, result };
}
function success(commandIdentity, data, message, nextAction) {
  return envelope(message, {
    runId: randomUUID(),
    commandIdentity,
    outcome: "success",
    effectClass: "inspect",
    transactionState: "unchanged",
    causeCode: "SUCCESS_UNCHANGED",
    failureClass: null,
    exitCode: 0,
    data,
    retryable: false,
    repairAction: null,
    effects: INSPECT_EFFECTS,
    nextAction
  });
}
function stationResult(commandIdentity, key, message) {
  const station = STATIONS[key];
  return envelope(message, {
    runId: randomUUID(),
    commandIdentity,
    outcome: station.outcome,
    effectClass: "inspect",
    transactionState: "unchanged",
    causeCode: station.causeCode,
    failureClass: station.failureClass,
    exitCode: station.exitCode,
    data: null,
    retryable: false,
    repairAction: station.repairAction,
    effects: INSPECT_EFFECTS,
    ...station.guidance
  });
}
var IDENTITIES = COMMANDS.map((command) => command.commandIdentity);
var ENVELOPE_KEYS = ["availablePaths", "contractVersion", "envelopeVersion", "message", "result"];
var RESULT_KEYS = [
  "causeCode",
  "commandIdentity",
  "data",
  "effectClass",
  "effects",
  "exitCode",
  "failureClass",
  "nextAction",
  "outcome",
  "repairAction",
  "retryable",
  "runId",
  "transactionState"
];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonblank(value) {
  return typeof value === "string" && value.trim() !== "";
}
function sameKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function envelopeHolds(value) {
  if (!sameKeys(value, ENVELOPE_KEYS) || value.envelopeVersion !== 2 || value.contractVersion !== CONTRACT_VERSION)
    return false;
  return nonblank(value.message) && JSON.stringify(value.availablePaths) === JSON.stringify(AVAILABLE_PATHS);
}
function baseHolds(result) {
  if (!sameKeys(result, RESULT_KEYS) || !nonblank(result.runId) || !nonblank(result.nextAction))
    return false;
  if (!IDENTITIES.includes(String(result.commandIdentity)) || result.retryable !== false)
    return false;
  if (result.effectClass !== "inspect" || result.transactionState !== "unchanged")
    return false;
  return JSON.stringify(result.effects) === JSON.stringify(INSPECT_EFFECTS);
}
function armHolds(result) {
  if (result.outcome === "success") {
    return result.causeCode === "SUCCESS_UNCHANGED" && result.failureClass === null && result.exitCode === 0 && result.repairAction === null;
  }
  const station = Object.values(STATIONS).find((entry) => entry.causeCode === result.causeCode);
  if (station === undefined || result.data !== null || result.repairAction !== station.repairAction)
    return false;
  return result.outcome === station.outcome && result.failureClass === station.failureClass && result.exitCode === station.exitCode;
}
function serializeEnvelope(value) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string")
      return null;
    const parsed = JSON.parse(text);
    if (!isRecord(parsed) || !envelopeHolds(parsed) || !isRecord(parsed.result))
      return null;
    return baseHolds(parsed.result) && armHolds(parsed.result) ? `${text}
` : null;
  } catch {
    return null;
  }
}
function discoveryData() {
  return {
    contractVersion: CONTRACT_VERSION,
    generationConventionVersion: CONTRACT_VERSION,
    profile: "simple",
    commands: COMMANDS,
    exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
    signalExits: { "130": "SIGINT", "143": "SIGTERM" },
    effectExclusions: [
      "Never writes, moves or deletes a vault note, schema, script or configuration file.",
      "Never creates a Git commit, branch or worktree, and never runs Vault Steward.",
      "Never contacts a network service; check reads the canonical checkout's .gitignore through git check-ignore only."
    ]
  };
}
var LEGACY_OUTPUT_CONTRACT = {
  kind: "legacy",
  envelope: false,
  exitMeanings: { "0": "success", "1": "findings, refusal or failure; read the outcomes" }
};
function commandDiscovery(commandIdentity) {
  return {
    command: COMMANDS.find((entry) => entry.commandIdentity === commandIdentity),
    semantics: "possible-outcomes",
    outputContract: LEGACY_OUTPUT_CONTRACT,
    outcomes: LEGACY_OUTCOMES[commandIdentity],
    ...commandIdentity === "vault-notes.check" ? { findingIds: VAULT_FINDING_IDS } : {}
  };
}
function isCommandIdentity(value) {
  return value === "vault-notes.check" || value === "vault-notes.list" || value === "vault-notes.inventory";
}

// packages/vault-notes/src/inventory.ts
import path4 from "path";
async function inventoryVault(root) {
  const notes = await (await openCatalogue(root)).notes();
  const inventory = {
    total: notes.length,
    byFamily: {},
    byType: {},
    byStatus: {}
  };
  for (const note of notes) {
    increment(inventory.byFamily, note.placement.family ?? "root");
    if (typeof note.frontmatter?.type === "string")
      increment(inventory.byType, note.frontmatter.type);
    if (typeof note.frontmatter?.status === "string")
      increment(inventory.byStatus, note.frontmatter.status);
  }
  return inventory;
}
function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}
function renderSection(title, counts) {
  return [
    title,
    ...Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => `  ${key}: ${count}`)
  ];
}
function renderInventory(inventory) {
  return [
    `Vault notes: ${inventory.total}`,
    "",
    ...renderSection("By family", inventory.byFamily),
    "",
    ...renderSection("By type", inventory.byType),
    "",
    ...renderSection("By status", inventory.byStatus)
  ].join(`
`);
}
function parseRoot2(args) {
  const value = args[args.indexOf("--root") + 1];
  return args.includes("--root") && value ? path4.resolve(value) : process.cwd();
}
async function runInventory(args) {
  const inventory = await inventoryVault(parseRoot2(args));
  console.log(args.includes("--json") ? JSON.stringify(inventory, null, 2) : renderInventory(inventory));
}

// packages/vault-notes/src/list.ts
import path5 from "path";
var usage = `List current vault notes from their metadata. This command writes nothing.

Usage: bun run list [--family <name>] [--root <path>] [--json]

Examples:
  bun run list --family products
  bun run list --family projects --json

Family indexes are navigation, not a complete catalog. New notes appear here
without an index edit. Paths are relative to the selected vault root.`;

class ListingError extends Error {
  code;
  nextAction;
  files;
  constructor(code, nextAction, files = []) {
    super(code);
    this.code = code;
    this.nextAction = nextAction;
    this.files = files;
  }
}
function parse(args) {
  const options = { root: process.cwd() };
  const seen = new Set;
  for (let index = 0;index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json")
      continue;
    if (flag !== "--root" && flag !== "--family") {
      throw new ListingError("INVALID_USAGE", "Run bun run list --help for supported arguments.");
    }
    const value = args[++index];
    if (!value || value.startsWith("--") || seen.has(flag)) {
      throw new ListingError("INVALID_USAGE", `Provide ${flag} once with a value.`);
    }
    seen.add(flag);
    if (flag === "--root")
      options.root = path5.resolve(value);
    else
      options.family = value;
  }
  return options;
}
async function listNotes(root, family) {
  const catalogue = await openCatalogue(root);
  const families = catalogue.contract.routing.familyReadmes;
  if (family && !Object.hasOwn(families, family)) {
    throw new ListingError("INVALID_USAGE", `Choose a family: ${Object.keys(families).join(", ")}.`);
  }
  const notes = [];
  const invalid = [];
  for (const note of await catalogue.notes((placement) => (!family || placement.family === family) && !placement.isIndex)) {
    const { title, type, status, summary } = note.frontmatter ?? {};
    if (typeof title !== "string" || !title.trim() || typeof type !== "string" || !type.trim() || typeof status !== "string" || !status.trim() || typeof summary !== "string" || !summary.trim()) {
      invalid.push(note.relativePath);
      continue;
    }
    notes.push({ path: note.relativePath, title, type, status, summary });
  }
  if (invalid.length) {
    throw new ListingError("INVALID_NOTES", "Run bun run check and repair the named files before relying on a complete listing.", invalid);
  }
  return notes;
}
async function runList(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  const json = args.includes("--json");
  try {
    const { root, family } = parse(args);
    const notes = await listNotes(root, family);
    if (json)
      console.log(JSON.stringify({ schemaVersion: 1, ok: true, notes }));
    else
      console.log(notes.length ? notes.map((note) => `${note.path}
  ${note.title} (${note.type}, ${note.status})
  ${note.summary}`).join(`

`) : "No notes found.");
  } catch (error) {
    const failure = error instanceof ListingError ? error : new ListingError("LIST_FAILED", "Confirm the vault root is readable and contains schemas/frontmatter-contract.json, then run bun run check.");
    if (json)
      console.log(JSON.stringify({ schemaVersion: 1, ok: false, code: failure.code, nextAction: failure.nextAction, files: failure.files }));
    else
      console.error(`${failure.code}: ${failure.nextAction}${failure.files.length ? `
${failure.files.join(`
`)}` : ""}`);
    process.exitCode = 1;
  }
}

// packages/vault-notes/src/main.ts
var LEGACY_RUNNERS = new Map([
  ["check", (args) => runCheck(args, process.env)],
  ["list", runList],
  ["inventory", runInventory]
]);
var USAGE = [
  "Usage:",
  "  vault-notes check [--root PATH] [--canonical-root PATH] [--json]",
  "  vault-notes list [--family NAME] [--root PATH] [--json] [--help]",
  "  vault-notes inventory [--root PATH] [--json]",
  "  vault-notes --help [--json] | --discover [--json] | --discover-command COMMAND_IDENTITY [--json]"
];
var OPTIONS = [
  { name: "--root", valueName: "PATH", summary: "Vault root to inspect; default the current directory." },
  {
    name: "--canonical-root",
    valueName: "PATH",
    summary: "check only: canonical checkout for escaping or gitignored link targets; else VAULT_CANONICAL_ROOT, else vault.json."
  },
  { name: "--family", valueName: "NAME", summary: "list only: one family from the vault contract." },
  { name: "--json", valueName: null, summary: "Machine output: legacy JSON for commands, one 2.0 envelope for control paths." },
  { name: "--discover", valueName: null, summary: "Describe the contract, commands and effect exclusions." },
  { name: "--discover-command", valueName: "COMMAND_IDENTITY", summary: "Describe one command's possible outcomes." },
  { name: "--help", valueName: null, summary: "Show this help." }
];
var HUMAN_HELP = [
  "Inspect vault notes. Every command is read-only.",
  "",
  ...USAGE,
  "",
  "check, list and inventory keep the vault's legacy output byte-for-byte and emit no",
  "Contract Core 2.0 envelope; help and discovery do.",
  "",
  "Options:",
  ...OPTIONS.map((option) => `  ${option.name}${option.valueName === null ? "" : ` ${option.valueName}`}  ${option.summary}`),
  "",
  "Examples:",
  "  vault-notes check --root ~/code/my-second-brain-playground",
  "  vault-notes list --family projects --json",
  "  vault-notes --discover-command vault-notes.check --json"
].join(`
`);

class UsageError extends Error {
}
function selectControl(args) {
  const rest = args.filter((arg) => arg !== "--json");
  const [first, second, ...extra] = rest;
  if (extra.length === 0 && second === undefined && (first === "--help" || first === "-h"))
    return { kind: "help" };
  if (extra.length === 0 && second === undefined && first === "--discover")
    return { kind: "discover" };
  if (extra.length === 0 && first === "--discover-command" && second !== undefined)
    return { kind: "discover-command", selector: second };
  throw new UsageError(first === undefined ? "Choose a command." : "Choose a supported command.");
}
function control(selection) {
  if (selection.kind === "help") {
    const data2 = {
      summary: "Inspect-only vault notes: check, list and inventory.",
      usage: USAGE.slice(1).map((line) => line.trim()),
      commands: COMMANDS,
      options: OPTIONS
    };
    return { envelope: success("vault-notes.help", data2, "Show help.", "Choose a command from the usage lines."), human: HUMAN_HELP };
  }
  if (selection.kind === "discover") {
    const human2 = "Commands: check (inspect, legacy output), list (inspect, legacy output), inventory (inspect, legacy output)";
    return { envelope: success("vault-notes.discovery", discoveryData(), "Describe commands.", "Choose a command to run."), human: human2 };
  }
  const { selector } = selection;
  if (!isCommandIdentity(selector))
    throw new UsageError("--discover-command needs a listed command identity.");
  const data = commandDiscovery(selector);
  const human = `${selector}: ${data.outcomes.map((outcome) => `${outcome.id}/exit ${outcome.exitCode}`).join(", ")}`;
  return {
    envelope: success("vault-notes.command-discovery", data, `Describe ${selector}.`, "Read the outcomes; discovery reports no live state."),
    human
  };
}
function controlIdentity(args) {
  if (args.includes("--help") || args.includes("-h"))
    return "vault-notes.help";
  if (args.includes("--discover"))
    return "vault-notes.discovery";
  if (args.includes("--discover-command"))
    return "vault-notes.command-discovery";
  return "vault-notes.dispatch";
}
function write(text, json) {
  try {
    process.stdout.write(text);
    return null;
  } catch {
    if (!json)
      process.stderr.write(`${STATIONS.emission.trigger} Repair: ${STATIONS.emission.repairAction}
`);
    return 1;
  }
}
function emitMachine(output) {
  const text = serializeEnvelope(output.envelope);
  if (text !== null)
    return write(text, true) ?? output.envelope.result.exitCode;
  const fallback = serializeEnvelope(stationResult(output.envelope.result.commandIdentity, "serialization", STATIONS.serialization.trigger));
  return fallback === null ? 1 : write(fallback, true) ?? 1;
}
function emit(output, json) {
  if (json)
    return emitMachine(output);
  const { exitCode, repairAction } = output.envelope.result;
  if (exitCode !== 0) {
    process.stderr.write(`${output.envelope.message} Repair: ${String(repairAction)}
`);
    return exitCode;
  }
  return write(`${output.human}
`, false) ?? exitCode;
}
function runControl(args) {
  const json = args.includes("--json");
  let output;
  try {
    output = control(selectControl(args));
  } catch (error) {
    const message = error instanceof UsageError ? error.message : "The command failed unexpectedly before producing a result.";
    output = { envelope: stationResult(controlIdentity(args), error instanceof UsageError ? "usage" : "serialization", message), human: "" };
  }
  return emit(output, json);
}
var argv = process.argv.slice(2);
var legacy = LEGACY_RUNNERS.get(argv[0] ?? "");
if (legacy)
  await legacy(argv.slice(1));
else
  process.exitCode = runControl(argv);
