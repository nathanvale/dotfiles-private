/**
 * Shared line sanitizer for hooks that inject git state (branch names, commit
 * subjects, status lines) into hook output: strips control characters and
 * collapses whitespace so untrusted git text can't break the surrounding
 * markdown or smuggle a control sequence into the transcript.
 */

/** Strips ASCII control characters (0x00-0x1F and 0x7F) via charCodeAt to avoid Biome's noControlCharactersInRegex lint rule on regex literals. */
export function sanitizeContextLine(value: string): string {
	let out = ''
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i)
		out += c <= 0x1f || c === 0x7f ? ' ' : value[i]
	}
	return out.replace(/```/g, "'''").replace(/\s+/g, ' ').trim()
}
