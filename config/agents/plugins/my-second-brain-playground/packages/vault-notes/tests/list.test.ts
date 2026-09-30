import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const roots: string[] = [];
const command = path.join(import.meta.dir, "..", "src", "main.ts");
const contract = await readFile(path.join(import.meta.dir, "fixtures", "frontmatter-contract.json"), "utf8");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vault-list-"));
  roots.push(root);
  await mkdir(path.join(root, "schemas"));
  await mkdir(path.join(root, "products"));
  await mkdir(path.join(root, "source-artifacts"));
  await writeFile(path.join(root, "schemas/frontmatter-contract.json"), contract);
  await note(root, "products/README.md", "Products", "family-index");
  await note(root, "source-artifacts/README.md", "Source Artifacts", "family-index");
  return root;
}

async function note(root: string, file: string, title: string, type = "product") {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), `---\ntitle: "${title}"\ntype: ${type}\nstatus: active\nupdated: 2026-09-05\nsummary: "Fictional listing fixture."\n---\n\n# ${title}\n`);
}

function list(root: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, command, "list", "--root", root, "--json", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  return { exit: result.exitCode, stdout, stderr };
}

test("new notes become discoverable without editing the family index", async () => {
  const root = await fixture();
  const originalIndex = await readFile(path.join(root, "products/README.md"), "utf8");
  await note(root, "products/first.md", "First Lamp");
  const first = list(root, "--family", "products");
  expect(first.exit).toBe(0);
  expect(first.stderr).toBe("");
  expect(JSON.parse(first.stdout).notes.map((n: { path: string }) => n.path)).toEqual(["products/first.md"]);
  await note(root, "products/second.md", "Second Lamp");
  const second = list(root, "--family", "products");
  expect(second.exit).toBe(0);
  expect(JSON.parse(second.stdout).notes).toEqual([
    { path: "products/first.md", title: "First Lamp", type: "product", status: "active", summary: "Fictional listing fixture." },
    { path: "products/second.md", title: "Second Lamp", type: "product", status: "active", summary: "Fictional listing fixture." },
  ]);
  expect(await readFile(path.join(root, "products/README.md"), "utf8")).toBe(originalIndex);
});

test("family listing includes project packets and excludes other families and indexes", async () => {
  const root = await fixture();
  await note(root, "products/lamp.md", "Lamp");
  await note(root, "projects/README.md", "Projects", "family-index");
  await note(root, "projects/reading/README.md", "Reading Session", "project");
  await note(root, ".worktrees/other/products/hidden.md", "Hidden");
  const result = list(root, "--family", "projects");
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout).notes.map((n: { path: string }) => n.path)).toEqual(["projects/reading/README.md"]);
});

test("source-artifact notes are listed by their dedicated family route", async () => {
  const root = await fixture();
  await writeFile(
    path.join(root, "source-artifacts", "fixture.md"),
    `---\ntitle: "Fixture Source"\ntype: source-artifact\nstatus: active\nupdated: 2026-09-25\nsummary: "Synthetic source artifact listing fixture."\nsources:\n  - https://drive.google.com/file/d/fixture-drive-file-id/view\nsource_handles:\n  drive_account: personal\n  drive_file_id: fixture-drive-file-id\n---\n\n# Fixture Source\n`,
  );
  const index = await readFile(path.join(root, "source-artifacts/README.md"), "utf8");
  const result = list(root, "--family", "source-artifacts");
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).notes).toEqual([
    {
      path: "source-artifacts/fixture.md",
      title: "Fixture Source",
      type: "source-artifact",
      status: "active",
      summary: "Synthetic source artifact listing fixture.",
    },
  ]);
  expect(await readFile(path.join(root, "source-artifacts/README.md"), "utf8")).toBe(index);
});

test("invalid arguments and unknown families return structured repair without a listing", async () => {
  const root = await fixture();
  for (const args of [["--family", "elsewhere"], ["--unknown"], ["--family"]]) {
    const result = list(root, ...args);
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "INVALID_USAGE" });
    expect(JSON.parse(result.stdout).nextAction.length).toBeGreaterThan(0);
  }
});

test("malformed note metadata is reported instead of silently hiding the file", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "products/broken.md"), "# Missing metadata\n");
  const result = list(root, "--family", "products");
  expect(result.exit).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "INVALID_NOTES", files: ["products/broken.md"] });
  expect(await readFile(path.join(root, "products/broken.md"), "utf8")).toBe("# Missing metadata\n");
});
