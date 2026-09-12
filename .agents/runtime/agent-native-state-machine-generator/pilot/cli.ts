/**
 * The pilot CLI front door: vault-git-reimagined.
 *
 * Runs the generated Command Surface Contract through the existing
 * cli-command-facade. Everything semantic is generated: the contracts, the
 * Branch Station Catalog, the semantic expectation table, and the Projection
 * Composer selection the envelopes carry. This file owns only the seams the
 * Extension Points name: the Input Binder below translates argv into one
 * declared invocation, the workspace Fact Provider observes, and the facade
 * shapes envelopes and exits.
 *
 * The front door maps the Observed Fact to the observed Branch Station and
 * hands that station to the generated composer; it never assembles a
 * projection by hand. Input Schema v1 declares no fact-to-branch surface, so
 * that mapping stays handwritten (recorded in the candidate's
 * unresolved_decisions for stage 5).
 *
 * Learning pilot only: nothing here is qualification evidence, and running
 * green never constitutes Specification Admission.
 */
import {
	type CliRuntimeErrorEnvelope,
	type CliRuntimeSuccessEnvelope,
	type CommandFacadeContract,
	createCliRuntimeError,
	createCliRuntimeErrorEnvelope,
	createCliRuntimeSuccessEnvelope,
	createCliUsageRuntimeError,
	createCommandResultData,
	writeJsonEnvelope,
} from '@side-quest/cli-command-facade'
import { projectVaultGitReimaginedCommandDiscoveryTree } from './extensions/command-discovery.ts'
import { observeVaultWorkspace } from './extensions/workspace-observation.ts'
import { vaultGitReimaginedCommandContracts } from './generated/src/command-surface-contract.ts'
import { selectVaultGitReimaginedProjection } from './generated/src/projection-composer.ts'

type PilotCommand = keyof typeof vaultGitReimaginedCommandContracts

interface PilotOutcome {
	readonly exitCode: number
	readonly envelope: CliRuntimeSuccessEnvelope | CliRuntimeErrorEnvelope
}

/**
 * Input Binder: validated argv in, one declared invocation out. It refuses
 * anything the Command Surface Contract does not declare and reinterprets
 * nothing. Bare invocation binds to the declared read_only_dashboard command,
 * exactly as the generated status.no_argument station claims.
 */
type PilotBinding =
	| {
			readonly ok: true
			readonly command: PilotCommand
			readonly bare: boolean
	  }
	| {
			readonly ok: false
			readonly command?: PilotCommand
			readonly message: string
	  }

/** Derived from the generated contract record, so it cannot drift. */
const DECLARED_COMMAND_LIST = Object.keys(vaultGitReimaginedCommandContracts)
	.sort()
	.join(' and ')

function bindInvocation(argv: readonly string[]): PilotBinding {
	if (argv.length === 0) return { ok: true, command: 'status', bare: true }
	const [head, ...rest] = argv
	if (head === undefined || !isPilotCommand(head)) {
		return {
			ok: false,
			message: `Unknown command ${JSON.stringify(head ?? '')}; the declared commands are ${DECLARED_COMMAND_LIST}.`,
		}
	}
	for (const argument of rest) {
		if (argument !== '--json') {
			return {
				ok: false,
				command: head,
				message: `Unknown flag or operand ${JSON.stringify(argument)} for ${head}; the declared flag is --json.`,
			}
		}
	}
	return { ok: true, command: head, bare: false }
}

function isPilotCommand(value: string): value is PilotCommand {
	return value in vaultGitReimaginedCommandContracts
}

/**
 * Widens one generated contract literal to the facade type, so a
 * union-indexed access can feed the facade helpers without a cast.
 */
function contractFor(command: PilotCommand): CommandFacadeContract {
	return vaultGitReimaginedCommandContracts[command]
}

function runStatus(
	runId: string,
	stationId: 'status.no_argument' | 'status.success',
): PilotOutcome {
	if (!observeVaultWorkspace(process.cwd()).workspaceObservable) {
		return refusedOutcome(runId, 'status')
	}
	const projection = selectVaultGitReimaginedProjection(stationId)
	return {
		exitCode: 0,
		envelope: createCliRuntimeSuccessEnvelope({
			run_id: runId,
			data: createCommandResultData(vaultGitReimaginedCommandContracts.status, {
				state_projection: projection,
				workspace_observable: true,
			}),
		}),
	}
}

function runCommands(runId: string): PilotOutcome {
	if (!observeVaultWorkspace(process.cwd()).workspaceObservable) {
		return refusedOutcome(runId, 'commands')
	}
	const projection = selectVaultGitReimaginedProjection('commands.success')
	return {
		exitCode: 0,
		envelope: createCliRuntimeSuccessEnvelope({
			run_id: runId,
			data: createCommandResultData(
				vaultGitReimaginedCommandContracts.commands,
				{
					state_projection: projection,
					discovery: projectVaultGitReimaginedCommandDiscoveryTree(),
				},
			),
		}),
	}
}

function refusedOutcome(runId: string, command: PilotCommand): PilotOutcome {
	const projection = selectVaultGitReimaginedProjection(`${command}.refused`)
	return {
		exitCode: 1,
		envelope: createCliRuntimeErrorEnvelope({
			run_id: runId,
			data: createCommandResultData(contractFor(command), {
				state_projection: projection,
				workspace_observable: false,
			}),
			// The facade allows `retryable` true only under recoverability
			// retry: its `retryable` means "retry now, unchanged, may help",
			// which a refusal awaiting repair cannot claim. Exact Same-Input
			// Retry Safety is a different meaning and travels in the
			// projection.
			error: createCliRuntimeError({
				run_id: runId,
				code: 'projection_unavailable',
				message:
					'The workspace root carries no .git entry, so no State Projection is available.',
				exit_code: 1,
				recoverability: 'repair_state',
				retryable: false,
			}),
			process_exit_code: 1,
		}),
	}
}

function invalidUsageOutcome(
	runId: string,
	message: string,
	command?: PilotCommand,
): PilotOutcome {
	const error = createCliUsageRuntimeError({
		run_id: runId,
		code: 'invalid_usage',
		message,
		exit_code: 2,
	})
	if (command === undefined) {
		return {
			exitCode: 2,
			envelope: createCliRuntimeErrorEnvelope({
				run_id: runId,
				error,
				process_exit_code: 2,
			}),
		}
	}
	const projection = selectVaultGitReimaginedProjection(
		`${command}.invalid_usage`,
	)
	return {
		exitCode: 2,
		envelope: createCliRuntimeErrorEnvelope({
			run_id: runId,
			data: createCommandResultData(contractFor(command), {
				state_projection: projection,
			}),
			error,
			process_exit_code: 2,
		}),
	}
}

function main(argv: readonly string[]): number {
	const runId = `vault-git-reimagined-${crypto.randomUUID()}`
	const startedAt = performance.now()
	const emit = (outcome: PilotOutcome): number => {
		writeJsonEnvelope(process.stdout, outcome.envelope, {
			runId,
			durationMs: Math.round(performance.now() - startedAt),
		})
		return outcome.exitCode
	}

	try {
		const binding = bindInvocation(argv)
		if (!binding.ok) {
			return emit(invalidUsageOutcome(runId, binding.message, binding.command))
		}
		if (binding.command === 'commands') return emit(runCommands(runId))
		return emit(
			runStatus(runId, binding.bare ? 'status.no_argument' : 'status.success'),
		)
	} catch {
		return emit({
			exitCode: 1,
			envelope: createCliRuntimeErrorEnvelope({
				run_id: runId,
				error: createCliRuntimeError({
					run_id: runId,
					code: 'unexpected_failure',
					message: 'The pilot front door failed before producing a result.',
					exit_code: 1,
					recoverability: 'contact_support',
					retryable: false,
				}),
				process_exit_code: 1,
			}),
		})
	}
}

if (import.meta.main) {
	process.exit(main(Bun.argv.slice(2)))
}
