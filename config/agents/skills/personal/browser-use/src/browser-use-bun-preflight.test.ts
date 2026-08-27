import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
	BUN_PREFLIGHT_INSTALL_COMMAND,
	BUN_PREFLIGHT_MISSING_EXIT_CODE,
	BUN_PREFLIGHT_RUNTIME_NAME,
	bunPreflightRemedy,
	bunPreflightShim,
} from "./browser-use-bun-preflight";

// DDA-A21 (runtime-env cluster): a missing or wrong-version Bun runtime must
// yield ACTIONABLE guidance, not a raw exec error. The oracle: PATH without
// `bun` — the installed entry fails with a named remedy.
//
// PROCESS tier: the launcher shim is spawned as the installed entry under a
// PATH stripped of bun, and the emitted stderr/exit are asserted. Baseline
// contrast: a raw `#!/usr/bin/env bun` shebang under the same PATH emits the
// bare `env: bun` error the shim replaces. HERMETIC: temp dirs only; the only
// `bun` visible is a fixture the test plants, never the real runtime.

const disposables: (() => void)[] = [];
afterAll(() => {
	for (const dispose of disposables) dispose();
});

function sandbox() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "browser-use-bun-preflight-")));
	disposables.push(() => rmSync(base, { recursive: true, force: true }));
	return base;
}

// A PATH containing only the standard system dirs — deliberately no bun.
const BUN_LESS_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

describe("DDA-A21 bun runtime preflight on the installed entry", () => {
	test("the checked-in self-hosted entry emits the contract remedy without bun", () => {
		const deliveredEntry = join(import.meta.dir, "browser-use-bun-preflight.ts");
		const result = spawnSync(deliveredEntry, ["task", "list"], {
			env: { PATH: BUN_LESS_PATH },
			encoding: "utf8",
		});

		expect(result.status).toBe(BUN_PREFLIGHT_MISSING_EXIT_CODE);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(`${bunPreflightRemedy("browser-use")}\n`);
	});

	test("baseline: a raw #!/usr/bin/env bun shebang emits a bare exec error under a bun-less PATH", () => {
		const base = sandbox();
		const raw = join(base, "browser-use-raw");
		writeFileSync(raw, "#!/usr/bin/env bun\nconsole.log('ran');\n");
		chmodSync(raw, 0o755);

		const result = spawnSync(raw, [], { env: { PATH: BUN_LESS_PATH }, encoding: "utf8" });

		// The raw shebang is exactly the DDA-A21 hazard: no named remedy, a bare
		// `env: bun` exec failure at exit 127.
		expect(result.status).toBe(127);
		expect(result.stderr).toContain("bun");
		expect(result.stderr).not.toContain(BUN_PREFLIGHT_INSTALL_COMMAND);
	});

	test("the shim replaces the raw error with a named, actionable remedy and a typed exit", () => {
		const base = sandbox();
		const shimPath = join(base, "browser-use");
		writeFileSync(
			shimPath,
			bunPreflightShim({ commandName: "browser-use", entryPath: "/opt/browser-use/src/browser-use.ts" }),
		);
		chmodSync(shimPath, 0o755);

		const result = spawnSync(shimPath, ["task", "list"], {
			env: { PATH: BUN_LESS_PATH },
			encoding: "utf8",
		});

		// Typed exit code (input tier), never the bare 127 exec error.
		expect(result.status).toBe(BUN_PREFLIGHT_MISSING_EXIT_CODE);
		// The remedy NAMES the runtime, the install command, and the command.
		expect(result.stderr).toContain(BUN_PREFLIGHT_RUNTIME_NAME);
		expect(result.stderr).toContain(BUN_PREFLIGHT_INSTALL_COMMAND);
		expect(result.stderr).toContain("browser-use");
		// It is NOT the raw exec error.
		expect(result.stderr).not.toContain("No such file or directory");
		// stdout stays clean — the remedy is a stderr diagnostic.
		expect(result.stdout).toBe("");
	});

	test("with bun present on PATH the shim execs the entry, preserving args and exit status", () => {
		const base = sandbox();
		const binDir = join(base, "bin");
		mkdirSync(binDir, { recursive: true });
		// A fixture `bun` that echoes its args and exits non-zero, so the test can
		// prove the shim `exec`'d it (args preserved) rather than short-circuiting.
		const fakeBun = join(binDir, "bun");
		writeFileSync(fakeBun, '#!/bin/sh\nprintf "bun-ran %s\\n" "$*"\nexit 7\n');
		chmodSync(fakeBun, 0o755);

		const shimPath = join(base, "browser-use");
		writeFileSync(
			shimPath,
			bunPreflightShim({ commandName: "browser-use", entryPath: "/opt/browser-use/src/browser-use.ts" }),
		);
		chmodSync(shimPath, 0o755);

		const result = spawnSync(shimPath, ["task", "list"], {
			env: { PATH: `${binDir}:${BUN_LESS_PATH}` },
			encoding: "utf8",
		});

		// The shim exec'd the fixture bun with the real entry followed by the
		// forwarded args, and the fixture's exit status propagated.
		expect(result.status).toBe(7);
		expect(result.stdout).toContain("bun-ran");
		expect(result.stdout).toContain("/opt/browser-use/src/browser-use.ts");
		expect(result.stdout).toContain("task list");
	});

	// LOADER POLICY (cwd .env containment). Bun auto-loads a `.env` from the
	// invocation cwd. Without `--no-env-file` any directory the operator stands in
	// can inject AUTH_TOKEN_FORBIDDEN_ENV_KEYS into the CLI process and trip the
	// auth custody gate on token material nobody exported. These tests use an
	// explicit non-secret SENTINEL only; no real credential is read or emitted.
	test("the launcher keeps a cwd .env out of the CLI process", () => {
		const base = sandbox();
		const binDir = join(base, "bin");
		const workdir = join(base, "workdir");
		mkdirSync(binDir, { recursive: true });
		mkdirSync(workdir, { recursive: true });
		// A fixture `bun` that reports the forwarded flags and whether the real bun
		// would have been asked to skip env-file loading.
		const fakeBun = join(binDir, "bun");
		writeFileSync(fakeBun, '#!/bin/sh\nprintf "flags %s\\n" "$*"\n');
		chmodSync(fakeBun, 0o755);
		writeFileSync(join(workdir, ".env"), "BROWSER_USE_TOKEN=SENTINEL_NOT_A_REAL_TOKEN\n");

		const shimPath = join(base, "browser-use");
		writeFileSync(
			shimPath,
			bunPreflightShim({ commandName: "browser-use", entryPath: "/opt/browser-use/src/browser-use.ts" }),
		);
		chmodSync(shimPath, 0o755);

		const result = spawnSync(shimPath, ["auth", "install-token"], {
			cwd: workdir,
			env: { PATH: `${binDir}:${BUN_LESS_PATH}` },
			encoding: "utf8",
		});

		// The shim asks bun to skip cwd .env loading, before the entry path.
		expect(result.stdout).toContain("--no-env-file");
		// The sentinel never reaches the child's argv.
		expect(result.stdout).not.toContain("SENTINEL_NOT_A_REAL_TOKEN");
	});

	test("REAL bun: the checked-in entry ignores a cwd .env forbidden key but honours an inherited one", () => {
		const base = sandbox();
		const workdir = join(base, "workdir");
		mkdirSync(workdir, { recursive: true });
		writeFileSync(join(workdir, ".env"), "BROWSER_USE_TOKEN=SENTINEL_CWD_ONLY\n");
		// A tiny entry that reports only the SHAPE of the forbidden key, never a value.
		const probe = join(base, "probe.ts");
		writeFileSync(
			probe,
			"console.log(process.env.BROWSER_USE_TOKEN === undefined ? 'absent' : 'present');\n",
		);
		const shimPath = join(base, "browser-use");
		writeFileSync(shimPath, bunPreflightShim({ commandName: "browser-use", entryPath: probe }));
		chmodSync(shimPath, 0o755);
		const basePath = `${dirname(process.execPath)}:${BUN_LESS_PATH}`;

		// cwd-only sentinel: Bun must NOT import it, so the custody gate cannot fire.
		const cwdOnly = spawnSync(shimPath, [], {
			cwd: workdir,
			env: { PATH: basePath },
			encoding: "utf8",
		});
		expect(cwdOnly.status).toBe(0);
		expect(cwdOnly.stdout.trim()).toBe("absent");

		// Genuinely INHERITED sentinel: still visible, so the fail-closed gate holds.
		const inherited = spawnSync(shimPath, [], {
			cwd: workdir,
			env: { PATH: basePath, BROWSER_USE_TOKEN: "SENTINEL_INHERITED" },
			encoding: "utf8",
		});
		expect(inherited.status).toBe(0);
		expect(inherited.stdout.trim()).toBe("present");
	});

	test("the remedy string names the runtime, install command, and command name", () => {
		const remedy = bunPreflightRemedy("browser-use");
		expect(remedy).toContain(BUN_PREFLIGHT_RUNTIME_NAME);
		expect(remedy).toContain(BUN_PREFLIGHT_INSTALL_COMMAND);
		expect(remedy).toContain("browser-use");
		// No absolute path leaks into the operator-facing remedy.
		expect(remedy).not.toContain("/opt/");
	});
});
