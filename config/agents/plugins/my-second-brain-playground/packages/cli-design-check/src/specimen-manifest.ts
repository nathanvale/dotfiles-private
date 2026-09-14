// The only source of specimen expectations. Every literal below is written from the frozen
// oracle row and the checker's rule order, never copied from checker output. Mutations live in
// fixtures/specimens/src/cli.ts; a process entry runs the whole matrix against that CLI with
// CLI_DESIGN_SPECIMEN=<specimen> and expects the named row to carry exactly `findings`, every
// other row to pass, exit 3 and a repairAction naming the row. A unit entry feeds one mutated
// base envelope to the named row's rules in process and expects exactly `findings`.
export type ProofLayer = "process" | "unit"

export interface UnitInput {
	readonly base: keyof typeof UNIT_BASE
	// Dotted paths set or removed on a copy of the base envelope, for example "result.exitMeanings.1".
	readonly set?: Readonly<Record<string, unknown>>
	readonly remove?: readonly string[]
	readonly observedExit: number
	// Raw stdout for human rows; when present the base envelope is not used.
	readonly stdout?: string
	readonly stderr?: string
	readonly secretMarker?: string
}

// A specimen every row accepts: exit 0, all rows pass; optionally the report names the unseen effect.
export interface PassingObservation {
	readonly field: "notObserved" | "excludedEntryKinds"
	readonly names: string
}

// A durable effect the specimen must leave behind, asserted on the filesystem before cleanup.
export type ExpectedEffect =
	| { readonly kind: "file"; readonly path: string; readonly content: string }
	| { readonly kind: "symlink"; readonly path: string; readonly target: string }

export interface SpecimenExpectation {
	readonly rule: string
	// The finding code (or family template) this entry proves; for a passing specimen, the report field it proves.
	readonly code: string
	readonly specimen: string
	readonly proof: ProofLayer
	readonly row: string
	readonly mutation: string
	readonly findings: readonly string[]
	// The rule cannot be isolated on any matrix row; the listed companions are still caused by the one mutation.
	readonly attributableOnly?: true
	readonly environmentSensitive?: true
	readonly timeoutMs?: number
	readonly passes?: Partial<PassingObservation>
	// Effects the test asserts before cleanup; "<target>" is the target root, "<tmpdir>" the OS temp directory.
	readonly effects?: readonly ExpectedEffect[]
	// Paths the test removes after the run, same placeholders.
	readonly cleanup?: readonly string[]
	// Expected targetObservation.changedPaths when the mutation writes inside the target.
	readonly changedPaths?: readonly string[]
	// Expected observedExit on the named row, asserted when present.
	readonly observedExit?: number
	readonly unit?: UnitInput
}

// Independent oracle: conformant envelopes restated as literals, not produced by any fixture.
export const UNIT_BASE = {
	success: {
		envelopeVersion: 1,
		contractVersion: "1.0.0",
		commandIdentity: "config-peek.read",
		runIdentity: "run-unit",
		outcome: "success",
		failureClass: null,
		causeCode: null,
		message: "Configuration read successfully",
		effectClass: "inspect",
		transactionState: "unchanged",
		retryable: false,
		retryDelayMilliseconds: null,
		nextAction: null,
		availablePaths: [],
		repairAction: null,
		handoff: null,
		result: { path: "config/valid.json", values: { name: "demo" } },
	},
	refusal: {
		envelopeVersion: 1,
		contractVersion: "1.0.0",
		commandIdentity: "config-peek.read",
		runIdentity: "run-unit",
		outcome: "refused",
		failureClass: "domain",
		causeCode: "DOMAIN_INPUT_MISSING",
		message: "Input file is missing; provide a readable JSON file",
		effectClass: "inspect",
		transactionState: "unchanged",
		retryable: false,
		retryDelayMilliseconds: null,
		nextAction: "config-peek --help",
		availablePaths: ["config-peek --help"],
		repairAction: "Provide a readable JSON file inside the current directory",
		handoff: null,
		result: { path: "config/missing.json" },
	},
	discovery: {
		envelopeVersion: 1,
		contractVersion: "1.0.0",
		commandIdentity: "config-peek.discover",
		runIdentity: "run-unit",
		outcome: "success",
		failureClass: null,
		causeCode: null,
		message: "Command discovery completed",
		effectClass: "inspect",
		transactionState: "unchanged",
		retryable: false,
		retryDelayMilliseconds: null,
		nextAction: null,
		availablePaths: ["config-peek [--json] <path>"],
		repairAction: null,
		handoff: null,
		result: {
			name: "config-peek",
			contractVersion: "1.0.0",
			generationConventionVersion: "1.0.0",
			commands: [{ identity: "config-peek.read", argv: "[--json] <path>", effectClass: "inspect", description: "Read and flatten one JSON file" }],
			exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "retryable-or-unavailable" },
			machineMode: "--json",
			logtape: false,
		},
	},
} as const

export const SPECIMEN_MANIFEST: readonly SpecimenExpectation[] = [
	{
		rule: "O-01",
		code: "STDOUT_NOT_SINGLE_JSON_OBJECT",
		specimen: "S01",
		proof: "process",
		row: "help-json",
		mutation: "prose on `--help --json`",
		findings: ["STDOUT_NOT_SINGLE_JSON_OBJECT"],
	},
	{
		rule: "O-16",
		code: "STDOUT_NOT_SINGLE_JSON_OBJECT",
		specimen: "S19",
		proof: "process",
		row: "no-arguments-json",
		mutation: "bare `--json` answers with a human one-liner on stderr and nothing on stdout",
		findings: ["STDOUT_NOT_SINGLE_JSON_OBJECT", "STDERR_NOT_EMPTY"],
	},
	{
		rule: "O-12",
		code: "ENVELOPE_FIELD_INVALID:outcome",
		specimen: "S15",
		proof: "process",
		row: "malformed-value-json",
		mutation: "malformed input is treated as a success: success envelope, null repairAction, exit 0",
		findings: ["ENVELOPE_FIELD_INVALID:outcome", "ENVELOPE_FIELD_INVALID:failureClass", "ENVELOPE_FIELD_INVALID:repairAction", "EXIT_MISMATCH"],
	},
	{
		rule: "O-10",
		code: "ENVELOPE_FIELD_INVALID:failureClass",
		specimen: "S13",
		proof: "process",
		row: "malformed-value-json",
		mutation: "declares failureClass schema (cause SCHEMA_INPUT_MALFORMED) while exiting 3",
		findings: ["ENVELOPE_FIELD_INVALID:failureClass"],
	},
	{
		rule: "O-12",
		code: "malformed-value-json accepts schema with exit 4",
		specimen: "C14",
		proof: "process",
		row: "malformed-value-json",
		mutation: "declares failureClass schema (cause SCHEMA_INPUT_MALFORMED) and exits 4: the oracle's other aligned pairing",
		findings: [],
		passes: {},
		observedExit: 4,
	},
	{
		rule: "O-12",
		code: "ENVELOPE_FIELD_INVALID:failureClass",
		specimen: "C15",
		proof: "process",
		row: "malformed-value-json",
		mutation: "keeps failureClass domain but exits 4 (misaligned; exit 4 alone is not accepted)",
		findings: ["ENVELOPE_FIELD_INVALID:failureClass"],
		observedExit: 4,
	},
	{
		rule: "O-03",
		code: "ENVELOPE_FIELD_INVALID:result.exitMeanings.0",
		specimen: "S02",
		proof: "process",
		row: "discover",
		mutation: 'exitMeanings "0" is "banana"',
		findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings.0"],
	},
	{
		rule: "O-04",
		code: "DISCOVERY_FIELD_UNDECLARED:exitMeanings.<key>",
		specimen: "S03",
		proof: "process",
		row: "discover",
		mutation: 'exitMeanings gains an undeclared key "99"',
		findings: ["DISCOVERY_FIELD_UNDECLARED:exitMeanings.99"],
	},
	{
		rule: "O-05",
		code: "ENVELOPE_FIELD_INVALID:result.exitMeanings.75",
		specimen: "S04",
		proof: "process",
		row: "discover",
		mutation: 'exitMeanings "75" is the empty string',
		findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings.75"],
	},
	{
		rule: "O-06",
		code: "ENVELOPE_SUCCESS_UNRESOLVED",
		specimen: "S05",
		proof: "process",
		row: "discover",
		mutation: "the success discovery envelope carries transactionState unknown",
		findings: ["ENVELOPE_SUCCESS_UNRESOLVED"],
	},
	{
		rule: "O-07",
		code: "ENVELOPE_UNRESOLVED_RETRYABLE",
		specimen: "U01",
		proof: "unit",
		row: "help-json",
		mutation: "a refusal reports partially-completed yet retryable true",
		findings: ["ENVELOPE_UNRESOLVED_RETRYABLE"],
		unit: { base: "refusal", set: { transactionState: "partially-completed", retryable: true }, observedExit: 3 },
	},
	{
		rule: "O-07",
		code: "ENVELOPE_UNRESOLVED_RETRYABLE",
		specimen: "S06",
		proof: "process",
		row: "missing-input",
		mutation: "the missing-input refusal reports transactionState unknown yet retryable true",
		findings: ["ENVELOPE_UNRESOLVED_RETRYABLE", "ENVELOPE_FIELD_INVALID:retryable", "ENVELOPE_FIELD_INVALID:transactionState"],
		attributableOnly: true,
	},
	{
		rule: "O-08",
		code: "ENVELOPE_FIELD_INVALID:nextAction",
		specimen: "S07",
		proof: "process",
		row: "missing-input",
		mutation: "the refusal's nextAction is the empty string",
		findings: ["ENVELOPE_FIELD_INVALID:nextAction"],
	},
	{
		rule: "O-08",
		code: "ENVELOPE_FIELD_INVALID:repairAction",
		specimen: "S08",
		proof: "process",
		row: "missing-input",
		mutation: "the refusal's repairAction is the empty string",
		findings: ["ENVELOPE_FIELD_INVALID:repairAction"],
	},
	{
		rule: "O-08",
		code: "ENVELOPE_FIELD_INVALID:handoff.reason",
		specimen: "S09",
		proof: "process",
		row: "success-json",
		mutation: "the success carries a handoff whose reason is the empty string",
		findings: ["ENVELOPE_FIELD_INVALID:handoff.reason"],
	},
	{
		rule: "O-08",
		code: "ENVELOPE_FIELD_INVALID:nextAction",
		specimen: "S10",
		proof: "process",
		row: "success-json",
		mutation: "the success's nextAction is the empty string",
		findings: ["ENVELOPE_FIELD_INVALID:nextAction"],
	},
	{
		rule: "O-09",
		code: "ENVELOPE_NEXT_STEP_RULE",
		specimen: "S11",
		proof: "process",
		row: "missing-input",
		mutation: "the refusal carries both a nextAction and a handoff",
		findings: ["ENVELOPE_NEXT_STEP_RULE"],
	},
	{
		rule: "O-09",
		code: "ENVELOPE_NEXT_STEP_RULE",
		specimen: "S12",
		proof: "process",
		row: "missing-input",
		mutation: "the refusal carries neither a nextAction nor a handoff",
		findings: ["ENVELOPE_NEXT_STEP_RULE"],
	},
	{
		rule: "O-13",
		code: "STDOUT_NOT_SINGLE_JSON_OBJECT",
		specimen: "S16",
		proof: "process",
		row: "large-envelope",
		mutation: "a forced exit with status 0 immediately after writing the 2 MiB envelope (the tail never reaches the pipe)",
		findings: ["STDOUT_NOT_SINGLE_JSON_OBJECT"],
		// Truncation depends on Bun 1.4.0 pipe writes and reader timing (oracle proof limit).
		environmentSensitive: true,
	},
	{
		rule: "O-13",
		code: "LARGE_ENVELOPE_BELOW_THRESHOLD",
		specimen: "C01",
		proof: "process",
		row: "large-envelope",
		mutation: "the declared large result is a short string",
		findings: ["LARGE_ENVELOPE_BELOW_THRESHOLD"],
	},
	{
		rule: "O-15",
		code: "targetObservation.notObserved",
		specimen: "S17",
		proof: "process",
		row: "target-unchanged",
		mutation: "the success-json row writes a file outside --cwd (in the OS temp directory)",
		findings: [],
		passes: { field: "notObserved", names: "out-of-tree paths" },
		effects: [{ kind: "file", path: "<tmpdir>/cli-design-specimen-S17.txt", content: "written outside the target root\n" }],
		cleanup: ["<tmpdir>/cli-design-specimen-S17.txt"],
	},
	{
		rule: "O-15",
		code: "targetObservation.excludedEntryKinds",
		specimen: "S18",
		proof: "process",
		row: "target-unchanged",
		mutation: "the success-json row creates a symlink inside --cwd",
		findings: [],
		passes: { field: "excludedEntryKinds", names: "symlink" },
		effects: [{ kind: "symlink", path: "<target>/config/specimen-link.json", target: "valid.json" }],
		cleanup: ["<target>/config/specimen-link.json"],
	},
	{
		rule: "O-17",
		code: "HUMAN_OUTPUT_IS_JSON",
		specimen: "S20",
		proof: "process",
		row: "success-human",
		mutation: "human success output is a top-level JSON array",
		findings: ["HUMAN_OUTPUT_IS_JSON"],
	},
	{
		rule: "O-17",
		code: "HUMAN_OUTPUT_IS_JSON",
		specimen: "U03",
		proof: "unit",
		row: "success-human",
		mutation: "human success output is a bare number, which stays legal prose",
		findings: [],
		unit: { base: "success", stdout: "42\n", observedExit: 0 },
	},
	{
		rule: "O-17",
		code: "HUMAN_OUTPUT_IS_JSON",
		specimen: "U04",
		proof: "unit",
		row: "success-human",
		mutation: "human success output is a quoted string, which stays legal prose",
		findings: [],
		unit: { base: "success", stdout: '"demo"\n', observedExit: 0 },
	},
	// O-10 unit-only exits (U02): the alignment of internal, schema and unavailable classes with 1, 4 and 75.
	{ rule: "O-10", code: "ENVELOPE_FIELD_INVALID:failureClass", specimen: "U02a", proof: "unit", row: "help-json", mutation: "internal failure aligned with exit 1", findings: [], unit: { base: "refusal", set: { outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_UNEXPECTED" }, observedExit: 1 } },
	{ rule: "O-10", code: "ENVELOPE_FIELD_INVALID:failureClass", specimen: "U02b", proof: "unit", row: "help-json", mutation: "internal failure with exit 3", findings: ["ENVELOPE_FIELD_INVALID:failureClass"], unit: { base: "refusal", set: { outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_UNEXPECTED" }, observedExit: 3 } },
	{ rule: "O-10", code: "ENVELOPE_FIELD_INVALID:failureClass", specimen: "U02c", proof: "unit", row: "help-json", mutation: "schema refusal aligned with exit 4", findings: [], unit: { base: "refusal", set: { failureClass: "schema", causeCode: "SCHEMA_INPUT_INVALID" }, observedExit: 4 } },
	{ rule: "O-10", code: "ENVELOPE_FIELD_INVALID:failureClass", specimen: "U02d", proof: "unit", row: "help-json", mutation: "unavailable failure aligned with exit 75", findings: [], unit: { base: "refusal", set: { outcome: "failed", failureClass: "unavailable", causeCode: "UNAVAILABLE_STORAGE_BUSY" }, observedExit: 75 } },
	{ rule: "O-10", code: "ENVELOPE_FIELD_INVALID:failureClass", specimen: "U02e", proof: "unit", row: "help-json", mutation: "unavailable failure with exit 3", findings: ["ENVELOPE_FIELD_INVALID:failureClass"], unit: { base: "refusal", set: { outcome: "failed", failureClass: "unavailable", causeCode: "UNAVAILABLE_STORAGE_BUSY" }, observedExit: 3 } },
	// Coverage specimens (O-18): every flat code and one representative per templated family at process level.
	{ rule: "coverage", code: "STDOUT_NOT_EMPTY", specimen: "C02", proof: "process", row: "no-arguments", mutation: "the human refusal also prints a line on stdout", findings: ["STDOUT_NOT_EMPTY"] },
	{ rule: "coverage", code: "STDOUT_EMPTY", specimen: "C03", proof: "process", row: "success-human", mutation: "human success prints nothing", findings: ["STDOUT_EMPTY"] },
	{ rule: "coverage", code: "STDERR_NOT_ONE_LINE", specimen: "C04", proof: "process", row: "no-arguments", mutation: "the human refusal prints two stderr lines", findings: ["STDERR_NOT_ONE_LINE"] },
	{ rule: "coverage", code: "JSON_ON_STDERR", specimen: "C05", proof: "process", row: "success-json", mutation: "the success envelope is also written to stderr", findings: ["STDERR_NOT_EMPTY", "JSON_ON_STDERR"] },
	{ rule: "coverage", code: "PROMPTED_OR_HUNG", specimen: "C06", proof: "process", row: "no-arguments", mutation: "the human refusal never exits", findings: ["PROMPTED_OR_HUNG", "EXIT_MISMATCH"], timeoutMs: 1000 },
	{ rule: "coverage", code: "TARGET_MUTATED", specimen: "C07", proof: "process", row: "target-unchanged", mutation: "the success-json row writes SPECIMEN_WROTE inside --cwd", findings: ["TARGET_MUTATED"], changedPaths: ["SPECIMEN_WROTE"], effects: [{ kind: "file", path: "<target>/SPECIMEN_WROTE", content: "written inside the target root\n" }], cleanup: ["<target>/SPECIMEN_WROTE"] },
	{ rule: "coverage", code: "HELP_MISSING_USAGE", specimen: "C08", proof: "process", row: "help", mutation: "help text has no usage line", findings: ["HELP_MISSING_USAGE"] },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:retryDelayMilliseconds", specimen: "C09", proof: "process", row: "success-json", mutation: "the success envelope has no retryDelayMilliseconds field", findings: ["ENVELOPE_FIELD_MISSING:retryDelayMilliseconds"] },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings.75", specimen: "C10", proof: "process", row: "discover", mutation: 'exitMeanings has no "75" key', findings: ["DISCOVERY_FIELD_MISSING:exitMeanings.75"] },
	{ rule: "coverage", code: "SECRET_MARKER_LEAKED:stdout", specimen: "C11", proof: "process", row: "secret-redaction", mutation: "the secret marker appears in the envelope message", findings: ["SECRET_MARKER_LEAKED:stdout"] },
	{ rule: "coverage", code: "SECRET_KEY_NOT_REDACTED:<path>", specimen: "C12", proof: "process", row: "secret-redaction", mutation: "result.values.apiToken is a plain value instead of [REDACTED]", findings: ["SECRET_KEY_NOT_REDACTED:values.apiToken"] },
	{ rule: "coverage", code: "STDERR_NOT_EMPTY", specimen: "C13", proof: "process", row: "help", mutation: "help also prints a diagnostic on stderr", findings: ["STDERR_NOT_EMPTY"] },
	// Remaining templated instances at unit level (O-18): ENVELOPE_FIELD_MISSING.
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:envelopeVersion", specimen: "U05", proof: "unit", row: "help-json", mutation: "envelopeVersion absent", findings: ["ENVELOPE_FIELD_MISSING:envelopeVersion"], unit: { base: "success", remove: ["envelopeVersion"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:contractVersion", specimen: "U06", proof: "unit", row: "help-json", mutation: "contractVersion absent", findings: ["ENVELOPE_FIELD_MISSING:contractVersion"], unit: { base: "success", remove: ["contractVersion"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:commandIdentity", specimen: "U07", proof: "unit", row: "help-json", mutation: "commandIdentity absent", findings: ["ENVELOPE_FIELD_MISSING:commandIdentity"], unit: { base: "success", remove: ["commandIdentity"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:runIdentity", specimen: "U08", proof: "unit", row: "help-json", mutation: "runIdentity absent", findings: ["ENVELOPE_FIELD_MISSING:runIdentity"], unit: { base: "success", remove: ["runIdentity"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:outcome", specimen: "U09", proof: "unit", row: "help-json", mutation: "outcome absent", findings: ["ENVELOPE_FIELD_MISSING:outcome"], unit: { base: "success", remove: ["outcome"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:failureClass", specimen: "U10", proof: "unit", row: "help-json", mutation: "failureClass absent", findings: ["ENVELOPE_FIELD_MISSING:failureClass"], unit: { base: "success", remove: ["failureClass"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:causeCode", specimen: "U11", proof: "unit", row: "help-json", mutation: "causeCode absent", findings: ["ENVELOPE_FIELD_MISSING:causeCode"], unit: { base: "success", remove: ["causeCode"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:message", specimen: "U12", proof: "unit", row: "help-json", mutation: "message absent", findings: ["ENVELOPE_FIELD_MISSING:message"], unit: { base: "success", remove: ["message"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:effectClass", specimen: "U13", proof: "unit", row: "help-json", mutation: "effectClass absent", findings: ["ENVELOPE_FIELD_MISSING:effectClass"], unit: { base: "success", remove: ["effectClass"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:transactionState", specimen: "U14", proof: "unit", row: "help-json", mutation: "transactionState absent", findings: ["ENVELOPE_FIELD_MISSING:transactionState"], unit: { base: "success", remove: ["transactionState"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:retryable", specimen: "U15", proof: "unit", row: "help-json", mutation: "retryable absent", findings: ["ENVELOPE_FIELD_MISSING:retryable"], unit: { base: "success", remove: ["retryable"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:nextAction", specimen: "U16", proof: "unit", row: "help-json", mutation: "nextAction absent", findings: ["ENVELOPE_FIELD_MISSING:nextAction"], unit: { base: "success", remove: ["nextAction"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:availablePaths", specimen: "U17", proof: "unit", row: "help-json", mutation: "availablePaths absent", findings: ["ENVELOPE_FIELD_MISSING:availablePaths"], unit: { base: "success", remove: ["availablePaths"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:repairAction", specimen: "U18", proof: "unit", row: "help-json", mutation: "repairAction absent", findings: ["ENVELOPE_FIELD_MISSING:repairAction"], unit: { base: "success", remove: ["repairAction"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:handoff", specimen: "U19", proof: "unit", row: "help-json", mutation: "handoff absent", findings: ["ENVELOPE_FIELD_MISSING:handoff"], unit: { base: "success", remove: ["handoff"], observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_MISSING:result", specimen: "U20", proof: "unit", row: "help-json", mutation: "result absent", findings: ["ENVELOPE_FIELD_MISSING:result"], unit: { base: "success", remove: ["result"], observedExit: 0 } },
	// Remaining templated instances at unit level (O-18): ENVELOPE_FIELD_INVALID.
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:envelopeVersion", specimen: "U21", proof: "unit", row: "help-json", mutation: "envelopeVersion is 2", findings: ["ENVELOPE_FIELD_INVALID:envelopeVersion"], unit: { base: "success", set: { envelopeVersion: 2 }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:contractVersion", specimen: "U22", proof: "unit", row: "help-json", mutation: 'contractVersion is "2.0.0"', findings: ["ENVELOPE_FIELD_INVALID:contractVersion"], unit: { base: "success", set: { contractVersion: "2.0.0" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:commandIdentity", specimen: "U23", proof: "unit", row: "help-json", mutation: "commandIdentity is empty", findings: ["ENVELOPE_FIELD_INVALID:commandIdentity"], unit: { base: "success", set: { commandIdentity: "" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:runIdentity", specimen: "U24", proof: "unit", row: "help-json", mutation: "runIdentity is empty", findings: ["ENVELOPE_FIELD_INVALID:runIdentity"], unit: { base: "success", set: { runIdentity: "" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:causeCode", specimen: "U25", proof: "unit", row: "help-json", mutation: "causeCode is lowercase", findings: ["ENVELOPE_FIELD_INVALID:causeCode"], unit: { base: "refusal", set: { causeCode: "domain_input_missing" }, observedExit: 3 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:message", specimen: "U26", proof: "unit", row: "help-json", mutation: "message is a number", findings: ["ENVELOPE_FIELD_INVALID:message"], unit: { base: "success", set: { message: 42 }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:effectClass", specimen: "U27", proof: "unit", row: "help-json", mutation: 'effectClass is "cosmic"', findings: ["ENVELOPE_FIELD_INVALID:effectClass"], unit: { base: "success", set: { effectClass: "cosmic" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:retryDelayMilliseconds", specimen: "U28", proof: "unit", row: "help-json", mutation: "retryDelayMilliseconds is negative", findings: ["ENVELOPE_FIELD_INVALID:retryDelayMilliseconds"], unit: { base: "success", set: { retryDelayMilliseconds: -1 }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:availablePaths", specimen: "U29", proof: "unit", row: "help-json", mutation: "availablePaths is a string", findings: ["ENVELOPE_FIELD_INVALID:availablePaths"], unit: { base: "success", set: { availablePaths: "config-peek --help" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:handoff", specimen: "U30", proof: "unit", row: "help-json", mutation: "handoff is a string", findings: ["ENVELOPE_FIELD_INVALID:handoff"], unit: { base: "success", set: { handoff: "ask the operator" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result", specimen: "U31", proof: "unit", row: "help-json", mutation: "result is an array", findings: ["ENVELOPE_FIELD_INVALID:result"], unit: { base: "success", set: { result: [] }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.name", specimen: "U32", proof: "unit", row: "discover", mutation: "discovery name is a number", findings: ["ENVELOPE_FIELD_INVALID:result.name"], unit: { base: "discovery", set: { "result.name": 42 }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.contractVersion", specimen: "U33", proof: "unit", row: "discover", mutation: 'discovery contractVersion is "2.0.0"', findings: ["ENVELOPE_FIELD_INVALID:result.contractVersion"], unit: { base: "discovery", set: { "result.contractVersion": "2.0.0" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.generationConventionVersion", specimen: "U34", proof: "unit", row: "discover", mutation: 'generationConventionVersion is "2.0.0"', findings: ["ENVELOPE_FIELD_INVALID:result.generationConventionVersion"], unit: { base: "discovery", set: { "result.generationConventionVersion": "2.0.0" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.machineMode", specimen: "U35", proof: "unit", row: "discover", mutation: 'machineMode is "--machine"', findings: ["ENVELOPE_FIELD_INVALID:result.machineMode"], unit: { base: "discovery", set: { "result.machineMode": "--machine" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.commands", specimen: "U36", proof: "unit", row: "discover", mutation: "commands is empty", findings: ["ENVELOPE_FIELD_INVALID:result.commands"], unit: { base: "discovery", set: { "result.commands": [] }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.exitMeanings", specimen: "U37", proof: "unit", row: "discover", mutation: "exitMeanings is a string", findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings"], unit: { base: "discovery", set: { "result.exitMeanings": "0 success" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.logtape", specimen: "U38", proof: "unit", row: "discover", mutation: 'logtape is "yes"', findings: ["ENVELOPE_FIELD_INVALID:result.logtape"], unit: { base: "discovery", set: { "result.logtape": "yes" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.exitMeanings.1", specimen: "U39", proof: "unit", row: "discover", mutation: 'exitMeanings "1" is "banana"', findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings.1"], unit: { base: "discovery", set: { "result.exitMeanings.1": "banana" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.exitMeanings.2", specimen: "U40", proof: "unit", row: "discover", mutation: 'exitMeanings "2" is "banana"', findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings.2"], unit: { base: "discovery", set: { "result.exitMeanings.2": "banana" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.exitMeanings.3", specimen: "U41", proof: "unit", row: "discover", mutation: 'exitMeanings "3" is "banana"', findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings.3"], unit: { base: "discovery", set: { "result.exitMeanings.3": "banana" }, observedExit: 0 } },
	{ rule: "coverage", code: "ENVELOPE_FIELD_INVALID:result.exitMeanings.4", specimen: "U42", proof: "unit", row: "discover", mutation: 'exitMeanings "4" is "banana"', findings: ["ENVELOPE_FIELD_INVALID:result.exitMeanings.4"], unit: { base: "discovery", set: { "result.exitMeanings.4": "banana" }, observedExit: 0 } },
	// Remaining templated instances at unit level (O-18): DISCOVERY_FIELD_MISSING.
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:result", specimen: "U43", proof: "unit", row: "discover", mutation: "the discovery envelope has a null result", findings: ["DISCOVERY_FIELD_MISSING:result"], unit: { base: "discovery", set: { result: null }, observedExit: 0 } },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:name", specimen: "U44", proof: "unit", row: "discover", mutation: "discovery name absent", findings: ["DISCOVERY_FIELD_MISSING:name"], unit: { base: "discovery", remove: ["result.name"], observedExit: 0 } },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:contractVersion", specimen: "U45", proof: "unit", row: "discover", mutation: "discovery contractVersion absent", findings: ["DISCOVERY_FIELD_MISSING:contractVersion"], unit: { base: "discovery", remove: ["result.contractVersion"], observedExit: 0 } },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:generationConventionVersion", specimen: "U46", proof: "unit", row: "discover", mutation: "generationConventionVersion absent", findings: ["DISCOVERY_FIELD_MISSING:generationConventionVersion"], unit: { base: "discovery", remove: ["result.generationConventionVersion"], observedExit: 0 } },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:machineMode", specimen: "U47", proof: "unit", row: "discover", mutation: "machineMode absent", findings: ["DISCOVERY_FIELD_MISSING:machineMode"], unit: { base: "discovery", remove: ["result.machineMode"], observedExit: 0 } },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:commands", specimen: "U48", proof: "unit", row: "discover", mutation: "commands absent", findings: ["DISCOVERY_FIELD_MISSING:commands"], unit: { base: "discovery", remove: ["result.commands"], observedExit: 0 } },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings", specimen: "U49", proof: "unit", row: "discover", mutation: "exitMeanings absent", findings: ["DISCOVERY_FIELD_MISSING:exitMeanings"], unit: { base: "discovery", remove: ["result.exitMeanings"], observedExit: 0 } },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:logtape", specimen: "U50", proof: "unit", row: "discover", mutation: "logtape absent", findings: ["DISCOVERY_FIELD_MISSING:logtape"], unit: { base: "discovery", remove: ["result.logtape"], observedExit: 0 } },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings.0", specimen: "U51", proof: "unit", row: "discover", mutation: 'exitMeanings "0" absent', findings: ["DISCOVERY_FIELD_MISSING:exitMeanings.0"], unit: { base: "discovery", remove: ["result.exitMeanings.0"], observedExit: 0 } },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings.1", specimen: "U52", proof: "unit", row: "discover", mutation: 'exitMeanings "1" absent', findings: ["DISCOVERY_FIELD_MISSING:exitMeanings.1"], unit: { base: "discovery", remove: ["result.exitMeanings.1"], observedExit: 0 } },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings.2", specimen: "U53", proof: "unit", row: "discover", mutation: 'exitMeanings "2" absent', findings: ["DISCOVERY_FIELD_MISSING:exitMeanings.2"], unit: { base: "discovery", remove: ["result.exitMeanings.2"], observedExit: 0 } },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings.3", specimen: "U54", proof: "unit", row: "discover", mutation: 'exitMeanings "3" absent', findings: ["DISCOVERY_FIELD_MISSING:exitMeanings.3"], unit: { base: "discovery", remove: ["result.exitMeanings.3"], observedExit: 0 } },
	{ rule: "coverage", code: "DISCOVERY_FIELD_MISSING:exitMeanings.4", specimen: "U55", proof: "unit", row: "discover", mutation: 'exitMeanings "4" absent', findings: ["DISCOVERY_FIELD_MISSING:exitMeanings.4"], unit: { base: "discovery", remove: ["result.exitMeanings.4"], observedExit: 0 } },
	// Remaining templated instance at unit level (O-18): SECRET_MARKER_LEAKED on stderr.
	{ rule: "coverage", code: "SECRET_MARKER_LEAKED:stderr", specimen: "U56", proof: "unit", row: "secret-redaction", mutation: "the secret marker appears on stderr", findings: ["SECRET_MARKER_LEAKED:stderr", "STDERR_NOT_EMPTY"], unit: { base: "success", stderr: "warning: CHECK_FIXTURE_SECRET_MARKER\n", secretMarker: "CHECK_FIXTURE_SECRET_MARKER", observedExit: 0 } },
] as const
