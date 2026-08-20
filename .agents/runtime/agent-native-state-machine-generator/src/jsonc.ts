/**
 * Hand-written data-only JSONC reader.
 *
 * Permits line comments, block comments and trailing commas. Rejects every
 * non-data construct (identifiers, calls, operators) with a located
 * diagnostic rather than silently coercing it. Values carry their own source
 * location so later stages can point at the exact offending element.
 */
import { type Diagnostic, diagnostic, type SourceLocation } from './diagnostics.ts'

export type JsonPrimitive = string | number | boolean | null

export type JsoncNode =
	| { readonly kind: 'object'; readonly entries: readonly JsoncEntry[]; readonly loc: SourceLocation }
	| { readonly kind: 'array'; readonly items: readonly JsoncNode[]; readonly loc: SourceLocation }
	| { readonly kind: 'string'; readonly value: string; readonly loc: SourceLocation }
	| { readonly kind: 'number'; readonly value: number; readonly loc: SourceLocation }
	| { readonly kind: 'boolean'; readonly value: boolean; readonly loc: SourceLocation }
	| { readonly kind: 'null'; readonly loc: SourceLocation }

export interface JsoncEntry {
	readonly key: string
	readonly keyLoc: SourceLocation
	readonly value: JsoncNode
}

export interface ParseSuccess {
	readonly ok: true
	readonly root: JsoncNode
	readonly diagnostics: readonly []
}

export interface ParseFailure {
	readonly ok: false
	readonly diagnostics: readonly Diagnostic[]
}

export type ParseResult = ParseSuccess | ParseFailure

/** Thrown internally to unwind to the single parse entry point. */
class ParseError extends Error {
	constructor(readonly diagnostic: Diagnostic) {
		super(diagnostic.message)
	}
}

const WHITESPACE = new Set([' ', '\t', '\r', '\n'])
const DIGITS = new Set('0123456789')

export function parseJsonc(text: string, sourcePath?: string): ParseResult {
	const parser = new Parser(text, sourcePath)
	try {
		const root = parser.parseDocument()
		return { ok: true, root, diagnostics: [] }
	} catch (error) {
		if (error instanceof ParseError) return { ok: false, diagnostics: [error.diagnostic] }
		throw error
	}
}

class Parser {
	private index = 0

	constructor(
		private readonly text: string,
		private readonly sourcePath?: string,
	) {}

	parseDocument(): JsoncNode {
		this.skipTrivia()
		const root = this.parseValue()
		this.skipTrivia()
		if (this.index < this.text.length) {
			this.fail('jsonc_syntax_error', `Unexpected trailing content ${this.describeHere()}.`)
		}
		return root
	}

	// --- position bookkeeping -------------------------------------------------

	private locationAt(offset: number): SourceLocation {
		let line = 1
		let lineStart = 0
		for (let i = 0; i < offset && i < this.text.length; i += 1) {
			if (this.text[i] === '\n') {
				line += 1
				lineStart = i + 1
			}
		}
		return { line, column: offset - lineStart + 1, offset }
	}

	private here(): SourceLocation {
		return this.locationAt(this.index)
	}

	private describeHere(): string {
		const char = this.text[this.index]
		return char === undefined ? 'at end of input' : `character ${JSON.stringify(char)}`
	}

	private fail(
		cause: 'jsonc_syntax_error' | 'jsonc_duplicate_key' | 'jsonc_non_data_value',
		message: string,
		location: SourceLocation = this.here(),
	): never {
		throw new ParseError(
			diagnostic({
				cause,
				stage: 'parse',
				message,
				path: '',
				location,
				...(this.sourcePath === undefined ? {} : { sourcePath: this.sourcePath }),
			}),
		)
	}

	// --- trivia ---------------------------------------------------------------

	/**
	 * Comments and whitespace carry no meaning and are discarded here. This is
	 * what makes comment placement invisible to the canonical form and digest.
	 */
	private skipTrivia(): void {
		for (;;) {
			const char = this.text[this.index]
			if (char !== undefined && WHITESPACE.has(char)) {
				this.index += 1
				continue
			}
			if (char === '/' && this.text[this.index + 1] === '/') {
				const end = this.text.indexOf('\n', this.index)
				this.index = end === -1 ? this.text.length : end
				continue
			}
			if (char === '/' && this.text[this.index + 1] === '*') {
				const end = this.text.indexOf('*/', this.index + 2)
				if (end === -1) this.fail('jsonc_syntax_error', 'Unterminated block comment.')
				this.index = end + 2
				continue
			}
			return
		}
	}

	// --- values ---------------------------------------------------------------

	private parseValue(): JsoncNode {
		const char = this.text[this.index]
		if (char === undefined) this.fail('jsonc_syntax_error', 'Unexpected end of input; expected a value.')
		if (char === '{') return this.parseObject()
		if (char === '[') return this.parseArray()
		if (char === '"') return this.parseString()
		if (char === '-' || DIGITS.has(char)) return this.parseNumber()
		return this.parseKeywordOrReject()
	}

	private parseObject(): JsoncNode {
		const loc = this.here()
		this.index += 1
		const entries: JsoncEntry[] = []
		const seen = new Map<string, SourceLocation>()
		for (;;) {
			this.skipTrivia()
			if (this.text[this.index] === '}') {
				this.index += 1
				return { kind: 'object', entries, loc }
			}
			if (this.index >= this.text.length) {
				this.fail('jsonc_syntax_error', 'Unexpected end of input inside an object.')
			}
			if (this.text[this.index] !== '"') {
				this.fail(
					'jsonc_syntax_error',
					`Object keys must be double-quoted strings; found ${this.describeHere()}.`,
				)
			}
			const keyLoc = this.here()
			const keyNode = this.parseString()
			const key = keyNode.kind === 'string' ? keyNode.value : ''
			const previous = seen.get(key)
			if (previous !== undefined) {
				this.fail(
					'jsonc_duplicate_key',
					`Duplicate object key ${JSON.stringify(key)} (first declared at line ${previous.line}).`,
					keyLoc,
				)
			}
			seen.set(key, keyLoc)
			this.skipTrivia()
			if (this.text[this.index] !== ':') {
				this.fail('jsonc_syntax_error', `Expected ":" after object key ${JSON.stringify(key)}.`)
			}
			this.index += 1
			this.skipTrivia()
			const value = this.parseValue()
			entries.push({ key, keyLoc, value })
			this.skipTrivia()
			const next = this.text[this.index]
			if (next === ',') {
				this.index += 1
				continue
			}
			if (next === '}') {
				this.index += 1
				return { kind: 'object', entries, loc }
			}
			this.fail('jsonc_syntax_error', `Expected "," or "}" in object; found ${this.describeHere()}.`)
		}
	}

	private parseArray(): JsoncNode {
		const loc = this.here()
		this.index += 1
		const items: JsoncNode[] = []
		for (;;) {
			this.skipTrivia()
			if (this.text[this.index] === ']') {
				this.index += 1
				return { kind: 'array', items, loc }
			}
			if (this.index >= this.text.length) {
				this.fail('jsonc_syntax_error', 'Unexpected end of input inside an array.')
			}
			items.push(this.parseValue())
			this.skipTrivia()
			const next = this.text[this.index]
			if (next === ',') {
				this.index += 1
				continue
			}
			if (next === ']') {
				this.index += 1
				return { kind: 'array', items, loc }
			}
			this.fail('jsonc_syntax_error', `Expected "," or "]" in array; found ${this.describeHere()}.`)
		}
	}

	private parseString(): JsoncNode {
		const loc = this.here()
		this.index += 1
		let value = ''
		for (;;) {
			const char = this.text[this.index]
			if (char === undefined || char === '\n') {
				this.fail('jsonc_syntax_error', 'Unterminated string literal.', loc)
			}
			if (char === '"') {
				this.index += 1
				return { kind: 'string', value, loc }
			}
			if (char === '\\') {
				value += this.parseEscape()
				continue
			}
			value += char
			this.index += 1
		}
	}

	private parseEscape(): string {
		const escapeLoc = this.here()
		this.index += 1
		const char = this.text[this.index]
		this.index += 1
		switch (char) {
			case '"':
				return '"'
			case '\\':
				return '\\'
			case '/':
				return '/'
			case 'b':
				return '\b'
			case 'f':
				return '\f'
			case 'n':
				return '\n'
			case 'r':
				return '\r'
			case 't':
				return '\t'
			case 'u': {
				const hex = this.text.slice(this.index, this.index + 4)
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
					this.fail('jsonc_syntax_error', 'Invalid \\u escape sequence.', escapeLoc)
				}
				this.index += 4
				return String.fromCharCode(Number.parseInt(hex, 16))
			}
			default:
				this.fail('jsonc_syntax_error', `Invalid escape sequence "\\${char ?? ''}".`, escapeLoc)
		}
	}

	private parseNumber(): JsoncNode {
		const loc = this.here()
		const start = this.index
		if (this.text[this.index] === '-') this.index += 1
		while (this.index < this.text.length && DIGITS.has(this.text[this.index] as string)) this.index += 1
		if (this.text[this.index] === '.') {
			this.index += 1
			while (this.index < this.text.length && DIGITS.has(this.text[this.index] as string)) this.index += 1
		}
		const exponent = this.text[this.index]
		if (exponent === 'e' || exponent === 'E') {
			this.index += 1
			const sign = this.text[this.index]
			if (sign === '+' || sign === '-') this.index += 1
			while (this.index < this.text.length && DIGITS.has(this.text[this.index] as string)) this.index += 1
		}
		const raw = this.text.slice(start, this.index)
		const value = Number(raw)
		if (!Number.isFinite(value)) {
			this.fail('jsonc_syntax_error', `Invalid number literal ${JSON.stringify(raw)}.`, loc)
		}
		return { kind: 'number', value, loc }
	}

	/**
	 * Only `true`, `false` and `null` are data keywords. Everything else that
	 * looks like an identifier (a function, an import, a computed expression) is
	 * refused here as a non-data value, which is the data-only ruling.
	 */
	private parseKeywordOrReject(): JsoncNode {
		const loc = this.here()
		const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.text.slice(this.index))
		if (match === null) {
			this.fail('jsonc_syntax_error', `Unexpected ${this.describeHere()}; expected a value.`, loc)
		}
		const word = match[0]
		this.index += word.length
		if (word === 'true') return { kind: 'boolean', value: true, loc }
		if (word === 'false') return { kind: 'boolean', value: false, loc }
		if (word === 'null') return { kind: 'null', loc }
		this.fail(
			'jsonc_non_data_value',
			`Non-data value ${JSON.stringify(word)}. Specifications are data-only: functions, imports, references and computed values are prohibited.`,
			loc,
		)
	}
}

/** Strips locations, yielding plain JSON data for canonicalization. */
export function toPlainValue(node: JsoncNode): unknown {
	switch (node.kind) {
		case 'object': {
			const result: Record<string, unknown> = {}
			for (const entry of node.entries) result[entry.key] = toPlainValue(entry.value)
			return result
		}
		case 'array':
			return node.items.map(toPlainValue)
		case 'null':
			return null
		default:
			return node.value
	}
}
