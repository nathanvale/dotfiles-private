import { CHECKER_AVAILABLE_PATHS, CHECKER_DISCOVERY_DATA, CHECKER_HELP_DATA, CHECKER_IDENTITIES } from "./command-contract.ts"
import { type CauseCode, CHECKER_CONTRACT_VERSION, CHECKER_ENVELOPE_VERSION, causeRuleFor } from "./contract.ts"
import type { SuccessorRow, SuccessorRunReport } from "./runner.ts"

type Handoff = { owner: "operator"; reason: string; inspect: string[] }
type Guidance = { kind: "next"; nextAction: string } | { kind: "handoff"; handoff: Handoff }

interface Verdict {
	causeCode: CauseCode
	repairAction: string | null
	guidance: Guidance
	retryDelayMilliseconds?: number | undefined
}

interface ReportVerdict extends Verdict {
	message: string
}

const EMPTY_EFFECTS = { completed: [], remaining: [], uncertain: [], inventoryComplete: true } as const

function stringify(value: unknown): string {
	return `${JSON.stringify(value)}\n`
}

function resultEnvelope(runId: string, commandIdentity: string, message: string, data: unknown, verdict: Verdict): string {
	const rule = causeRuleFor(verdict.causeCode)
	if (rule.guidance !== verdict.guidance.kind) throw new Error(`guidance does not match ${verdict.causeCode}`)
	if (rule.retryable !== (verdict.retryDelayMilliseconds !== undefined)) throw new Error(`retry delay does not match ${verdict.causeCode}`)
	return stringify({
		envelopeVersion: CHECKER_ENVELOPE_VERSION,
		contractVersion: CHECKER_CONTRACT_VERSION,
		message,
		availablePaths: CHECKER_AVAILABLE_PATHS,
		result: {
			runId,
			commandIdentity,
			outcome: rule.outcome,
			effectClass: "inspect",
			transactionState: rule.state,
			causeCode: verdict.causeCode,
			failureClass: rule.failureClass,
			exitCode: rule.exit,
			data: rule.outcome === "success" ? data : null,
			retryable: rule.retryable,
			...(verdict.retryDelayMilliseconds === undefined ? {} : { retryDelayMilliseconds: verdict.retryDelayMilliseconds }),
			repairAction: verdict.repairAction,
			effects: EMPTY_EFFECTS,
			...(verdict.guidance.kind === "next" ? { nextAction: verdict.guidance.nextAction } : { handoff: verdict.guidance.handoff }),
		},
	})
}

function cell(value: number | readonly number[] | string | null): string {
	return value === null ? "-" : String(value)
}

function renderRow(row: SuccessorRow): string {
	const custody = row.streamCustody === null ? "-" : `${row.streamCustody.stdoutPath},${row.streamCustody.stderrPath}`
	return `${row.scenario} | ${cell(row.observedExit)} | ${cell(row.expectedExit)} | ${row.passed ? "pass" : "fail"} | ${row.findings.join(", ") || "-"} | ${cell(row.observedContractVersion)} | ${custody}`
}

export function renderHuman(report: SuccessorRunReport): string {
	const lines = [
		"scenario | exit | expected | result | findings | version | retained streams",
		...report.rows.map(renderRow),
		`passed ${report.passedCount}/${report.rows.length}`,
		`target unchanged: ${report.targetUnchanged ? "yes" : "no"}`,
		`retention requested: ${report.retention.requested ? "yes" : "no"}`,
		`skipped rows: ${report.skippedRows.length === 0 ? "none" : report.skippedRows.join(", ")}`,
		`observation exclusions: ${report.observationExclusions.length === 0 ? "none" : report.observationExclusions.join(", ")}`,
	]
	return `${lines.join("\n")}\n`
}

function retainedPaths(report: SuccessorRunReport): string[] {
	return report.rows.flatMap((row) => (row.streamCustody === null ? [] : [row.streamCustody.stdoutPath, row.streamCustody.stderrPath]))
}

function reportDisclosure(report: SuccessorRunReport): string {
	const custody = retainedPaths(report)
	return `Checker report: ${report.passedCount}/${report.rows.length} passed; ${report.failedCount} failed; skipped rows: ${report.skippedRows.length === 0 ? "none" : report.skippedRows.join(", ")}; observation exclusions: ${report.observationExclusions.length === 0 ? "none" : report.observationExclusions.join(", ")}; retained stream custody: ${custody.length === 0 ? "none" : custody.join(", ")}.`
}

function semanticVersionParts(value: string): [bigint, bigint, bigint] | null {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
	if (match === null) return null
	return [BigInt(match[1] ?? ""), BigInt(match[2] ?? ""), BigInt(match[3] ?? "")]
}

function supportedVersionParts(): [bigint, bigint, bigint] {
	const parts = semanticVersionParts(CHECKER_CONTRACT_VERSION)
	if (parts === null) throw new Error(`checker contract version ${CHECKER_CONTRACT_VERSION} is not semantic`)
	return parts
}

const SUPPORTED_VERSION_PARTS = supportedVersionParts()

function compareToSupportedVersion(value: string): -1 | 0 | 1 | null {
	const observed = semanticVersionParts(value)
	if (observed === null) return null
	for (const [index, part] of observed.entries()) {
		const expected = SUPPORTED_VERSION_PARTS[index] as bigint
		if (part < expected) return -1
		if (part > expected) return 1
	}
	return 0
}

function unsupportedGuidance(observedVersion: string | null): { message: string; repairAction: string } {
	if (observedVersion === null) return { message: "Target contract version is missing; observed null.", repairAction: "Supply an explicit supported 2.0.0 document." }
	const rendered = JSON.stringify(observedVersion)
	const comparison = compareToSupportedVersion(observedVersion)
	if (observedVersion === "1.0" || comparison === -1) return { message: `Target contract version ${rendered} is unsupported legacy format.`, repairAction: "Obtain a conforming 2.0.0 producer; no legacy adapter is available." }
	if (comparison === 1) return { message: `Target contract version ${rendered} is newer than supported 2.0.0.`, repairAction: `Use a reviewed consumer matching ${rendered}, or obtain a conforming 2.0.0 producer.` }
	if (/\d/.test(observedVersion)) return { message: `Target contract version ${rendered} is malformed.`, repairAction: "Supply an explicit supported 2.0.0 document." }
	return { message: `Target contract version ${rendered} is unrecognized.`, repairAction: "Supply an explicit supported 2.0.0 document." }
}

function reportVerdict(report: SuccessorRunReport): ReportVerdict {
	const disclosure = reportDisclosure(report)
	if (report.failedCount === 0) {
		return {
			message: `Target contract 2.0.0 accepted. ${disclosure}`,
			causeCode: "SUCCESS_UNCHANGED",
			repairAction: null,
			guidance: { kind: "next", nextAction: CHECKER_IDENTITIES.run },
		}
	}
	const first = report.rows.find((row) => !row.passed)
	const finding = first?.findings[0] ?? "unknown finding"
	if (finding === "TARGET_CONTRACT_UNSUPPORTED") {
		const guidance = unsupportedGuidance(first?.observedContractVersion ?? null)
		return {
			message: `${guidance.message} ${disclosure}`,
			causeCode: "SCHEMA_UNSUPPORTED_CONTRACT",
			repairAction: guidance.repairAction,
			guidance: { kind: "next", nextAction: CHECKER_IDENTITIES.run },
		}
	}
	return {
		message: `Target contract 2.0.0 is broken: ${finding}. ${disclosure}`,
		causeCode: "SCHEMA_INVALID_INPUT",
		repairAction: `Repair target 2.0.0 field or correlation ${finding}, then rerun the checker. Inspect the target's effects separately; do not replay it automatically.`,
		guidance: { kind: "next", nextAction: CHECKER_IDENTITIES.run },
	}
}

export function renderJson(report: SuccessorRunReport): { text: string; exit: 0 | 4 } {
	const verdict = reportVerdict(report)
	const exit = causeRuleFor(verdict.causeCode).exit as 0 | 4
	return { text: resultEnvelope(report.runIdentity, CHECKER_IDENTITIES.run, verdict.message, report, verdict), exit }
}

export function renderUsageError(message: string): string {
	return resultEnvelope("run-cli-design-check-usage", CHECKER_IDENTITIES.dispatch, message, null, {
		causeCode: "USAGE_INVALID_INVOCATION",
		repairAction: "Correct the invocation using cli-design-check --help.",
		guidance: { kind: "next", nextAction: CHECKER_IDENTITIES.help },
	})
}

export function renderHelp(): string {
	return resultEnvelope("run-cli-design-check-help", CHECKER_IDENTITIES.help, "Describe the successor checker invocation.", CHECKER_HELP_DATA, {
		causeCode: "SUCCESS_UNCHANGED",
		repairAction: null,
		guidance: { kind: "next", nextAction: CHECKER_IDENTITIES.run },
	})
}

export function renderDiscovery(): string {
	return resultEnvelope("run-cli-design-check-discovery", CHECKER_IDENTITIES.discovery, "Describe the checker command and 2.0 contract.", CHECKER_DISCOVERY_DATA, {
		causeCode: "SUCCESS_UNCHANGED",
		repairAction: null,
		guidance: { kind: "next", nextAction: CHECKER_IDENTITIES.run },
	})
}

export function renderInternalError(message: string): string {
	return resultEnvelope("run-cli-design-check-internal", CHECKER_IDENTITIES.run, message, null, {
		causeCode: "INTERNAL_RESULT_UNCHANGED",
		repairAction: "Inspect the checker failure without replaying the target.",
		guidance: { kind: "handoff", handoff: { owner: "operator", reason: "Checker result production failed after target execution.", inspect: [CHECKER_IDENTITIES.run] } },
	})
}
