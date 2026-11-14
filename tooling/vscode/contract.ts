import { randomUUID } from "node:crypto";
import { Refusal, requireValue } from "./model.ts";
import { Incomplete, type Observation } from "./runtime.ts";

export const commands = ["vscode.apply", "vscode.discover", "vscode.help", "vscode.preview", "vscode.rollback", "vscode.status"] as const;
export type Command = typeof commands[number];
const exits = { usage: 2, domain: 3, schema: 4, transient: 75, internal: 1 } as const;
const emptyEffects = (): Observation => ({ completed: [], remaining: [], uncertain: [], inventoryComplete: true });
const refusalCauses = { usage: "USAGE_INVALID_INVOCATION", domain: "DOMAIN_PRECONDITION_UNMET", schema: "SCHEMA_INVALID_INPUT", transient: "TRANSIENT_NOT_STARTED" } as const;

// This table owns both discovery and process-result vocabulary.
const stations = {
	SUCCESS_UNCHANGED: { outcome: "success", transactionState: "unchanged", failureClass: null, exitCode: 0, retryable: false },
	SUCCESS_COMPLETED: { outcome: "success", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false },
	USAGE_INVALID_INVOCATION: { outcome: "refused", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false },
	DOMAIN_PRECONDITION_UNMET: { outcome: "refused", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false },
	SCHEMA_INVALID_INPUT: { outcome: "refused", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false },
	TRANSIENT_NOT_STARTED: { outcome: "refused", transactionState: "unchanged", failureClass: "transient", exitCode: 75, retryable: true },
	INTERNAL_RESULT_UNCHANGED: { outcome: "failed", transactionState: "unchanged", failureClass: "internal", exitCode: 1, retryable: false },
	INTERNAL_RESULT_COMPLETED: { outcome: "failed", transactionState: "completed", failureClass: "internal", exitCode: 1, retryable: false },
	INTERNAL_RESULT_PARTIAL: { outcome: "failed", transactionState: "partially-completed", failureClass: "internal", exitCode: 1, retryable: false },
	INTERNAL_RESULT_UNKNOWN: { outcome: "failed", transactionState: "unknown", failureClass: "internal", exitCode: 1, retryable: false },
} as const;
type Cause = keyof typeof stations;

function effectClass(command: Command) {
	if (command === "vscode.apply" || command === "vscode.rollback") return "external";
	if (command === "vscode.preview") return "repository-local";
	return "inspect";
}

function reachable(command: Command, cause: string): boolean {
	if (command === "vscode.apply" || command === "vscode.rollback") return true;
	if (command === "vscode.help" || command === "vscode.discover") return cause === "SUCCESS_UNCHANGED" || cause === "USAGE_INVALID_INVOCATION";
	if (cause === "TRANSIENT_NOT_STARTED") return false;
	if (cause.startsWith("INTERNAL_RESULT_") && cause !== "INTERNAL_RESULT_UNCHANGED") return false;
	if (command === "vscode.preview") return cause !== "SUCCESS_UNCHANGED";
	return cause !== "SUCCESS_COMPLETED";
}

export function discover(command?: Command) {
	const selected = command ? [command] : commands;
	const detailed = {
		contractVersion: "2.0.0", generationConventionVersion: "2.0.0", profile: "complex",
		commands: selected.map((identity) => ({
			commandIdentity: identity, effectClass: effectClass(identity),
			stations: Object.entries(stations).filter(([cause]) => reachable(identity, cause)).map(([causeCode, row]) => ({
				stationIdentity: `${identity}.${causeCode}`, causeCode, ...row,
				effectClass: effectClass(identity), reachability: "process",
				trigger: causeCode, repairAction: row.outcome === "success" ? null : "Repair inputs or inspect the active plan before continuing.",
				nextAction: identity === "vscode.preview" ? "vscode.apply" : "vscode.status",
			})),
		})),
		exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" }, signalExits: { "130": "SIGINT", "143": "SIGTERM" },
		effectExclusions: ["No editor window is opened or reloaded.", "No SSH, container, service, account sync or launcher changes.", "Rollback retains installed extensions; it never uninstalls them."],
	};
	if (command) return detailed;
	return { ...detailed, commands: detailed.commands.map(({ commandIdentity, effectClass }) => ({
		commandIdentity, effectClass,
		route: commandIdentity === "vscode.help" ? ["--help"] : commandIdentity === "vscode.discover" ? ["--discover"] : [commandIdentity.slice(7)],
		summary: commandIdentity,
	})) };
}

function envelope(command: Command, cause: Cause, message: string, data: unknown, effects: Observation) {
	const row = stations[cause];
	const result = {
		runId: randomUUID(), commandIdentity: command, causeCode: cause, ...row,
		effectClass: effectClass(command), data,
		repairAction: row.outcome === "success" ? null : message, effects,
		...(row.retryable ? { retryDelayMilliseconds: 1000 } : {}),
		...(row.outcome === "failed"
			? { handoff: { owner: "human", reason: message, inspect: ["vscode.status with the original --plan"] } }
			: { nextAction: command === "vscode.preview" ? "vscode.apply" : "vscode.status" }),
	};
	// Validate the final serialized envelope, including correlation and evidence.
	const output = { envelopeVersion: 2, contractVersion: "2.0.0", message, availablePaths: commands, result };
	const encoded = JSON.stringify(output);
	const decoded = JSON.parse(encoded);
	requireValue(decoded.result.data !== undefined && message.length > 0, "Invalid result serialization.");
	const allEffects = [...effects.completed, ...effects.remaining, ...effects.uncertain];
	requireValue(new Set(allEffects).size === allEffects.length, "Overlapping effect evidence.");
	requireValue(row.transactionState !== "completed" || effects.completed.length > 0, "Completed result needs observed effects.");
	requireValue(row.transactionState !== "unchanged" || effects.completed.length + effects.uncertain.length === 0, "Unchanged result cannot claim effects.");
	return output;
}

export function success(command: Command, data: unknown, completed: string[] = []) {
	return envelope(command, completed.length ? "SUCCESS_COMPLETED" : "SUCCESS_UNCHANGED", "Ready. Review the result before the next action.", data, { ...emptyEffects(), completed: [...completed].sort() });
}

export function failure(command: Command, error: unknown) {
	if (error instanceof Incomplete) {
		const evidence = error.evidence;
		let cause: Cause = "INTERNAL_RESULT_UNCHANGED";
		if (evidence.uncertain.length || !evidence.inventoryComplete) cause = "INTERNAL_RESULT_UNKNOWN";
		else if (evidence.completed.length) cause = evidence.remaining.length ? "INTERNAL_RESULT_PARTIAL" : "INTERNAL_RESULT_COMPLETED";
		return envelope(command, cause, error.message, null, evidence);
	}
	if (error instanceof Refusal) return envelope(command, refusalCauses[error.kind], error.message, null, emptyEffects());
	return envelope(command, "INTERNAL_RESULT_UNCHANGED", "Could not read or prepare configuration. Check directory access and run status before trying again.", null, emptyEffects());
}

export type Envelope = ReturnType<typeof success>;
