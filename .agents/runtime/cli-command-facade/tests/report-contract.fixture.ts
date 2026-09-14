import type { CommandFacadeContract } from "@side-quest/cli-command-facade";

export const reportContract = {
	script: "tools/report.ts",
	summary: "Report command state.",
	usage: ["report --json"],
	json: true,
	audience: "agent",
	mutation: "read-only",
	sideEffects: ["check"],
	flags: {
		"--json": { type: "boolean", description: "Emit JSON." },
	},
	exitCodes: {
		"0": "report emitted",
		"1": "report failed",
		"2": "usage error",
	},
	resultContract: {
		id: "example.report",
		schema_version: 1,
	},
} as const satisfies CommandFacadeContract<"report">;
