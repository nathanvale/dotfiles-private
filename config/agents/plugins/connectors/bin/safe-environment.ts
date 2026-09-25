// The one process-environment allow-list for Connectors. Callers pass an
// explicit source rather than reading ambient state while assembling children.
const SAFE_ENVIRONMENT_KEYS = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "XDG_STATE_HOME"] as const;
// Reserved for the semantic dispatcher and the packaged adapters' internal
// roles. It is not a caller-selectable environment key and cannot carry a map
// of arbitrary route environment.
export const INTERNAL_INVOCATION_CONTEXT_ENV = "CONNECTORS_INTERNAL_INVOCATION_CONTEXT";
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

// The one shape an internal invocation context may take: one non-empty line
// of at most 4096 characters.
export function validInternalContext(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\n") && !value.includes("\r");
}

export function safeEnvironment(source: EnvironmentSource): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const key of SAFE_ENVIRONMENT_KEYS) {
		const value = source[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}
