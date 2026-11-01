import { type ProviderProcess, providerProcess } from "../../../bin/provider-process.ts";
import { INTERNAL_INVOCATION_CONTEXT_ENV } from "../../../bin/safe-environment.ts";

export const profileContext = (profile: string): string => `notebooklm-profile=${profile}`;
export function runProvider(argv: readonly string[]): void {
	const processOwner = providerProcess("notebooklm-provider");
	const fail: ProviderProcess["fail"] = processOwner.fail;
	if (argv.length !== 0 && !(argv.length === 1 && argv[0] === "--preflight")) processOwner.fail("arguments-invalid", "only preflight is admitted", 2);
	const context = process.env[INTERNAL_INVOCATION_CONTEXT_ENV] ?? "";
	const profile = /^notebooklm-profile=([a-zA-Z0-9][a-zA-Z0-9_-]{0,31})$/.exec(context)?.[1];
	if (!profile) fail("profile-invalid", "use the NotebookLM packaged adapter", 3);
	const executable = processOwner.executableOnPath("notebooklm-mcp");
	if (argv[0] === "--preflight") return;
	processOwner.replaceProcess(executable, [executable, "--transport", "stdio", "--no-debug"], { ...processOwner.cleanEnvironment(), NLM_PROFILE: profile, NOTEBOOKLM_MCP_DEBUG: "false", NOTEBOOKLM_RATE_LIMIT_MAX_RETRIES: "0" });
}
