import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATOR = join(PACKAGE_ROOT, "app", "migrate-profile.ts");
const temporaryRoots: string[] = [];

type CommandResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((path) =>
			rm(path, { recursive: true, force: true }),
		),
	);
});

async function fixture(): Promise<{
	home: string;
	legacy: string;
	destination: string;
	everydaySentinel: string;
}> {
	const home = await mkdtemp(join(tmpdir(), "agent-chrome-profile-test-"));
	temporaryRoots.push(home);
	const legacy = join(home, ".agent-warm-profile");
	const destination = join(
		home,
		"Library",
		"Application Support",
		"Agent Chrome",
		"Chrome User Data",
	);
	const everydaySentinel = join(
		home,
		"Library",
		"Application Support",
		"Google",
		"Chrome",
		"everyday-sentinel.txt",
	);
	await mkdir(join(legacy, "Default"), { recursive: true, mode: 0o700 });
	await chmod(legacy, 0o700);
	await writeFile(join(legacy, "Local State"), "fixture-local-state\n");
	await writeFile(
		join(legacy, "Default", "Cookies"),
		"fixture-private-cookie-bytes\n",
	);
	await mkdir(join(home, "Library", "Application Support", "Google", "Chrome"), {
		recursive: true,
	});
	await writeFile(everydaySentinel, "everyday-preserve\n");
	return { home, legacy, destination, everydaySentinel };
}

async function run(home: string, mode: "--check" | "--apply"): Promise<CommandResult> {
	const child = Bun.spawn([process.execPath, "run", MIGRATOR, mode, "--json"], {
		cwd: PACKAGE_ROOT,
		env: {
			...process.env,
			HOME: home,
			PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe.skipIf(process.platform !== "darwin")("Agent Chrome profile migration", () => {
	test("preview stays read-only and points at the reserved destination's owner", async () => {
		const state = await fixture();
		const sourceCookie = await readFile(join(state.legacy, "Default", "Cookies"));
		const sourceLocalState = await readFile(join(state.legacy, "Local State"));

		// Inspection is preserved: it reads posture and reports it, which claims
		// nothing. What it points at changed, because the writer it used to point
		// at is refused.
		const preview = await run(state.home, "--check");
		expect(preview.exitCode).toBe(0);
		expect(JSON.parse(preview.stdout)).toMatchObject({
			status: "preview",
			changed_state: "none",
			source: state.legacy,
			destination: state.destination,
			next_action: "use_warm_browser",
		});
		expect(await lstat(state.destination).catch(() => null)).toBeNull();

		// Applying would create and populate the profile the Agent Browser
		// Profile Cutover reserved for Warm Browser, which is a claim on it.
		const apply = await run(state.home, "--apply");
		expect(apply.exitCode).toBe(20);
		expect(JSON.parse(apply.stdout)).toMatchObject({
			status: "blocked",
			code: "destination_retired",
			changed_state: "none",
			source: state.legacy,
			destination: state.destination,
			source_retained: true,
			next_action: "use_warm_browser",
		});
		expect(apply.stdout).not.toContain("fixture-private-cookie-bytes");
		// Nothing was created, and the legacy profile is byte for byte what it
		// was, so a rollback finds it exactly as it left it.
		expect(await lstat(state.destination).catch(() => null)).toBeNull();
		expect(await readFile(join(state.legacy, "Default", "Cookies"))).toEqual(
			sourceCookie,
		);
		expect(await readFile(join(state.legacy, "Local State"))).toEqual(
			sourceLocalState,
		);
		expect(await readFile(state.everydaySentinel, "utf8")).toBe(
			"everyday-preserve\n",
		);
	});

	test("apply refuses the reserved destination without disturbing a live legacy lock", async () => {
		const state = await fixture();
		const lock = join(state.legacy, "SingletonLock");
		await symlink(`${hostname()}-${process.pid}`, lock);

		const apply = await run(state.home, "--apply");
		expect(apply.exitCode).toBe(20);
		expect(JSON.parse(apply.stdout)).toMatchObject({
			status: "blocked",
			code: "destination_retired",
			changed_state: "none",
			next_action: "use_warm_browser",
		});
		expect(await readlink(lock)).toBe(`${hostname()}-${process.pid}`);
		expect(await lstat(state.destination).catch(() => null)).toBeNull();
	});

	test("a live legacy lock still classifies as running after the Mac hostname changes", async () => {
		const state = await fixture();
		const lock = join(state.legacy, "SingletonLock");
		await symlink(`previous-mac-name.local-${process.pid}`, lock);

		const preview = await run(state.home, "--check");
		expect(preview.exitCode).toBe(20);
		expect(JSON.parse(preview.stdout)).toMatchObject({
			status: "blocked",
			code: "browser_running",
			changed_state: "none",
			next_action: "close_agent_chrome",
		});
		expect(await lstat(state.destination).catch(() => null)).toBeNull();
	});

	test("an existing destination is preserved and never overwritten", async () => {
		const state = await fixture();
		await mkdir(state.destination, { recursive: true });
		await writeFile(join(state.destination, "preserve.txt"), "destination-preserve\n");

		const apply = await run(state.home, "--apply");
		expect(apply.exitCode).toBe(20);
		// The retirement answers first, so the destination is not even inspected;
		// the guarantee this case owns, that an existing destination is never
		// overwritten, holds all the same and now holds one step earlier.
		expect(JSON.parse(apply.stdout)).toMatchObject({
			status: "blocked",
			code: "destination_retired",
			changed_state: "none",
		});
		expect(await readFile(join(state.destination, "preserve.txt"), "utf8")).toBe(
			"destination-preserve\n",
		);
		expect(await readFile(state.everydaySentinel, "utf8")).toBe(
			"everyday-preserve\n",
		);
	});

	test("check and apply reject a symlinked Agent Chrome owner without changing its target", async () => {
		const state = await fixture();
		const ownerRoot = join(
			state.home,
			"Library",
			"Application Support",
			"Agent Chrome",
		);
		const foreignTarget = join(state.home, "foreign-owner-target");
		await mkdir(foreignTarget, { mode: 0o755 });
		await symlink(foreignTarget, ownerRoot);

		const preview = await run(state.home, "--check");
		expect(preview.exitCode).toBe(20);
		expect(JSON.parse(preview.stdout)).toMatchObject({
			status: "blocked",
			code: "destination_owner_unsafe",
			changed_state: "none",
		});
		expect((await lstat(foreignTarget)).mode & 0o777).toBe(0o755);
		expect(await lstat(state.destination).catch(() => null)).toBeNull();

		const apply = await run(state.home, "--apply");
		expect(apply.exitCode).toBe(20);
		// Check still owns the symlinked-owner verdict. Apply never reaches it,
		// because the reserved destination is refused before anything is read,
		// and the foreign target is left exactly as it was either way.
		expect(JSON.parse(apply.stdout)).toMatchObject({
			status: "blocked",
			code: "destination_retired",
			changed_state: "none",
		});
		expect((await lstat(foreignTarget)).mode & 0o777).toBe(0o755);
		expect(await lstat(state.destination).catch(() => null)).toBeNull();
	});
});
