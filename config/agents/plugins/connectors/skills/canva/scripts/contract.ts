// Canva launcher contract: the one owner of command identities, refusal
// causes, and their exit meanings (2 usage, 3 precondition, 4 configuration or
// dependency, per the shared provider-process vocabulary). Help, SKILL.md, and
// the process tests restate these; they never define them.
import type { RefusalExit } from "../../../bin/provider-process.ts";

export const COMMANDS = ["login", "status", "list", "call"] as const;
export type Command = (typeof COMMANDS)[number];

export const USAGE = `canva <${COMMANDS.join("|")}> --account <slug> [flags]`;

// route-invalid keeps the shared route's own exit; its entry is the fallback.
// The last three exits are set by the shared provider-process helper.
export const CAUSE_EXIT = {
	"command-invalid": 2,
	"account-invalid": 2,
	"arguments-invalid": 2,
	"flag-forbidden": 2,
	"route-invalid": 2,
	"client-mode-not-admitted": 3,
	"legacy-cache-present": 3,
	"vault-root-invalid": 3,
	"client-mode-invalid": 4,
	"registry-identity-invalid": 4,
	"executable-missing": 4,
	"execve-unavailable": 4,
	"exec-failed": 4,
} as const satisfies Record<string, RefusalExit>;

export type Cause = keyof typeof CAUSE_EXIT;

export function isCommand(value: string | undefined): value is Command {
	return (COMMANDS as readonly (string | undefined)[]).includes(value);
}

// Messages are fixed text: a refusal never echoes caller input, because argv
// may carry a secret-shaped value.
export class CanvaError extends Error {
	readonly code: Cause;
	readonly exitCode: RefusalExit;
	constructor(code: Cause, message: string, exitCode: RefusalExit = CAUSE_EXIT[code]) {
		super(message);
		this.code = code;
		this.exitCode = exitCode;
	}
}
