#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { cleanupRecoveryTraces, viewRecoveryTraces, openRecoveryObservability, isRecoveryIdentity, isPluginVersion } from "./interface.ts"

const usage = `Usage:
  recovery-traces view [--journey ID] [--invocation ID] [--worker ID] [--task ID] [--state-home PATH]
  recovery-traces cleanup [--state-home PATH]
  recovery-traces identity
`

type Command = "view" | "cleanup" | "identity"

function parse(args: readonly string[]): { command: Command; stateHome?: string; filter: Record<string, string> } | null {
	const command = args[0]
	if (command !== "view" && command !== "cleanup" && command !== "identity") return null
	const filter: Record<string, string> = {}
	let stateHome: string | undefined
	for (let index = 1; index < args.length; index += 2) {
		const key = args[index]
		const value = args[index + 1]
		if (!key || !value || value.startsWith("--")) return null
		if (key === "--state-home") stateHome = value
		else if (command === "view" && key === "--journey") filter.journey_identity = value
		else if (command === "view" && key === "--invocation") filter.invocation_identity = value
		else if (command === "view" && key === "--worker") filter.observed_worker_identity = value
		else if (command === "view" && key === "--task") filter.ledger_task_identity = value
		else return null
	}
	return { command, stateHome, filter }
}

function pluginRoot(): string {
	const sourceRoot = resolve(import.meta.dir, "../../..")
	return resolve(sourceRoot, "packages/recovery-observability/src") === import.meta.dir
		? sourceRoot
		: resolve(import.meta.dir, "..")
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export async function runTraceCommand(args: readonly string[]): Promise<number> {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help")) {
		process.stdout.write(usage)
		return 0
	}
	const parsed = parse(args)
	if (parsed === null) {
		process.stderr.write(usage)
		return 64
	}
	if (parsed.command === "identity") {
		if (args.length !== 1) {
			process.stderr.write(usage)
			return 64
		}
		try {
			const root = pluginRoot()
			const plugin: unknown = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
			if (typeof plugin !== "object" || plugin === null || !("version" in plugin) || !isPluginVersion(plugin.version)) {
				throw new Error("invalid-plugin-metadata")
			}
			process.stdout.write(`${JSON.stringify({
				schema_version: 1,
				command: "identity",
				ok: true,
				plugin_version: plugin.version,
				recovery_source_sha256: sha256(resolve(root, "packages/compaction-recovery/src/recovery.py")),
				observer_source_sha256: sha256(resolve(root, "packages/recovery-observability/src/recovery-observer.ts")),
				runtime_sha256: sha256(resolve(root, "runtime/recovery-observer.js")),
			})}\n`)
			return 0
		} catch {
			process.stdout.write(`${JSON.stringify({ schema_version: 1, command: "identity", ok: false, error: "identity-unavailable", next_action: "Restore the plugin package metadata, recovery sources, and observer runtime, then retry identity." })}\n`)
			return 1
		}
	}
	const journey = process.env.MSB_RECOVERY_CLEANUP_JOURNEY
	const parent = process.env.MSB_RECOVERY_CLEANUP_PARENT
	const invocation = `cleanup-${randomUUID()}`
	const observer = parsed.command === "cleanup" && isRecoveryIdentity(journey) && isRecoveryIdentity(parent)
		? openRecoveryObservability({ invocationIdentity: invocation, stateHome: parsed.stateHome }) : undefined
	const started = process.hrtime.bigint()
	const recordCleanup = (sequence: number, outcome: "started" | "succeeded" | "unavailable") => {
		try {
			observer?.accept({
				schema_version: 1, record_type: "lifecycle", record_identity: `${invocation}-${sequence}`,
				journey_identity: journey, invocation_identity: invocation, producer_identity: invocation,
				producer_sequence: sequence, parent_record_identity: parent, harness_kind: "command",
				operation: "cleanup", phase: "cleanup", occurred_at: new Date().toISOString(),
				duration_ms: Number(process.hrtime.bigint() - started) / 1_000_000, outcome,
			})
		} catch {
			// Cleanup observations cannot replace the cleanup command result.
		}
	}
	recordCleanup(0, "started")
	const result = parsed.command === "view"
		? viewRecoveryTraces({ stateHome: parsed.stateHome, filter: parsed.filter })
		: cleanupRecoveryTraces({ stateHome: parsed.stateHome })
	recordCleanup(1, result.available ? "succeeded" : "unavailable")
	observer?.dispose()
	process.stdout.write(`${JSON.stringify({ schema_version: 1, command: parsed.command, ok: true, ...result })}\n`)
	return 0
}

if (import.meta.main) process.exitCode = await runTraceCommand(process.argv.slice(2))
