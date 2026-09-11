import { randomUUID } from "node:crypto"
import {
	CONTRACT_VERSION,
	ENVELOPE_VERSION,
	type JsonRecord,
	type MachineEnvelope,
} from "./contract.ts"
import type { RunReport, ScenarioRow } from "./runner.ts"

type VerdictFields = Pick<MachineEnvelope, "outcome" | "failureClass" | "causeCode" | "nextAction" | "repairAction">
type BaseFields = Pick<MachineEnvelope, "envelopeVersion" | "contractVersion" | "commandIdentity" | "runIdentity" | "effectClass" | "transactionState" | "retryable" | "retryDelayMilliseconds" | "availablePaths" | "handoff">

function stringify(envelope: MachineEnvelope): string {
	return `${JSON.stringify(envelope)}\n`
}

function baseEnvelope(): BaseFields {
	return {
		envelopeVersion: ENVELOPE_VERSION,
		contractVersion: CONTRACT_VERSION,
		commandIdentity: "cli-design-check.run",
		runIdentity: `run-${randomUUID()}`,
		effectClass: "inspect",
		transactionState: "unchanged",
		retryable: false,
		retryDelayMilliseconds: null,
		availablePaths: [],
		handoff: null,
	}
}

function cell(value: number | null): string {
	return value === null ? "-" : String(value)
}

function renderRow(row: ScenarioRow): string {
	const verdict = row.passed ? "pass" : "fail"
	const findings = row.findings.join(", ") || "-"
	return `${row.scenario} | ${cell(row.observedExit)} | ${cell(row.expectedExit)} | ${verdict} | ${findings}`
}

export function renderHuman(report: RunReport): string {
	const lines = [
		"scenario | exit | expected | result | findings",
		...report.rows.map(renderRow),
		`passed ${report.passedCount}/${report.rows.length}`,
		`target unchanged: ${report.targetUnchanged ? "yes" : "no"}`,
	]
	return `${lines.join("\n")}\n`
}

function verdictFields(firstFailure: ScenarioRow | undefined): VerdictFields {
	if (firstFailure === undefined) return { outcome: "success", failureClass: null, causeCode: null, nextAction: null, repairAction: null }
	return {
		outcome: "refused",
		failureClass: "domain",
		causeCode: "DOMAIN_CONTRACT_VIOLATION",
		nextAction: `inspect scenario "${firstFailure.scenario}"`,
		repairAction: `${firstFailure.scenario} failed: ${firstFailure.findings[0]}`,
	}
}

export function renderJson(report: RunReport): string {
	return stringify({
		...baseEnvelope(),
		...verdictFields(report.rows.find((row) => !row.passed)),
		message: `passed ${report.passedCount}/${report.rows.length} scenarios`,
		result: report as unknown as JsonRecord,
	})
}

export function renderUsageError(message: string): string {
	return stringify({
		...baseEnvelope(),
		outcome: "refused",
		failureClass: "usage",
		causeCode: "USAGE_INVALID_ARGUMENTS",
		message,
		nextAction: "run cli-design-check --help",
		repairAction: "Correct the arguments and retry.",
		result: null,
	})
}

export function renderInternalError(message: string): string {
	return stringify({
		...baseEnvelope(),
		outcome: "failed",
		failureClass: "internal",
		causeCode: "INTERNAL_UNEXPECTED",
		message,
		nextAction: "inspect message, then retry",
		repairAction: "Inspect the error and retry.",
		result: null,
	})
}
