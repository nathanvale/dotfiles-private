// The one process-environment allow-list for Connectors. Callers pass an
// explicit source rather than reading ambient state while assembling children.
const SAFE_ENVIRONMENT_KEYS = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "XDG_STATE_HOME"] as const;
// Reserved for the semantic dispatcher only. It is not a caller-selectable
// environment key and cannot carry a map of arbitrary route environment.
export const INTERNAL_INVOCATION_CONTEXT_ENV = "CONNECTORS_INTERNAL_INVOCATION_CONTEXT";
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export function safeEnvironment(source: EnvironmentSource): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const key of SAFE_ENVIRONMENT_KEYS) {
		const value = source[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}
