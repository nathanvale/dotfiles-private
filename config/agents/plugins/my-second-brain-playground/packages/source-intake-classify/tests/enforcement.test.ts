// Ticket #158 acceptance 1: with the lane profile, the installed Codex sandbox denies every read of a synthetic
// receipt, whichever root selects it. Evidence comes from `codex sandbox` processes on synthetic files, never from a
// model. A positive control proves the sandbox runs permitted commands, and a weakened-profile control proves each
// probe can fail, so a denial here is the profile's doing.
import { afterAll, beforeAll, describe, expect } from "bun:test"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type Lane, laneConfigArgs, PROFILE_NAME, prepareLane } from "../src/lane.ts"
import { ACCOUNT_DEFAULT_ROOT, createFixture, type Fixture, LANE_READY, laneLedger, OPAQUE_ITEM_REF, REAL_CODEX, removeFixture, SENTINEL } from "./fixtures/harness.ts"

const PERMISSION_DENIAL = "Operation not permitted"

interface Probe {
	exitCode: number | null
	stdout: string
	stderr: string
}

const proofs = laneLedger()
let fixture: Fixture

/** Resolves the lane as the command does, from a process environment the test sets and then restores. */
function laneFor(env: Record<string, string | undefined>): Lane {
	const saved = { ...process.env }
	try {
		for (const key of ["XDG_STATE_HOME", "HOME", "CODEX_HOME", "PATH", "TMPDIR"]) delete process.env[key]
		for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value
		const lane = prepareLane()
		if (lane === null) throw new Error("fixture lane did not resolve")
		return lane
	} finally {
		process.env = saved
	}
}

function workspaceFor(name: string): string {
	const workspace = join(fixture.root, `workspace-${name}`)
	mkdirSync(workspace, { mode: 0o700 })
	return workspace
}

function sandboxed(lane: Lane, workspace: string, argv: string[], configArgs = lane.configArgs): Probe {
	const child = Bun.spawnSync({ cmd: [lane.codex, "sandbox", ...configArgs, "-P", PROFILE_NAME, "-C", workspace, "--", ...argv], cwd: workspace, env: lane.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000 })
	return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

function expectDenied(probe: Probe): void {
	expect(probe.exitCode).not.toBe(0)
	expect(probe.stderr).toContain(PERMISSION_DENIAL)
	expect(probe.stdout).not.toContain(SENTINEL)
	expect(probe.stderr).not.toContain(SENTINEL)
}

function writeReceipt(stateHome: string): string {
	const itemDirectory = join(stateHome, "my-second-brain-playground", "drive-inbox-filing", "items", OPAQUE_ITEM_REF)
	mkdirSync(itemDirectory, { recursive: true, mode: 0o700 })
	const receipt = join(itemDirectory, "classification-metadata.json")
	writeFileSync(receipt, JSON.stringify({ displayName: "Fictional planning note", receiptSummary: SENTINEL }), { mode: 0o600 })
	return receipt
}

beforeAll(() => {
	fixture = createFixture()
})

afterAll(() => {
	removeFixture(fixture)
})

const codexPath = REAL_CODEX === null ? "" : dirname(REAL_CODEX)
const SELECTIONS = [
	{ name: "XDG_STATE_HOME", env: (): Record<string, string> => ({ XDG_STATE_HOME: fixture.stateHome, HOME: fixture.home }), stateHome: () => fixture.stateHome },
	{ name: "the HOME fallback", env: (): Record<string, string> => ({ HOME: fixture.home }), stateHome: () => join(fixture.home, ".local", "state") },
]

for (const selection of SELECTIONS) {
	describe(`receipt root selected by ${selection.name}`, () => {
		let lane: Lane
		let receipt: string
		let workspace = ""

		beforeAll(() => {
			if (!LANE_READY) return
			receipt = writeReceipt(selection.stateHome())
			lane = laneFor({ ...selection.env(), CODEX_HOME: join(fixture.root, "codex-home"), PATH: codexPath, TMPDIR: process.env.TMPDIR })
			workspace = workspaceFor(selection.name.replaceAll(" ", "-"))
			symlinkSync(receipt, join(workspace, "receipt-link"))
			writeFileSync(join(workspace, "control.txt"), "PERMITTED_CONTROL\n")
		})

		afterAll(() => {
			if (workspace !== "") rmSync(workspace, { recursive: true, force: true })
		})

		proofs.test("the lane denies both roots: the selected one and the account default", () => {
			expect(lane.deniedRoots).toContain(join(selection.stateHome(), "my-second-brain-playground"))
			expect(lane.deniedRoots).toContain(ACCOUNT_DEFAULT_ROOT as string)
		})

		proofs.test("positive control: the sandbox runs a permitted read in the workspace", () => {
			expect(sandboxed(lane, workspace, ["/bin/cat", join(workspace, "control.txt")])).toMatchObject({ exitCode: 0, stdout: "PERMITTED_CONTROL\n" })
		})

		proofs.test("weakened-profile control: without the denies the same read returns the sentinel", () => {
			const weak = `{filesystem={":root"="read", ":minimal"="read", ":workspace_roots"={"."="read"}}, network={enabled=false}}`
			expect(sandboxed(lane, workspace, ["/bin/cat", receipt], laneConfigArgs(weak)).stdout).toContain(SENTINEL)
		})

		proofs.test("cat of the receipt is denied", () => expectDenied(sandboxed(lane, workspace, ["/bin/cat", receipt])))
		proofs.test("ls of the item directory is denied", () => expectDenied(sandboxed(lane, workspace, ["/bin/ls", dirname(receipt)])))
		proofs.test("cp of the receipt is denied", () => expectDenied(sandboxed(lane, workspace, ["/bin/cp", receipt, join(workspace, "copy")])))
		proofs.test("stat of the receipt is denied", () => expectDenied(sandboxed(lane, workspace, ["/usr/bin/stat", receipt])))
		proofs.test("a read through a workspace symlink is denied", () => expectDenied(sandboxed(lane, workspace, ["/bin/cat", join(workspace, "receipt-link")])))
		proofs.test("the lane cannot plant a hard link to the receipt in its workspace", () => expectDenied(sandboxed(lane, workspace, ["/bin/ln", receipt, join(workspace, "receipt-hard")])))
		proofs.test("ls of the account default root is denied", () => expectDenied(sandboxed(lane, workspace, ["/bin/ls", ACCOUNT_DEFAULT_ROOT as string])))
		proofs.test("the caller's Codex credential is denied", () => expectDenied(sandboxed(lane, workspace, ["/bin/cat", lane.authTarget])))
	})
}

// Eleven proofs for each of the two root selections.
proofs.pin(22)
