// Ticket #155 invariant 3: no existence oracle. Each probe runs the same invocation against a present and an absent
// (or otherwise unusable) receipt and requires byte-identical exit, stdout and stderr in both output modes. Outcomes
// that depend on the receipt must equal the fixed authority refusal; the usage, schema, internal and transient
// classes must come from piped caller input alone and so must not vary with the receipt either. The grant and request
// arrive on standard input, so the grant's receiptPath is the only caller-named path.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, linkSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import {
	createFifo,
	createFixture,
	DESCRIPTOR_LIMIT_PRELOAD,
	EXHAUST_DESCRIPTORS,
	envelope,
	fifoSentinel,
	type Fixture,
	type FixtureOptions,
	grant,
	type InvokeOptions,
	input,
	invoke,
	type ProcessResult,
	REFUSAL_HUMAN,
	REFUSAL_JSON,
	receipt,
	removeFixture,
	request,
	SENTINEL,
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
	"a FIFO": (target) => createFifo(target.receiptPath),
	"with a second hard link": (target) => {
		writeJson(target.receiptPath, receipt())
		linkSync(target.receiptPath, join(target.root, "second-link.json"))
	},
}

type Outputs = { machine: ProcessResult; human: ProcessResult }
type Invocation = { args: readonly string[]; options?: InvokeOptions }

function both(invocation: Invocation): Outputs {
	return { machine: invoke(fixture, [...invocation.args, "--json"], invocation.options), human: invoke(fixture, invocation.args, invocation.options) }
}

function piped(grantValue: unknown, requestValue: unknown): Invocation {
	return { args: ["project"], options: { stdin: input(grantValue, requestValue) } }
}

/** Runs one invocation under a fresh fixture per receipt state and returns each state's outputs. */
function probe(states: Record<string, ReceiptState>, build: (target: Fixture) => Invocation, options: FixtureOptions = {}): Record<string, Outputs> {
	const observed: Record<string, Outputs> = {}
	for (const [name, state] of Object.entries(states)) {
		removeFixture(fixture)
		fixture = createFixture(options)
		const invocation = build(fixture)
		state(fixture)
		observed[name] = both(invocation)
	}
	return observed
}

const refused = { machine: { exitCode: 3, stderr: "", stdout: REFUSAL_JSON }, human: { exitCode: 3, stderr: REFUSAL_HUMAN, stdout: "" } }

function expectAllRefused(observed: Record<string, Outputs>): void {
	expect(Object.keys(observed).length).toBeGreaterThan(1)
	for (const [name, outputs] of Object.entries(observed)) expect(outputs, name).toEqual(refused)
}

test("a mismatched request is refused identically whether the receipt is present or absent", () => {
	expectAllRefused(probe({ present, absent }, (target) => piped(grant(target), request({ provider: "opus" }))))
})

test("a matching request against any unusable receipt is refused identically to an absent one", () => {
	expectAllRefused(probe(UNUSABLE, (target) => piped(grant(target), request())))
})

test("a present, usable receipt is the only state that changes the outcome", () => {
	const observed = probe({ present }, (target) => piped(grant(target), request()))
	expect(observed.present?.machine.exitCode).toBe(0)
	expect(observed.present?.machine.stdout).not.toContain(SENTINEL)
})

// The path-open surface is gone: an operand is never read as input. A FIFO operand would hang the command if opened.
// Wrong behavior caught: reading a grant or request from a caller-supplied path.
const OPERANDS: Record<string, (target: Fixture) => readonly string[]> = {
	"the receipt as a project operand": (target) => ["project", target.receiptPath],
	"a FIFO as a project operand": (target) => {
		const fifo = join(target.inputs, "operand.fifo")
		createFifo(fifo)
		return ["project", fifo]
	},
	"the former GRANT REQUEST form naming the receipt and a FIFO": (target) => {
		const fifo = join(target.inputs, "request.fifo")
		createFifo(fifo)
		return [target.receiptPath, fifo]
	},
}

for (const [name, args] of Object.entries(OPERANDS)) {
	test(`${name}: a usage refusal, identical present or absent, and never opened`, () => {
		const observed = probe({ present, absent }, (target) => ({ args: args(target), options: { stdin: input(grant(target), request()) } }))
		expect(observed.present?.machine.exitCode).toBe(2)
		expect(observed.present?.human.stdout).toBe("")
		expect(observed.present).toEqual(observed.absent as Outputs)
	})
}

// The grant's receiptPath is the only caller-named path. With an authorized request, every spelling other than the
// exact receipt path under the configured root is refused before it is touched, present or absent.
const RECEIPT_PATH_ALIASES: Record<string, (target: Fixture) => string> = {
	"a symlink to the receipt": (target) => {
		const link = join(target.inputs, "linked-receipt.json")
		symlinkSync(target.receiptPath, link)
		return link
	},
	"a path through a symlinked directory into the item": (target) => {
		const link = join(target.inputs, "linked-item")
		symlinkSync(target.itemDirectory, link)
		return join(link, "classification-metadata.json")
	},
	"a link target that walks through the item directory and back out": (target) => {
		writeJson(join(target.inputs, "walk-target.json"), receipt())
		const link = join(target.inputs, "walk-receipt.json")
		// A raw string: path.join would collapse the dot segments and the target would never enter the item directory.
		symlinkSync(`${target.itemDirectory}/../../../../../inputs/walk-target.json`, link)
		return link
	},
	"a case-variant spelling": (target) => target.receiptPath.replace("/drive-inbox-filing/", "/DRIVE-INBOX-FILING/"),
	"the item directory": (target) => target.itemDirectory,
	// Textual aliases that normalize to the exact path. The grant names the path as exact text, so a gate that
	// normalizes the caller's spelling (path.resolve) before comparing would allow each of these with a receipt present.
	// Raw strings: path.join would normalize them back to the exact path.
	"a dot-segment spelling": (target) => `${target.itemDirectory}/../synthetic-item-001/classification-metadata.json`,
	"a current-directory segment": (target) => `${target.itemDirectory}/./classification-metadata.json`,
	"a doubled slash": (target) => target.receiptPath.replace("/items/", "/items//"),
	"a trailing slash": (target) => `${target.receiptPath}/`,
	"a path relative to the caller's working directory": (target) => relative(target.root, target.receiptPath),
}

for (const [name, receiptPath] of Object.entries(RECEIPT_PATH_ALIASES)) {
	test(`receiptPath as ${name}: refused identically whether the receipt is present or absent`, () => {
		expectAllRefused(probe({ present, absent }, (target) => piped(grant(target, { receiptPath: receiptPath(target) }), request())))
	})
}

// Physical state root (Nathan, 2026-09-30, option 1): the configured root must be its own physical path. A root reached
// through a symbolic link (a linked ~/.local/state, or macOS /tmp) gets the fixed denial even for the exact configured
// spelling the README names, so the root node cannot redirect the read to whatever it points at. A gate that resolves
// the root and pins the item directory under its real path allows this grant with a receipt present.
const LINKED_STATE_HOME: FixtureOptions = { linkedStateHome: true }

test("with a linked state root, the exact configured receiptPath is refused identically present or absent", () => {
	expectAllRefused(probe({ present, absent }, (target) => piped(grant(target), request()), LINKED_STATE_HOME))
})

test("with a linked state root, the physical spelling of the receipt path is refused identically present or absent", () => {
	const physical = (target: Fixture) => join(target.root, "physical-state", relative(target.stateHome, target.receiptPath))
	expectAllRefused(probe({ present, absent }, (target) => piped(grant(target, { receiptPath: physical(target) }), request()), LINKED_STATE_HOME))
})

// The configured root must be written as its canonical physical absolute path. For each non-canonical spelling of the
// same physical root, neither the README's literal expansion nor the normalized path is accepted. A gate that
// normalizes the configured root (path.join) accepts the normalized spelling with a receipt present.
const NON_CANONICAL_STATE_HOME: Record<string, (target: Fixture) => string> = {
	"a trailing slash": (target) => `${target.stateHome}/`,
	"a doubled slash": (target) => target.stateHome.replace(/\/state$/, "//state"),
	"a dot-dot segment": (target) => `${target.stateHome}/../state`,
}

for (const [name, spelling] of Object.entries(NON_CANONICAL_STATE_HOME)) {
	const grantedAs: Record<string, (target: Fixture) => string> = {
		"the README's literal expansion": (target) => `${spelling(target)}/${relative(target.stateHome, target.receiptPath)}`,
		"the normalized path": (target) => target.receiptPath,
	}
	for (const [form, receiptPath] of Object.entries(grantedAs)) {
		test(`with XDG_STATE_HOME spelled with ${name}, receiptPath as ${form}: refused identically present or absent`, () => {
			expectAllRefused(
				probe({ present, absent }, (target) => {
					target.env.XDG_STATE_HOME = spelling(target)
					return piped(grant(target, { receiptPath: receiptPath(target) }), request())
				}),
			)
		})
	}
}

// The README names the root as ${XDG_STATE_HOME:-$HOME/.local/state}: an unset or empty value falls back to HOME.
const XDG_FALLBACK: Record<string, (env: Record<string, string>) => void> = {
	unset: (env) => {
		delete env.XDG_STATE_HOME
	},
	empty: (env) => {
		env.XDG_STATE_HOME = ""
	},
}

function homeReceiptPath(target: Fixture, home: string): string {
	return join(target.root, home, ".local", "state", relative(target.stateHome, target.receiptPath))
}

// A gate that treats the empty string as a configured (relative) root denies this exact grant; one that reads the
// fixture's own state root instead of HOME's projects its sentinel value.
for (const [mode, fallback] of Object.entries(XDG_FALLBACK)) {
	test(`with XDG_STATE_HOME ${mode}, the exact receiptPath under HOME projects the granted fields`, () => {
		const observed = probe(
			{
				present: (target) => {
					mkdirSync(join(homeReceiptPath(target, "home"), ".."), { recursive: true })
					writeJson(homeReceiptPath(target, "home"), receipt())
					writeJson(target.receiptPath, { displayName: SENTINEL, mimeType: SENTINEL })
				},
			},
			(target) => {
				target.env.HOME = join(target.root, "home")
				fallback(target.env)
				return piped(grant(target, { receiptPath: homeReceiptPath(target, "home") }), request())
			},
		)
		expect(observed.present?.machine.exitCode).toBe(0)
		expect(envelope(observed.present?.machine as ProcessResult).result.data).toEqual({
			opaqueItemRef: "synthetic-item-001",
			projection: { displayName: "Fictional planning note", mimeType: "text/plain" },
		})
		expect(observed.present?.human).toEqual({
			exitCode: 0,
			stderr: "",
			stdout: "Granted projection for synthetic-item-001:\n  displayName: Fictional planning note\n  mimeType: text/plain\n",
		})
		expect(observed.present?.machine.stdout).not.toContain(SENTINEL)
	})
}

// The HOME fallback is the root as HOME spells it, so it must be canonical too. Each spelling below names <root>/home
// lexically; through lnk/.. the kernel instead resolves HOME to <root>/other, so a receipt sits under both. A gate that
// normalizes HOME (path.join) accepts the normalized spelling with a receipt present, and in the lnk/.. case reads a
// root other than the one HOME physically names.
const NON_CANONICAL_HOME: Record<string, (target: Fixture) => string> = {
	"a trailing slash": (target) => `${join(target.root, "home")}/`,
	"a doubled slash": (target) => `${target.root}//home`,
	"a dot-dot segment": (target) => {
		mkdirSync(join(target.root, "home", "x"), { recursive: true })
		return `${join(target.root, "home")}/x/..`
	},
	"a link then a dot-dot segment": (target) => {
		mkdirSync(join(target.root, "other", "sub"), { recursive: true })
		mkdirSync(join(target.root, "home"), { recursive: true })
		symlinkSync(join(target.root, "other", "sub"), join(target.root, "home", "lnk"))
		return `${join(target.root, "home")}/lnk/..`
	},
}

const homeReceiptsPresent: ReceiptState = (target) => {
	for (const home of ["home", "other"]) {
		mkdirSync(join(homeReceiptPath(target, home), ".."), { recursive: true })
		writeJson(homeReceiptPath(target, home), receipt())
	}
}

for (const [mode, fallback] of Object.entries(XDG_FALLBACK)) {
	for (const [name, spelling] of Object.entries(NON_CANONICAL_HOME)) {
		const grantedAs: Record<string, (target: Fixture, home: string) => string> = {
			"the README's literal expansion": (target, home) => `${home}/.local/state/${relative(target.stateHome, target.receiptPath)}`,
			"the normalized path": (target) => homeReceiptPath(target, "home"),
		}
		for (const [form, receiptPath] of Object.entries(grantedAs)) {
			test(`with XDG_STATE_HOME ${mode} and HOME spelled with ${name}, receiptPath as ${form}: refused identically present or absent`, () => {
				expectAllRefused(
					probe({ present: homeReceiptsPresent, absent }, (target) => {
						target.env.HOME = spelling(target)
						fallback(target.env)
						return piped(grant(target, { receiptPath: receiptPath(target, target.env.HOME) }), request())
					}),
				)
			})
		}
	}
}

// With HOME unset or empty and XDG_STATE_HOME unset, the root is the home in the operating system's account record
// plus /.local/state, which these tests never touch. A grant naming a synthetic root is denied before anything is
// read: the fixture's own state root, or <working directory>/.local/state, which a gate resolving an empty HOME
// against the working directory would accept with a receipt present.
const ABSENT_HOME: Record<string, (env: Record<string, string>) => void> = {
	unset: (env) => {
		delete env.HOME
	},
	empty: (env) => {
		env.HOME = ""
	},
}

const SYNTHETIC_ROOT_RECEIPTS: readonly ((target: Fixture) => string)[] = [(target) => target.receiptPath, (target) => homeReceiptPath(target, "")]

const syntheticReceiptsPresent: ReceiptState = (target) => {
	for (const receiptPath of SYNTHETIC_ROOT_RECEIPTS) {
		mkdirSync(join(receiptPath(target), ".."), { recursive: true })
		writeJson(receiptPath(target), receipt())
	}
}

for (const [mode, absentHome] of Object.entries(ABSENT_HOME)) {
	const configure = (target: Fixture) => {
		absentHome(target.env)
		delete target.env.XDG_STATE_HOME
	}

	test(`with HOME ${mode} and XDG_STATE_HOME unset, a receiptPath under a synthetic root is refused identically present or absent`, () => {
		for (const receiptPath of SYNTHETIC_ROOT_RECEIPTS) {
			expectAllRefused(
				probe({ present: syntheticReceiptsPresent, absent }, (target) => {
					configure(target)
					return piped(grant(target, { receiptPath: receiptPath(target) }), request())
				}),
			)
		}
	})

	test(`with HOME ${mode} and XDG_STATE_HOME unset, a receiptPath under a synthetic root never opens its receipt`, async () => {
		configure(fixture)
		mkdirSync(join(homeReceiptPath(fixture, ""), ".."), { recursive: true })
		const sentinels = await Promise.all(SYNTHETIC_ROOT_RECEIPTS.map((receiptPath) => fifoSentinel(fixture, receiptPath(fixture))))
		try {
			for (const receiptPath of SYNTHETIC_ROOT_RECEIPTS) expect(both(piped(grant(fixture, { receiptPath: receiptPath(fixture) }), request()))).toEqual(refused)
			expect(await Promise.all(sentinels.map((sentinel) => sentinel.opened()))).toEqual([false, false])
			for (const sentinel of sentinels) sentinel.openAsReader()
			expect(await Promise.all(sentinels.map((sentinel) => sentinel.opened()))).toEqual([true, true])
		} finally {
			await Promise.all(sentinels.map((sentinel) => sentinel.stop()))
		}
	})
}

for (const [name, receiptPath] of Object.entries(RECEIPT_PATH_ALIASES)) {
	test(`with a linked state root, receiptPath as ${name}: refused identically whether the receipt is present or absent`, () => {
		expectAllRefused(probe({ present, absent }, (target) => piped(grant(target, { receiptPath: receiptPath(target) }), request()), LINKED_STATE_HOME))
	})
}

// Trusted configuration boundary: with HOME and XDG_STATE_HOME at a decoy, a receipt under any other root, such as
// the account's default root, cannot be reached, whether named directly or linked into the decoy tree.
function otherRootReceipt(target: Fixture): string {
	return join(target.root, "account", ".local", "state", "my-second-brain-playground", "drive-inbox-filing", "items", "synthetic-item-001", "classification-metadata.json")
}

const otherRootPresent: ReceiptState = (target) => {
	mkdirSync(join(otherRootReceipt(target), ".."), { recursive: true })
	writeJson(otherRootReceipt(target), receipt())
}

function decoyState(target: Fixture): string {
	const decoy = join(target.root, "decoy")
	target.env.HOME = decoy
	target.env.XDG_STATE_HOME = join(decoy, "state")
	return join(decoy, "state")
}

test("with a decoy HOME and XDG_STATE_HOME, a receipt under another root named as receiptPath is refused identically", () => {
	expectAllRefused(
		probe({ present: otherRootPresent, absent }, (target) => {
			mkdirSync(decoyState(target), { recursive: true })
			return piped(grant(target, { receiptPath: otherRootReceipt(target) }), request())
		}),
	)
})

test("with a decoy HOME and XDG_STATE_HOME, a decoy items tree linked to another root is refused identically", () => {
	expectAllRefused(
		probe({ present: otherRootPresent, absent }, (target) => {
			const decoyItems = join(decoyState(target), "my-second-brain-playground", "drive-inbox-filing", "items")
			const otherItems = join(otherRootReceipt(target), "..", "..")
			mkdirSync(otherItems, { recursive: true })
			mkdirSync(join(decoyItems, ".."), { recursive: true })
			symlinkSync(otherItems, decoyItems)
			return piped(grant(target, { receiptPath: join(decoyItems, "synthetic-item-001", "classification-metadata.json") }), request())
		}),
	)
})

// The other classes read piped caller input only. Each must give the same bytes with a present or an absent receipt.
const CALLER_CLASSES: Record<string, { build: (target: Fixture) => Invocation; exitCode: number }> = {
	"usage: an operand after project": { build: (target) => ({ args: ["project", "extra"], options: { stdin: input(grant(target), request()) } }), exitCode: 2 },
	"schema: input is not JSON": { build: () => ({ args: ["project"], options: { stdin: "{broken" } }), exitCode: 4 },
	"schema: malformed opaque reference": { build: (target) => piped(grant(target), request({ opaqueItemRef: "Not_An_Item" })), exitCode: 4 },
	"internal: standard input is a directory": {
		build: (target) => {
			const directory = join(target.inputs, "a-directory")
			mkdirSync(directory)
			return { args: ["project"], options: { stdinPath: directory } }
		},
		exitCode: 1,
	},
	"transient: descriptor limit before input is read": {
		build: (target) => ({ args: ["project"], options: { stdin: input(grant(target), request()), preload: DESCRIPTOR_LIMIT_PRELOAD, env: EXHAUST_DESCRIPTORS } }),
		exitCode: 75,
	},
}

for (const [name, row] of Object.entries(CALLER_CLASSES)) {
	test(`${name}: identical with a present or absent receipt`, () => {
		const observed = probe({ present, absent }, row.build)
		expect(observed.present?.machine.exitCode).toBe(row.exitCode)
		expect(observed.present).toEqual(observed.absent as Outputs)
		for (const outputs of Object.values(observed)) {
			expect(`${outputs.machine.stdout}${outputs.machine.stderr}${outputs.human.stdout}${outputs.human.stderr}`).not.toContain(SENTINEL)
			expect(outputs.machine.stdout).not.toContain(fixture.root)
			expect(outputs.human.stderr).not.toContain(fixture.root)
		}
	})
}

test("an absent XDG state home is refused identically to an absent receipt", () => {
	const observed = probe({ absent }, (target) => {
		target.env.XDG_STATE_HOME = join(target.root, "missing-state")
		return piped(grant(target), request())
	})
	expect(observed.absent).toEqual(refused)
})
