// Vault Catalogue interface: which files are notes, where each note sits, and when a note is read. check, list,
// inventory and the coming Resources Index all depend on these answers.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openCatalogue } from "../src/vault-catalogue";

const contract = await Bun.file(path.join(import.meta.dir, "fixtures", "frontmatter-contract.json")).text();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function vault(files: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vault-catalogue-"));
  roots.push(root);
  await mkdir(path.join(root, "schemas"));
  await writeFile(path.join(root, "schemas", "frontmatter-contract.json"), contract);
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), `---\ntitle: "${file}"\n---\n`);
  }
  return root;
}

test("governed notes and the filename policy apply their own exclusions", async () => {
  const catalogue = await openCatalogue(
    await vault([
      "README.md",
      "reference/AGENTS.md",
      "templates/Project.md",
      ".codex/Notes.md",
      ".playwright-cli/Trace.md",
      ".worktrees/candidate/Note.md",
    ]),
  );

  expect((await catalogue.notes()).map((note) => note.relativePath)).toEqual([".playwright-cli/Trace.md", "README.md"]);
  expect(await catalogue.filenamePolicyPaths()).toEqual([
    ".codex/Notes.md",
    "README.md",
    "reference/AGENTS.md",
    "templates/Project.md",
  ]);
});

test("placement names the owning project at any depth and the types routed to each path", async () => {
  const catalogue = await openCatalogue(
    await vault([
      "README.md",
      "stray.md",
      "docs/README.md",
      "projects/README.md",
      "projects/loose.md",
      "projects/alpha/README.md",
      "projects/alpha/research/deep/finding.md",
      "projects/alpha/research/README.md",
      "projects/alpha/specs/README.md",
      "projects/alpha/tickets/feature/implement.md",
      "projects/alpha/proofs/run.md",
    ]),
  );
  const placements = Object.fromEntries((await catalogue.notes()).map((note) => [note.relativePath, note.placement]));
  const projectLocal = ["decision", "reference"];

  expect(placements).toEqual({
    "README.md": { family: null, project: null, artifactFolder: null, isIndex: true, expectedTypes: ["vault-index"] },
    "stray.md": { family: null, project: null, artifactFolder: null, isIndex: false, expectedTypes: [] },
    "docs/README.md": { family: "docs", project: null, artifactFolder: null, isIndex: false, expectedTypes: [] },
    "projects/README.md": { family: "projects", project: null, artifactFolder: null, isIndex: true, expectedTypes: ["family-index"] },
    "projects/loose.md": { family: "projects", project: null, artifactFolder: null, isIndex: false, expectedTypes: [] },
    "projects/alpha/README.md": { family: "projects", project: "alpha", artifactFolder: null, isIndex: false, expectedTypes: ["project"] },
    "projects/alpha/research/deep/finding.md": {
      family: "projects",
      project: "alpha",
      artifactFolder: null,
      isIndex: false,
      expectedTypes: projectLocal,
    },
    "projects/alpha/research/README.md": { family: "projects", project: "alpha", artifactFolder: null, isIndex: false, expectedTypes: projectLocal },
    "projects/alpha/specs/README.md": { family: "projects", project: "alpha", artifactFolder: "specs", isIndex: false, expectedTypes: ["reference"] },
    "projects/alpha/tickets/feature/implement.md": {
      family: "projects",
      project: "alpha",
      artifactFolder: "tickets",
      isIndex: false,
      expectedTypes: ["project-ticket"],
    },
    "projects/alpha/proofs/run.md": { family: "projects", project: "alpha", artifactFolder: "proofs", isIndex: false, expectedTypes: projectLocal },
  });
});

test("a selection is made before any note is read, so an unselected unreadable note cannot fail it", async () => {
  const root = await vault(["products/widget.md", "people/locked.md"]);
  await chmod(path.join(root, "people", "locked.md"), 0o000);
  const catalogue = await openCatalogue(root);

  const products = await catalogue.notes((placement) => placement.family === "products");

  expect(products.map((note) => [note.relativePath, note.frontmatter])).toEqual([["products/widget.md", { title: "products/widget.md" }]]);
  if (process.getuid?.() !== 0) await expect(catalogue.notes()).rejects.toThrow("EACCES");
});
