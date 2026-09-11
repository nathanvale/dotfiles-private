import { findBaselineExitCodeDrift } from "./baseline-exit-drift";
import {
	COMMAND_FACADE_CAPABILITY_ROLES,
	COMMAND_FACADE_EXECUTION_MODES,
	COMMAND_FACADE_INTERACTIVITY,
	COMMAND_FACADE_OUTPUT_MODES,
	COMMAND_FACADE_SIDE_EFFECTS,
	type CommandDiscoveryActionAffordance,
	type CommandDiscoveryActionAffordances,
	type CommandDiscoveryAugment,
	type CommandDiscoveryCommand,
	type CommandDiscoveryFlag,
	type CommandDiscoveryResultContract,
	type CommandDiscoveryTree,
	type CommandFacadeActionAffordances,
	type CommandFacadeContract,
	type CommandFacadeFlag,
	type CommandFacadeMetadataDrift,
	type CommandFacadeResultContract,
	type ProjectCommandDiscoveryTreeOptions,
} from "./command-contract";
import {
	ENV_VAR_NAME_PATTERN,
	matchSensitiveEnvVarName,
	validateProjectedFreeText,
} from "./runtime-text-safety";

const COMMAND_DISCOVERY_CORE_KEYS = new Set<string>([
	"script",
	"summary",
	"json",
	"mutation",
	"audience",
	"side_effects",
	"execution_modes",
	"output_modes",
	"capability_roles",
	"interactivity",
	"env_vars",
	"result_contract",
	"action_affordances",
	"usage",
	"flags",
	"exit_codes",
	"alias_of",
	"default_args",
	"unified_route",
	"canonical_usage",
]);

export function projectCommandDiscoveryFlag(
	flag: CommandFacadeFlag,
	options: { includeDescription?: boolean } = {},
): CommandDiscoveryFlag {
	const description =
		(options.includeDescription ?? true) ? flag.description : undefined;
	if (flag.type === "boolean") {
		return {
			type: "boolean",
			...(description ? { description } : {}),
		};
	}
	if (flag.type === "enum") {
		return {
			type: "enum",
			values: [...flag.values],
			...(flag.required ? { required: true } : {}),
			...(description ? { description } : {}),
		};
	}
	return {
		type: flag.type,
		...(flag.required ? { required: true } : {}),
		...(description ? { description } : {}),
	};
}

export function projectCommandDiscoveryResultContract(
	resultContract: CommandFacadeResultContract,
): CommandDiscoveryResultContract {
	return { ...resultContract };
}

export function projectCommandDiscoveryActionAffordances(
	actionAffordances: CommandFacadeActionAffordances,
): CommandDiscoveryActionAffordances {
	return Object.fromEntries(
		Object.entries(actionAffordances).map(([group, actions]) => [
			group,
			actions.map((action) => ({
				id: action.id,
				summary: action.summary,
				side_effects: [...action.sideEffects],
			})),
		]),
	);
}

export function projectCommandDiscoveryTree<
	TCommand extends string,
	TContract extends CommandFacadeContract<string, string, string>,
	TExtra extends CommandDiscoveryAugment = Record<never, never>,
>(
	contracts: readonly (readonly [TCommand, TContract])[],
	options: ProjectCommandDiscoveryTreeOptions<TCommand, TContract, TExtra> = {},
): CommandDiscoveryTree<
	TCommand,
	CommandDiscoveryCommand<TContract["audience"], TContract["mutation"]> & TExtra
> {
	const commands = Object.fromEntries(
		contracts
			.filter(
				([command, contract]) => options.include?.(command, contract) ?? true,
			)
			.map(([command, contract]) => {
				const alias = contract.alias
					? {
							alias_of: contract.alias.command,
							default_args: [...contract.alias.defaultArgs],
						}
					: {};
				const route = options.routesByCommand?.get(command);
				const canonicalUsage = options.canonicalUsageByCommand?.get(command);
				const augment = projectCommandDiscoveryAugment(
					command,
					options.augment?.(command, contract),
				);
				return [
					command,
					{
						script: contract.script,
						summary: contract.summary,
						json: contract.json,
						mutation: contract.mutation,
						audience: contract.audience,
						...(contract.sideEffects
							? { side_effects: [...contract.sideEffects] }
							: {}),
						...(contract.executionModes
							? { execution_modes: [...contract.executionModes] }
							: {}),
						...(contract.outputModes
							? { output_modes: [...contract.outputModes] }
							: {}),
						...(contract.capabilityRoles
							? { capability_roles: [...contract.capabilityRoles] }
							: {}),
						...(contract.interactivity
							? { interactivity: contract.interactivity }
							: {}),
						...(contract.envVars
							? {
									env_vars: contract.envVars.map((envVar) => ({
										name: envVar.name,
										...(envVar.required ? { required: true } : {}),
										...(envVar.secret ? { secret: true } : {}),
										...(envVar.description
											? { description: envVar.description }
											: {}),
									})),
								}
							: {}),
						...(contract.resultContract
							? {
									result_contract: projectCommandDiscoveryResultContract(
										contract.resultContract,
									),
								}
							: {}),
						...(contract.actionAffordances
							? {
									action_affordances: projectCommandDiscoveryActionAffordances(
										contract.actionAffordances,
									),
								}
							: {}),
						usage: [...contract.usage],
						flags: Object.fromEntries(
							Object.entries(contract.flags).map(([flag, metadata]) => [
								flag,
								projectCommandDiscoveryFlag(metadata, {
									...(options.includeFlagDescriptions !== undefined
										? {
												includeDescription:
													options.includeFlagDescriptions,
											}
										: {}),
								}),
							]),
						),
						exit_codes: { ...contract.exitCodes },
						...alias,
						...(route
							? {
									unified_route: {
										...route,
										route: [...route.route],
									},
								}
							: {}),
						...(canonicalUsage ? { canonical_usage: [...canonicalUsage] } : {}),
						...augment,
					},
				];
			}),
	) as Partial<
		Record<
			TCommand,
			CommandDiscoveryCommand<TContract["audience"], TContract["mutation"]> &
				TExtra
		>
	>;

	return { commands };
}

function projectCommandDiscoveryAugment<TExtra extends CommandDiscoveryAugment>(
	command: string,
	augment: TExtra | undefined,
): TExtra | Record<never, never> {
	if (!augment) return {};
	for (const key of Object.keys(augment)) {
		if (COMMAND_DISCOVERY_CORE_KEYS.has(key)) {
			throw new Error(
				`Command discovery augment for ${command} cannot override core field ${key}.`,
			);
		}
	}
	return augment;
}

type DiscoveryDriftContext = {
	path: string;
	allowedSideEffects: ReadonlySet<string>;
	allowedExecutionModes: ReadonlySet<string>;
	allowedOutputModes: ReadonlySet<string>;
	allowedCapabilityRoles: ReadonlySet<string>;
	allowedInteractivity: ReadonlySet<string>;
};

function buildDiscoveryDriftContext(path: string): DiscoveryDriftContext {
	return {
		path,
		allowedSideEffects: new Set<string>(COMMAND_FACADE_SIDE_EFFECTS),
		allowedExecutionModes: new Set<string>(COMMAND_FACADE_EXECUTION_MODES),
		allowedOutputModes: new Set<string>(COMMAND_FACADE_OUTPUT_MODES),
		allowedCapabilityRoles: new Set<string>(COMMAND_FACADE_CAPABILITY_ROLES),
		allowedInteractivity: new Set<string>(COMMAND_FACADE_INTERACTIVITY),
	};
}

function findDiscoverySummaryDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	path: string,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const issue of validateProjectedFreeText(
		`${command}.summary`,
		entry.summary,
	)) {
		drift.push({
			category: "command-discovery-summary-unsafe-text",
			path,
			action: `Remove unsafe content from ${command} summary (${issue}).`,
		});
	}
	return drift;
}

function findDiscoveryUsageDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	path: string,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const [index, usageLine] of entry.usage.entries()) {
		for (const issue of validateProjectedFreeText(
			`${command}.usage[${index}]`,
			usageLine,
		)) {
			drift.push({
				category: "command-discovery-usage-unsafe-text",
				path,
				action: `Remove unsafe content from ${command} usage[${index}] (${issue}).`,
			});
		}
	}
	return drift;
}

function findDiscoverySideEffectsDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	path: string,
	allowedSideEffects: ReadonlySet<string>,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const sideEffect of entry.side_effects ?? []) {
		if (!allowedSideEffects.has(sideEffect)) {
			drift.push({
				category: "command-discovery-side-effect-invalid",
				path,
				action: `Use a known side effect for ${command}: ${[...allowedSideEffects].join(", ")}.`,
			});
		}
	}
	return drift;
}

function findDiscoveryExecutionModesDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	path: string,
	allowedExecutionModes: ReadonlySet<string>,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const executionMode of entry.execution_modes ?? []) {
		if (!allowedExecutionModes.has(executionMode)) {
			drift.push({
				category: "command-discovery-execution-mode-invalid",
				path,
				action: `Use a known execution mode for ${command}: ${[...allowedExecutionModes].join(", ")}.`,
			});
		}
	}
	return drift;
}

function findDiscoveryOutputModesDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	path: string,
	allowedOutputModes: ReadonlySet<string>,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const outputMode of entry.output_modes ?? []) {
		if (!allowedOutputModes.has(outputMode)) {
			drift.push({
				category: "command-discovery-output-mode-invalid",
				path,
				action: `Use a known output mode for ${command}: ${[...allowedOutputModes].join(", ")}.`,
			});
		}
	}
	return drift;
}

function findDiscoveryCapabilityRolesDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	path: string,
	allowedCapabilityRoles: ReadonlySet<string>,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const capabilityRole of entry.capability_roles ?? []) {
		if (!allowedCapabilityRoles.has(capabilityRole)) {
			drift.push({
				category: "command-discovery-capability-role-invalid",
				path,
				action: `Use a known capability role for ${command}: ${[...allowedCapabilityRoles].join(", ")}.`,
			});
		}
	}
	return drift;
}

function findDiscoveryInteractivityDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	path: string,
	allowedInteractivity: ReadonlySet<string>,
): CommandFacadeMetadataDrift[] {
	if (
		entry.interactivity !== undefined &&
		!allowedInteractivity.has(entry.interactivity)
	) {
		return [
			{
				category: "command-discovery-interactivity-invalid",
				path,
				action: `Use a known interactivity for ${command}: ${[...allowedInteractivity].join(", ")}.`,
			},
		];
	}
	return [];
}

function findDiscoveryEnvVarsDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	path: string,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const envVar of entry.env_vars ?? []) {
		if (!ENV_VAR_NAME_PATTERN.test(envVar.name)) {
			drift.push({
				category: "command-discovery-env-var-name-invalid",
				path,
				action: `Environment variable name ${JSON.stringify(envVar.name)} for command ${command} must match ^[A-Z_][A-Z0-9_]*$.`,
			});
			continue;
		}
		if (matchSensitiveEnvVarName(envVar.name)) {
			drift.push({
				category: "command-discovery-env-var-name-sensitive",
				path,
				action: `Environment variable name ${envVar.name} for command ${command} implies a secret and must not be declared (it would leak into agent-facing discovery).`,
			});
		}
		if (envVar.description !== undefined) {
			for (const issue of validateProjectedFreeText(
				`${command}.env_vars.${envVar.name}.description`,
				envVar.description,
			)) {
				drift.push({
					category: "command-discovery-env-var-description-unsafe-text",
					path,
					action: `Remove unsafe content from ${command} env-var ${envVar.name} description (${issue}).`,
				});
			}
		}
	}
	return drift;
}

function findDiscoveryFlagsDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	path: string,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const [flag, metadata] of Object.entries(entry.flags)) {
		if (!flag.startsWith("--")) {
			drift.push({
				category: "command-discovery-flag-name-invalid",
				path,
				action: `Rename ${command} flag ${flag} so it starts with --.`,
			});
		}
		if (metadata.type === "enum" && metadata.values.length === 0) {
			drift.push({
				category: "command-discovery-enum-flag-values-missing",
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
					category: "command-discovery-flag-description-unsafe-text",
					path,
					action: `Remove unsafe content from ${command} flag ${flag} description (${issue}).`,
				});
			}
		}
	}
	return drift;
}

function findDiscoveryExitCodesDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	path: string,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const [code, message] of Object.entries(entry.exit_codes)) {
		if (!/^\d+$/.test(code)) {
			drift.push({
				category: "command-discovery-exit-code-invalid",
				path,
				action: `Rename ${command} exit code ${code} to a numeric string.`,
			});
		}
		for (const issue of validateProjectedFreeText(
			`${command}.exit_codes.${code}`,
			message,
		)) {
			drift.push({
				category: "command-discovery-exit-code-unsafe-text",
				path,
				action: `Remove unsafe content from ${command} exit_codes.${code} (${issue}).`,
			});
		}
	}
	drift.push(
		...findBaselineExitCodeDrift({
			command,
			path,
			exitCodes: entry.exit_codes,
			discovery: true,
		}),
	);
	return drift;
}

function findDiscoveryAliasDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	tree: CommandDiscoveryTree<string, CommandDiscoveryCommand>,
	path: string,
): CommandFacadeMetadataDrift[] {
	if (entry.alias_of && !tree.commands[entry.alias_of]) {
		return [
			{
				category: "command-discovery-alias-target-missing",
				path,
				action: `Point alias command ${command} at a command in the discovery tree, or exclude the alias from this projection.`,
			},
		];
	}
	return [];
}

function findDiscoveryRouteDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	path: string,
	routeOwners: Map<string, string>,
): CommandFacadeMetadataDrift[] {
	if (!entry.unified_route) return [];
	const existing = routeOwners.get(entry.unified_route.canonical);
	if (existing) {
		return [
			{
				category: "command-discovery-route-duplicate",
				path,
				action: `Route ${entry.unified_route.canonical} is projected by both ${existing} and ${command}.`,
			},
		];
	}
	routeOwners.set(entry.unified_route.canonical, command);
	return [];
}

/**
 * Runs every per-command discovery check in the canonical order pinned by the
 * facade's tests: summary -> usage -> side_effect -> execution_mode ->
 * output_mode -> capability_role -> interactivity -> env_var -> flags ->
 * exit_code -> alias_of -> result_contract/action_affordances -> unified_route.
 */
function collectCommandDiscoveryDrift(
	command: string,
	entry: CommandDiscoveryCommand,
	tree: CommandDiscoveryTree<string, CommandDiscoveryCommand>,
	context: DiscoveryDriftContext,
	routeOwners: Map<string, string>,
): CommandFacadeMetadataDrift[] {
	return [
		...findDiscoverySummaryDrift(command, entry, context.path),
		...findDiscoveryUsageDrift(command, entry, context.path),
		...findDiscoverySideEffectsDrift(
			command,
			entry,
			context.path,
			context.allowedSideEffects,
		),
		...findDiscoveryExecutionModesDrift(
			command,
			entry,
			context.path,
			context.allowedExecutionModes,
		),
		...findDiscoveryOutputModesDrift(
			command,
			entry,
			context.path,
			context.allowedOutputModes,
		),
		...findDiscoveryCapabilityRolesDrift(
			command,
			entry,
			context.path,
			context.allowedCapabilityRoles,
		),
		...findDiscoveryInteractivityDrift(
			command,
			entry,
			context.path,
			context.allowedInteractivity,
		),
		...findDiscoveryEnvVarsDrift(command, entry, context.path),
		...findDiscoveryFlagsDrift(command, entry, context.path),
		...findDiscoveryExitCodesDrift(command, entry, context.path),
		...findDiscoveryAliasDrift(command, entry, tree, context.path),
		...findCommandDiscoveryResultContractDrift({
			command,
			path: context.path,
			resultContract: entry.result_contract,
			actionAffordances: entry.action_affordances,
			allowedSideEffects: context.allowedSideEffects,
		}),
		...findDiscoveryRouteDrift(command, entry, context.path, routeOwners),
	];
}

export function findCommandDiscoveryTreeDrift(
	tree: CommandDiscoveryTree<string, CommandDiscoveryCommand>,
	options: { path?: string } = {},
): CommandFacadeMetadataDrift[] {
	const context = buildDiscoveryDriftContext(
		options.path ?? "command-discovery-tree",
	);
	const routeOwners = new Map<string, string>();
	return Object.entries(tree.commands).flatMap(([command, entry]) =>
		entry
			? collectCommandDiscoveryDrift(command, entry, tree, context, routeOwners)
			: [],
	);
}

function findDiscoveryResultContractShapeDrift(
	command: string,
	path: string,
	resultContract: CommandDiscoveryCommand["result_contract"],
): CommandFacadeMetadataDrift[] {
	if (!resultContract) return [];
	const drift: CommandFacadeMetadataDrift[] = [];
	if (
		typeof resultContract.id !== "string" ||
		resultContract.id.trim().length === 0
	) {
		drift.push({
			category: "command-discovery-result-contract-id-invalid",
			path,
			action: `Give ${command} result_contract.id a non-empty string value.`,
		});
	}
	if (resultContract.kind !== undefined) {
		for (const issue of validateProjectedFreeText(
			`${command}.result_contract.kind`,
			resultContract.kind,
		)) {
			drift.push({
				category: "command-discovery-result-contract-kind-unsafe-text",
				path,
				action: `Remove unsafe content from ${command} result_contract.kind (${issue}).`,
			});
		}
	}
	if (
		resultContract.schema_version !== undefined &&
		typeof resultContract.schema_version !== "number"
	) {
		for (const issue of validateProjectedFreeText(
			`${command}.result_contract.schema_version`,
			resultContract.schema_version,
		)) {
			drift.push({
				category:
					"command-discovery-result-contract-schema-version-unsafe-text",
				path,
				action: `Remove unsafe content from ${command} result_contract.schema_version (${issue}).`,
			});
		}
	}
	return drift;
}

function findDiscoveryActionIdDrift(
	command: string,
	path: string,
	group: string,
	action: CommandDiscoveryActionAffordance & Record<string, unknown>,
	actionOwners: Map<string, string>,
): CommandFacadeMetadataDrift[] {
	if (typeof action.id !== "string" || action.id.trim().length === 0) {
		return [
			{
				category: "command-discovery-action-id-invalid",
				path,
				action: `Give every ${command} action affordance in group ${group} a non-empty id.`,
			},
		];
	}
	const existingGroup = actionOwners.get(action.id);
	if (existingGroup) {
		return [
			{
				category: "command-discovery-action-id-duplicate",
				path,
				action: `Use unique action affordance ids for ${command}; ${action.id} appears in both ${existingGroup} and ${group}.`,
			},
		];
	}
	actionOwners.set(action.id, group);
	return [];
}

function findDiscoveryActionSummaryDrift(
	command: string,
	path: string,
	group: string,
	action: CommandDiscoveryActionAffordance & Record<string, unknown>,
): CommandFacadeMetadataDrift[] {
	if (
		typeof action.summary !== "string" ||
		action.summary.trim().length === 0
	) {
		return [
			{
				category: "command-discovery-action-summary-missing",
				path,
				action: `Add a short summary for ${command} action affordance ${action.id || "(missing id)"}.`,
			},
		];
	}
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const issue of validateProjectedFreeText(
		`${command}.action_affordances.${group}.${action.id}.summary`,
		action.summary,
	)) {
		drift.push({
			category: "command-discovery-action-summary-unsafe-text",
			path,
			action: `Remove unsafe content from ${command} action affordance ${action.id || "(missing id)"} summary (${issue}).`,
		});
	}
	return drift;
}

function findDiscoveryActionSideEffectsDrift(
	command: string,
	path: string,
	action: CommandDiscoveryActionAffordance & Record<string, unknown>,
	allowedSideEffects: ReadonlySet<string>,
): CommandFacadeMetadataDrift[] {
	const drift: CommandFacadeMetadataDrift[] = [];
	for (const sideEffect of action.side_effects ?? []) {
		if (!allowedSideEffects.has(sideEffect)) {
			drift.push({
				category: "command-discovery-action-side-effect-invalid",
				path,
				action: `Use a known side effect for ${command} action affordance ${action.id || "(missing id)"}: ${[...allowedSideEffects].join(", ")}.`,
			});
		}
	}
	return drift;
}

function findDiscoveryActionDrift(
	command: string,
	path: string,
	group: string,
	action: unknown,
	allowedSideEffects: ReadonlySet<string>,
	actionOwners: Map<string, string>,
): CommandFacadeMetadataDrift[] {
	if (!isCommandDiscoveryActionRecord(action)) {
		return [
			{
				category: "command-discovery-action-affordance-invalid",
				path,
				action: `Make every ${command} action affordance in group ${group} an object.`,
			},
		];
	}
	const drift: CommandFacadeMetadataDrift[] = [
		...findDiscoveryActionIdDrift(command, path, group, action, actionOwners),
		...findDiscoveryActionSummaryDrift(command, path, group, action),
		...findDiscoveryActionSideEffectsDrift(
			command,
			path,
			action,
			allowedSideEffects,
		),
	];
	if ("command_template" in action) {
		drift.push({
			category: "command-discovery-action-command-template-unsupported",
			path,
			action: `Remove command_template from ${command} action affordance ${action.id || "(missing id)"}; command templates are not part of the current discovery grammar.`,
		});
	}
	return drift;
}

function findDiscoveryActionAffordanceGroupDrift(
	command: string,
	path: string,
	group: string,
	actions: readonly CommandDiscoveryActionAffordance[],
	allowedSideEffects: ReadonlySet<string>,
	actionOwners: Map<string, string>,
): CommandFacadeMetadataDrift[] {
	if (!Array.isArray(actions)) {
		return [
			{
				category: "command-discovery-action-affordance-group-invalid",
				path,
				action: `Make ${command} action_affordances.${group} an array of action affordances.`,
			},
		];
	}
	return actions.flatMap((action) =>
		findDiscoveryActionDrift(
			command,
			path,
			group,
			action,
			allowedSideEffects,
			actionOwners,
		),
	);
}

function findCommandDiscoveryResultContractDrift(input: {
	command: string;
	path: string;
	resultContract: CommandDiscoveryCommand["result_contract"];
	actionAffordances: CommandDiscoveryCommand["action_affordances"];
	allowedSideEffects: ReadonlySet<string>;
}): CommandFacadeMetadataDrift[] {
	const drift = findDiscoveryResultContractShapeDrift(
		input.command,
		input.path,
		input.resultContract,
	);
	if (!input.actionAffordances) return drift;

	const actionOwners = new Map<string, string>();
	return [
		...drift,
		...Object.entries(input.actionAffordances).flatMap(([group, actions]) =>
			findDiscoveryActionAffordanceGroupDrift(
				input.command,
				input.path,
				group,
				actions,
				input.allowedSideEffects,
				actionOwners,
			),
		),
	];
}

function isCommandDiscoveryActionRecord(
	value: unknown,
): value is Record<string, unknown> & CommandDiscoveryActionAffordance {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
