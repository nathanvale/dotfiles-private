/**
 * Message assembly: turns the buffers the parser collects into the JSON
 * shapes the CLI writes.
 */

import { isValidAuthor } from './lines'
import type {
	Attachment,
	Reaction,
	ReplyTo,
	ScrapedData,
	TeamsMessage,
} from './types'

/**
 * Extracts @mentions from message content
 */
function extractMentions(content: string): string[] {
	const mentions: string[] = []

	// Pattern for explicit mentions (names without @)
	// Teams shows "FirstName LastName" or just "FirstName" for mentions
	// Usually followed by comma or space

	// Check for "Everyone" mention
	if (content.includes('Everyone')) {
		mentions.push('Everyone')
	}

	// Look for name patterns that appear to be mentions
	// This is heuristic - names at start of sentences or after commas
	const namePattern = /(?:^|,\s*)([A-Z][a-z]+ [A-Z][a-z]+)(?=\s|,|$|\?)/g
	let match: RegExpExecArray | null = namePattern.exec(content)
	while (match !== null) {
		const [, name = ''] = match
		if (!mentions.includes(name) && isValidAuthor(name)) {
			mentions.push(name)
		}
		match = namePattern.exec(content)
	}

	return mentions
}

/**
 * Generates a unique message ID
 */
function generateMessageId(author: string, timestamp: string): string {
	const authorSlug = author.toLowerCase().replace(/\s+/g, '-')
	const timeSlug = timestamp.replace(/[/\s:]/g, '').replace(/[ap]m/i, '')
	return `${authorSlug}-${timeSlug}`
}

/**
 * Parses DD/MM/YYYY timestamp to Date
 */
function parseDate(timestamp: string): Date | null {
	const match = timestamp.match(
		/(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) ([ap]m)/i,
	)
	if (!match) return null

	const [, day = '', month = '', year = '', hour = '', minute = '', ampm = ''] =
		match
	let h = parseInt(hour, 10)
	if (ampm.toLowerCase() === 'pm' && h !== 12) h += 12
	if (ampm.toLowerCase() === 'am' && h === 12) h = 0

	return new Date(
		parseInt(year, 10),
		parseInt(month, 10) - 1,
		parseInt(day, 10),
		h,
		parseInt(minute, 10),
	)
}

/** The buffers one message accumulates while the parser reads it. */
export interface MessageDraft {
	author: string
	timestamp: string
	content: string[]
	reactions: Reaction[]
	attachments: Attachment[]
	isReply: boolean
	replyTo?: ReplyTo | undefined
}

export function createMessage(draft: MessageDraft): TeamsMessage {
	const { author, timestamp, content, reactions, attachments, isReply, replyTo } =
		draft
	const [datePart = ''] = timestamp.split(' ')
	const timePart = timestamp.replace(`${datePart} `, '')
	const contentText = content.join('\n').trim()

	return {
		id: generateMessageId(author, timestamp),
		author,
		timestamp,
		date: datePart,
		time: timePart,
		content: contentText,
		isReply,
		replyTo,
		reactions,
		attachments,
		mentions: extractMentions(contentText),
	}
}

function isoDay(time: number): string {
	return new Date(time).toISOString().slice(0, 10)
}

export function buildScrapedData(
	channel: string,
	messages: TeamsMessage[],
): ScrapedData {
	// Calculate date range
	const times = messages
		.map((m) => parseDate(m.timestamp))
		.filter((d): d is Date => d !== null)
		.map((d) => d.getTime())

	return {
		channel,
		scrapedAt: new Date().toISOString(),
		messageCount: messages.length,
		dateRange: {
			earliest: times.length > 0 ? isoDay(Math.min(...times)) : '',
			latest: times.length > 0 ? isoDay(Math.max(...times)) : '',
		},
		messages,
	}
}
