import { findBaselineExitCodeDrift } from "./baseline-exit-drift";
import { CLI_DIAGNOSTIC_FLAGS } from "./cli-diagnostics";
import {
	COMMAND_FACADE_AUDIENCES,
	COMMAND_FACADE_CAPABILITY_ROLES,
	COMMAND_FACADE_EXECUTION_MODES,
	COMMAND_FACADE_INTERACTIVITY,
	COMMAND_FACADE_OUTPUT_MODES,
	COMMAND_FACADE_SIDE_EFFECTS,
	type CommandFacadeContract,
	type CommandFacadeExecutionMode,
	type CommandFacadeMetadataDrift,
	type CommandFacadeSideEffect,
} from "./command-contract";
import { CliRuntimeContractError } from "./runtime-envelope";
import {
	ENV_VAR_NAME_PATTERN,
	matchSensitiveEnvVarName,
	validateProjectedFreeText,
} from "./runtime-text-safety";

/**
 * The escalating side effects that honestly declare write/destructive intent.
 * A write-implying mutation must declare at least one of these (see the
 * `command-mutation-sideeffect-mismatch` cross-check in
 * {@link findCommandFacadeMetadataDrift}). Members of
 * {@link COMMAND_FACADE_SIDE_EFFECTS}, named here so the cross-check tracks the
 * vocabulary instead of restating bare string literals.
 */
const WRITE_ESCALATING_SIDE_EFFECTS = [
	"write",
	"destructive",
] as const satisfies readonly CommandFacadeSideEffect[];

/**
 * The execution modes that satisfy Write Preview Capability (KTD7): a write or
 * destructive command proves it can preview its effect by declaring `check` or
 * `dry_run`. `normal` is the do-it-for-real path and does not count as preview.
 * Members of {@link COMMAND_FACADE_EXECUTION_MODES}, named here so the
 * write-preview cross-check tracks the vocabulary instead of bare literals.
 */
const PREVIEW_EXECUTION_MODES = [
	"check",
	"dry_run",
] as const satisfies readonly CommandFacadeExecutionMode[];

const RESERVED_CLI_DIAGNOSTIC_FLAGS = new Set<string>(CLI_DIAGNOSTIC_FLAGS);

/**
 * Shape shared by every command contract regardless of its command, audience,
 * or mutation literal union. Every per-check helper below reads only fields
 * that are already concrete at this shape, so none of them need the outer
 * `TCommand`/`TContract` generics of {@link findCommandFacadeMetadataDrift}.
 */
type AnyCommandFacadeContract = CommandFacadeContract<string, string, string>;

type MetadataDriftContext = {
	path: string;
	allowedAudiences: ReadonlySet<string>;
	allowedSideEffects: ReadonlySet<string>;
	allowedExecutionModes: ReadonlySet<string>;
	allowedOutputModes: ReadonlySet<string>;
	allowedCapabilityRoles: ReadonlySet<string>;
	allowedInteractivity: ReadonlySet<string>;
	writeImplyingMutations: ReadonlySet<string> | undefined;
};

function buildMetadataDriftContext(
	options: CommandFacadeContractValidationOptions,
): MetadataDriftContext {
	return {
		path: options.path ?? "command-contract",
		allowedAudiences:
			options.allowedAudiences ?? new Set<string>(COMMAND_FACADE_AUDIENCES),
		allowedSideEffects: new Set<string>(COMMAND_FACADE_SIDE_EFFECTS),
		allowedExecutionModes: new Set<string>(COMMAND_FACADE_EXECUTION_MODES),
		allowedOutputModes: new Set<string>(COMMAND_FACADE_OUTPUT_MODES),
		allowedCapabilityRoles: new Set<string>(COMMAND_FACADE_CAPABILITY_ROLES),
		allowedInteractivity: new Set<string>(COMMAND_FACADE_INTERACTIVITY),
		writeImplyingMutations: options.writeImplyingMutations,
	};
}

function findSummaryTextDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const issue of validateProjectedFreeText(
		`${command}.summary`,
		contract.summary,
	)) {
		drift.push({
			category: "command-summary-unsafe-text",
			path,
			action: `Remove unsafe content from ${command} summary (${issue}).`,
		});
	}
	return drift;
}

function findUsageTextDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const [index, usageLine] of contract.usage.entries()) {
		for (const issue of validateProjectedFreeText(
			`${command}.usage[${index}]`,
			usageLine,
		)) {
			drift.push({
				category: "command-usage-unsafe-text",
				path,
				action: `Remove unsafe content from ${command} usage[${index}] (${issue}).`,
			});
		}
	}
	return drift;
}

function findAudienceDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
	allowedAudiences: ReadonlySet<string>,
): CommandFacadeMetadataDrift[] {
	if (!contract.audience) {
		return [
			{
				category: "command-audience-missing",
				path,
				action: `Assign an audience for command ${command}.`,
			},
		];
	}
	if (!allowedAudiences.has(contract.audience)) {
		return [
			{
				category: "command-audience-invalid",
				path,
				action: `Audience for command ${command} must be one of ${[...allowedAudiences].join(", ")}.`,
			},
		];
	}
	return [];
}

function findSideEffectsDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
	allowedSideEffects: ReadonlySet<string>,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const sideEffect of contract.sideEffects ?? []) {
		if (!allowedSideEffects.has(sideEffect)) {
			drift.push({
				category: "command-side-effect-invalid",
				path,
				action: `Side effect for command ${command} must be one of ${[...allowedSideEffects].join(", ")}.`,
			});
		}
	}
	return drift;
}

function findMutationSideEffectMismatchDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
	writeImplyingMutations: ReadonlySet<string> | undefined,
): CommandFacadeMetadataDrift[] {
	if (!writeImplyingMutations?.has(contract.mutation)) {
		return [];
	}
	const declaredSideEffects = contract.sideEffects ?? [];
	const declaresEscalatingSideEffect = WRITE_ESCALATING_SIDE_EFFECTS.some(
		(sideEffect) => declaredSideEffects.includes(sideEffect),
	);
	if (declaresEscalatingSideEffect) {
		return [];
	}
	return [
		{
			category: "command-mutation-sideeffect-mismatch",
			path,
			action: `Declare sideEffects including 'write' or 'destructive' for command ${command} (its mutation '${contract.mutation}' implies write/destructive intent).`,
		},
	];
}

/**
 * Write Preview Capability (U5, KTD7): any command honestly declaring a
 * write/destructive side effect must offer a `check`/`dry_run` preview path,
 * or declare a narrow package-owned preview exemption. Keyed on the declared
 * side effect, not the opt-in writeImplyingMutations set, so it is always-on
 * for honestly-declared mutating commands. The exemption `reason` is free
 * text and is safe-text scanned whether or not a preview mode is also
 * present.
 *
 * A reason only exempts if it is non-empty AND safe to project: a blank
 * reason (`previewExemption: { reason: "" }`) or one that is only
 * control/bidi/ANSI characters is semantically empty and must not silently
 * escape the missing-preview requirement. The projected-text scan rejects
 * both, so it is the single source of truth for whether the exemption
 * counts. It is computed once and reused for both the missing-preview check
 * and the unsafe-text drift below rather than scanning twice.
 */
function findWritePreviewDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
): CommandFacadeMetadataDrift[] {
	const declaresWriteSideEffect = WRITE_ESCALATING_SIDE_EFFECTS.some(
		(sideEffect) => (contract.sideEffects ?? []).includes(sideEffect),
	);
	const declaresPreviewMode = PREVIEW_EXECUTION_MODES.some((mode) =>
		(contract.executionModes ?? []).includes(mode),
	);
	const exemptionReasonIssues =
		contract.previewExemption === undefined
			? []
			: validateProjectedFreeText(
					`${command}.previewExemption.reason`,
					contract.previewExemption.reason,
				);
	const hasValidExemption =
		typeof contract.previewExemption?.reason === "string" &&
		contract.previewExemption.reason.trim().length > 0 &&
		exemptionReasonIssues.length === 0;

	const drift: CommandFacadeMetadataDrift[] = [];
	if (declaresWriteSideEffect && !declaresPreviewMode && !hasValidExemption) {
		drift.push({
			category: "command-write-preview-missing",
			path,
			action: `Declare a 'check' or 'dry_run' execution mode for command ${command}, or a non-empty, safe-text package-owned previewExemption reason (it declares a write/destructive side effect).`,
		});
	}
	for (const issue of exemptionReasonIssues) {
		drift.push({
			category: "command-write-preview-exemption-unsafe-text",
			path,
			action: `Remove unsafe content from ${command} previewExemption reason (${issue}).`,
		});
	}
	return drift;
}

function findExecutionModesDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
	allowedExecutionModes: ReadonlySet<string>,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const executionMode of contract.executionModes ?? []) {
		if (!allowedExecutionModes.has(executionMode)) {
			drift.push({
				category: "command-execution-mode-invalid",
				path,
				action: `Execution mode for command ${command} must be one of ${[...allowedExecutionModes].join(", ")}.`,
			});
		}
	}
	return drift;
}

function findOutputModesDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
	allowedOutputModes: ReadonlySet<string>,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const outputMode of contract.outputModes ?? []) {
		if (!allowedOutputModes.has(outputMode)) {
			drift.push({
				category: "command-output-mode-invalid",
				path,
				action: `Output mode for command ${command} must be one of ${[...allowedOutputModes].join(", ")}.`,
			});
		}
	}
	return drift;
}

function findCapabilityRolesDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
	allowedCapabilityRoles: ReadonlySet<string>,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const capabilityRole of contract.capabilityRoles ?? []) {
		if (!allowedCapabilityRoles.has(capabilityRole)) {
			drift.push({
				category: "command-capability-role-invalid",
				path,
				action: `Capability role for command ${command} must be one of ${[...allowedCapabilityRoles].join(", ")}.`,
			});
		}
	}
	return drift;
}

function findInteractivityDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
	allowedInteractivity: ReadonlySet<string>,
): CommandFacadeMetadataDrift[] {
	if (
		contract.interactivity !== undefined &&
		!allowedInteractivity.has(contract.interactivity)
	) {
		return [
			{
				category: "command-interactivity-invalid",
				path,
				action: `Interactivity for command ${command} must be one of ${[...allowedInteractivity].join(", ")}.`,
			},
		];
	}
	return [];
}

function findEnvVarsDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const envVar of contract.envVars ?? []) {
		if (!ENV_VAR_NAME_PATTERN.test(envVar.name)) {
			drift.push({
				category: "command-env-var-name-invalid",
				path,
				action: `Environment variable name ${JSON.stringify(envVar.name)} for command ${command} must match ^[A-Z_][A-Z0-9_]*$.`,
			});
			continue;
		}
		if (matchSensitiveEnvVarName(envVar.name)) {
			drift.push({
				category: "command-env-var-name-sensitive",
				path,
				action: `Environment variable name ${envVar.name} for command ${command} implies a secret and must not be declared (it would leak into agent-facing discovery).`,
			});
		}
		if (envVar.description !== undefined) {
			for (const issue of validateProjectedFreeText(
				`${command}.envVars.${envVar.name}.description`,
				envVar.description,
			)) {
				drift.push({
					category: "command-env-var-description-unsafe-text",
					path,
					action: `Remove unsafe content from ${command} env-var ${envVar.name} description (${issue}).`,
				});
			}
		}
	}
	return drift;
}

function findFlagsDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
): CommandFacadeMetadataDrift[] {
	if (contract.flags == null) {
		return [
			{
				category: "command-flags-missing",
				path,
				action: `Declare a flags record for command ${command} (use {} for none).`,
			},
		];
	}
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const [flag, metadata] of Object.entries(contract.flags)) {
		if (RESERVED_CLI_DIAGNOSTIC_FLAGS.has(flag)) {
			drift.push({
				category: "command-reserved-diagnostic-flag",
				path,
				action: `Rename ${command} flag ${flag}; ${flag} is reserved for facade-owned CLI diagnostics.`,
			});
		}
		if (!flag.startsWith("--")) {
			drift.push({
				category: "command-flag-name-invalid",
				path,
				action: `Rename ${command} flag ${flag} so it starts with --.`,
			});
		}
		if (metadata.type === "enum" && metadata.values.length === 0) {
			drift.push({
				category: "command-enum-flag-values-missing",
				path,
				action: `Add enum values for ${command} ${flag}.`,
			});
		}
		if (metadata.description !== undefined) {
			for (const issue of validateProjectedFreeText(
				`${command}.flags.${flag}.description`,
				metadata.description,
			)) {
				drift.push({
					category: "command-flag-description-unsafe-text",
					path,
					action: `Remove unsafe content from ${command} flag ${flag} description (${issue}).`,
				});
			}
		}
	}
	return drift;
}

function findExitCodesDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
): CommandFacadeMetadataDrift[] {
	if (contract.exitCodes == null) {
		return [
			{
				category: "command-exit-codes-missing",
				path,
				action: `Declare an exitCodes record for command ${command}.`,
			},
		];
	}
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const [code, message] of Object.entries(contract.exitCodes)) {
		if (!/^\d+$/.test(code)) {
			drift.push({
				category: "command-exit-code-invalid",
				path,
				action: `Rename ${command} exit code ${code} to a numeric string.`,
			});
		}
		for (const issue of validateProjectedFreeText(
			`${command}.exitCodes.${code}`,
			message,
		)) {
			drift.push({
				category: "command-exit-code-unsafe-text",
				path,
				action: `Remove unsafe content from ${command} exitCodes.${code} (${issue}).`,
			});
		}
	}
	drift.push(
		...findBaselineExitCodeDrift({
			command,
			path,
			exitCodes: contract.exitCodes,
			discovery: false,
		}),
	);
	return drift;
}

function findAliasDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	contracts: Readonly<Record<string, AnyCommandFacadeContract>>,
	path: string,
): CommandFacadeMetadataDrift[] {
	if (!contract.alias) {
		return [];
	}
	const drift: CommandFacadeMetadataDrift[] = [];
	const target = contracts[contract.alias.command];
	if (!target) {
		drift.push({
			category: "command-alias-target-missing",
			path,
			action: `Point alias command ${command} at an existing command.`,
		});
	}
	if (contract.alias.defaultArgs.length === 0) {
		drift.push({
			category: "command-alias-default-args-missing",
			path,
			action: `Declare default arguments for alias command ${command}.`,
		});
	}
	for (const arg of contract.alias.defaultArgs) {
		if (arg.startsWith("--") && target && !target.flags[arg]) {
			drift.push({
				category: "command-alias-default-arg-unknown",
				path,
				action: `Declare ${arg} on alias target ${contract.alias.command} or remove it from ${command}.`,
			});
		}
	}
	return drift;
}

function findActionAffordancesDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
): CommandFacadeMetadataDrift[] {
	if (!contract.actionAffordances) {
		return [];
	}
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const [group, actions] of Object.entries(contract.actionAffordances)) {
		for (const [index, action] of actions.entries()) {
			for (const issue of validateProjectedFreeText(
				`${command}.actionAffordances.${group}[${index}].summary`,
				action.summary,
			)) {
				drift.push({
					category: "command-action-summary-unsafe-text",
					path,
					action: `Remove unsafe content from ${command} action affordance ${group}[${index}] summary (${issue}).`,
				});
			}
		}
	}
	return drift;
}

function findResultContractDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	path: string,
): CommandFacadeMetadataDrift[] {
	if (!contract.resultContract) {
		return [];
	}
	const drift: CommandFacadeMetadataDrift[] = [];
	if (contract.resultContract.kind !== undefined) {
		for (const issue of validateProjectedFreeText(
			`${command}.resultContract.kind`,
			contract.resultContract.kind,
		)) {
			drift.push({
				category: "command-result-contract-kind-unsafe-text",
				path,
				action: `Remove unsafe content from ${command} resultContract.kind (${issue}).`,
			});
		}
	}
	if (
		contract.resultContract.schema_version !== undefined &&
		typeof contract.resultContract.schema_version !== "number"
	) {
		for (const issue of validateProjectedFreeText(
			`${command}.resultContract.schema_version`,
			contract.resultContract.schema_version,
		)) {
			drift.push({
				category: "command-result-contract-schema-version-unsafe-text",
				path,
				action: `Remove unsafe content from ${command} resultContract.schema_version (${issue}).`,
			});
		}
	}
	return drift;
}

/**
 * Runs every per-command check in the canonical order pinned by the facade's
 * tests: summary -> usage -> audience -> side_effect -> mutation_mismatch ->
 * write_preview -> execution_mode -> output_mode -> capability_role ->
 * interactivity -> env_var -> flags -> exit_code -> alias -> action_affordance
 * -> result_contract.
 */
function collectCommandMetadataDrift(
	command: string,
	contract: AnyCommandFacadeContract,
	contracts: Readonly<Record<string, AnyCommandFacadeContract>>,
	context: MetadataDriftContext,
): CommandFacadeMetadataDrift[] {
	return [
		...findSummaryTextDrift(command, contract, context.path),
		...findUsageTextDrift(command, contract, context.path),
		...findAudienceDrift(
			command,
			contract,
			context.path,
			context.allowedAudiences,
		),
		...findSideEffectsDrift(
			command,
			contract,
			context.path,
			context.allowedSideEffects,
		),
		...findMutationSideEffectMismatchDrift(
			command,
			contract,
			context.path,
			context.writeImplyingMutations,
		),
		...findWritePreviewDrift(command, contract, context.path),
		...findExecutionModesDrift(
			command,
			contract,
			context.path,
			context.allowedExecutionModes,
		),
		...findOutputModesDrift(
			command,
			contract,
			context.path,
			context.allowedOutputModes,
		),
		...findCapabilityRolesDrift(
			command,
			contract,
			context.path,
			context.allowedCapabilityRoles,
		),
		...findInteractivityDrift(
			command,
			contract,
			context.path,
			context.allowedInteractivity,
		),
		...findEnvVarsDrift(command, contract, context.path),
		...findFlagsDrift(command, contract, context.path),
		...findExitCodesDrift(command, contract, context.path),
		...findAliasDrift(command, contract, contracts, context.path),
		...findActionAffordancesDrift(command, contract, context.path),
		...findResultContractDrift(command, contract, context.path),
	];
}

function throwIfRuntimeContractIssues(issues: readonly string[]): void {
	if (issues.length > 0) {
		throw new CliRuntimeContractError(issues);
	}
}

export function findCommandFacadeMetadataDrift<
	TCommand extends string,
	TContract extends CommandFacadeContract<string, string, string>,
>(
	contracts: Record<TCommand, TContract>,
	options: CommandFacadeContractValidationOptions = {},
): CommandFacadeMetadataDrift[] {
	const context = buildMetadataDriftContext(options);
	const anyContracts = contracts as Readonly<
		Record<string, AnyCommandFacadeContract>
	>;
	return Object.entries<TContract>(contracts).flatMap(([command, contract]) =>
		collectCommandMetadataDrift(command, contract, anyContracts, context),
	);
}

export type CommandFacadeContractValidationOptions = {
	allowedAudiences?: ReadonlySet<string>;
	writeImplyingMutations?: ReadonlySet<string>;
	path?: string;
};

export type ParseCommandFacadeContractResult<
	TCommand extends string,
	TContract extends CommandFacadeContract<string, string, string>,
> =
	| { ok: true; contracts: Record<TCommand, TContract> }
	| { ok: false; issues: CommandFacadeMetadataDrift[] };

/**
 * Validate a record of command facade contracts without throwing.
 *
 * Reuses {@link findCommandFacadeMetadataDrift} as its validation core: on no
 * drift it returns `{ ok: true, contracts }` (the record echoed back); on drift
 * it returns `{ ok: false, issues }` carrying the structured drift so an
 * autonomous caller can branch on `category` and apply `action`.
 */
export function parseCommandFacadeContract<
	TCommand extends string,
	TContract extends CommandFacadeContract<string, string, string>,
>(
	contracts: Record<TCommand, TContract>,
	options: CommandFacadeContractValidationOptions = {},
): ParseCommandFacadeContractResult<TCommand, TContract> {
	const issues = findCommandFacadeMetadataDrift(contracts, options);
	if (issues.length === 0) {
		return { ok: true, contracts };
	}
	return { ok: false, issues };
}

/**
 * Validate a record of command facade contracts, throwing on drift.
 *
 * Collapses write-and-check into one construction step: on success it returns
 * the validated record unchanged; on drift it stringifies the structured drift
 * and routes it through the existing {@link throwIfRuntimeContractIssues}
 * plumbing, throwing {@link CliRuntimeContractError} (whose `issues` is a
 * `readonly string[]`). No new error class or throw path is introduced.
 */
export function defineCommandFacadeContract<
	TCommand extends string,
	TContract extends CommandFacadeContract<string, string, string>,
>(
	contracts: Record<TCommand, TContract>,
	options: CommandFacadeContractValidationOptions = {},
): Record<TCommand, TContract> {
	const result = parseCommandFacadeContract(contracts, options);
	if (!result.ok) {
		throwIfRuntimeContractIssues(
			result.issues.map((drift) => `${drift.category}: ${drift.action}`),
		);
	}
	return contracts;
}
