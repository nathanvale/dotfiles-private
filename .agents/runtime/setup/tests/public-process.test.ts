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

function run(args: readonly string[], env: Record<string, string>, stdin: string | undefined = undefined) {
	const result = Bun.spawnSync([setup, ...args], { cwd: dotfilesRoot, env, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("projected Setup public process", () => {
	test("missing SSH prerequisites name each missing evidence class and external owner without exposing configured paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-public-process-"));
		roots.push(root);
		const privateInput = {
			ssh_identity_file_path: join(root, "secret-identity-do-not-echo"),
			ssh_public_key_path: join(root, "secret-public-key-do-not-echo"),
			ssh_known_hosts_path: join(root, "secret-known-hosts-do-not-echo"),
		};
		const env = {
			HOME: join(root, "home"),
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_DATA_HOME: join(root, "data"),
			XDG_STATE_HOME: join(root, "state"),
			PATH: process.env.PATH ?? "/usr/bin:/bin",
		};
		const args = ["sync", "--domain", "vault-git", "--check", "--input-stdin", "setup.vault-git.host-enrollment"] as const;
		const input = JSON.stringify(privateInput);

		const json = run([...args, "--json"], env, input);
		expect(json.exitCode, json.stderr).toBe(1);
		expect(JSON.parse(json.stdout).data.vault_git).toMatchObject({
			state: "needs_human",
			missingPrerequisites: ["ssh_identity_file", "ssh_public_key", "ssh_known_hosts"],
			missingPrerequisiteDetails: [
				{
					id: "ssh_identity_file",
					purpose: "dedicated_repository_ssh_identity",
					requirement: "regular_current_owner_private_file",
					expectedOwner: "current_user",
					expectedMode: "0400_or_0600",
				},
				{
					id: "ssh_public_key",
					purpose: "matching_repository_ssh_public_key",
					requirement: "regular_file_matching_identity",
					expectedOwner: "any_user",
					expectedMode: "any_mode",
				},
				{
					id: "ssh_known_hosts",
					purpose: "reviewed_repository_ssh_known_hosts",
					requirement: "nonempty_current_owner_private_file",
					expectedOwner: "current_user",
					expectedMode: "0600",
				},
			],
			nextAction: { owner: "repository_ssh_owner" },
		});
		const plain = run(args, env, input);
		expect(plain.exitCode, plain.stderr).toBe(1);
		for (const value of Object.values(privateInput)) {
			expect(json.stdout).not.toContain(value);
			expect(plain.stdout).not.toContain(value);
		}
		expect(plain.stdout).toContain("repository_ssh_owner");
		expect(plain.stdout).toContain("ssh_identity_file");
		expect(plain.stdout).toContain("ssh_public_key");
		expect(plain.stdout).toContain("ssh_known_hosts");
		expect(plain.stdout).toContain("0400_or_0600");
		expect(plain.stdout).toContain("matching_repository_ssh_public_key");
		expect(plain.stdout).toContain("0600");
	});

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
    expect(red.exitCode, red.stderr).toBe(1);
    expect(JSON.parse(red.stdout).data).toMatchObject({
      station: "sync.vault_git_evidence_reconciliation_required",
      vault_git: {
        state: "blocked",
        nextAction: {
          actionId: "reconcile_host_enrollment_evidence",
          owner: "vault_git_operator",
          condition: "host_enrollment_evidence_reconciled",
        },
      },
    });

    await Bun.write(runtime, await readFile(staged));
    await chmod(runtime, 0o755);
    const green = run(["sync", "--domain", "vault-git", "--check", "--json"], env);
    expect(green.exitCode, green.stderr).toBe(0);
    expect(JSON.parse(green.stdout).data.station).toBe("sync.vault_git_selected");
	}, 120_000);

	test("Vault Git state-root override fences Setup rollback against the Manager work root", async () => {
		const root = await mkdtemp(join(tmpdir(), "setup-public-process-"));
		roots.push(root);
		const home = join(root, "home");
		const configRoot = join(root, "config", "context", "vault-git");
		const dataRoot = join(root, "data", "context", "vault-git");
		const [prior, selected] = await Promise.all([
			installRuntimeFixture(root, dataRoot, "prior runtime"),
			installRuntimeFixture(root, dataRoot, "selected runtime"),
		]);
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
			selected_digest: selected.digest,
			prior_digest: prior.digest,
		})}\n`, { mode: 0o600 });
		const selector = join(home, ".bun", "bin", "vault-git");
		await mkdir(join(home, ".bun", "bin"), { recursive: true });
		await symlink(selected.path, selector);
		const managerStateRoot = join(root, "manager-state");
		await mkdir(join(managerStateRoot, "vault-git-transaction-manager", "a".repeat(64)), { recursive: true, mode: 0o700 });
		await writeFile(
			join(managerStateRoot, "vault-git-transaction-manager", "a".repeat(64), "current.json"),
			"{}\n",
			{ mode: 0o600 },
		);
		const environment = {
			HOME: home,
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_DATA_HOME: join(root, "data"),
			XDG_STATE_HOME: join(root, "clear-xdg-state"),
			PATH: process.env.PATH ?? "/usr/bin:/bin",
		};
		const args = ["sync", "--domain", "vault-git", "--rollback", "--check", "--json"] as const;

		const withoutOverride = run(args, environment);
		expect(withoutOverride.exitCode, withoutOverride.stderr).toBe(1);
		expect(JSON.parse(withoutOverride.stdout).data).toMatchObject({
			state: "changes",
			station: "sync.vault_git_rollback_ready",
		});
		const withOverride = run(args, { ...environment, VAULT_GIT_STATE_ROOT: managerStateRoot });
		expect(withOverride.exitCode, withOverride.stderr).toBe(1);
		expect(JSON.parse(withOverride.stdout).data).toMatchObject({
			state: "blocked",
			station: "sync.vault_git_rollback_blocked",
			vault_git: {
				nextAction: {
					actionId: "wait_for_vault_git_idle",
					owner: "vault_git_operator",
					condition: "no_active_or_uncertain_work",
				},
			},
		});
	});
});

async function installRuntimeFixture(root: string, dataRoot: string, source: string) {
	const sourcePath = join(root, `${source.replaceAll(" ", "-")}.ts`);
	const stagedPath = join(root, `${source.replaceAll(" ", "-")}.vault-git`);
	await writeFile(sourcePath, `#!/usr/bin/env bun\nconsole.log(${JSON.stringify(source)});\n`);
	const built = Bun.spawnSync(
		[process.execPath, "build", sourcePath, "--compile", "--outfile", stagedPath],
		{ cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	expect(built.exitCode, built.stderr.toString()).toBe(0);
	const digest = createHash("sha256").update(await readFile(stagedPath)).digest("hex");
	const runtimeRoot = join(dataRoot, "runtimes", digest);
	const path = join(runtimeRoot, "vault-git");
	await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
	await chmod(runtimeRoot, 0o700);
	await writeFile(path, await readFile(stagedPath), { mode: 0o755 });
	await chmod(path, 0o755);
	return { digest, path };
}
