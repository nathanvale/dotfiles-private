import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

const sessionStorage = new AsyncLocalStorage<BrowserUseQualificationSessionAuthority>();

type LiveHandoff = {
	handle: string;
	runId: string;
	raw: string;
	producerReceiptRaw: string;
};

type LiveReceipt = {
	handle: string;
	handoffHandle: string;
	runId: string;
	requestId: string;
	raw: string;
	consumed: boolean;
	rawSha256: string;
};

export type QualificationReceiptCapability = {
	handle: string;
	request_id: string;
};

export type QualificationReceiptResolution =
	| { ok: true; raws: string[] }
	| {
			ok: false;
			code:
				| "qualification_receipt_capability_invalid"
				| "qualification_receipt_capability_not_live"
				| "qualification_receipt_capability_mismatch"
				| "qualification_receipt_capability_replayed";
	  };

/** Process-local authority. Persisted handles and receipts are never accepted. */
export class BrowserUseQualificationSessionAuthority {
	readonly session_id = randomUUID();
	readonly #handoffs = new Map<string, LiveHandoff>();
	readonly #receipts = new Map<string, LiveReceipt>();
	readonly #receiptRawIdentities = new Set<string>();
	#closed = false;

	admitHandoff(input: {
		runId: string;
		raw: string;
		producerReceiptRaw: string;
		handle?: string;
	}): string {
		if (this.#closed) throw new Error("qualification_session_closed");
		const handle = input.handle ?? randomUUID();
		if (this.#handoffs.has(handle)) throw new Error("qualification_handoff_handle_conflict");
		this.#handoffs.set(handle, {
			handle,
			runId: input.runId,
			raw: input.raw,
			producerReceiptRaw: input.producerReceiptRaw,
		});
		return handle;
	}

	resolveHandoff(handle: string, runId: string): string | undefined {
		return this.resolveHandoffCapability(handle, runId)?.raw;
	}

	resolveHandoffCapability(
		handle: string,
		runId: string,
	): Readonly<LiveHandoff> | undefined {
		if (this.#closed) return undefined;
		const admitted = this.#handoffs.get(handle);
		return admitted?.runId === runId ? admitted : undefined;
	}

	admitReceipt(input: {
		handoffHandle: string;
		runId: string;
		requestId: string;
		raw: string;
	}): string {
		if (this.#closed) throw new Error("qualification_session_closed");
		if (!this.resolveHandoffCapability(input.handoffHandle, input.runId)) {
			throw new Error("qualification_handoff_capability_not_live");
		}
		const rawSha256 = createHash("sha256").update(input.raw).digest("hex");
		const rawIdentity = JSON.stringify([
			input.runId,
			input.handoffHandle,
			rawSha256,
		]);
		if (this.#receiptRawIdentities.has(rawIdentity)) {
			throw new Error("qualification_receipt_capability_duplicate");
		}
		const handle = randomUUID();
		this.#receiptRawIdentities.add(rawIdentity);
		this.#receipts.set(handle, {
			handle,
			handoffHandle: input.handoffHandle,
			runId: input.runId,
			requestId: input.requestId,
			raw: input.raw,
			consumed: false,
			rawSha256,
		});
		return handle;
	}

	consumeReceipts(input: {
		receiptCapabilities: readonly QualificationReceiptCapability[];
		handoffHandle: string;
		runId: string;
	}): QualificationReceiptResolution {
		const handles = input.receiptCapabilities.map((value) => value.handle);
		const requestIds = input.receiptCapabilities.map(
			(value) => value.request_id,
		);
		if (
			this.#closed ||
			input.receiptCapabilities.length === 0 ||
			new Set(handles).size !== handles.length ||
			new Set(requestIds).size !== requestIds.length
		) {
			return { ok: false, code: "qualification_receipt_capability_invalid" };
		}
		const receipts: LiveReceipt[] = [];
		for (const capability of input.receiptCapabilities) {
			const handle = capability.handle;
			const receipt = this.#receipts.get(handle);
			if (!receipt) {
				return { ok: false, code: "qualification_receipt_capability_not_live" };
			}
			if (receipt.consumed) {
				return { ok: false, code: "qualification_receipt_capability_replayed" };
			}
			if (
				receipt.runId !== input.runId ||
				receipt.handoffHandle !== input.handoffHandle ||
				receipt.requestId !== capability.request_id
			) {
				return { ok: false, code: "qualification_receipt_capability_mismatch" };
			}
			receipts.push(receipt);
		}
		for (const receipt of receipts) receipt.consumed = true;
		return { ok: true, raws: receipts.map((receipt) => receipt.raw) };
	}

	receiptCounts(): { admitted: number; consumed: number } {
		let consumed = 0;
		for (const receipt of this.#receipts.values()) {
			if (receipt.consumed) consumed += 1;
		}
		return { admitted: this.#receipts.size, consumed };
	}

	close(): void {
		this.#closed = true;
		this.#handoffs.clear();
		this.#receipts.clear();
		this.#receiptRawIdentities.clear();
	}
}

export function currentBrowserUseQualificationSession(): BrowserUseQualificationSessionAuthority | undefined {
	return sessionStorage.getStore();
}

export async function withBrowserUseQualificationSession<T>(
	session: BrowserUseQualificationSessionAuthority,
	body: () => Promise<T>,
): Promise<T> {
	return await sessionStorage.run(session, body);
}
