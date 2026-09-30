// Ticket #158 acceptance 3 and the lane invocation: the spawned `codex exec` inherits only descriptors 0, 1 and 2,
// an allowlisted environment with no fixture sentinel, the required configuration, a fresh workspace that is gone
// afterwards, and only the lane input on standard input. Observed by a fake codex that never calls a model.
import { afterAll, beforeAll, expect } from "bun:test"
import { existsSync, lstatSync, readlinkSync } from "node:fs"
import { join } from "node:path"
import {
	ACCOUNT_DEFAULT_ROOT,
	createFixture,
	type ExecObservation,
	envelope,
	execObservations,
	type Fixture,
	invoke,
	LANE_READY,
	laneInput,
	laneLedger,
	removeFixture,
	SENTINEL,
	THREAD_ID,
} from "./fixtures/harness.ts"

let fixture: Fixture
let observation: ExecObservation
// biome-ignore lint/suspicious/noExplicitAny: the success envelope is read after a strict JSON parse.
let result: any

// Independent oracle: the environment keys the lane may inherit, restated from the Ticket #158 boundary.
const ALLOWED_ENV = ["CODEX_HOME", "HOME", "LANG", "PATH", "SHELL", "TMPDIR"]
// Independent oracle: the Ticket #158 features the lane must disable.
const REQUIRED_DISABLED = ["apps", "browser_use", "computer_use", "in_app_browser", "multi_agent", "multi_agent_v2", "plugins"]

beforeAll(() => {
	fixture = createFixture()
	if (!LANE_READY) return
	result = envelope(invoke(fixture, ["classify", "--json"], { stdin: JSON.stringify(laneInput()) }))
	observation = execObservations(fixture)[0] as ExecObservation
}, 60_000)

afterAll(() => {
	removeFixture(fixture)
})

function flagValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag)
	return index === -1 ? undefined : argv[index + 1]
}

function settings(argv: string[]): string[] {
	return argv.flatMap((value, index) => (argv[index - 1] === "-c" ? [value] : []))
}

const proofs = laneLedger()

proofs.test("one lane run completes and reports its evidence", () => {
	expect(execObservations(fixture)).toHaveLength(1)
	expect(result.result.causeCode).toBe("SUCCESS_COMPLETED")
	expect(result.result.data.lane).toMatchObject({ model: "gpt-6-luna", reasoningEffort: "medium", threadId: THREAD_ID })
	expect(result.result.data.lane.codexVersion).toMatch(/^\d+\.\d+\.\d+/)
	// The hash covers every configuration argument the lane received, from the first -c to the last --disable value.
	const configArgs = observation.argv.slice(1, observation.argv.indexOf("--ignore-user-config"))
	expect(configArgs).toContain("agents.enabled=false")
	expect(result.result.data.lane.laneConfigSha256).toBe(new Bun.CryptoHasher("sha256").update(JSON.stringify(configArgs)).digest("hex"))
})

proofs.test("the lane inherits only descriptors 0, 1 and 2", () => {
	expect(observation.descriptors).toEqual([0, 1, 2])
})

// RED control for the descriptor observation: the same fake, started with one extra open descriptor, reports it.
proofs.test("the descriptor observation sees an extra inherited descriptor", () => {
	const fake = join(fixture.fakeRoot, "bin", "codex")
	const child = Bun.spawnSync(["/bin/sh", "-c", 'exec 3</dev/null; exec "$0" exec', fake], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
	expect(child.exitCode).toBe(0)
	expect(execObservations(fixture).at(-1)?.descriptors).toEqual([0, 1, 2, 3])
})

proofs.test("the lane environment is the allowlist and holds no sentinel or receipt root selector", () => {
	expect(Object.keys(observation.env).sort()).toEqual(ALLOWED_ENV)
	expect(Object.values(observation.env).some((value) => value.includes(SENTINEL))).toBe(false)
	expect(observation.env.CODEX_HOME).toBe(join(fixture.privateRoot, "source-intake-classify", "codex-home"))
	expect(observation.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin")
})

proofs.test("the run is a top-level exec with the required configuration and a kept rollout", () => {
	const argv = observation.argv
	expect(argv[0]).toBe("exec")
	for (const flag of ["--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json"]) expect(argv).toContain(flag)
	expect(argv).not.toContain("--ephemeral")
	expect(flagValue(argv, "-m")).toBe("gpt-6-luna")
	const values = settings(argv)
	for (const setting of ['approval_policy="never"', 'web_search="disabled"', 'shell_environment_policy.inherit="none"', "agents.enabled=false", 'default_permissions="msb_source_intake_classify"']) expect(values).toContain(setting)
	const disabled = argv.flatMap((value, index) => (argv[index - 1] === "--disable" ? [value] : []))
	for (const feature of REQUIRED_DISABLED) expect(disabled).toContain(feature)
	const profile = values.find((value) => value.startsWith("permissions.msb_source_intake_classify="))
	for (const entry of ['":root"="deny"', '":minimal"="read"', '":tmpdir"="deny"', '":slash_tmp"="deny"', `"${fixture.privateRoot}"="deny"`, `"${ACCOUNT_DEFAULT_ROOT}"="deny"`]) expect(profile).toContain(entry)
})

proofs.test("the workspace was fresh, is removed afterwards, and never held a receipt path", () => {
	const workspace = flagValue(observation.argv, "-C") as string
	expect(workspace.startsWith(fixture.privateRoot)).toBe(false)
	expect(existsSync(workspace)).toBe(false)
})

proofs.test("standard input carries the lane input and nothing from the receipt", () => {
	expect(observation.stdin).toContain('"displayName": "Fictional planning note"')
	expect(observation.stdin).not.toContain(SENTINEL)
	expect(observation.stdin).not.toContain(fixture.receiptPath)
})

proofs.test("the lane Codex home links the caller's credential and holds no instructions or user config", () => {
	const home = join(fixture.privateRoot, "source-intake-classify", "codex-home")
	expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true)
	expect(readlinkSync(join(home, "auth.json"))).toBe(join(fixture.root, "codex-home", "auth.json"))
	for (const name of ["AGENTS.md", "AGENTS.override.md", "config.toml"]) expect(existsSync(join(home, name))).toBe(false)
})

proofs.pin(8)
