// Canva custody contract: the one owner of the refusal causes the custody
// interface raises and their exit meanings (2 usage, 3 precondition, 4
// configuration, per the shared provider-process vocabulary). The packaged
// adapter maps each exit to its refusal kind; SKILL.md restates the causes.
import type { RefusalExit } from "../../../bin/provider-process.ts";

// route-invalid keeps the shared route's own exit; its entry is the fallback.
const CAUSE_EXIT = {
	"account-invalid": 2,
	"route-invalid": 2,
	"client-mode-not-admitted": 3,
	"legacy-cache-present": 3,
	"vault-root-invalid": 3,
	"client-mode-invalid": 4,
	"registry-identity-invalid": 4,
} as const satisfies Record<string, RefusalExit>;

export type Cause = keyof typeof CAUSE_EXIT;

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
