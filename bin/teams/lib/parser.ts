/**
 * Line-by-line state machine parser (most reliable)
 *
 * Teams clipboard format:
 * - Each message has a "preview header": "Content preview... by AuthorName"
 * - Followed by: AuthorName\nDD/MM/YYYY H:MM am/pm\n\nActual content
 * - Reactions appear as: emoji\nN emoji-name reactions.\nN
 * - Replies start with "Begin Reference,"
 *
 * The machine is a state table: one handler per state, a dispatcher that
 * picks the handler for the current line, and shared helpers for the line
 * classification and message finalization every state needs.
 */

import {
	findChannel,
	isCountLine,
	isCustomEmojiReaction,
	isEllipsisLine,
	isPraiseUiElement,
	isReactionSummary,
	isReplyReference,
	isUiChrome,
	isUiElement,
	isValidAuthor,
	type LineView,
	matchesPreviewStart,
	parseAttachment,
	parseReaction,
	parseReplyReference,
	type ReplyReference,
	startsAuthor,
	startsPreview,
	timestampRegex,
	viewLine,
} from './lines'
import { buildScrapedData, createMessage, type MessageDraft } from './message'
import type { ScrapedData, TeamsMessage } from './types'

const DEBUG_REPLIES = false

function debug(message: () => string): void {
	if (DEBUG_REPLIES) console.log(message())
}

type ParseState =
	| 'seeking'
	| 'found_preview'
	| 'found_author'
	| 'reading_content'
	| 'reading_reply_content'

/**
 * Everything the machine carries between lines: the cursor, the state, the
 * messages finished so far, and the draft of the message being read.
 *
 * Invariant: `isReply` is true and `replyTo` is set only while the state is
 * `reading_reply_content`; every exit from that state resets both.
 */
interface ParseContext extends MessageDraft {
	lines: string[]
	index: number
	state: ParseState
	messages: TeamsMessage[]
	skipQuotedLines: number // Counter to skip quoted content in replies
}

type StateHandler = (ctx: ParseContext, view: LineView) => void

function createContext(lines: string[]): ParseContext {
	return {
		lines,
		index: 0,
		state: 'seeking',
		messages: [],
		skipQuotedLines: 0,
		author: '',
		timestamp: '',
		content: [],
		reactions: [],
		attachments: [],
		isReply: false,
	}
}

// --- Message finalization ---------------------------------------------------

function hasPendingMessage(ctx: ParseContext): boolean {
	return (
		ctx.author !== '' &&
		ctx.timestamp !== '' &&
		(ctx.content.length > 0 || ctx.reactions.length > 0)
	)
}

function pushCurrentMessage(ctx: ParseContext): void {
	ctx.messages.push(createMessage(ctx))
}

/** Saves the draft when it holds content or reactions; reports whether it did. */
function flushPendingMessage(ctx: ParseContext): boolean {
	if (!hasPendingMessage(ctx)) return false
	pushCurrentMessage(ctx)
	return true
}

/** Fresh buffers for the next message; the saved message keeps its own arrays. */
function resetDraft(ctx: ParseContext): void {
	ctx.content = []
	ctx.reactions = []
	ctx.attachments = []
	ctx.isReply = false
	ctx.replyTo = undefined
}

/** Starts a plain message from an AuthorName line followed by a timestamp. */
function startMessage(ctx: ParseContext, view: LineView): void {
	ctx.author = view.trimmed
	ctx.timestamp = view.nextLine
	resetDraft(ctx)
	ctx.state = 'found_author'
}

// --- Reply references -------------------------------------------------------

interface ReplyScan {
	replyTimestamp: string
	originalAuthor: string
	originalTimestamp: string
	originalAuthorLineIndex: number
}

/**
 * After "Begin Reference, preview by ReplyAuthor" the lines run:
 * ReplyAuthor\nTimestamp\n\nOriginalAuthor\nTimestamp\nQuotedContent\nActualReplyContent
 * Find the reply author line and the original author line within 15 lines.
 */
function scanReplyAuthors(
	lines: string[],
	index: number,
	replyAuthor: string,
): ReplyScan {
	const scan: ReplyScan = {
		replyTimestamp: '',
		originalAuthor: '',
		originalTimestamp: '',
		originalAuthorLineIndex: -1,
	}

	for (let j = index + 1; j < Math.min(index + 15, lines.length); j++) {
		const scanLine = lines[j]?.trim() || ''
		const scanNextLine = lines[j + 1]?.trim() || ''
		if (!timestampRegex.test(scanNextLine)) continue

		// Find reply author (first author match)
		if (scan.replyTimestamp === '' && scanLine === replyAuthor) {
			scan.replyTimestamp = scanNextLine
			debug(() => `[DEBUG]   Found reply timestamp: ${scan.replyTimestamp}`)
			continue
		}

		// Find original author (second author match - can be same person for self-replies)
		if (scan.replyTimestamp !== '' && isValidAuthor(scanLine)) {
			scan.originalAuthor = scanLine
			scan.originalTimestamp = scanNextLine
			scan.originalAuthorLineIndex = j
			debug(
				() =>
					`[DEBUG]   Found original author: ${scan.originalAuthor} at line ${j}`,
			)
			break
		}
	}

	return scan
}

/**
 * Turns the draft into the reply message and jumps past the quoted original
 * author's timestamp line. Falls back to seeking when the reference cannot be
 * resolved.
 */
function beginReply(ctx: ParseContext, ref: ReplyReference): void {
	const scan = scanReplyAuthors(ctx.lines, ctx.index, ref.replyAuthor)
	if (scan.replyTimestamp === '' || scan.originalAuthor === '') {
		debug(
			() =>
				`[DEBUG]   Failed to find reply/original author! replyTimestamp=${scan.replyTimestamp}, originalAuthor=${scan.originalAuthor}`,
		)
		ctx.state = 'seeking'
		return
	}

	debug(
		() =>
			`[DEBUG]   Setting up reply: ${ref.replyAuthor} replying to ${scan.originalAuthor}`,
	)
	ctx.author = ref.replyAuthor
	ctx.timestamp = scan.replyTimestamp
	resetDraft(ctx)
	ctx.isReply = true
	ctx.skipQuotedLines = 0 // Reset quoted line counter
	ctx.replyTo = {
		author: scan.originalAuthor,
		timestamp: scan.originalTimestamp,
		preview: ref.preview,
	}

	// Skip to after the original author's timestamp line; the loop increments once more
	ctx.index = scan.originalAuthorLineIndex + 1
	ctx.state = 'reading_reply_content'
	debug(
		() => `[DEBUG]   Transitioning to reading_reply_content, i=${ctx.index}`,
	)
}

function debugReplyReference(ref: ReplyReference): void {
	debug(
		() =>
			`[DEBUG]   Reply author: ${ref.replyAuthor}, preview: ${ref.preview.substring(0, 30)}...`,
	)
}

// --- Shared line handling for content states -------------------------------

/** Consumes an emoji or custom emoji reaction pair; reports whether it did. */
function consumeReaction(ctx: ParseContext, view: LineView): boolean {
	const reaction = parseReaction(view)
	if (reaction) {
		ctx.reactions.push(reaction)
	} else if (!isCustomEmojiReaction(view)) {
		return false
	}
	ctx.index += 2 // Skip emoji line, count line, and the bare number line
	return true
}

// --- State handlers ---------------------------------------------------------

function seek(ctx: ParseContext, view: LineView): void {
	const { trimmed } = view

	if (isReplyReference(trimmed)) {
		debug(
			() => `[DEBUG] Line ${ctx.index}: Found Begin Reference in seeking state`,
		)
		seekReply(ctx, trimmed)
		return
	}

	// Preview header: skip it, the content comes from the actual message
	if (startsPreview(view)) {
		ctx.state = 'found_preview'
		return
	}

	// Direct author + timestamp (no preview header)
	if (startsAuthor(view)) {
		flushPendingMessage(ctx)
		startMessage(ctx, view)
	}
}

function seekReply(ctx: ParseContext, trimmed: string): void {
	const ref = parseReplyReference(trimmed)
	if (!ref) {
		debug(() => `[DEBUG]   Begin Reference regex did not match!`)
		return
	}
	debugReplyReference(ref)

	// Save any previous message
	if (hasPendingMessage(ctx)) {
		debug(
			() =>
				`[DEBUG]   Saving previous message: ${ctx.author} (isReply: ${ctx.isReply})`,
		)
		pushCurrentMessage(ctx)
	}

	beginReply(ctx, ref)
}

function readPreview(ctx: ParseContext, view: LineView): void {
	// Check for Begin Reference first (might be a reply after a preview)
	if (isReplyReference(view.trimmed)) {
		ctx.state = 'seeking'
		ctx.index-- // Reprocess this line in seeking state
		return
	}

	// After preview header, expect AuthorName + timestamp
	if (startsAuthor(view)) {
		flushPendingMessage(ctx)
		startMessage(ctx, view)
		return
	}

	// Not what we expected, go back to seeking
	ctx.state = 'seeking'
}

function skipTimestamp(ctx: ParseContext, view: LineView): void {
	if (timestampRegex.test(view.trimmed)) {
		ctx.state = 'reading_content'
	}
}

/** Boundaries that end an ordinary message; reports whether one was hit. */
function endsContent(ctx: ParseContext, view: LineView): boolean {
	// New message preview header
	if (startsPreview(view)) {
		if (flushPendingMessage(ctx)) resetDraft(ctx)
		ctx.state = 'found_preview'
		return true
	}

	// Direct author + timestamp (new message without preview)
	if (startsAuthor(view)) {
		flushPendingMessage(ctx)
		startMessage(ctx, view)
		return true
	}

	if (isReplyReference(view.trimmed)) {
		debug(
			() =>
				`[DEBUG] Line ${ctx.index}: Found Begin Reference in reading_content state`,
		)
		// Save current message first
		if (flushPendingMessage(ctx)) resetDraft(ctx)

		const ref = parseReplyReference(view.trimmed)
		if (!ref) {
			debug(() => `[DEBUG]   Begin Reference regex did not match!`)
			ctx.state = 'seeking'
			return true
		}
		debugReplyReference(ref)
		beginReply(ctx, ref)
		return true
	}

	return false
}

function readContent(ctx: ParseContext, view: LineView): void {
	const { trimmed } = view
	if (endsContent(ctx, view)) return
	if (consumeReaction(ctx, view)) return
	if (isCountLine(trimmed)) return

	const attachment = parseAttachment(trimmed)
	if (attachment) {
		ctx.attachments.push(attachment)
		return
	}

	if (
		isUiElement(trimmed) ||
		isPraiseUiElement(trimmed) ||
		isReactionSummary(trimmed)
	) {
		return
	}

	// Add to content (but not empty lines)
	if (trimmed) {
		ctx.content.push(trimmed)
	}
}

/** Boundaries that end a reply; the reply is saved even when empty. */
function endsReply(ctx: ParseContext, view: LineView): boolean {
	const { trimmed } = view

	if (startsPreview(view)) {
		debug(
			() =>
				`[DEBUG]   -> New preview header, saving reply: ${ctx.author} with ${ctx.content.length} content lines`,
		)
		pushCurrentMessage(ctx)
		resetDraft(ctx)
		ctx.state = 'found_preview'
		return true
	}

	if (isReplyReference(trimmed)) {
		debug(
			() =>
				`[DEBUG]   -> New Begin Reference, saving reply: ${ctx.author} with ${ctx.content.length} content lines, isReply=${ctx.isReply}`,
		)
		pushCurrentMessage(ctx)
		resetDraft(ctx)
		ctx.state = 'seeking'
		ctx.index-- // Reprocess this line in seeking state
		return true
	}

	if (startsAuthor(view)) {
		debug(
			() =>
				`[DEBUG]   -> New author ${trimmed}, saving reply: ${ctx.author} with ${ctx.content.length} content lines`,
		)
		pushCurrentMessage(ctx)
		startMessage(ctx, view)
		return true
	}

	return false
}

/**
 * The first non-empty line after the original author's timestamp is the
 * quoted original message; it should roughly match the start of the preview.
 */
function isQuotedContent(ctx: ParseContext, trimmed: string): boolean {
	return (
		ctx.replyTo !== undefined &&
		ctx.content.length === 0 &&
		ctx.skipQuotedLines === 0 &&
		matchesPreviewStart(ctx.replyTo.preview, trimmed)
	)
}

/**
 * Inside a reply block after the original author's timestamp. The structure
 * is QuotedContent (often ending with …) then ActualReplyContent; skip the
 * quoted content and capture everything after it.
 */
function readReplyContent(ctx: ParseContext, view: LineView): void {
	const { trimmed } = view
	debug(
		() =>
			`[DEBUG] Line ${ctx.index} reading_reply_content: "${trimmed.substring(0, 50)}" (content.len=${ctx.content.length}, skipQuoted=${ctx.skipQuotedLines})`,
	)

	if (endsReply(ctx, view)) return
	if (consumeReaction(ctx, view)) return
	if (isCountLine(trimmed) || isReactionSummary(trimmed) || isUiElement(trimmed)) {
		return
	}

	if (isEllipsisLine(trimmed)) {
		debug(() => `[DEBUG]   Skipping ellipsis line`)
		return
	}

	if (isQuotedContent(ctx, trimmed)) {
		debug(() => `[DEBUG]   Skipping quoted content (matches preview)`)
		ctx.skipQuotedLines = 1
		return
	}

	if (trimmed) {
		debug(() => `[DEBUG]   Adding reply content: "${trimmed.substring(0, 40)}"`)
		ctx.content.push(trimmed)
	}
}

const handlers: Record<ParseState, StateHandler> = {
	seeking: seek,
	found_preview: readPreview,
	found_author: skipTimestamp,
	reading_content: readContent,
	reading_reply_content: readReplyContent,
}

// --- Dispatcher -------------------------------------------------------------

export function parseTeamsStateMachine(raw: string): ScrapedData {
	const ctx = createContext(raw.split('\n'))

	for (ctx.index = 0; ctx.index < ctx.lines.length; ctx.index++) {
		const view = viewLine(ctx.lines, ctx.index)

		// Debug: Check for Begin Reference anywhere
		if (isReplyReference(view.trimmed)) {
			debug(
				() =>
					`[DEBUG] Line ${ctx.index}: Begin Reference found, current state: ${ctx.state}`,
			)
		}

		// Skip UI chrome at the top
		if (ctx.state === 'seeking' && isUiChrome(view.trimmed)) continue

		handlers[ctx.state](ctx, view)
	}

	// Don't forget the last message
	flushPendingMessage(ctx)

	return buildScrapedData(findChannel(raw), ctx.messages)
}
