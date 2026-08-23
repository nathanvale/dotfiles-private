import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const dotfilesRoot = join(import.meta.dir, "..", "..", "..", "..");
const setup = join(dotfilesRoot, "node_modules", ".bin", "setup");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function run(args: readonly string[], env: Record<string, string>) {
  const result = Bun.spawnSync([setup, ...args], { cwd: dotfilesRoot, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("projected Setup public process", () => {
  test("fresh HOME/XDG reads only the selected contained runtime and detects a corrupt selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-public-process-"));
    roots.push(root);
    const home = join(root, "home");
    const configRoot = join(root, "config", "context", "vault-git");
    const dataRoot = join(root, "data", "context", "vault-git");
    const source = join(root, "fixture.ts");
    const staged = join(root, "staged-vault-git");
    await writeFile(source, '#!/usr/bin/env bun\nconsole.log("selected fixture vault-git");\n');
    const built = Bun.spawnSync([process.execPath, "build", source, "--compile", "--outfile", staged], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(built.exitCode, built.stderr.toString()).toBe(0);
    const digest = createHash("sha256").update(await readFile(staged)).digest("hex");
    const runtimeRoot = join(dataRoot, "runtimes", digest);
    const runtime = join(runtimeRoot, "vault-git");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await chmod(runtimeRoot, 0o700);
    await Bun.write(runtime, await readFile(staged));
    await chmod(runtime, 0o755);
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    await chmod(configRoot, 0o700);
    await writeFile(join(configRoot, "activation.json"), `${JSON.stringify({
      schema_version: 1,
      host_handle: `host_${"a".repeat(32)}`,
      ssh_identity_file_path: "/private/fixture/id",
      ssh_public_key_path: "/private/fixture/id.pub",
      ssh_known_hosts_path: "/private/fixture/known_hosts",
    })}\n`, { mode: 0o600 });
    await writeFile(join(configRoot, "runtime-selection.json"), `${JSON.stringify({
      schema_version: 1,
      selected_digest: digest,
      prior_digest: null,
    })}\n`, { mode: 0o600 });
    const selector = join(home, ".bun", "bin", "vault-git");
    await mkdir(join(home, ".bun", "bin"), { recursive: true });
    await symlink(runtime, selector);
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    };

    const selected = run(["sync", "--domain", "vault-git", "--check", "--json"], env);
    expect(selected.exitCode, selected.stderr).toBe(0);
    expect(JSON.parse(selected.stdout).data).toMatchObject({
      station: "sync.vault_git_selected",
      vault_git: { selectedRuntime: { digest }, priorRuntime: null },
    });

    await writeFile(runtime, "corrupt selected runtime");
    await chmod(runtime, 0o755);
    const red = run(["sync", "--domain", "vault-git", "--check", "--json"], env);
    expect(red.exitCode, red.stderr).toBe(0);
    expect(JSON.parse(red.stdout).data).toMatchObject({
      station: "sync.vault_git_inputs_required",
      vault_git: { state: "not_enrolled" },
    });

    await Bun.write(runtime, await readFile(staged));
    await chmod(runtime, 0o755);
    const green = run(["sync", "--domain", "vault-git", "--check", "--json"], env);
    expect(green.exitCode, green.stderr).toBe(0);
    expect(JSON.parse(green.stdout).data.station).toBe("sync.vault_git_selected");
  }, 120_000);
});
