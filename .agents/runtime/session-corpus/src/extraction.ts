import type { NormalizedMessage, SessionMetadata } from "./model.ts"
import { parseNormalizedMessage, readJsonLines } from "./parser.ts"
import { redactSessionText } from "./redaction.ts"

function startedAtSortValue(value: string | undefined): number {
	if (!value) return Number.POSITIVE_INFINITY
	const timestamp = Date.parse(value)
	return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp
}

/** One bounded redacted message returned from private history. */
export interface ExtractedSessionMessage {
	/** Zero-based normalized message index. */
	index: number
	/** Conversation role retained by the parser. */
	role: "user" | "assistant"
	/** Original message timestamp when available. */
	timestamp?: string
	/** Redacted bounded text. */
	text: string
	/** Whether the caller's text budget clipped this message. */
	truncated: boolean
}

/** Bounded source-neutral page used by higher-level session workflows. */
export interface ExtractedSessionPage {
	/** First normalized message index requested. */
	offset: number
	/** Requested page size. */
	limit: number
	/** Total normalized messages in the native session. */
	totalMessages: number
	/** Next page offset, or null at the end. */
	nextOffset: number | null
	/** Redaction substitutions applied to returned messages. */
	redactions: number
	/** Redacted message page. */
	messages: ExtractedSessionMessage[]
}

type ExtractionState = {
	totalMessages: number
	redactions: number
	messages: ExtractedSessionMessage[]
}

function isNonNegativeSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0
}

function validateExtractionOptions(options: {
	offset: number
	limit: number
	maxMessageChars: number
}): void {
	if (!isNonNegativeSafeInteger(options.offset)) {
		throw new Error("offset must be a non-negative integer")
	}
	if (!isPositiveSafeInteger(options.limit)) {
		throw new Error("limit must be a positive integer")
	}
	if (!isNonNegativeSafeInteger(options.maxMessageChars)) {
		throw new Error("maxMessageChars must be a non-negative integer")
	}
}

function compareSessionFragments(left: SessionMetadata, right: SessionMetadata): number {
	const leftStarted = startedAtSortValue(left.startedAt)
	const rightStarted = startedAtSortValue(right.startedAt)
	return leftStarted - rightStarted || left.path.localeCompare(right.path)
}

function orderedSessionFragments(fragments: SessionMetadata[]): SessionMetadata[] {
	return [...fragments].sort(compareSessionFragments)
}

function appendExtractedMessage(
	state: ExtractionState,
	message: NormalizedMessage | undefined,
	options: { offset: number; limit: number; maxMessageChars: number },
): void {
	if (!message) return
	const index = state.totalMessages
	state.totalMessages += 1
	if (index < options.offset || state.messages.length >= options.limit) return
	const redacted = redactSessionText(message.text)
	state.redactions += redacted.redactions
	const truncated = redacted.text.length > options.maxMessageChars
	state.messages.push({
		index,
		role: message.role,
		timestamp: message.timestamp,
		text: truncated
			? redacted.text.slice(0, options.maxMessageChars) + "…"
			: redacted.text,
		truncated,
	})
}

async function appendFragmentMessages(
	state: ExtractionState,
	metadata: SessionMetadata,
	options: { offset: number; limit: number; maxMessageChars: number },
	strict: boolean,
): Promise<void> {
	for await (const value of readJsonLines(metadata.path, { strict })) {
		appendExtractedMessage(state, parseNormalizedMessage(value, metadata.source), options)
	}
}

function buildExtractedSessionPage(
	state: ExtractionState,
	options: { offset: number; limit: number; maxMessageChars: number },
): ExtractedSessionPage {
	const nextOffset = options.offset + state.messages.length < state.totalMessages
		? options.offset + state.messages.length
		: null
	return {
		offset: options.offset,
		limit: options.limit,
		totalMessages: state.totalMessages,
		nextOffset,
		redactions: state.redactions,
		messages: state.messages,
	}
}

/**
 * Read one bounded redacted page from resolved private session metadata.
 *
 * @param metadata - Runtime-native source locator retained inside trusted code
 * @param options - Pagination and per-message text budget
 * @returns Source-neutral page without private filesystem paths
 *
 * @example
 * ```ts
 * const page = await extractSessionPage(metadata, { offset: 0, limit: 20, maxMessageChars: 2000 })
 * ```
 */
export async function extractSessionPage(
	metadata: SessionMetadata,
	options: { offset: number; limit: number; maxMessageChars: number },
): Promise<ExtractedSessionPage> {
	return extractSessionFragmentsPageUnsafe([metadata], options, false)
}

/**
 * Read one logical session across all native fragments in deterministic order.
 *
 * @param fragments - Every runtime-native locator for one source-qualified session
 * @param options - Pagination and per-message text budget
 * @returns One combined source-neutral page without private filesystem paths
 * @throws {Error} When pagination is invalid or any selected fragment is malformed or unreadable
 *
 * @example
 * ```ts
 * const page = await extractSessionFragmentsPage(fragments, { offset: 0, limit: 20, maxMessageChars: 2000 })
 * ```
 */
export async function extractSessionFragmentsPage(
	fragments: SessionMetadata[],
	options: { offset: number; limit: number; maxMessageChars: number },
): Promise<ExtractedSessionPage> {
	return extractSessionFragmentsPageUnsafe(fragments, options, true)
}

async function extractSessionFragmentsPageUnsafe(
	fragments: SessionMetadata[],
	options: { offset: number; limit: number; maxMessageChars: number },
	strict: boolean,
): Promise<ExtractedSessionPage> {
	validateExtractionOptions(options)
	const state: ExtractionState = { totalMessages: 0, redactions: 0, messages: [] }
	for (const metadata of orderedSessionFragments(fragments)) {
		await appendFragmentMessages(state, metadata, options, strict)
	}
	return buildExtractedSessionPage(state, options)
}
