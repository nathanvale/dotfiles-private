import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"

// Q3 companion proof (CDS-PE-4): the committed variants under companions/ carry only ids, patches and patch hashes. The
// expected finding, unaffected checks, reference solution and frozen hashes live in a private manifest named by
// REPAIR_LAB_COMPANIONS_MANIFEST; without it this proof is reported as skipped, an explicit counted outcome, never a pass.
// Each variant is staged as a copy of the package, patched, judged, then restored through the reference solution and
// proved byte-identical to the frozen baseline.

const PACKAGE = resolve(import.meta.dir, "../..")
const WORKTREE = resolve(PACKAGE, "../../../../../..")
const COMPANIONS = join(import.meta.dir, "companions")
const MANIFEST_PATH = process.env.REPAIR_LAB_COMPANIONS_MANIFEST

interface FailingCheck {
	file: string
	mustContain: string[]
}
interface TscExpectation {
	exit: "zero" | "nonzero"
	mustContain: string[]
}
interface Variant {
	id: string
	patch: string
	patchSha256: string
	finding: string
	failing: FailingCheck[]
	unaffected: string[]
	tsc: TscExpectation
	patchedFiles: Record<string, string>
	solution: string
	solutionSha256: string
}
interface Manifest {
	frozenAt: string
	baseline: Record<string, string>
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
	mkdirSync(stageRoot, { recursive: true, mode: 0o700 })
	// A reused proof path is evidence, never scratch space. The caller must supply a fresh manifest parent.
	mkdirSync(directory, { mode: 0o700 })
	for (const name of ["src", "tests", "package.json"]) cpSync(join(PACKAGE, name), join(directory, name), { recursive: true })
	writeFileSync(join(directory, "tsconfig.json"), `${JSON.stringify({ extends: join(WORKTREE, "tsconfig.base.json"), include: ["src/**/*.ts", "tests/**/*.ts"] })}\n`)
	mkdirSync(join(directory, "node_modules"))
	symlinkSync(join(PACKAGE, "node_modules", "zod"), join(directory, "node_modules", "zod"))
	symlinkSync(join(PACKAGE, "node_modules", "@logtape"), join(directory, "node_modules", "@logtape"))
	symlinkSync(join(WORKTREE, "node_modules", "@types"), join(directory, "node_modules", "@types"))
	return directory
}

// The manifest variable is deliberately absent from children: a staged copy's own companion proof reports skipped.
const CHILD_ENV: Record<string, string> = { HOME: process.env.HOME ?? "/", PATH: process.env.PATH ?? "", NO_COLOR: "1", TERM: "dumb" }

function spawn(command: string[], cwd: string): Run {
	const child = Bun.spawnSync(command, { cwd, env: CHILD_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 300_000 })
	return { exit: child.exitCode ?? -1, output: `${child.stdout.toString()}${child.stderr.toString()}` }
}

function applyPatch(directory: string, patchPath: string): void {
	const check = spawn(["patch", "-p1", "-F0", "--batch", "--dry-run", "-i", patchPath], directory)
	if (check.exit !== 0) throw new Error(`patch does not apply cleanly: ${patchPath}\n${check.output}`)
	const applied = spawn(["patch", "-p1", "-F0", "--batch", "-i", patchPath], directory)
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

	test("refuses to replace a reused stage path", () => {
		const root = mkdtempSync(join(tmpdir(), "repair-lab-companion-retention-"))
		const stageRoot = join(root, "staged")
		const existingStage = join(stageRoot, "a")
		mkdirSync(existingStage, { recursive: true, mode: 0o700 })
		const marker = join(existingStage, "prior-evidence.txt")
		writeFileSync(marker, "prior staged evidence\n")
		expect(() => stage(stageRoot, "a")).toThrow()
		expect(readFileSync(marker, "utf8")).toBe("prior staged evidence\n")
		rmSync(root, { recursive: true, force: true })
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

describe("Q3 companions (CDS-PE-4)", () => {
	test.skipIf(MANIFEST_PATH === undefined)("each variant reproduces its expected finding, keeps its declared unaffected checks green, and the reference solution restores the frozen baseline", () => {
		const manifestPath = MANIFEST_PATH as string
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
		const index = JSON.parse(readFileSync(join(COMPANIONS, "index.json"), "utf8")) as Index
		const stageRoot = join(dirname(manifestPath), "staged")
		const runsRoot = join(dirname(manifestPath), "runs")
		mkdirSync(runsRoot, { recursive: true, mode: 0o700 })
		expect(hashSources(PACKAGE)).toEqual(manifest.baseline)
		expect(index.variants.map((entry) => `${entry.id} ${entry.patch} ${entry.patchSha256}`)).toEqual(manifest.variants.map((variant) => `${variant.id} ${variant.patch} ${variant.patchSha256}`))
		for (const variant of manifest.variants) {
			const receipts: Record<string, unknown> = { id: variant.id, finding: variant.finding, startedAt: new Date().toISOString() }
			const patchPath = join(COMPANIONS, variant.patch)
			expect(sha256(readFileSync(patchPath))).toBe(variant.patchSha256)
			const directory = stage(stageRoot, variant.id)
			applyPatch(directory, patchPath)
			expect(pick(hashSources(directory), Object.keys(variant.patchedFiles))).toEqual(variant.patchedFiles)
			try {
				judgeVariant(variant, directory, receipts)
				proveSolution(variant, directory, manifest, receipts)
			} finally {
				receipts.finishedAt = new Date().toISOString()
				writeReceipt(join(runsRoot, `${variant.id}.json`), receipts)
			}
		}
	}, 900_000)
})
