// Atlassian dispatcher: one semantic Jira or Confluence operation for one
// tenant through the Atlassian Community Provider, every write behind a
// durable preview and apply journal, and the operator path that inspects and
// adjudicates what the journal holds. Raw provider-route is the transport
// primitive underneath; this module owns the safety policy. Its interface is
// two functions: `invocationFor` validates a semantic request into a typed
// Invocation before any capability exists, and `dispatch` runs one Invocation
// to an Outcome and the provenance of every Provider call it made. It is
// imported only by the packaged adapter (adapter.ts), which maps the Outcome
// onto the front door's result; it has no entry of its own.
import { TENANT_PATTERN } from "./custody/index.ts";
import type { OperationSpec, Provenance } from "./dispatch/contract.ts";
import { type Dependencies, type Input, readInput } from "./dispatch/engine.ts";
import { adjudicateFlow, applyFlow, type Outcome, previewFlow, readFlow, receiptFlow, receiptsFlow, Session, unlockFlow } from "./dispatch/flows.ts";
import { type WriteInput, writeInput } from "./dispatch/writes.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// The work one invocation does. `Read` and `Write` are the input a step
// carries: raw in a Request, validated in an Invocation. Adjudication input is
// checked against its receipt inside the flow, which alone knows the operation.
export type Step<Read, Write> =
	| { kind: "read"; spec: OperationSpec; input: Read }
	| { kind: "preview"; spec: OperationSpec; input: Write }
	| { kind: "apply"; spec: OperationSpec; input: Write; previewId: string }
	| { kind: "receipts" }
	| { kind: "receipt"; runId: string }
	| { kind: "unlock"; runId: string }
	| { kind: "adjudicate"; runId: string; input: unknown };

export type Request = { tenant: string } & Step<unknown, unknown>;
export type Invocation = { tenant: string } & Step<Input, WriteInput>;

// usage-invalid: the tenant or an identifier is malformed. input-invalid: the
// operation's input contract refuses the input. Neither names caller text.
export type Invalid = "usage-invalid" | "input-invalid";
export type Validated = { ok: true; invocation: Invocation } | { ok: false; cause: Invalid };

const usage: Validated = { ok: false, cause: "usage-invalid" };
const inputInvalid: Validated = { ok: false, cause: "input-invalid" };

// Identifiers are checked before input, so a malformed tenant, preview id, or
// run id is a usage refusal whatever the input holds.
export function invocationFor(request: Request): Validated {
	if (!TENANT_PATTERN.test(request.tenant)) return usage;
	switch (request.kind) {
		case "read": {
			const input = readInput(request.spec.id, request.input);
			return input.ok ? { ok: true, invocation: { ...request, input: input.input } } : inputInvalid;
		}
		case "preview":
		case "apply": {
			if (request.kind === "apply" && !IDENTIFIER.test(request.previewId)) return usage;
			const input = writeInput(request.spec.id as Parameters<typeof writeInput>[0], request.input);
			return input.ok ? { ok: true, invocation: { ...request, input: input.input } } : inputInvalid;
		}
		case "receipt":
		case "unlock":
		case "adjudicate":
			return IDENTIFIER.test(request.runId) ? { ok: true, invocation: request } : usage;
		case "receipts":
			return { ok: true, invocation: request };
	}
}

export interface Dispatched {
	outcome: Outcome;
	provenance: readonly Provenance[];
}

async function outcomeOf(session: Session, invocation: Invocation): Promise<Outcome> {
	switch (invocation.kind) {
		case "read":
			return readFlow(session, invocation.spec, invocation.input);
		case "preview":
			return previewFlow(session, invocation.spec, invocation.input);
		case "apply":
			return applyFlow(session, invocation.spec, invocation.input, invocation.previewId);
		case "receipts":
			return receiptsFlow(session);
		case "receipt":
			return receiptFlow(session, invocation.runId);
		case "unlock":
			return unlockFlow(session, invocation.runId);
		case "adjudicate":
			return adjudicateFlow(session, invocation.runId, invocation.input);
	}
}

// Dependencies belong to the invocation's tenant, so the transport, credential
// item, and trusted origin share one identity.
export async function dispatch(invocation: Invocation, dependencies: Dependencies): Promise<Dispatched> {
	const session = new Session(dependencies, invocation.tenant);
	const outcome = await outcomeOf(session, invocation);
	return { outcome, provenance: session.provenance };
}
