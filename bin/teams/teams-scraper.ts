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

import { parseArgs } from 'node:util'
import { $ } from 'bun'
import { parseTeamsStateMachine } from './lib/parser'

/**
 * Captures Teams chat content via clipboard
 */
async function captureTeamsContent(): Promise<string> {
	console.log('📋 Activating Teams and capturing content...')

	// Activate Teams
	await $`osascript -e 'tell application "Microsoft Teams" to activate'`
	await Bun.sleep(500)

	// Select all and copy
	await $`osascript -e 'tell application "System Events" to keystroke "a" using command down'`
	await Bun.sleep(300)
	await $`osascript -e 'tell application "System Events" to keystroke "c" using command down'`
	await Bun.sleep(500)

	// Deselect
	await $`osascript -e 'tell application "System Events" to key code 53'`

	// Get clipboard content
	const result = await $`pbpaste`.text()
	return result
}

// Main execution
async function main() {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			channel: { type: 'string', short: 'c' },
			output: { type: 'string', short: 'o', default: './teams-messages.json' },
			raw: { type: 'string', short: 'r' },
			help: { type: 'boolean', short: 'h' },
		},
		strict: true,
	})

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
`)
		return
	}

	let rawContent: string

	if (values.raw) {
		console.log(`📄 Reading from file: ${values.raw}`)
		rawContent = await Bun.file(values.raw).text()
	} else {
		rawContent = await captureTeamsContent()
	}

	console.log(`📊 Captured ${rawContent.length} characters`)

	// Parse the content
	console.log('🔍 Parsing messages...')
	const data = parseTeamsStateMachine(rawContent)

	console.log(`✅ Parsed ${data.messageCount} messages`)
	console.log(
		`📅 Date range: ${data.dateRange.earliest} to ${data.dateRange.latest}`,
	)
	console.log(`📢 Channel: ${data.channel}`)

	// Write output
	const outputPath = values.output || './teams-messages.json'
	await Bun.write(outputPath, JSON.stringify(data, null, 2))
	console.log(`💾 Saved to: ${outputPath}`)

	// Print sample
	if (data.messages.length > 0) {
		console.log('\n📝 Sample messages:')
		for (const msg of data.messages.slice(0, 3)) {
			console.log(
				`  [${msg.timestamp}] ${msg.author}: ${msg.content.substring(0, 60)}...`,
			)
			if (msg.reactions.length > 0) {
				console.log(
					`    Reactions: ${msg.reactions.map((r) => `${r.emoji || r.name}(${r.count})`).join(', ')}`,
				)
			}
		}
	}
}

main().catch(console.error)
