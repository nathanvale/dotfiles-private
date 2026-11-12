import { afterAll, expect, test } from "bun:test";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PACKAGE_ROOT } from "../support/harness.ts";

// The README blocks are run byte-for-byte with /bin/sh, the same seam the
// desktop entry uses. Expectations come from the fixture files, never the recipe.
const README = await readFile(join(PACKAGE_ROOT, "README.md"), "utf8");

function documented(heading: string): string {
  const lines = README.split("\n");
  const start = lines.indexOf(`### ${heading}`);
  const open = lines.indexOf("```sh", start);
  const close = lines.indexOf("```", open + 1);
  expect(start).toBeGreaterThan(-1);
  expect(open).toBeGreaterThan(start);
  return lines.slice(open + 1, close).join("\n");
}

const ADOPT = documented("Adopt on the Mac");
const ROLLBACK = documented("Roll back on the Mac");
const PLACE_GUIDE = documented("Place the guide in the pilot");
const REMOVE_GUIDE = documented("Remove the guide from the pilot");

const SOURCES = ["examples/targets.json", "desktop/Remote Development.command", "bin/remote-dev", "guide/START-HERE.md"];
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** A throwaway Mac-like home with the package checkout at its documented path. */
async function macHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "remote-dev-adopt-"));
  roots.push(home);
  const checkout = join(home, "code/dotfiles/packages/remote-dev");
  for (const source of SOURCES.slice(0, 3)) {
    await mkdir(dirname(join(checkout, source)), { recursive: true });
    await copyFile(join(PACKAGE_ROOT, source), join(checkout, source));
  }
  for (const folder of ["Desktop", ".config", ".local/bin", ".local/state"]) {
    await mkdir(join(home, folder), { recursive: true });
  }
  return home;
}

function sh(block: string, home: string, cwd = home) {
  const result = Bun.spawnSync(["/bin/sh", "-c", block], {
    cwd,
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString(), stdout: result.stdout.toString() };
}

/** Independent reader: every path under root with its kind and content or link target. */
async function snapshot(root: string): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const info = await lstat(path);
      const relative = path.slice(root.length + 1);
      if (info.isSymbolicLink()) entries.push(`${relative} -> ${await readlink(path)}`);
      else if (info.isDirectory()) {
        entries.push(`${relative}/`);
        await walk(path);
      } else entries.push(`${relative} = ${await readFile(path, "utf8")}`);
    }
  };
  await walk(root);
  return entries;
}

const source = (path: string) => readFile(join(PACKAGE_ROOT, path), "utf8");
const targetsPath = (home: string) => join(home, ".config/remote-dev/targets.json");
const desktopPath = (home: string) => join(home, "Desktop/Remote Development.command");
const linkPath = (home: string) => join(home, ".local/bin/remote-dev");

const OCCUPIED: [string, (home: string) => Promise<string>][] = [
  ["an existing targets file", async (home) => {
    await mkdir(join(home, ".config/remote-dev"));
    await writeFile(targetsPath(home), "user-owned targets\n");
    return targetsPath(home);
  }],
  ["a broken symlink at the desktop item", async (home) => {
    await symlink(join(home, "missing-target"), desktopPath(home));
    return desktopPath(home);
  }],
  ["an existing remote-dev link", async (home) => {
    await symlink("/opt/other/remote-dev", linkPath(home));
    return linkPath(home);
  }],
  ["a file where the config folder goes", async (home) => {
    await writeFile(join(home, ".config/remote-dev"), "user-owned file\n");
    return join(home, ".config/remote-dev");
  }],
  ["an earlier adoption record", async (home) => {
    await mkdir(join(home, ".local/state/remote-dev-adoption"));
    return join(home, ".local/state/remote-dev-adoption");
  }],
];

test.each(OCCUPIED)("Mac adoption refuses %s and writes nothing", async (_, occupy) => {
  const home = await macHome();
  const occupied = await occupy(home);
  const before = await snapshot(home);
  const adopt = sh(ADOPT, home);
  expect(adopt.exitCode).toBe(1);
  expect(adopt.stderr).toBe(`Occupied, nothing adopted: ${occupied}\n`);
  expect(await snapshot(home)).toEqual(before);
});

test("Mac adoption adds exactly the owned files, and rollback removes them while unchanged", async () => {
  const home = await macHome();
  await writeFile(join(home, ".local/bin/other-tool"), "unrelated\n");
  const before = await snapshot(home);
  const adopt = sh(ADOPT, home);
  expect(adopt.stderr).toBe("");
  expect(adopt.exitCode).toBe(0);
  expect(await readFile(targetsPath(home), "utf8")).toBe(await source("examples/targets.json"));
  expect(await readFile(desktopPath(home), "utf8")).toBe(await source("desktop/Remote Development.command"));
  expect((await lstat(desktopPath(home))).mode & 0o777).toBe(0o755);
  expect(await readlink(linkPath(home))).toBe(`${home}/code/dotfiles/packages/remote-dev/bin/remote-dev`);
  const rollback = sh(ROLLBACK, home);
  expect(rollback).toEqual({ exitCode: 0, stderr: "", stdout: "remote-dev adoption removed.\n" });
  expect(await snapshot(home)).toEqual(before);
  expect(sh(ROLLBACK, home)).toMatchObject({ exitCode: 1, stderr: "No remote-dev adoption record; nothing removed.\n" });
});

test("rollback keeps and names changed additions, then finishes after review", async () => {
  const home = await macHome();
  await mkdir(join(home, ".config/remote-dev"));
  await writeFile(join(home, ".config/remote-dev/notes.txt"), "user notes\n");
  const before = await snapshot(home);
  expect(sh(ADOPT, home).exitCode).toBe(0);
  const edited = `${(await source("examples/targets.json")).trimEnd()}\n// board added locally\n`;
  await writeFile(targetsPath(home), edited);
  await rm(linkPath(home));
  await symlink("/opt/other/remote-dev", linkPath(home));
  const first = sh(ROLLBACK, home);
  expect(first.exitCode).toBe(1);
  expect(first.stderr).toBe(
    [
      `Kept, changed since adoption: ${linkPath(home)}`,
      `Kept, changed since adoption: ${targetsPath(home)}`,
      "Review the kept paths, then run this again.",
      "",
    ].join("\n"),
  );
  expect(await readFile(targetsPath(home), "utf8")).toBe(edited);
  expect(await readlink(linkPath(home))).toBe("/opt/other/remote-dev");
  expect(await lstat(desktopPath(home)).catch(() => null)).toBeNull();
  // After review the user removes their changed copies; the rerun then completes.
  await rm(targetsPath(home));
  await rm(linkPath(home));
  expect(sh(ROLLBACK, home).exitCode).toBe(0);
  expect(await snapshot(home)).toEqual(before);
});

test("a partial Mac adoption is undone by the same rollback without touching anything else", async () => {
  const home = await macHome();
  await rm(join(home, "Desktop"), { recursive: true });
  const before = await snapshot(home);
  const adopt = sh(ADOPT, home);
  expect(adopt.exitCode).not.toBe(0);
  expect(await readFile(targetsPath(home), "utf8")).toBe(await source("examples/targets.json"));
  expect(await lstat(linkPath(home)).catch(() => null)).toBeNull();
  const rollback = sh(ROLLBACK, home);
  expect(rollback).toEqual({ exitCode: 0, stderr: "", stdout: "remote-dev adoption removed.\n" });
  expect(await snapshot(home)).toEqual(before);
});

/** A throwaway container home and /workspace stand-in holding the dotfiles checkout. */
async function pilot(): Promise<{ home: string; root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "remote-dev-guide-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const guide = join(workspace, "dotfiles/packages/remote-dev/guide/START-HERE.md");
  await mkdir(dirname(guide), { recursive: true });
  await copyFile(join(PACKAGE_ROOT, "guide/START-HERE.md"), guide);
  const home = join(root, "home");
  await mkdir(join(home, ".local/state"), { recursive: true });
  return { home, root, workspace };
}

test.each([
  ["an existing START-HERE.md", (path: string) => writeFile(path, "existing pilot guide\n")],
  ["a broken START-HERE.md symlink", (path: string) => symlink("/nowhere/START-HERE.md", path)],
])("placing the guide refuses %s and writes nothing", async (_, occupy) => {
  const { home, root, workspace } = await pilot();
  await occupy(join(workspace, "START-HERE.md"));
  const before = await snapshot(root);
  const place = sh(PLACE_GUIDE, home, workspace);
  expect(place.exitCode).toBe(1);
  expect(place.stderr).toBe("Occupied, nothing placed: START-HERE.md\n");
  expect(await snapshot(root)).toEqual(before);
});

test("the guide is placed and removed while unchanged, and kept once edited", async () => {
  const { home, root, workspace } = await pilot();
  const before = await snapshot(root);
  expect(sh(PLACE_GUIDE, home, workspace).exitCode).toBe(0);
  expect(await readFile(join(workspace, "START-HERE.md"), "utf8")).toBe(await source("guide/START-HERE.md"));
  expect(sh(REMOVE_GUIDE, home, root)).toEqual({ exitCode: 0, stderr: "", stdout: "Guide removed.\n" });
  expect(await snapshot(root)).toEqual(before);

  expect(sh(PLACE_GUIDE, home, workspace).exitCode).toBe(0);
  await writeFile(join(workspace, "START-HERE.md"), "edited in the pilot\n");
  const removal = sh(REMOVE_GUIDE, home, root);
  expect(removal.exitCode).toBe(1);
  expect(removal.stderr).toBe(`Kept, changed since placement: ${workspace}/START-HERE.md\n`);
  expect(await readFile(join(workspace, "START-HERE.md"), "utf8")).toBe("edited in the pilot\n");
});
