/**
 * Line classification for the Teams clipboard format.
 *
 * Each predicate looks at one trimmed line (sometimes with the line or two
 * that follow it) and says what the state machine should treat it as.
 */

import type { Attachment, Reaction } from './types'

export const timestampRegex = /^(\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} [ap]m)$/

/** The current line plus the two that follow it, all trimmed. */
export interface LineView {
	trimmed: string
	nextLine: string
	lineAfterNext: string
}

export function viewLine(lines: string[], index: number): LineView {
	return {
		trimmed: lines[index]?.trim() || '',
		nextLine: lines[index + 1]?.trim() || '',
		lineAfterNext: lines[index + 2]?.trim() || '',
	}
}

/**
 * Checks if a string looks like a valid author name
 */
export function isValidAuthor(name: string): boolean {
	// Filter out UI elements that look like names
	const invalidNames = [
		'Chat',
		'Channels',
		'Chats',
		'Meeting',
		'Unread',
		'Has context menu',
		'Last read',
		'Jump to newest',
		'Meet now',
		'Sign in',
		'See more',
	]

	const trimmed = name.trim()
	if (invalidNames.some((invalid) => trimmed.includes(invalid))) {
		return false
	}

	// Must have at least first and last name pattern
	return /^[A-Z][a-z]+ [A-Z][a-z]+/.test(trimmed)
}

/** UI chrome at the top of the capture, skipped while seeking. */
export function isUiChrome(trimmed: string): boolean {
	const chromeLines = [
		'',
		'Chat',
		'Shared',
		'Has context menu',
		'Meet now',
		'Unread',
		'Channels',
		'Chats',
		'Meeting chats',
	]
	return (
		chromeLines.includes(trimmed) ||
		trimmed.includes('Sign in') ||
		trimmed.includes('notifications') ||
		isCountLine(trimmed)
	)
}

/** A "preview by Author" header line. */
function isPreviewHeader(line: string): boolean {
	return (
		/ by [A-Z][a-z]+ [A-Z][a-z]+$/.test(line) &&
		!line.startsWith('Begin Reference')
	)
}

/** Preview header followed by AuthorName then a timestamp. */
export function startsPreview(view: LineView): boolean {
	return (
		isPreviewHeader(view.trimmed) &&
		isValidAuthor(view.nextLine) &&
		timestampRegex.test(view.lineAfterNext)
	)
}

/** AuthorName followed by a timestamp (no preview header). */
export function startsAuthor(view: LineView): boolean {
	return isValidAuthor(view.trimmed) && timestampRegex.test(view.nextLine)
}

export function isReplyReference(trimmed: string): boolean {
	return trimmed.startsWith('Begin Reference,')
}

/** Format: "Begin Reference, preview by ReplyAuthor" */
export interface ReplyReference {
	replyAuthor: string
	preview: string
}

export function parseReplyReference(
	trimmed: string,
): ReplyReference | undefined {
	const refMatch = trimmed.match(
		/Begin Reference, (.+) by ([A-Z][a-z]+ [A-Z][a-z ]+)$/,
	)
	if (!refMatch) return undefined
	const [, preview = '', replyAuthor = ''] = refMatch
	return { replyAuthor: replyAuthor.trim(), preview: preview.trim() }
}

/** Reaction: emoji line followed by "N Name reactions." */
export function parseReaction(view: LineView): Reaction | undefined {
	const { trimmed, nextLine } = view
	if (trimmed.length === 0 || trimmed.length > 4 || !/[^\w\s]/.test(trimmed)) {
		return undefined
	}
	const countMatch = nextLine.match(/^(\d+) ([A-Za-z\s-]+) reactions?\.?$/)
	if (!countMatch) return undefined
	const [, count = '', name = ''] = countMatch
	return { emoji: trimmed, name: name.trim(), count: parseInt(count, 10) }
}

/** Custom emoji reaction (e.g., "exco_daniel", "blob-dance-emoji"). */
export function isCustomEmojiReaction(view: LineView): boolean {
	return (
		/^[a-z_-]+$/.test(view.trimmed) &&
		/^\d+ [a-z_-]+ reactions?\.?$/i.test(view.nextLine)
	)
}

/** Standalone number (reaction count duplicate). */
export function isCountLine(trimmed: string): boolean {
	return /^\d+$/.test(trimmed)
}

/** Single reaction line format: "1 Name reaction." */
export function isReactionSummary(trimmed: string): boolean {
	return /^\d+ [A-Za-z\s-]+ reactions?\.?$/.test(trimmed)
}

/** UI elements that appear between content lines. */
export function isUiElement(trimmed: string): boolean {
	return ['Last read', 'has context menu', 'Jump to newest', 'undefined'].includes(
		trimmed,
	)
}

/** Praise UI elements, skipped only in ordinary message content. */
export function isPraiseUiElement(trimmed: string): boolean {
	return trimmed === 'Review your praise history' || trimmed === 'Send praise'
}

export function parseAttachment(trimmed: string): Attachment | undefined {
	if (isGifLine(trimmed)) {
		return { type: 'gif', description: trimmed }
	}
	if (trimmed.startsWith('Url Preview for')) {
		return {
			type: 'link',
			description: trimmed.replace('Url Preview for ', ''),
		}
	}
	if (trimmed.startsWith('www.') || trimmed.startsWith('http')) {
		return { type: 'link', description: trimmed }
	}
	if (trimmed.includes('Praise card sent') || trimmed === 'Praise') {
		return { type: 'praise', description: trimmed }
	}
	return undefined
}

function isGifLine(trimmed: string): boolean {
	return (
		trimmed.includes('(GIF Image)') ||
		trimmed.startsWith('GIF by') ||
		/GIF\)$/.test(trimmed)
	)
}

/** Quoted content in Teams replies often ends with an ellipsis. */
export function isEllipsisLine(trimmed: string): boolean {
	return trimmed.endsWith('…') || trimmed.endsWith('...')
}

/**
 * Whether a line looks like the start of the quoted original message, by
 * comparing its first characters against the reply preview.
 */
export function matchesPreviewStart(preview: string, trimmed: string): boolean {
	const previewStart = preview.replace(/…$/, '').replace(/\.\.\.$/, '').trim()
	return (
		trimmed.startsWith(
			previewStart.substring(0, Math.min(10, previewStart.length)),
		) ||
		previewStart.startsWith(trimmed.substring(0, Math.min(10, trimmed.length)))
	)
}

/** Channel name: the first line that starts with a channel emoji. */
export function findChannel(raw: string): string {
	const channelMatch = raw.match(/([🏆🎯📊🔧💡][^\n]+)\n/u)
	return channelMatch?.[1]?.trim() ?? 'Unknown Channel'
}
