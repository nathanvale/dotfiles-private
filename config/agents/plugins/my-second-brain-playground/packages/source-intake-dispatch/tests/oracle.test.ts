// Ticket #155 invariant 3: no existence oracle. Each probe runs the same invocation against a present and an absent
// (or otherwise unusable) receipt and requires byte-identical exit, stdout and stderr in both output modes. Outcomes
// that depend on the receipt must equal the fixed authority refusal; the usage, schema, internal and transient
// classes must come from caller input alone and so must not vary with the receipt either.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
	ACCOUNT_RECORD_PRELOAD,
	createFixture,
	DESCRIPTOR_LIMIT_PRELOAD,
	type Fixture,
	grant,
	invoke,
	type ProcessResult,
	REFUSAL_HUMAN,
	REFUSAL_JSON,
	receipt,
	removeFixture,
	request,
	SENTINEL,
	writeInputs,
	writeJson,
} from "./fixtures/harness.ts"

let fixture: Fixture

beforeEach(() => {
	fixture = createFixture()
})

afterEach(() => {
	removeFixture(fixture)
})

type ReceiptState = (fixture: Fixture) => void

const present: ReceiptState = (target) => {
	writeJson(target.receiptPath, receipt())
}
const absent: ReceiptState = () => {}

// Receipt states that are not a usable receipt. Each must be indistinguishable from an absent one.
const UNUSABLE: Record<string, ReceiptState> = {
	absent,
	"a directory": (target) => mkdirSync(target.receiptPath),
	"invalid JSON": (target) => writeFileSync(target.receiptPath, `{"displayName": ${SENTINEL}`),
	"a JSON array": (target) => writeJson(target.receiptPath, [SENTINEL]),
	"missing a requested field": (target) => writeJson(target.receiptPath, { displayName: SENTINEL }),
	"a non-scalar field": (target) => writeJson(target.receiptPath, { displayName: SENTINEL, mimeType: { nested: SENTINEL } }),
	"a non-finite number": (target) => writeFileSync(target.receiptPath, `{"displayName":"${SENTINEL}","mimeType":1e999}`),
	unreadable: (target) => {
		writeJson(target.receiptPath, receipt())
		chmodSync(target.receiptPath, 0o000)
	},
	"a symlink to valid metadata": (target) => {
		const elsewhere = writeJson(join(target.root, "elsewhere.json"), receipt())
		symlinkSync(elsewhere, target.receiptPath)
	},
	"in an unreadable item directory": (target) => {
		writeJson(target.receiptPath, receipt())
		chmodSync(target.itemDirectory, 0o000)
	},
	"with no item directory": (target) => renameSync(target.itemDirectory, join(target.root, "moved-item")),
}

function both(args: readonly string[], preload?: string): { machine: ProcessResult; human: ProcessResult } {
	return { machine: invoke(fixture, [...args, "--json"], preload), human: invoke(fixture, args, preload) }
}

/** Runs one invocation under a fresh fixture per receipt state and returns each state's outputs. */
function probe(states: Record<string, ReceiptState>, args: (target: Fixture) => readonly string[], preload?: string): Record<string, ReturnType<typeof both>> {
	const observed: Record<string, ReturnType<typeof both>> = {}
	for (const [name, state] of Object.entries(states)) {
		removeFixture(fixture)
		fixture = createFixture()
		const argv = args(fixture)
		state(fixture)
		observed[name] = both(argv, preload)
	}
	return observed
}

const refused = { machine: { exitCode: 3, stderr: "", stdout: REFUSAL_JSON }, human: { exitCode: 3, stderr: REFUSAL_HUMAN, stdout: "" } }

function expectAllRefused(observed: Record<string, ReturnType<typeof both>>): void {
	expect(Object.keys(observed).length).toBeGreaterThan(1)
	for (const [name, outputs] of Object.entries(observed)) expect(outputs, name).toEqual(refused)
}

test("a mismatched request is refused identically whether the receipt is present or absent", () => {
	expectAllRefused(probe({ present, absent }, (target) => writeInputs(target, grant(target), request({ provider: "opus" }))))
})

test("a matching request against any unusable receipt is refused identically to an absent one", () => {
	expectAllRefused(probe(UNUSABLE, (target) => writeInputs(target, grant(target), request())))
})

test("a present, usable receipt is the only state that changes the outcome", () => {
	const observed = probe({ present }, (target) => writeInputs(target, grant(target), request()))
	expect(observed.present?.machine.exitCode).toBe(0)
	expect(observed.present?.machine.stdout).not.toContain(SENTINEL)
})

// A caller that names a receipt as its own grant or request must not learn whether that receipt exists or parses.
const ALIASES: Record<string, (target: Fixture) => readonly string[]> = {
	"request path is the receipt": (target) => [writeInputs(target, grant(target), request())[0], target.receiptPath],
	"grant path is the receipt": (target) => [target.receiptPath, writeInputs(target, grant(target), request())[1]],
	"request path is a symlink to the receipt": (target) => {
		const link = join(target.inputs, "linked-request.json")
		symlinkSync(target.receiptPath, link)
		return [writeInputs(target, grant(target), request())[0], link]
	},
	"request path goes through a symlinked directory into the item": (target) => {
		const link = join(target.inputs, "linked-item")
		symlinkSync(target.itemDirectory, link)
		return [writeInputs(target, grant(target), request())[0], join(link, "classification-metadata.json")]
	},
	"request path uses dot segments into the item": (target) => [writeInputs(target, grant(target), request())[0], join(target.inputs, "..", "state", "my-second-brain-playground", "drive-inbox-filing", "items", "synthetic-item-001", "classification-metadata.json")],
	"request path is the item directory": (target) => [writeInputs(target, grant(target), request())[0], target.itemDirectory],
}

for (const [name, args] of Object.entries(ALIASES)) {
	test(`${name}: refused identically whether the receipt is present or absent`, () => {
		expectAllRefused(probe({ present, absent }, args))
	})
}

test("a case-variant spelling of the receipt path is refused on a case-insensitive volume", () => {
	const upper = (target: Fixture) => target.receiptPath.replace("/drive-inbox-filing/", "/DRIVE-INBOX-FILING/")
	present(fixture)
	if (!existsSync(upper(fixture))) return // A case-sensitive volume cannot resolve the variant, so there is no alias.
	expectAllRefused(probe({ present, absent }, (target) => [writeInputs(target, grant(target), request())[0], upper(target)]))
})

// The new classes read caller input only. Each must give the same bytes with a present or an absent receipt.
const CALLER_CLASSES: Record<string, { args: (target: Fixture) => readonly string[]; exitCode: number; preload?: string }> = {
	"usage: one operand": { args: (target) => [writeInputs(target, grant(target), request())[0]], exitCode: 2 },
	"schema: grant is not JSON": {
		args: (target) => {
			const grantPath = join(target.inputs, "invalid-grant.json")
			writeFileSync(grantPath, "{broken")
			return [grantPath, writeInputs(target, grant(target), request())[1]]
		},
		exitCode: 4,
	},
	"schema: malformed opaque reference": { args: (target) => writeInputs(target, grant(target), request({ opaqueItemRef: "Not_An_Item" })), exitCode: 4 },
	"internal: grant is a directory outside the items tree": {
		args: (target) => {
			const directory = join(target.inputs, "a-directory")
			mkdirSync(directory)
			return [directory, writeInputs(target, grant(target), request())[1]]
		},
		exitCode: 1,
	},
	"transient: descriptor limit before the grant opens": {
		args: (target) => [writeJson(join(target.inputs, "busy-grant.json"), grant(target)), writeInputs(target, grant(target), request())[1]],
		exitCode: 75,
		preload: DESCRIPTOR_LIMIT_PRELOAD,
	},
}

for (const [name, row] of Object.entries(CALLER_CLASSES)) {
	test(`${name}: identical with a present or absent receipt`, () => {
		const observed = probe({ present, absent }, row.args, row.preload)
		expect(observed.present?.machine.exitCode).toBe(row.exitCode)
		expect(observed.present).toEqual(observed.absent as ReturnType<typeof both>)
		for (const outputs of Object.values(observed)) {
			expect(`${outputs.machine.stdout}${outputs.machine.stderr}${outputs.human.stdout}${outputs.human.stderr}`).not.toContain(SENTINEL)
			expect(outputs.machine.stdout).not.toContain(fixture.root)
			expect(outputs.human.stderr).not.toContain(fixture.root)
		}
	})
}

test("an absent XDG state home is refused identically to an absent receipt", () => {
	const observed = probe({ absent }, (target) => {
		const inputs = writeInputs(target, grant(target), request())
		target.env.XDG_STATE_HOME = join(target.root, "missing-state")
		return inputs
	})
	expect(observed.absent).toEqual(refused)
})

// A link outside the items tree whose target walks into the item directory and back out. Resolving it physically would
// succeed only when the item directory exists, so the outcome must not depend on that directory.
const itemDirectoryPresent: ReceiptState = present
const itemDirectoryAbsent: ReceiptState = (target) => renameSync(target.itemDirectory, join(target.root, "moved-item"))

const WALK_BACK_OUT: Record<string, { exitCode: number; create: (path: string) => void }> = {
	schema: { exitCode: 4, create: (path) => writeFileSync(path, "{broken") },
	internal: { exitCode: 1, create: (path) => mkdirSync(path) },
}

for (const [name, row] of Object.entries(WALK_BACK_OUT)) {
	test(`${name}: a grant link whose target walks through the item directory and back out is identical with the item directory present or absent`, () => {
		const observed = probe({ itemDirectoryPresent, itemDirectoryAbsent }, (target) => {
			row.create(join(target.inputs, "walk-target"))
			const link = join(target.inputs, "walk-grant.json")
			// A raw string: path.join would collapse the dot segments and the target would never enter the item directory.
			symlinkSync(`${target.itemDirectory}/../../../../../inputs/walk-target`, link)
			return [link, writeInputs(target, grant(target), request())[1]]
		})
		expect(Object.keys(observed)).toEqual(["itemDirectoryPresent", "itemDirectoryAbsent"])
		expect(observed.itemDirectoryPresent?.machine.exitCode).toBe(row.exitCode)
		expect(observed.itemDirectoryPresent).toEqual(observed.itemDirectoryAbsent as ReturnType<typeof both>)
	})
}

// Trusted configuration boundary: the account's default receipt root, read from the OS account record, stays guarded
// even when HOME and XDG_STATE_HOME point at a decoy. The preload substitutes a synthetic account record.
function accountReceiptPath(target: Fixture): string {
	return join(target.root, "account", ".local", "state", "my-second-brain-playground", "drive-inbox-filing", "items", "synthetic-item-001", "classification-metadata.json")
}

const accountReceiptPresent: ReceiptState = (target) => {
	mkdirSync(join(accountReceiptPath(target), ".."), { recursive: true })
	writeJson(accountReceiptPath(target), receipt())
}

test("a default-root receipt named as the grant is refused identically when HOME and XDG_STATE_HOME point at a decoy", () => {
	const observed = probe(
		{ present: accountReceiptPresent, absent },
		(target) => {
			const decoy = join(target.root, "decoy")
			mkdirSync(join(decoy, "state"), { recursive: true })
			target.env.HOME = decoy
			target.env.XDG_STATE_HOME = join(decoy, "state")
			target.env.SOURCE_INTAKE_TEST_ACCOUNT_HOME = join(target.root, "account")
			return [accountReceiptPath(target), writeInputs(target, grant(target), request())[1]]
		},
		ACCOUNT_RECORD_PRELOAD,
	)
	expectAllRefused(observed)
})
