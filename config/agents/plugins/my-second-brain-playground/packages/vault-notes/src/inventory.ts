import path from "node:path";
import { openCatalogue } from "./vault-catalogue";

/** Counts that let humans and agents inspect the vault without reading every note. */
export interface VaultInventory {
  total: number;
  byFamily: Record<string, number>;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
}

/** Count governed notes by family, type, and status. */
export async function inventoryVault(root: string): Promise<VaultInventory> {
  const notes = await (await openCatalogue(root)).notes();
  const inventory: VaultInventory = {
    total: notes.length,
    byFamily: {},
    byType: {},
    byStatus: {},
  };

  for (const note of notes) {
    increment(inventory.byFamily, note.placement.family ?? "root");
    if (typeof note.frontmatter?.type === "string") increment(inventory.byType, note.frontmatter.type);
    if (typeof note.frontmatter?.status === "string") increment(inventory.byStatus, note.frontmatter.status);
  }

  return inventory;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function renderSection(title: string, counts: Record<string, number>): string[] {
  return [
    title,
    ...Object.entries(counts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => `  ${key}: ${count}`),
  ];
}

/** Render a compact inventory for a human reader. */
function renderInventory(inventory: VaultInventory): string {
  return [
    `Vault notes: ${inventory.total}`,
    "",
    ...renderSection("By family", inventory.byFamily),
    "",
    ...renderSection("By type", inventory.byType),
    "",
    ...renderSection("By status", inventory.byStatus),
  ].join("\n");
}

function parseRoot(args: string[]): string {
  const value = args[args.indexOf("--root") + 1];
  return args.includes("--root") && value ? path.resolve(value) : process.cwd();
}

/** Legacy `inventory` command: frozen human and `--json` output. */
export async function runInventory(args: string[]): Promise<void> {
  const inventory = await inventoryVault(parseRoot(args));
  console.log(args.includes("--json") ? JSON.stringify(inventory, null, 2) : renderInventory(inventory));
}
