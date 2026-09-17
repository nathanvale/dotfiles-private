// Duplicate-aware, bounded JSON decoding for durable and authority-bearing state. JSON.parse alone silently
// accepts duplicate object keys and a `__proto__` member (which Object.keys then hides), so this small parser owns
// the stricter private-state contract: every own key of a decoded object is exactly one key in the text.

class ClosedJsonError extends Error {}

/** The one member name whose assignment does not create an own property. */
const PROTO_KEY = "__proto__"
/** JSON allows exactly these four whitespace characters (RFC 8259 section 2); every other space is content. */
const JSON_SPACE = new Set([" ", "\t", "\n", "\r"])

class Parser {
	private index = 0

	constructor(private readonly text: string) {}

	parse(): unknown {
		const value = this.value()
		this.space()
		if (this.index !== this.text.length) this.fail("trailing content")
		return value
	}

	private value(): unknown {
		this.space()
		const character = this.text[this.index]
		if (character === "{") return this.object()
		if (character === "[") return this.array()
		if (character === '"') return this.string()
		if (character === "t") return this.literal("true", true)
		if (character === "f") return this.literal("false", false)
		if (character === "n") return this.literal("null", null)
		if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) return this.number()
		return this.fail("expected a JSON value")
	}

	private object(): Record<string, unknown> {
		this.index += 1
		const result: Record<string, unknown> = {}
		const keys = new Set<string>()
		this.space()
		if (this.take("}")) return result
		for (;;) {
			this.space()
			if (this.text[this.index] !== '"') this.fail("expected an object key")
			const key = this.string()
			if (keys.has(key)) this.fail(`duplicate object key ${JSON.stringify(key)}`)
			if (key === PROTO_KEY) this.fail(`unsafe object key ${JSON.stringify(key)}`)
			keys.add(key)
			this.space()
			if (!this.take(":")) this.fail("expected ':' after an object key")
			result[key] = this.value()
			this.space()
			if (this.take("}")) return result
			if (!this.take(",")) this.fail("expected ',' or '}' in an object")
		}
	}

	private array(): unknown[] {
		this.index += 1
		const result: unknown[] = []
		this.space()
		if (this.take("]")) return result
		for (;;) {
			result.push(this.value())
			this.space()
			if (this.take("]")) return result
			if (!this.take(",")) this.fail("expected ',' or ']' in an array")
		}
	}

	private string(): string {
		const start = this.index
		this.index += 1
		let escaped = false
		while (this.index < this.text.length) {
			const code = this.text.charCodeAt(this.index)
			if (!escaped && code === 0x22) {
				this.index += 1
				try {
					return JSON.parse(this.text.slice(start, this.index)) as string
				} catch {
					return this.fail("invalid JSON string")
				}
			}
			if (!escaped && code < 0x20) this.fail("unescaped control character in a string")
			if (!escaped && code === 0x5c) escaped = true
			else escaped = false
			this.index += 1
		}
		return this.fail("unterminated JSON string")
	}

	private number(): number {
		const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.index))
		if (match === null) return this.fail("invalid JSON number")
		this.index += match[0].length
		const value = Number(match[0])
		if (!Number.isFinite(value)) return this.fail("non-finite JSON number")
		return value
	}

	private literal<T>(spelling: string, value: T): T {
		if (!this.text.startsWith(spelling, this.index)) return this.fail(`invalid JSON literal`)
		this.index += spelling.length
		return value
	}

	private space(): void {
		while (JSON_SPACE.has(this.text[this.index] ?? "")) this.index += 1
	}

	private take(character: string): boolean {
		if (this.text[this.index] !== character) return false
		this.index += 1
		return true
	}

	private fail(message: string): never {
		throw new ClosedJsonError(`${message} at byte ${Buffer.byteLength(this.text.slice(0, this.index), "utf8")}`)
	}
}

function decodeUtf8(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
	} catch {
		throw new ClosedJsonError("input is not strict UTF-8")
	}
}

function parseClosedJson(text: string): unknown {
	return new Parser(text).parse()
}

export function parseClosedJsonBytes(bytes: Uint8Array, limit: number): unknown {
	if (bytes.byteLength > limit) throw new ClosedJsonError(`input exceeds ${limit} bytes`)
	return parseClosedJson(decodeUtf8(bytes))
}
