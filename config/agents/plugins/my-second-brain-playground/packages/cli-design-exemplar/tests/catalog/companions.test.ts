import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

// B2 companion proof (CDS-BC-2): the committed variants under companions/ carry only ids, patches and patch hashes. The
// expected finding, unaffected checks, reference solution and frozen hashes live in a private manifest named by
// REPAIR_LAB_COMPANIONS_MANIFEST; without it this proof is reported as skipped, an explicit counted outcome, never a pass.
// Each variant is staged as a copy of the package, patched, judged, then restored through the reference solution and
// proved byte-identical to the frozen baseline.

const PACKAGE = resolve(import.meta.dir, "../..")
const WORKTREE = resolve(PACKAGE, "../../../../../..")
const COMPANIONS = join(import.meta.dir, "companions")
const MANIFEST_PATH = process.env.REPAIR_LAB_COMPANIONS_MANIFEST
const LIFECYCLE_OBSERVATION = resolve(PACKAGE, "../cli-design-check/src/successor/lifecycle-observation.ts")

interface FailingCheck {
	file: string
	mustContain: string[]
}
interface TscExpectation {
	exit: "zero" | "nonzero"
	mustContain: string[]
}
interface SkippedCheck {
	file: string
	reason: string
}
interface Variant {
	id: string
	patch: string
	patchSha256: string
	finding: string
	failing: FailingCheck[]
	unaffected: string[]
	skipped?: SkippedCheck[]
	tsc: TscExpectation
	patchedFiles: Record<string, string>
	solution: string
	solutionSha256: string
}
interface Manifest {
	frozenAt: string
	baseline: Record<string, string>
	lifecycleObservationSha256: string
	variants: Variant[]
}
interface Index {
	variants: Array<{ id: string; patch: string; patchSha256: string }>
}
interface Run {
	exit: number
	output: string
}

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex")

// Hashes of every regular file under src/ and tests/ plus package.json; the identity the manifest freezes.
function hashSources(root: string): Record<string, string> {
	const hashes: Record<string, string> = {}
	const pending = [join(root, "src"), join(root, "tests")]
	while (pending.length > 0) {
		const directory = pending.pop() as string
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) pending.push(path)
			else if (entry.isFile()) hashes[relative(root, path).split(sep).join("/")] = sha256(readFileSync(path))
		}
	}
	hashes["package.json"] = sha256(readFileSync(join(root, "package.json")))
	return Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)))
}

function stage(stageRoot: string, id: string): string {
	const directory = join(stageRoot, id)
	// The caller atomically claims this fresh root before any staging write.
	mkdirSync(directory, { mode: 0o700 })
	for (const name of ["src", "tests", "package.json"]) cpSync(join(PACKAGE, name), join(directory, name), { recursive: true })
	writeFileSync(join(directory, "tsconfig.json"), `${JSON.stringify({ extends: join(WORKTREE, "tsconfig.base.json"), include: ["src/**/*.ts", "tests/**/*.ts"] })}\n`)
	mkdirSync(join(directory, "node_modules"))
	symlinkSync(join(PACKAGE, "node_modules", "zod"), join(directory, "node_modules", "zod"))
	symlinkSync(join(PACKAGE, "node_modules", "@logtape"), join(directory, "node_modules", "@logtape"))
	symlinkSync(join(WORKTREE, "node_modules", "@types"), join(directory, "node_modules", "@types"))
	return directory
}

function claimStageRoot(stageRoot: string, oracleSource = LIFECYCLE_OBSERVATION, expectedDigest = sha256(readFileSync(oracleSource))): void {
	if (sha256(readFileSync(oracleSource)) !== expectedDigest) throw new Error("lifecycle observation does not match the private manifest")
	// No recursive creation: EEXIST refuses a prior proof root before its marker or oracle can be touched.
	mkdirSync(stageRoot, { mode: 0o700 })
	try {
		const lifecycleOracle = join(stageRoot, "cli-design-check", "src", "successor")
		mkdirSync(lifecycleOracle, { recursive: true, mode: 0o700 })
		cpSync(oracleSource, join(lifecycleOracle, "lifecycle-observation.ts"))
	} catch (error) {
		// Only the root this claim created is removed, so a later run does not inherit a half-seeded root.
		rmSync(stageRoot, { recursive: true, force: true })
		throw error
	}
}

// Every judged or skipped check names a canonical regular file inside the staged package; the counts alone
// cannot tell a real skipped check from a path that never existed or an alias of another entry.
function validateCoverageFiles(id: string, files: string[], root: string): void {
	const realRoot = realpathSync(root)
	for (const file of files) {
		const path = resolve(root, file)
		const canonical = relative(root, path).split(sep).join("/")
		const stats = lstatSync(path, { throwIfNoEntry: false })
		const realPath = stats === undefined ? undefined : realpathSync(path)
		if (isAbsolute(file) || canonical !== file || stats === undefined || stats.isSymbolicLink() || !stats.isFile() || realPath !== resolve(realRoot, file)) throw new Error(`${id} coverage file must be a canonical regular file inside the package: ${file}`)
	}
}

function coverageFiles(variant: CoverageVariant): string[] {
	return [...variant.failing.map((check) => check.file), ...variant.unaffected, ...(variant.skipped ?? []).map((check) => check.file)]
}

// The manifest variable is deliberately absent from children: a staged copy's own companion proof reports skipped.
const CHILD_ENV: Record<string, string> = { HOME: process.env.HOME ?? "/", PATH: process.env.PATH ?? "", NO_COLOR: "1", TERM: "dumb" }

function spawn(command: string[], cwd: string): Run {
	const child = Bun.spawnSync(command, { cwd, env: CHILD_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 300_000 })
	return { exit: child.exitCode ?? -1, output: `${child.stdout.toString()}${child.stderr.toString()}` }
}

function applyPatch(directory: string, patchPath: string): void {
	const check = spawn(["patch", "-p1", "-F0", "-V", "none", "--batch", "--dry-run", "-i", patchPath], directory)
	if (check.exit !== 0) throw new Error(`patch does not apply cleanly: ${patchPath}\n${check.output}`)
	const applied = spawn(["patch", "-p1", "-F0", "-V", "none", "--batch", "-i", patchPath], directory)
	if (applied.exit !== 0) throw new Error(`patch failed: ${patchPath}\n${applied.output}`)
}

const runTests = (directory: string, target: string): Run => spawn(["bun", "test", target], directory)
const runTsc = (directory: string): Run => spawn([join(WORKTREE, "node_modules", ".bin", "tsc"), "--noEmit", "-p", "tsconfig.json"], directory)

function completeRun(run: Run): Run {
	return { exit: run.exit, output: run.output }
}

function writeReceipt(path: string, receipts: Record<string, unknown>): void {
	writeFileSync(path, `${JSON.stringify(receipts, null, "\t")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
}

function pick(hashes: Record<string, string>, keys: string[]): Record<string, string> {
	return Object.fromEntries(keys.map((key) => [key, hashes[key] ?? "missing"]))
}

const COVERAGE: Readonly<Record<string, Readonly<{ failing: number; unaffected: number; skipped: number }>>> = {
	a: { failing: 1, unaffected: 3, skipped: 0 },
	b: { failing: 4, unaffected: 0, skipped: 0 },
	c: { failing: 3, unaffected: 1, skipped: 12 },
}

type CoverageVariant = Pick<Variant, "id" | "finding" | "failing" | "unaffected" | "skipped" | "tsc">

function coverageFor(id: string): Readonly<{ failing: number; unaffected: number; skipped: number }> {
	const expected = COVERAGE[id]
	if (expected === undefined) throw new Error(`unknown companion variant ${id}`)
	return expected
}

function validateCounts(variant: CoverageVariant, skipped: SkippedCheck[], expected: Readonly<{ failing: number; unaffected: number; skipped: number }>): void {
	if (variant.failing.length !== expected.failing || variant.unaffected.length !== expected.unaffected || skipped.length !== expected.skipped) throw new Error(`${variant.id} coverage must be ${expected.failing} failing, ${expected.unaffected} unaffected, ${expected.skipped} skipped`)
}

function validateFinding(id: string, finding: string): void {
	if (finding.trim() === "") throw new Error(`${id} finding requires nonempty text`)
}

function validateTsc(id: string, tsc: TscExpectation): void {
	if (tsc.mustContain.some((diagnostic) => diagnostic.trim() === "")) throw new Error(`${id} tsc diagnostics require nonempty text`)
	if (tsc.exit === "zero" && tsc.mustContain.length !== 0) throw new Error(`${id} zero-exit tsc requires no diagnostics`)
	if (tsc.exit === "nonzero" && tsc.mustContain.length === 0) throw new Error(`${id} nonzero tsc requires diagnostics`)
}

function validateFailingShape(id: string, failing: FailingCheck[]): void {
	for (const check of failing) {
		if (check.file.trim() === "") throw new Error(`${id} failing checks require a file`)
		if (check.mustContain.length === 0 || check.mustContain.some((needle) => needle.trim() === "")) throw new Error(`${id} failing checks require nonempty mustContain text`)
	}
}

function validateUnaffectedShape(id: string, unaffected: string[]): void {
	if (unaffected.some((file) => file.trim() === "")) throw new Error(`${id} unaffected checks require a file`)
}

function validateSkippedShape(id: string, skipped: SkippedCheck[]): void {
	if (skipped.some((check) => check.file.trim() === "" || check.reason.trim() === "")) throw new Error(`${id} skipped checks require a file and reason`)
}

function validateUniqueFiles(variant: CoverageVariant, skipped: SkippedCheck[]): void {
	const files = coverageFiles({ ...variant, skipped })
	if (new Set(files).size !== files.length) throw new Error(`${variant.id} coverage files must be unique`)
}

function validateCoverage(variant: CoverageVariant): void {
	const skipped = variant.skipped ?? []
	validateCounts(variant, skipped, coverageFor(variant.id))
	validateFinding(variant.id, variant.finding)
	validateTsc(variant.id, variant.tsc)
	validateFailingShape(variant.id, variant.failing)
	validateUnaffectedShape(variant.id, variant.unaffected)
	validateSkippedShape(variant.id, skipped)
	validateUniqueFiles(variant, skipped)
}

function judgeVariant(variant: Variant, directory: string, receipts: Record<string, unknown>): void {
	const tsc = runTsc(directory)
	receipts.tsc = completeRun(tsc)
	expect(`${variant.id} tsc ${variant.tsc.exit === "zero" ? tsc.exit === 0 : tsc.exit !== 0}`).toBe(`${variant.id} tsc true`)
	for (const needle of variant.tsc.mustContain) expect(tsc.output).toContain(needle)
	for (const check of variant.failing) {
		const run = runTests(directory, check.file)
		receipts[`failing:${check.file}`] = completeRun(run)
		expect(`${variant.id} ${check.file} exit ${run.exit !== 0 ? "nonzero" : "zero"}`).toBe(`${variant.id} ${check.file} exit nonzero`)
		for (const needle of check.mustContain) expect(run.output).toContain(needle)
	}
	for (const file of variant.unaffected) {
		const run = runTests(directory, file)
		receipts[`unaffected:${file}`] = completeRun(run)
		expect(`${variant.id} unaffected ${file} exit ${run.exit}`).toBe(`${variant.id} unaffected ${file} exit 0`)
	}
	receipts.skipped = variant.skipped ?? []
}

function proveSolution(variant: Variant, directory: string, manifest: Manifest, receipts: Record<string, unknown>): void {
	const solutionPath = join(dirname(MANIFEST_PATH as string), variant.solution)
	expect(sha256(readFileSync(solutionPath))).toBe(variant.solutionSha256)
	applyPatch(directory, solutionPath)
	expect(hashSources(directory)).toEqual(manifest.baseline)
	const green = runTests(directory, "tests")
	const tsc = runTsc(directory)
	receipts.solution = { tests: completeRun(green), tsc: completeRun(tsc) }
	expect(`${variant.id} solution tests exit ${green.exit}`).toBe(`${variant.id} solution tests exit 0`)
	expect(`${variant.id} solution tsc exit ${tsc.exit}`).toBe(`${variant.id} solution tsc exit 0`)
}

describe("companion proof retention", () => {
	test("keeps complete child output", () => {
		const root = mkdtempSync(join(tmpdir(), "repair-lab-companion-retention-"))
		const child = spawn([process.execPath, "-e", 'console.log("stdout-complete"); console.error("stderr-diagnostic"); process.exit(7)'], root)
		const captured = completeRun(child)
		expect(captured.exit).toBe(7)
		expect(captured.output).toContain("stdout-complete")
		expect(captured.output).toContain("stderr-diagnostic")
		rmSync(root, { recursive: true, force: true })
	})

	test("refuses a reused stage root before touching retained marker or lifecycle oracle", () => {
		const root = mkdtempSync(join(tmpdir(), "repair-lab-companion-retention-"))
		const stageRoot = join(root, "staged")
		mkdirSync(stageRoot, { recursive: true, mode: 0o700 })
		const marker = join(stageRoot, "prior-evidence.txt")
		const oracle = join(stageRoot, "cli-design-check", "src", "successor", "lifecycle-observation.ts")
		mkdirSync(dirname(oracle), { recursive: true, mode: 0o700 })
		writeFileSync(marker, "prior staged evidence\n")
		writeFileSync(oracle, "prior lifecycle oracle\n")
		const priorMarker = readFileSync(marker)
		const priorOracle = readFileSync(oracle)
		expect(() => claimStageRoot(stageRoot)).toThrow()
		expect(readFileSync(marker)).toEqual(priorMarker)
		expect(readFileSync(oracle)).toEqual(priorOracle)
		expect(readFileSync(marker, "utf8")).toBe("prior staged evidence\n")
		rmSync(root, { recursive: true, force: true })
	})

	test("removes only its own half-seeded stage root when oracle seeding fails", () => {
		const root = mkdtempSync(join(tmpdir(), "repair-lab-companion-retention-"))
		const stageRoot = join(root, "staged")
		expect(() => claimStageRoot(stageRoot, join(root, "missing-oracle.ts"))).toThrow()
		expect(existsSync(stageRoot)).toBe(false)
		expect(() => claimStageRoot(stageRoot)).not.toThrow()
		expect(existsSync(join(stageRoot, "cli-design-check", "src", "successor", "lifecycle-observation.ts"))).toBe(true)
		rmSync(root, { recursive: true, force: true })
	})

	test("rejects a changed lifecycle analyzer before claiming the stage root", () => {
		const root = mkdtempSync(join(tmpdir(), "repair-lab-companion-retention-"))
		const oracle = join(root, "lifecycle-observation.ts")
		const stageRoot = join(root, "staged")
		writeFileSync(oracle, "export const observation = 'changed'\n")
		expect(() => claimStageRoot(stageRoot, oracle, sha256("reviewed analyzer\n"))).toThrow("lifecycle observation does not match the private manifest")
		expect(existsSync(stageRoot)).toBe(false)
		claimStageRoot(stageRoot, oracle, sha256(readFileSync(oracle)))
		expect(readFileSync(join(stageRoot, "cli-design-check", "src", "successor", "lifecycle-observation.ts"))).toEqual(readFileSync(oracle))
		rmSync(root, { recursive: true, force: true })
	})

	test("requires every coverage file to be a canonical regular file inside the staged package", () => {
		const root = mkdtempSync(join(tmpdir(), "repair-lab-companion-retention-"))
		const outside = mkdtempSync(join(tmpdir(), "repair-lab-companion-outside-"))
		mkdirSync(join(root, "tests"))
		writeFileSync(join(root, "tests", "real.test.ts"), "export {}\n")
		writeFileSync(join(outside, "outside.test.ts"), "export {}\n")
		symlinkSync(join(outside, "outside.test.ts"), join(root, "tests", "final-link.test.ts"))
		symlinkSync(outside, join(root, "linked-tests"))
		expect(() => validateCoverageFiles("c", ["tests/real.test.ts"], root)).not.toThrow()
		for (const file of ["./tests/real.test.ts", "tests//real.test.ts", "tests/missing.test.ts", "../real.test.ts", "tests", join(root, "tests", "real.test.ts"), "tests/final-link.test.ts", "linked-tests/outside.test.ts"]) {
			expect(() => validateCoverageFiles("c", [file], root)).toThrow(`c coverage file must be a canonical regular file inside the package: ${file}`)
		}
		rmSync(root, { recursive: true, force: true })
		rmSync(outside, { recursive: true, force: true })
	})

	test("requires the complete reasoned skip inventory", () => {
		const failingOne: FailingCheck = { file: "tests/failing-one.test.ts", mustContain: ["finding"] }
		const failingTwo: FailingCheck = { file: "tests/failing-two.test.ts", mustContain: ["finding"] }
		const failingThree: FailingCheck = { file: "tests/failing-three.test.ts", mustContain: ["finding"] }
		const skipped: SkippedCheck[] = Array.from({ length: 12 }, (_, index) => ({ file: `tests/skipped-${index}.test.ts`, reason: "The tree fails its recorded TypeScript control." }))
		const c: CoverageVariant = { id: "c", finding: "TS2454 src/cli.ts", failing: [failingOne, failingTwo, failingThree], unaffected: ["tests/catalog/branch-station-catalogue.test.ts"], skipped, tsc: { exit: "nonzero", mustContain: ["TS2454"] } }
		expect(() => validateCoverage({ ...c, skipped: skipped.slice(0, -1) })).toThrow("c coverage must be 3 failing, 1 unaffected, 12 skipped")
		expect(() => validateCoverage({ ...c, finding: " " })).toThrow("c finding requires nonempty text")
		expect(() => validateCoverage({ ...c, tsc: { exit: "nonzero", mustContain: [""] } })).toThrow("c tsc diagnostics require nonempty text")
		expect(() => validateCoverage({ ...c, skipped: [{ file: "", reason: "missing file" }, ...skipped.slice(1)] })).toThrow("c skipped checks require a file and reason")
		expect(() => validateCoverage({ ...c, failing: [failingOne, failingOne, failingThree] })).toThrow("c coverage files must be unique")
		expect(() => validateCoverage({ ...c, unaffected: [failingOne.file] })).toThrow("c coverage files must be unique")
		expect(() => validateCoverage({ ...c, failing: [{ file: "", mustContain: ["finding"] }, failingTwo, failingThree] })).toThrow("c failing checks require a file")
		expect(() => validateCoverage({ ...c, failing: [{ file: failingOne.file, mustContain: [] }, failingTwo, failingThree] })).toThrow("c failing checks require nonempty mustContain text")
		expect(() => validateCoverage({ ...c, unaffected: [""] })).toThrow("c unaffected checks require a file")
		expect(() => validateCoverage(c)).not.toThrow()
		expect(() => validateCoverage({ id: "a", finding: "finding", failing: [{}] as FailingCheck[], unaffected: ["one", "two", "three"], skipped: [{ file: "extra", reason: "not allowed" }], tsc: { exit: "zero", mustContain: [] } })).toThrow("a coverage must be 1 failing, 3 unaffected, 0 skipped")
	})

	test("refuses to overwrite a prior run receipt", () => {
		const root = mkdtempSync(join(tmpdir(), "repair-lab-companion-retention-"))
		const runsRoot = join(root, "runs")
		mkdirSync(runsRoot, { mode: 0o700 })
		const receiptPath = join(runsRoot, "a.json")
		writeReceipt(receiptPath, { child: { exit: 7, output: "complete child output\n" } })
		const priorReceipt = readFileSync(receiptPath, "utf8")
		expect(() => writeReceipt(receiptPath, { replacement: true })).toThrow()
		expect(readFileSync(receiptPath, "utf8")).toBe(priorReceipt)
		rmSync(root, { recursive: true, force: true })
	})
})

describe("B2 companions (CDS-BC-2)", () => {
	test.skipIf(MANIFEST_PATH === undefined)("each variant reproduces its expected finding, keeps its declared unaffected checks green, and the reference solution restores the frozen baseline", () => {
		const manifestPath = MANIFEST_PATH as string
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
		const index = JSON.parse(readFileSync(join(COMPANIONS, "index.json"), "utf8")) as Index
		const stageRoot = join(dirname(manifestPath), "staged")
		expect(hashSources(PACKAGE)).toEqual(manifest.baseline)
		expect(index.variants.map((entry) => `${entry.id} ${entry.patch} ${entry.patchSha256}`)).toEqual(manifest.variants.map((variant) => `${variant.id} ${variant.patch} ${variant.patchSha256}`))
		let claimedStageRoot = false
		try {
			claimStageRoot(stageRoot, LIFECYCLE_OBSERVATION, manifest.lifecycleObservationSha256)
			claimedStageRoot = true
			const runsRoot = join(dirname(manifestPath), "runs")
			mkdirSync(runsRoot, { recursive: true, mode: 0o700 })
			for (const variant of manifest.variants) {
				validateCoverage(variant)
				const receipts: Record<string, unknown> = { id: variant.id, finding: variant.finding, startedAt: new Date().toISOString() }
				const patchPath = join(COMPANIONS, variant.patch)
				expect(sha256(readFileSync(patchPath))).toBe(variant.patchSha256)
				const directory = stage(stageRoot, variant.id)
				applyPatch(directory, patchPath)
				validateCoverageFiles(variant.id, coverageFiles(variant), directory)
				expect(pick(hashSources(directory), Object.keys(variant.patchedFiles))).toEqual(variant.patchedFiles)
				try {
					judgeVariant(variant, directory, receipts)
					proveSolution(variant, directory, manifest, receipts)
				} finally {
					receipts.finishedAt = new Date().toISOString()
					writeReceipt(join(runsRoot, `${variant.id}.json`), receipts)
				}
			}
		} finally {
			if (claimedStageRoot) rmSync(stageRoot, { recursive: true, force: true })
		}
	}, 900_000)
})
