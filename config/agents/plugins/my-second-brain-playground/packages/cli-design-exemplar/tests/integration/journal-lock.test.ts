import { afterEach, expect, test } from "bun:test"
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRoot, diagnosticsFiles, envelopeOf, journalRecords, MAIN, readState, removeRoot, RESET_RESOURCE, REVISION_5_RESOURCE, type Root, type Run, runCli, sha256 } from "../helpers/harness.ts"

const APPLY = ["apply", "--preview-id", "preview-healthy-revision-4", "--authorize", "fixture-authority", "--json"]
const REPAIR = ["repair", "--apply", "--preview-id", "repair-preview-missing-index", "--authorize", "fixture-authority", "--json"]
const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) removeRoot(root) })
function fixture(): Root { const root = createRoot("healthy-with-fresh-preview"); roots.push(root); return root }
const lockPath = (root: Root): string => join(root.root, "state/journal.lock")
const resultOf = (run: Run): Record<string, unknown> => envelopeOf(run).result as Record<string, unknown>
function lockBytes(root: Root): string | null { return existsSync(lockPath(root)) && lstatSync(lockPath(root)).isFile() ? readFileSync(lockPath(root), "utf8") : null }
function receipt(name: string, root: Root, runs: Record<string, Run>, extra: Record<string, unknown> = {}): void {
	const directory = process.env.O1_B_RECEIPTS
	if (directory === undefined) return
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	writeFileSync(join(directory, `${name}.json`), `${JSON.stringify({ runs, executable: MAIN, fixtureRoot: root.root, bunVersion: Bun.version, state: readState(root), lock: lockBytes(root), diagnostics: Object.fromEntries(diagnosticsFiles(root).map((file) => [file, readFileSync(join(root.root, "diagnostics", file), "utf8")])), ...extra }, null, 2)}\n`, { mode: 0o600 })
}
function refused(run: Run): void {
	expect(run.exit).toBe(3)
	expect(run.signal).toBeNull()
	expect(run.stderr).toBe("")
	const result = resultOf(run)
	expect(result).toMatchObject({ commandIdentity: expect.any(String), outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_JOURNAL_LOCK_HELD", transactionState: "unchanged", retryable: false, exitCode: 3 })
	expect(result.retryDelayMilliseconds).toBeUndefined()
	expect(result.nextAction).toBeUndefined()
	expect(result.handoff).toEqual({ owner: "operator", reason: "state/journal.lock already exists; inspect its owner and resource state before manual removal", inspect: ["repair-lab inspect"] })
	expect(result.repairAction).toBe("Inspect state/journal.lock and resource state; remove the lock manually only after confirming its owner is stopped. Do not retry automatically.")
}

// Scrubbed real child process, bounded lifetime, immediately drained streams. The shared barrier is fixture state,
// separate from resource/journal truth. Even a failed readiness assertion kills and reaps every child in finally.
function contender(root: Root, argv = APPLY) {
	const env = { HOME: process.env.HOME ?? "/", PATH: process.env.PATH ?? "", NO_COLOR: "1", TERM: "dumb", REPAIR_LAB_FAULT: "journal-contention" }
	const child = Bun.spawn(["bun", "run", MAIN, ...argv], { cwd: root.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
	const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
	const done = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([stdout, stderr, exit]): Run & { pid: number; argv: string[] } => { clearTimeout(timer); return { stdout, stderr, exit, signal: child.signalCode, pid: child.pid, argv: ["bun", "run", MAIN, ...argv] } })
	return { child, done }
}
function markers(root: Root, suffix: string): string[] { const directory = join(root.root, "receipts/journal-barrier"); return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(suffix)) : [] }
async function waitFor(probe: () => boolean): Promise<void> {
	const deadline = performance.now() + 5_000
	while (!probe()) { if (performance.now() >= deadline) throw new Error("real process did not reach the deterministic barrier within 5 seconds"); await Bun.sleep(5) }
}
function release(root: Root, name: "start" | "finish"): void { writeFileSync(join(root.root, "receipts/journal-barrier", name), "release\n", { flag: "wx", mode: 0o600 }) }
async function stop(children: ReturnType<typeof contender>[]): Promise<void> { for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL"); await Promise.all(children.map(({ done }) => done)) }

// Independent oracle: exact bytes for one revision change plus the complete five-record journal. Dynamic run identity
// is bound to the winner's public envelope; every other value is a test literal, never production parser output.
function exactlyOne(root: Root, winner: Run): void {
	const run = String(resultOf(winner).runId)
	const preview = "preview-healthy-revision-4"
	const base = { run, operation: "apply", preview_id: preview }
	const event = { kind: "event", seq: 4, run, effect: "effect.write-journal", operation: "apply", preview_id: preview, summary: "apply recorded" }
	const eventHash = sha256(JSON.stringify(event))
	expect(readState(root).resource).toBe(REVISION_5_RESOURCE)
	expect(journalRecords(root)).toEqual([
		{ kind: "intent", seq: 1, ...base, effect: "effect.update-index", before_sha256: sha256(RESET_RESOURCE), expected_after_sha256: sha256(REVISION_5_RESOURCE) },
		{ kind: "completed", seq: 2, ...base, effect: "effect.update-index", resource_revision: 5, observed_after_sha256: sha256(REVISION_5_RESOURCE) },
		{ kind: "intent", seq: 3, ...base, effect: "effect.write-journal", before_sha256: null, expected_after_sha256: eventHash },
		event,
		{ kind: "completed", seq: 5, ...base, effect: "effect.write-journal", resource_revision: 5, observed_after_sha256: eventHash },
	])
	expect(JSON.parse(readState(root).preview ?? "null")).toEqual({ preview_id: preview, kind: "apply", resource_revision: 4, expected_effect_ids: ["effect.update-index", "effect.write-journal"], consumed: true, consumed_by_run: run })
}

test("O1 B1 existing locks refuse every writer without PID or age stealing", async () => {
	const variants = ["", "malformed\n", '{"lockVersion":999,"ownerToken":"foreign"}\n', `${JSON.stringify({ lockVersion: 1, ownerToken: "alive", pid: process.pid })}\n`, '{"lockVersion":1,"ownerToken":"dead","pid":2147483647}\n']
	const routes = [["apply", "--preview", "--json"], APPLY, ["repair", "--preview", "--json"], REPAIR, ["repair", "--apply", "--retry-once", "--authorize", "fixture-authority", "--json"]]
	for (const [index, bytes] of variants.entries()) {
		const root = fixture(); const before = readState(root)
		writeFileSync(lockPath(root), bytes); utimesSync(lockPath(root), new Date(0), new Date(0))
		for (const [route, argv] of routes.entries()) {
			const run = await runCli(root, argv); receipt(`b1-${index}-${route}`, root, { writer: run }, { before, seededLock: bytes }); refused(run)
			expect(readState(root)).toEqual(before); expect(lockBytes(root)).toBe(bytes); expect(lstatSync(lockPath(root)).mtimeMs).toBe(0)
		}
	}
})

test("O1 B2 one shared start barrier produces one winner and unchanged losing writer", async () => {
	const root = fixture(); const before = readState(root); const children = [contender(root), contender(root)]
	try {
		await waitFor(() => markers(root, ".ready").length === 2)
		expect(children[0]?.child.pid).not.toBe(children[1]?.child.pid)
		expect(readState(root)).toEqual(before); expect(existsSync(lockPath(root))).toBe(false)
		release(root, "start")
		const loser = await Promise.race(children.map(({ done }) => done))
		await waitFor(() => markers(root, ".claimed").length === 1)
		receipt("b2-loser-before-winner-effects", root, { loser }, { before, ready: markers(root, ".ready"), claimed: markers(root, ".claimed") })
		refused(loser); expect(readState(root)).toEqual(before)
		const owner = JSON.parse(lockBytes(root) ?? "null")
		expect(owner).toEqual({ lockVersion: 1, ownerToken: markers(root, ".claimed")[0]?.replace(".claimed", ""), pid: expect.any(Number) })
		expect(lstatSync(lockPath(root)).mode & 0o777).toBe(0o600)
		release(root, "finish")
		const runs = await Promise.all(children.map(({ done }) => done)); const winner = runs.find((run) => run.exit === 0)
		receipt("b2-finished", root, { first: runs[0] as Run, second: runs[1] as Run }, { before, owner })
		expect(runs.map((run) => run.exit).sort()).toEqual([0, 3]); if (winner === undefined) throw new Error("no real winner")
		expect(winner.stderr).toBe(""); expect(winner.signal).toBeNull(); exactlyOne(root, winner); expect(existsSync(lockPath(root))).toBe(false)
		const after = readState(root); const again = await runCli(root, APPLY); const recover = await runCli(root, ["recover", "--json"])
		receipt("b2-no-replay", root, { again, recover }, { before: after })
		expect(again.exit).toBe(3); expect(resultOf(again).causeCode).toBe("DOMAIN_PRECONDITION_UNMET"); expect(recover.exit).toBe(0); expect(readState(root)).toEqual(after)
	} finally { await stop(children) }
})

test("O1 B3 read-only routes remain available while a live writer owns the lock", async () => {
	const root = fixture(); const before = readState(root); const children = [contender(root)]
	try {
		await waitFor(() => markers(root, ".ready").length === 1); release(root, "start"); await waitFor(() => markers(root, ".claimed").length === 1)
		const owner = lockBytes(root)
		for (const command of ["status", "inspect", "recover"]) { const run = await runCli(root, [command, "--json"]); receipt(`b3-${command}`, root, { reader: run }, { before, owner }); expect(run.exit).toBe(0); expect(run.stderr).toBe(""); expect(readState(root)).toEqual(before); expect(lockBytes(root)).toBe(owner) }
		release(root, "finish"); expect((await children[0]?.done)?.exit).toBe(0)
	} finally { await stop(children) }
})

test("O1 B4 crashes after claim, intent and resource write preserve residue and prevent replay", async () => {
	for (const phase of ["claim", "halt-before-effect", "halt-after-effect"] as const) {
		const root = fixture(); let crash: Run
		if (phase === "claim") {
			const children = [contender(root)]
			try { await waitFor(() => markers(root, ".ready").length === 1); release(root, "start"); await waitFor(() => markers(root, ".claimed").length === 1); children[0]?.child.kill("SIGKILL"); crash = await (children[0] as ReturnType<typeof contender>).done } finally { await stop(children) }
		} else crash = await runCli(root, APPLY, { fault: `${phase}:effect.update-index` })
		const before = readState(root); const owner = lockBytes(root); receipt(`b4-${phase}-crash`, root, { crash }, { owner })
		expect(crash.signal).toBe("SIGKILL"); expect(crash.exit).toBe(137); expect(owner).not.toBeNull()
		expect(before.resource).toBe(phase === "halt-after-effect" ? REVISION_5_RESOURCE : RESET_RESOURCE)
		expect(journalRecords(root).map((row) => row.kind)).toEqual(phase === "claim" ? [] : ["intent"])
		const again = await runCli(root, APPLY); const recover = await runCli(root, ["recover", "--json"])
		receipt(`b4-${phase}-refusal-recovery`, root, { again, recover }, { before, owner }); refused(again); expect(readState(root)).toEqual(before); expect(lockBytes(root)).toBe(owner)
		expect(recover.exit).toBe(phase === "halt-after-effect" ? 3 : 0)
		if (phase === "halt-after-effect") {
			expect(resultOf(recover).causeCode).toBe("DOMAIN_RECOVERY_PARTIAL_HANDOFF")
			// Explicit operator removal is a test action. A lock-free unresolved plan still refuses; recovery never replays.
			rmSync(lockPath(root)); const pending = await runCli(root, APPLY); receipt("b4-manual-removal-pending", root, { pending }, { before }); expect(resultOf(pending).causeCode).toBe("DOMAIN_PRIOR_RUN_PENDING"); expect(readState(root)).toEqual(before); expect(existsSync(lockPath(root))).toBe(false)
		}
	}
})

test("O1 B5 normal release preserves a replaced or modified owner lock", async () => {
	for (const replacement of ["modified", "new-inode"] as const) {
		const root = fixture(); const children = [contender(root)]
		try {
			await waitFor(() => markers(root, ".ready").length === 1); release(root, "start"); await waitFor(() => markers(root, ".claimed").length === 1)
			const original = lockBytes(root); const bytes = replacement === "new-inode" ? original as string : '{"lockVersion":1,"ownerToken":"foreign"}\n'
			if (replacement === "new-inode") { linkSync(lockPath(root), join(root.privateRoot, "original-lock-inode")); rmSync(lockPath(root)); writeFileSync(lockPath(root), bytes) } else writeFileSync(lockPath(root), bytes)
			release(root, "finish"); const winner = await (children[0] as ReturnType<typeof contender>).done
			receipt(`b5-${replacement}`, root, { winner }, { original, replacementBytes: bytes }); expect(winner.exit).toBe(0); exactlyOne(root, winner); expect(lockBytes(root)).toBe(bytes)
			const refusedRun = await runCli(root, APPLY); refused(refusedRun)
		} finally { await stop(children) }
	}
})

test("O1 B6 controlled failure and authority refusal release only their own lock", async () => {
	for (const fault of [undefined, "throw-internal", "silent-no-op", "readback-fail:effect.update-index"]) {
		const root = fixture(); const before = readState(root)
		const argv = fault === undefined ? ["apply", "--json"] : APPLY
		const run = await runCli(root, argv, fault === undefined ? {} : { fault }); receipt(`b6-${fault ?? "authority"}`, root, { run }, { before })
		expect(run.exit).toBe(fault === undefined ? 3 : 1); expect(run.stderr).toBe(""); expect(existsSync(lockPath(root))).toBe(false)
		if (fault === undefined || fault === "throw-internal") expect(readState(root)).toEqual(before)
		if (fault === "readback-fail:effect.update-index") expect(readState(root).resource).toBe(REVISION_5_RESOURCE)
	}
})

test("O1 B7 foreign lock directory and symlink refuse without touching destinations", async () => {
	for (const kind of ["directory", "symlink"] as const) {
		const root = fixture(); const before = readState(root); const target = join(root.privateRoot, "foreign-lock"); writeFileSync(target, "foreign-owner\n")
		if (kind === "directory") mkdirSync(lockPath(root)); else symlinkSync(target, lockPath(root))
		const run = await runCli(root, APPLY); receipt(`b7-${kind}`, root, { run }, { before, targetBytes: readFileSync(target, "utf8") }); refused(run); expect(readState(root)).toEqual(before); expect(readFileSync(target, "utf8")).toBe("foreign-owner\n"); expect(kind === "directory" ? lstatSync(lockPath(root)).isDirectory() : lstatSync(lockPath(root)).isSymbolicLink()).toBe(true)
	}
})

test("O1 B8 preview creation holds the same lock and cleans up before returning", async () => {
	const root = fixture(); const before = readState(root); const children = [contender(root, ["apply", "--preview", "--json"])]
	try {
		await waitFor(() => markers(root, ".ready").length === 1); release(root, "start"); await waitFor(() => markers(root, ".claimed").length === 1)
		const loser = await runCli(root, APPLY); receipt("b8-preview-owner", root, { loser }, { before }); refused(loser); expect(readState(root)).toEqual(before)
		release(root, "finish"); const preview = await (children[0] as ReturnType<typeof contender>).done; receipt("b8-preview-finished", root, { preview }, { before }); expect(preview.exit).toBe(0); expect(existsSync(lockPath(root))).toBe(false); expect(readState(root).resource).toBe(before.resource); expect(readState(root).journal).toBe(before.journal)
	} finally { await stop(children) }
})
