import type { RefusalExit } from "../../../bin/provider-process.ts";

// route-invalid keeps the shared route's own exit; its entry is the fallback.
const CAUSE_EXIT = {
	"account-invalid": 2,
	"route-invalid": 2,
	"legacy-cache-present": 3,
	"vault-root-invalid": 3,
	"registry-identity-invalid": 4,
} as const satisfies Record<string, RefusalExit>;

export type Cause = keyof typeof CAUSE_EXIT;

// Messages are fixed text: a refusal never echoes caller input, because argv
// may carry a secret-shaped value.
export class NotionError extends Error {
	readonly code: Cause;
	readonly exitCode: RefusalExit;
	constructor(code: Cause, message: string, exitCode: RefusalExit = CAUSE_EXIT[code]) {
		super(message);
		this.code = code;
		this.exitCode = exitCode;
	}
}
