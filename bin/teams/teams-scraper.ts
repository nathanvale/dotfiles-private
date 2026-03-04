#!/usr/bin/env bun
/**
 * Microsoft Teams Chat Scraper POC
 *
 * Extracts chat messages from Microsoft Teams via clipboard capture.
 * Parses the raw text into structured JSON with metadata.
 *
 * Usage:
 *   1. Open Teams to the desired channel
 *   2. Run: bun teams-scraper.ts [--channel "🏆Engineers"] [--output ./output.json]
 *   3. Script will capture, parse, and save messages
 */

import { $ } from "bun";
import { parseArgs } from "util";

const DEBUG_REPLIES = false;

interface TeamsMessage {
	id: string;
	author: string;
	timestamp: string;
	date: string;
	time: string;
	content: string;
	isReply: boolean;
	replyTo?: {
		author: string;
		timestamp: string;
		preview: string;
	};
	reactions: Reaction[];
	attachments: Attachment[];
	mentions: string[];
}

interface Reaction {
	emoji: string;
	name: string;
	count: number;
}

interface Attachment {
	type: "image" | "gif" | "link" | "file" | "praise";
	description: string;
	url?: string;
}

interface ScrapedData {
	channel: string;
	scrapedAt: string;
	messageCount: number;
	dateRange: {
		earliest: string;
		latest: string;
	};
	messages: TeamsMessage[];
}

/**
 * Captures Teams chat content via clipboard
 */
async function captureTeamsContent(): Promise<string> {
	console.log("📋 Activating Teams and capturing content...");

	// Activate Teams
	await $`osascript -e 'tell application "Microsoft Teams" to activate'`;
	await Bun.sleep(500);

	// Select all and copy
	await $`osascript -e 'tell application "System Events" to keystroke "a" using command down'`;
	await Bun.sleep(300);
	await $`osascript -e 'tell application "System Events" to keystroke "c" using command down'`;
	await Bun.sleep(500);

	// Deselect
	await $`osascript -e 'tell application "System Events" to key code 53'`;

	// Get clipboard content
	const result = await $`pbpaste`.text();
	return result;
}

/**
 * Checks if a string looks like a valid author name
 */
function isValidAuthor(name: string): boolean {
	// Filter out UI elements that look like names
	const invalidNames = [
		"Chat",
		"Channels",
		"Chats",
		"Meeting",
		"Unread",
		"Has context menu",
		"Last read",
		"Jump to newest",
		"Meet now",
		"Sign in",
		"See more",
	];

	const trimmed = name.trim();
	if (invalidNames.some((invalid) => trimmed.includes(invalid))) {
		return false;
	}

	// Must have at least first and last name pattern
	return /^[A-Z][a-z]+ [A-Z][a-z]+/.test(trimmed);
}

/**
 * Extracts @mentions from message content
 */
function extractMentions(content: string): string[] {
	const mentions: string[] = [];

	// Pattern for explicit mentions (names without @)
	// Teams shows "FirstName LastName" or just "FirstName" for mentions
	// Usually followed by comma or space

	// Check for "Everyone" mention
	if (content.includes("Everyone")) {
		mentions.push("Everyone");
	}

	// Look for name patterns that appear to be mentions
	// This is heuristic - names at start of sentences or after commas
	const namePattern = /(?:^|,\s*)([A-Z][a-z]+ [A-Z][a-z]+)(?=\s|,|$|\?)/g;
	let match: RegExpExecArray | null = namePattern.exec(content);
	while (match !== null) {
		const name = match[1];
		if (!mentions.includes(name) && isValidAuthor(name)) {
			mentions.push(name);
		}
		match = namePattern.exec(content);
	}

	return mentions;
}

/**
 * Generates a unique message ID
 */
function generateMessageId(author: string, timestamp: string): string {
	const authorSlug = author.toLowerCase().replace(/\s+/g, "-");
	const timeSlug = timestamp.replace(/[/\s:]/g, "").replace(/[ap]m/i, "");
	return `${authorSlug}-${timeSlug}`;
}

/**
 * Parses DD/MM/YYYY timestamp to Date
 */
function parseDate(timestamp: string): Date | null {
	const match = timestamp.match(
		/(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) ([ap]m)/i,
	);
	if (!match) return null;

	const [, day, month, year, hour, minute, ampm] = match;
	let h = parseInt(hour);
	if (ampm.toLowerCase() === "pm" && h !== 12) h += 12;
	if (ampm.toLowerCase() === "am" && h === 12) h = 0;

	return new Date(
		parseInt(year),
		parseInt(month) - 1,
		parseInt(day),
		h,
		parseInt(minute),
	);
}

/**
 * Line-by-line state machine parser (most reliable)
 *
 * Teams clipboard format:
 * - Each message has a "preview header": "Content preview... by AuthorName"
 * - Followed by: AuthorName\nDD/MM/YYYY H:MM am/pm\n\nActual content
 * - Reactions appear as: emoji\nN emoji-name reactions.\nN
 * - Replies start with "Begin Reference,"
 */
function parseTeamsStateMachine(raw: string): ScrapedData {
	const messages: TeamsMessage[] = [];

	// Find channel name
	const channelMatch = raw.match(/([🏆🎯📊🔧💡][^\n]+)\n/u);
	const channel = channelMatch ? channelMatch[1].trim() : "Unknown Channel";

	const lines = raw.split("\n");
	const timestampRegex = /^(\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} [ap]m)$/;

	// State machine
	type ParseState =
		| "seeking"
		| "found_preview"
		| "found_author"
		| "reading_content"
		| "reading_reply_content";
	let state: ParseState = "seeking";
	let skipQuotedLines = 0; // Counter to skip quoted content in replies

	let currentAuthor = "";
	let currentTimestamp = "";
	let currentContent: string[] = [];
	let currentReactions: Reaction[] = [];
	let currentAttachments: Attachment[] = [];
	let isReply = false;
	let replyTo: TeamsMessage["replyTo"];

	// Helper to check if a line is a "preview by Author" header
	const isPreviewHeader = (line: string): boolean => {
		return (
			/ by [A-Z][a-z]+ [A-Z][a-z]+$/.test(line) &&
			!line.startsWith("Begin Reference")
		);
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		const nextLine = lines[i + 1]?.trim() || "";
		const lineAfterNext = lines[i + 2]?.trim() || "";

		// Debug: Check for Begin Reference anywhere
		if (DEBUG_REPLIES && trimmed.startsWith("Begin Reference,")) {
			console.log(
				`[DEBUG] Line ${i}: Begin Reference found, current state: ${state}`,
			);
		}

		// Skip UI chrome at the top
		if (state === "seeking") {
			if (
				trimmed === "" ||
				trimmed === "Chat" ||
				trimmed === "Shared" ||
				trimmed === "Has context menu" ||
				trimmed === "Meet now" ||
				trimmed === "Unread" ||
				trimmed === "Channels" ||
				trimmed === "Chats" ||
				trimmed === "Meeting chats" ||
				trimmed.includes("Sign in") ||
				trimmed.includes("notifications") ||
				/^\d+$/.test(trimmed)
			) {
				continue;
			}
		}

		switch (state) {
			case "seeking":
				// Check for reply reference (Begin Reference,)
				// Format: "Begin Reference, preview by ReplyAuthor"
				// Then: ReplyAuthor\nTimestamp\n\nOriginalAuthor\nTimestamp\nQuotedContent\nActualReplyContent
				if (trimmed.startsWith("Begin Reference,")) {
					if (DEBUG_REPLIES)
						console.log(
							`[DEBUG] Line ${i}: Found Begin Reference in seeking state`,
						);
					const refMatch = trimmed.match(
						/Begin Reference, (.+) by ([A-Z][a-z]+ [A-Z][a-z ]+)$/,
					);
					if (refMatch) {
						const replyAuthor = refMatch[2].trim();
						const preview = refMatch[1].trim();
						if (DEBUG_REPLIES)
							console.log(
								`[DEBUG]   Reply author: ${replyAuthor}, preview: ${preview.substring(0, 30)}...`,
							);

						// Save any previous message
						if (
							currentAuthor &&
							currentTimestamp &&
							(currentContent.length > 0 || currentReactions.length > 0)
						) {
							if (DEBUG_REPLIES)
								console.log(
									`[DEBUG]   Saving previous message: ${currentAuthor} (isReply: ${isReply})`,
								);
							messages.push(
								createMessage(
									currentAuthor,
									currentTimestamp,
									currentContent,
									currentReactions,
									currentAttachments,
									isReply,
									replyTo,
								),
							);
						}

						// Find reply author line and original author line
						let replyTimestamp = "";
						let originalAuthor = "";
						let originalTimestamp = "";
						let originalAuthorLineIndex = -1;
						let foundReplyAuthorLine = false;

						for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
							const scanLine = lines[j]?.trim() || "";
							const scanNextLine = lines[j + 1]?.trim() || "";

							// Find reply author (first author match)
							if (
								!foundReplyAuthorLine &&
								scanLine === replyAuthor &&
								timestampRegex.test(scanNextLine)
							) {
								replyTimestamp = scanNextLine;
								foundReplyAuthorLine = true;
								if (DEBUG_REPLIES)
									console.log(
										`[DEBUG]   Found reply timestamp: ${replyTimestamp}`,
									);
								continue;
							}

							// Find original author (second author match - can be same person for self-replies)
							if (
								foundReplyAuthorLine &&
								!originalAuthor &&
								isValidAuthor(scanLine) &&
								timestampRegex.test(scanNextLine)
							) {
								originalAuthor = scanLine;
								originalTimestamp = scanNextLine;
								originalAuthorLineIndex = j;
								if (DEBUG_REPLIES)
									console.log(
										`[DEBUG]   Found original author: ${originalAuthor} at line ${j}`,
									);
								break;
							}
						}

						if (replyTimestamp && originalAuthor) {
							if (DEBUG_REPLIES)
								console.log(
									`[DEBUG]   Setting up reply: ${replyAuthor} replying to ${originalAuthor}`,
								);
							// Set up the reply message
							currentAuthor = replyAuthor;
							currentTimestamp = replyTimestamp;
							currentContent = [];
							currentReactions = [];
							currentAttachments = [];
							isReply = true;
							skipQuotedLines = 0; // Reset quoted line counter
							replyTo = {
								author: originalAuthor,
								timestamp: originalTimestamp,
								preview: preview,
							};

							// Skip ahead past the quoted content
							// We need to find where the quoted content ends
							// It ends when we hit a new preview header, new author line, or reactions
							if (originalAuthorLineIndex > 0) {
								// Skip to after original author's timestamp line
								i = originalAuthorLineIndex + 1; // Will be incremented by for loop
								state = "reading_reply_content";
								if (DEBUG_REPLIES)
									console.log(
										`[DEBUG]   Transitioning to reading_reply_content, i=${i}`,
									);
							}
						} else {
							if (DEBUG_REPLIES)
								console.log(
									`[DEBUG]   Failed to find reply/original author! replyTimestamp=${replyTimestamp}, originalAuthor=${originalAuthor}`,
								);
						}
					} else {
						if (DEBUG_REPLIES)
							console.log(`[DEBUG]   Begin Reference regex did not match!`);
					}
					continue;
				}

				// Check for preview header: "Content... by AuthorName"
				// Next line should be the same AuthorName, then timestamp
				if (
					isPreviewHeader(trimmed) &&
					isValidAuthor(nextLine) &&
					timestampRegex.test(lineAfterNext)
				) {
					// This is a preview header - skip it, we'll get content from the actual message
					state = "found_preview";
					continue;
				}

				// Check for direct author + timestamp (no preview header)
				if (isValidAuthor(trimmed) && timestampRegex.test(nextLine)) {
					// Save previous message if exists
					if (
						currentAuthor &&
						currentTimestamp &&
						(currentContent.length > 0 || currentReactions.length > 0)
					) {
						messages.push(
							createMessage(
								currentAuthor,
								currentTimestamp,
								currentContent,
								currentReactions,
								currentAttachments,
								isReply,
								replyTo,
							),
						);
					}

					// Start new message
					currentAuthor = trimmed;
					currentTimestamp = nextLine;
					currentContent = [];
					currentReactions = [];
					currentAttachments = [];
					if (!isReply) {
						replyTo = undefined;
					}
					state = "found_author";
				}
				break;

			case "found_preview":
				// Check for Begin Reference first (might be a reply after a preview)
				if (trimmed.startsWith("Begin Reference,")) {
					state = "seeking";
					i--; // Reprocess this line in seeking state
					break;
				}

				// After preview header, expect AuthorName + timestamp
				if (isValidAuthor(trimmed) && timestampRegex.test(nextLine)) {
					// Save previous message if exists
					if (
						currentAuthor &&
						currentTimestamp &&
						(currentContent.length > 0 || currentReactions.length > 0)
					) {
						messages.push(
							createMessage(
								currentAuthor,
								currentTimestamp,
								currentContent,
								currentReactions,
								currentAttachments,
								isReply,
								replyTo,
							),
						);
					}

					currentAuthor = trimmed;
					currentTimestamp = nextLine;
					currentContent = [];
					currentReactions = [];
					currentAttachments = [];
					if (!isReply) {
						replyTo = undefined;
					}
					state = "found_author";
				} else {
					// Not what we expected, go back to seeking
					state = "seeking";
				}
				break;

			case "found_author":
				// Skip the timestamp line
				if (timestampRegex.test(trimmed)) {
					state = "reading_content";
					isReply = false; // Reset for next message
				}
				break;

			case "reading_content":
				// Check for new message preview header
				if (
					isPreviewHeader(trimmed) &&
					isValidAuthor(nextLine) &&
					timestampRegex.test(lineAfterNext)
				) {
					// Save current message
					if (currentContent.length > 0 || currentReactions.length > 0) {
						messages.push(
							createMessage(
								currentAuthor,
								currentTimestamp,
								currentContent,
								currentReactions,
								currentAttachments,
								isReply,
								replyTo,
							),
						);
						currentContent = [];
						currentReactions = [];
						currentAttachments = [];
						isReply = false;
						replyTo = undefined;
					}
					state = "found_preview";
					break;
				}

				// Check for direct author + timestamp (new message without preview)
				if (isValidAuthor(trimmed) && timestampRegex.test(nextLine)) {
					// Save current message
					if (currentContent.length > 0 || currentReactions.length > 0) {
						messages.push(
							createMessage(
								currentAuthor,
								currentTimestamp,
								currentContent,
								currentReactions,
								currentAttachments,
								isReply,
								replyTo,
							),
						);
					}

					currentAuthor = trimmed;
					currentTimestamp = nextLine;
					currentContent = [];
					currentReactions = [];
					currentAttachments = [];
					isReply = false;
					replyTo = undefined;
					state = "found_author";
					break;
				}

				// Check for reply reference
				if (trimmed.startsWith("Begin Reference,")) {
					if (DEBUG_REPLIES)
						console.log(
							`[DEBUG] Line ${i}: Found Begin Reference in reading_content state`,
						);
					// Save current message first
					if (currentContent.length > 0 || currentReactions.length > 0) {
						messages.push(
							createMessage(
								currentAuthor,
								currentTimestamp,
								currentContent,
								currentReactions,
								currentAttachments,
								isReply,
								replyTo,
							),
						);
						currentContent = [];
						currentReactions = [];
						currentAttachments = [];
					}

					const refMatch = trimmed.match(
						/Begin Reference, (.+) by ([A-Z][a-z]+ [A-Z][a-z ]+)$/,
					);
					if (refMatch) {
						const replyAuthor = refMatch[2].trim();
						const preview = refMatch[1].trim();
						if (DEBUG_REPLIES)
							console.log(
								`[DEBUG]   Reply author: ${replyAuthor}, preview: ${preview.substring(0, 30)}...`,
							);

						// Find reply author line and original author line
						let replyTimestamp = "";
						let originalAuthor = "";
						let originalTimestamp = "";
						let originalAuthorLineIndex = -1;
						let foundReplyAuthorLine = false;

						for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
							const scanLine = lines[j]?.trim() || "";
							const scanNextLine = lines[j + 1]?.trim() || "";

							// Find reply author (first author match)
							if (
								!foundReplyAuthorLine &&
								scanLine === replyAuthor &&
								timestampRegex.test(scanNextLine)
							) {
								replyTimestamp = scanNextLine;
								foundReplyAuthorLine = true;
								if (DEBUG_REPLIES)
									console.log(
										`[DEBUG]   Found reply timestamp: ${replyTimestamp}`,
									);
								continue;
							}

							// Find original author (second author match - can be same person for self-replies)
							if (
								foundReplyAuthorLine &&
								!originalAuthor &&
								isValidAuthor(scanLine) &&
								timestampRegex.test(scanNextLine)
							) {
								originalAuthor = scanLine;
								originalTimestamp = scanNextLine;
								originalAuthorLineIndex = j;
								if (DEBUG_REPLIES)
									console.log(
										`[DEBUG]   Found original author: ${originalAuthor} at line ${j}`,
									);
								break;
							}
						}

						if (replyTimestamp && originalAuthor) {
							if (DEBUG_REPLIES)
								console.log(
									`[DEBUG]   Setting up reply: ${replyAuthor} replying to ${originalAuthor}`,
								);
							// Set up the reply message
							currentAuthor = replyAuthor;
							currentTimestamp = replyTimestamp;
							currentContent = [];
							currentReactions = [];
							currentAttachments = [];
							isReply = true;
							skipQuotedLines = 0; // Reset quoted line counter
							replyTo = {
								author: originalAuthor,
								timestamp: originalTimestamp,
								preview: preview,
							};

							// Skip ahead past the quoted content
							if (originalAuthorLineIndex > 0) {
								i = originalAuthorLineIndex + 1;
								state = "reading_reply_content";
								if (DEBUG_REPLIES)
									console.log(
										`[DEBUG]   Transitioning to reading_reply_content, i=${i}`,
									);
							}
						} else {
							if (DEBUG_REPLIES)
								console.log(
									`[DEBUG]   Failed to find reply/original author! replyTimestamp=${replyTimestamp}, originalAuthor=${originalAuthor}`,
								);
							state = "seeking";
						}
					} else {
						if (DEBUG_REPLIES)
							console.log(`[DEBUG]   Begin Reference regex did not match!`);
						state = "seeking";
					}
					break;
				}

				// Parse reactions: emoji followed by "N Name reactions."
				if (
					trimmed.length > 0 &&
					trimmed.length <= 4 &&
					/[^\w\s]/.test(trimmed)
				) {
					const countMatch = nextLine.match(
						/^(\d+) ([A-Za-z\s-]+) reactions?\.?$/,
					);
					if (countMatch) {
						currentReactions.push({
							emoji: trimmed,
							name: countMatch[2].trim(),
							count: parseInt(countMatch[1]),
						});
						i += 2; // Skip emoji line, count line, and the bare number line
						continue;
					}
				}

				// Skip custom emoji reactions (e.g., "exco_daniel", "blob-dance-emoji")
				if (
					/^[a-z_-]+$/.test(trimmed) &&
					/^\d+ [a-z_-]+ reactions?\.?$/i.test(nextLine)
				) {
					i += 2;
					continue;
				}

				// Skip standalone numbers (reaction count duplicates)
				if (/^\d+$/.test(trimmed)) {
					continue;
				}

				// Check for attachments
				if (
					trimmed.includes("(GIF Image)") ||
					trimmed.startsWith("GIF by") ||
					/GIF\)$/.test(trimmed)
				) {
					currentAttachments.push({ type: "gif", description: trimmed });
					continue;
				}
				if (trimmed.startsWith("Url Preview for")) {
					currentAttachments.push({
						type: "link",
						description: trimmed.replace("Url Preview for ", ""),
					});
					continue;
				}
				if (trimmed.startsWith("www.") || trimmed.startsWith("http")) {
					currentAttachments.push({ type: "link", description: trimmed });
					continue;
				}
				if (trimmed.includes("Praise card sent") || trimmed === "Praise") {
					currentAttachments.push({ type: "praise", description: trimmed });
					continue;
				}

				// Skip UI elements
				if (
					trimmed === "Last read" ||
					trimmed === "has context menu" ||
					trimmed === "Jump to newest" ||
					trimmed === "undefined" ||
					trimmed === "Review your praise history" ||
					trimmed === "Send praise"
				) {
					continue;
				}

				// Skip single reaction line format: "1 Name reaction."
				if (/^\d+ [A-Za-z\s-]+ reactions?\.?$/.test(trimmed)) {
					continue;
				}

				// Add to content (but not empty lines)
				if (trimmed) {
					currentContent.push(trimmed);
				}
				break;

			case "reading_reply_content":
				// In this state, we're inside a reply block after the original author's timestamp
				// The structure is: QuotedContent (often ending with …) then ActualReplyContent
				// We skip the quoted content and capture everything after the ellipsis line
				if (DEBUG_REPLIES)
					console.log(
						`[DEBUG] Line ${i} reading_reply_content: "${trimmed.substring(0, 50)}" (content.len=${currentContent.length}, skipQuoted=${skipQuotedLines})`,
					);

				// Check for new message (ends the reply)
				if (
					isPreviewHeader(trimmed) &&
					isValidAuthor(nextLine) &&
					timestampRegex.test(lineAfterNext)
				) {
					if (DEBUG_REPLIES)
						console.log(
							`[DEBUG]   -> New preview header, saving reply: ${currentAuthor} with ${currentContent.length} content lines`,
						);
					messages.push(
						createMessage(
							currentAuthor,
							currentTimestamp,
							currentContent,
							currentReactions,
							currentAttachments,
							isReply,
							replyTo,
						),
					);
					currentContent = [];
					currentReactions = [];
					currentAttachments = [];
					isReply = false;
					replyTo = undefined;
					state = "found_preview";
					break;
				}

				// Check for new Begin Reference (another reply)
				if (trimmed.startsWith("Begin Reference,")) {
					if (DEBUG_REPLIES)
						console.log(
							`[DEBUG]   -> New Begin Reference, saving reply: ${currentAuthor} with ${currentContent.length} content lines, isReply=${isReply}`,
						);
					messages.push(
						createMessage(
							currentAuthor,
							currentTimestamp,
							currentContent,
							currentReactions,
							currentAttachments,
							isReply,
							replyTo,
						),
					);
					currentContent = [];
					currentReactions = [];
					currentAttachments = [];
					isReply = false;
					replyTo = undefined;
					state = "seeking";
					i--;
					break;
				}

				// Check for direct author + timestamp
				if (isValidAuthor(trimmed) && timestampRegex.test(nextLine)) {
					if (DEBUG_REPLIES)
						console.log(
							`[DEBUG]   -> New author ${trimmed}, saving reply: ${currentAuthor} with ${currentContent.length} content lines`,
						);
					messages.push(
						createMessage(
							currentAuthor,
							currentTimestamp,
							currentContent,
							currentReactions,
							currentAttachments,
							isReply,
							replyTo,
						),
					);

					currentAuthor = trimmed;
					currentTimestamp = nextLine;
					currentContent = [];
					currentReactions = [];
					currentAttachments = [];
					isReply = false;
					replyTo = undefined;
					state = "found_author";
					break;
				}

				// Parse reactions
				if (
					trimmed.length > 0 &&
					trimmed.length <= 4 &&
					/[^\w\s]/.test(trimmed)
				) {
					const countMatch = nextLine.match(
						/^(\d+) ([A-Za-z\s-]+) reactions?\.?$/,
					);
					if (countMatch) {
						currentReactions.push({
							emoji: trimmed,
							name: countMatch[2].trim(),
							count: parseInt(countMatch[1]),
						});
						i += 2;
						continue;
					}
				}

				// Skip custom emoji reactions
				if (
					/^[a-z_-]+$/.test(trimmed) &&
					/^\d+ [a-z_-]+ reactions?\.?$/i.test(nextLine)
				) {
					i += 2;
					continue;
				}

				// Skip standalone numbers
				if (/^\d+$/.test(trimmed)) {
					continue;
				}

				// Skip single reaction line format
				if (/^\d+ [A-Za-z\s-]+ reactions?\.?$/.test(trimmed)) {
					continue;
				}

				// Skip UI elements
				if (
					trimmed === "Last read" ||
					trimmed === "has context menu" ||
					trimmed === "Jump to newest" ||
					trimmed === "undefined"
				) {
					continue;
				}

				// Quoted content in Teams replies often ends with "…" (ellipsis)
				// If we see a line ending with ellipsis, that's the end of quoted content
				// The next non-empty line is the actual reply
				if (trimmed.endsWith("…") || trimmed.endsWith("...")) {
					// This is the last line of quoted content - skip it
					// The next lines will be the actual reply
					if (DEBUG_REPLIES) console.log(`[DEBUG]   Skipping ellipsis line`);
					continue;
				}

				// Check if this line looks like it's part of the original quoted message
				// The first line after the original author's timestamp is the quoted content
				// It should roughly match the start of the preview text
				if (replyTo && currentContent.length === 0 && skipQuotedLines === 0) {
					// First non-empty line after original author timestamp - this is quoted content
					// Check if it looks like it could be the start of the original message (matches preview)
					const previewStart = replyTo.preview
						.replace(/…$/, "")
						.replace(/\.\.\.$/, "")
						.trim();
					// Check if this line is similar to the start of the preview (quoted message)
					if (
						trimmed.startsWith(
							previewStart.substring(0, Math.min(10, previewStart.length)),
						) ||
						previewStart.startsWith(
							trimmed.substring(0, Math.min(10, trimmed.length)),
						)
					) {
						if (DEBUG_REPLIES)
							console.log(
								`[DEBUG]   Skipping quoted content (matches preview)`,
							);
						skipQuotedLines = 1;
						continue;
					}
				}

				// Add to reply content
				if (trimmed) {
					if (DEBUG_REPLIES)
						console.log(
							`[DEBUG]   Adding reply content: "${trimmed.substring(0, 40)}"`,
						);
					currentContent.push(trimmed);
				}
				break;
		}
	}

	// Don't forget the last message
	if (
		currentAuthor &&
		currentTimestamp &&
		(currentContent.length > 0 || currentReactions.length > 0)
	) {
		messages.push(
			createMessage(
				currentAuthor,
				currentTimestamp,
				currentContent,
				currentReactions,
				currentAttachments,
				isReply,
				replyTo,
			),
		);
	}

	// Calculate date range
	const dates = messages
		.map((m) => parseDate(m.timestamp))
		.filter((d) => d !== null) as Date[];

	return {
		channel,
		scrapedAt: new Date().toISOString(),
		messageCount: messages.length,
		dateRange: {
			earliest:
				dates.length > 0
					? new Date(Math.min(...dates.map((d) => d.getTime())))
							.toISOString()
							.split("T")[0]
					: "",
			latest:
				dates.length > 0
					? new Date(Math.max(...dates.map((d) => d.getTime())))
							.toISOString()
							.split("T")[0]
					: "",
		},
		messages,
	};
}

function createMessage(
	author: string,
	timestamp: string,
	content: string[],
	reactions: Reaction[],
	attachments: Attachment[],
	isReply: boolean,
	replyTo?: TeamsMessage["replyTo"],
): TeamsMessage {
	const [datePart] = timestamp.split(" ");
	const timePart = timestamp.replace(datePart + " ", "");
	const contentText = content.join("\n").trim();

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
	};
}

// Main execution
async function main() {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			channel: { type: "string", short: "c" },
			output: { type: "string", short: "o", default: "./teams-messages.json" },
			raw: { type: "string", short: "r" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
	});

	if (values.help) {
		console.log(`
Microsoft Teams Chat Scraper

Usage:
  bun teams-scraper.ts [options]

Options:
  -c, --channel <name>   Expected channel name (for validation)
  -o, --output <path>    Output JSON file path (default: ./teams-messages.json)
  -r, --raw <path>       Use raw text file instead of clipboard capture
  -h, --help             Show this help message

Examples:
  bun teams-scraper.ts
  bun teams-scraper.ts -o ./engineers-chat.json
  bun teams-scraper.ts -r ./clipboard-dump.txt -o ./parsed.json
`);
		return;
	}

	let rawContent: string;

	if (values.raw) {
		console.log(`📄 Reading from file: ${values.raw}`);
		rawContent = await Bun.file(values.raw).text();
	} else {
		rawContent = await captureTeamsContent();
	}

	console.log(`📊 Captured ${rawContent.length} characters`);

	// Parse the content
	console.log("🔍 Parsing messages...");
	const data = parseTeamsStateMachine(rawContent);

	console.log(`✅ Parsed ${data.messageCount} messages`);
	console.log(
		`📅 Date range: ${data.dateRange.earliest} to ${data.dateRange.latest}`,
	);
	console.log(`📢 Channel: ${data.channel}`);

	// Write output
	const outputPath = values.output || "./teams-messages.json";
	await Bun.write(outputPath, JSON.stringify(data, null, 2));
	console.log(`💾 Saved to: ${outputPath}`);

	// Print sample
	if (data.messages.length > 0) {
		console.log("\n📝 Sample messages:");
		for (const msg of data.messages.slice(0, 3)) {
			console.log(
				`  [${msg.timestamp}] ${msg.author}: ${msg.content.substring(0, 60)}...`,
			);
			if (msg.reactions.length > 0) {
				console.log(
					`    Reactions: ${msg.reactions.map((r) => `${r.emoji || r.name}(${r.count})`).join(", ")}`,
				);
			}
		}
	}
}

main().catch(console.error);
