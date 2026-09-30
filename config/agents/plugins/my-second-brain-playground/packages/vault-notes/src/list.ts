import path from "node:path";
import { openCatalogue } from "./vault-catalogue";

const usage = `List current vault notes from their metadata. This command writes nothing.

Usage: bun run list [--family <name>] [--root <path>] [--json]

Examples:
  bun run list --family products
  bun run list --family projects --json

Family indexes are navigation, not a complete catalog. New notes appear here
without an index edit. Paths are relative to the selected vault root.`;

interface NoteSummary {
  path: string;
  title: string;
  type: string;
  status: string;
  summary: string;
}

class ListingError extends Error {
  constructor(readonly code: string, readonly nextAction: string, readonly files: string[] = []) {
    super(code);
  }
}

function parse(args: string[]) {
  const options: { root: string; family?: string } = { root: process.cwd() };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json") continue;
    if (flag !== "--root" && flag !== "--family") {
      throw new ListingError("INVALID_USAGE", "Run bun run list --help for supported arguments.");
    }
    const value = args[++index];
    if (!value || value.startsWith("--") || seen.has(flag)) {
      throw new ListingError("INVALID_USAGE", `Provide ${flag} once with a value.`);
    }
    seen.add(flag);
    if (flag === "--root") options.root = path.resolve(value);
    else options.family = value;
  }
  return options;
}

async function listNotes(root: string, family?: string): Promise<NoteSummary[]> {
  const catalogue = await openCatalogue(root);
  const families = catalogue.contract.routing.familyReadmes;
  if (family && !Object.hasOwn(families, family)) {
    throw new ListingError("INVALID_USAGE", `Choose a family: ${Object.keys(families).join(", ")}.`);
  }
  const notes: NoteSummary[] = [];
  const invalid: string[] = [];
  for (const note of await catalogue.notes((placement) => !placement.isIndex && (!family || placement.family === family))) {
    const { title, type, status, summary } = note.frontmatter ?? {};
    if (typeof title !== "string" || !title.trim() || typeof type !== "string" || !type.trim() ||
        typeof status !== "string" || !status.trim() || typeof summary !== "string" || !summary.trim()) {
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

/** Legacy `list` command: frozen human, `--json` and `--help` output. */
export async function runList(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  const json = args.includes("--json");
  try {
    const { root, family } = parse(args);
    const notes = await listNotes(root, family);
    if (json) console.log(JSON.stringify({ schemaVersion: 1, ok: true, notes }));
    else console.log(notes.length ? notes.map((note) => `${note.path}\n  ${note.title} (${note.type}, ${note.status})\n  ${note.summary}`).join("\n\n") : "No notes found.");
  } catch (error) {
    const failure = error instanceof ListingError ? error : new ListingError("LIST_FAILED", "Confirm the vault root is readable and contains schemas/frontmatter-contract.json, then run bun run check.");
    if (json) console.log(JSON.stringify({ schemaVersion: 1, ok: false, code: failure.code, nextAction: failure.nextAction, files: failure.files }));
    else console.error(`${failure.code}: ${failure.nextAction}${failure.files.length ? `\n${failure.files.join("\n")}` : ""}`);
    process.exitCode = 1;
  }
}
