/**
 * JSON shapes written by the Teams scraper. These are the CLI's output
 * contract; keep field names and order stable.
 */

export interface TeamsMessage {
	id: string
	author: string
	timestamp: string
	date: string
	time: string
	content: string
	isReply: boolean
	replyTo?: ReplyTo | undefined
	reactions: Reaction[]
	attachments: Attachment[]
	mentions: string[]
}

export interface ReplyTo {
	author: string
	timestamp: string
	preview: string
}

export interface Reaction {
	emoji: string
	name: string
	count: number
}

export interface Attachment {
	type: 'image' | 'gif' | 'link' | 'file' | 'praise'
	description: string
	url?: string
}

export interface ScrapedData {
	channel: string
	scrapedAt: string
	messageCount: number
	dateRange: {
		earliest: string
		latest: string
	}
	messages: TeamsMessage[]
}
