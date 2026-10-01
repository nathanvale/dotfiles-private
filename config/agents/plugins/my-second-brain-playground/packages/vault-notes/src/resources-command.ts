// `vault-notes resources`: inspect-only front door to the Resources Index. It parses its arguments strictly, reads the
// vault through the Vault Catalogue, and returns one Contract Core 2.0 result holding each selected project's proposed
// index content and findings. It never writes; a Vault Steward candidate owns every write.
import path from "node:path";
import { type Envelope, type StationKey, stationResult, success } from "./contract";
import { projectsOf, proposeResources, type ResourcesProposal, readResourcesPolicy } from "./resources-index";
import { openCatalogue, type VaultCatalogue } from "./vault-catalogue";

const IDENTITY = "vault-notes.resources";
const NEXT_ACTION = "Write each create or update proposal's content inside a Vault Steward candidate, then run vault-notes check there.";

/** A result ready to emit: the validated envelope and its human rendering. */
export interface Output {
  envelope: Envelope;
  human: string;
}

interface Options {
  root: string;
  projects: string[];
  updated: string;
}

class Refusal extends Error {
  constructor(
    readonly station: StationKey,
    message: string,
  ) {
    super(message);
  }
}

function refuse(station: StationKey, message: string): Output {
  return { envelope: stationResult(IDENTITY, station, message), human: "" };
}

/** Run `vault-notes resources` with the arguments after the command word. */
export async function runResources(args: string[], cwd: string, today: string): Promise<Output> {
  try {
    const options = parseOptions(args, cwd, today);
    const catalogue = await openVault(options.root);
    return await propose(catalogue, options);
  } catch (error) {
    if (error instanceof Refusal) return refuse(error.station, error.message);
    const reason = error instanceof Error ? error.message : String(error);
    return refuse("inspectionFailed", `The vault could not be inspected: ${reason}.`);
  }
}

/** Validated options: projects are distinct lowercase slugs and `updated` is a real calendar date. */
function parseOptions(args: string[], cwd: string, today: string): Options {
  const values = readOptionValues(args.filter((arg) => arg !== "--json"));
  if (new Set(values.projects).size !== values.projects.length) throw new Refusal("usage", "Name each --project once.");
  const badProject = values.projects.find((project) => !/^[a-z0-9][a-z0-9-]*$/.test(project));
  if (badProject !== undefined) throw new Refusal("optionInvalid", `--project '${badProject}' is not a lowercase project slug.`);
  const updated = values.updated ?? today;
  if (!isCalendarDate(updated)) throw new Refusal("optionInvalid", `--updated '${updated}' is not a real YYYY-MM-DD date.`);
  return { root: path.resolve(cwd, values.root ?? "."), projects: values.projects, updated };
}

const OPTION_KEYS = new Map<string, "projects" | "root" | "updated">([
  ["--project", "projects"],
  ["--root", "root"],
  ["--updated", "updated"],
]);

// Strict: every option takes a value; --root and --updated appear at most once; --project may repeat.
function readOptionValues(args: string[]): { root?: string; updated?: string; projects: string[] } {
  const values: { root?: string; updated?: string; projects: string[] } = { projects: [] };
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [String(args[index]), args[index + 1]];
    const key = OPTION_KEYS.get(name);
    if (key === undefined) throw new Refusal("usage", `resources does not accept '${name}'.`);
    if (value === undefined || value.startsWith("--")) throw new Refusal("usage", `${name} needs a value.`);
    if (key === "projects") values.projects.push(value);
    else if (values[key] !== undefined) throw new Refusal("usage", `${name} is given more than once.`);
    else values[key] = value;
  }
  return values;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

async function openVault(root: string): Promise<VaultCatalogue> {
  try {
    return await openCatalogue(root);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Refusal("contractInvalid", `schemas/frontmatter-contract.json is not valid JSON: ${error.message}.`);
    }
    if ((error as { code?: unknown }).code === "ENOENT") {
      throw new Refusal("contractMissing", `${root} has no schemas/frontmatter-contract.json.`);
    }
    throw error;
  }
}

async function propose(catalogue: VaultCatalogue, options: Options): Promise<Output> {
  const policy = readResourcesPolicy(catalogue.contract);
  if (policy.state === "invalid") throw new Refusal("contractInvalid", `projectResources is invalid: ${policy.reason}.`);
  const notes = await catalogue.notes((placement) => placement.project !== null);
  const known = projectsOf(notes);
  const unknown = options.projects.filter((project) => !known.includes(project));
  if (unknown.length > 0) throw new Refusal("projectUnknown", `No notes under projects/ for: ${unknown.join(", ")}.`);
  const selected = options.projects.length > 0 ? options.projects : known;
  const proposals = proposeResources(notes, selected, policy.indexFile, options.updated);
  const data = { active: policy.state === "active", indexFile: policy.indexFile, updated: options.updated, projects: proposals };
  const message = `Proposed ${proposals.length} Resources Index${proposals.length === 1 ? "" : "es"}; nothing was written.`;
  return { envelope: success(IDENTITY, data, message, NEXT_ACTION), human: renderHuman(data) };
}

function renderHuman(data: { active: boolean; indexFile: string; projects: ResourcesProposal[] }): string {
  const rules = data.active ? "active" : "inactive until the contract declares projectResources";
  const lines = [`Resources Index proposals (${data.indexFile}; check rules ${rules}):`];
  for (const proposal of data.projects) {
    const counts = `${proposal.notes.length} notes, ${proposal.folderMaps.length} folder maps`;
    lines.push(`${proposal.indexPath}: ${proposal.state} (${counts}, ${proposal.findings.length} findings)`);
    for (const finding of proposal.findings) lines.push(`  ${finding.id} ${finding.file}: ${finding.message}`);
  }
  lines.push("", "Content is in --json output: result.data.projects[].content. Nothing was written.");
  return lines.join("\n");
}
