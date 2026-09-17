import { describe, expect, test } from "bun:test"
import { parseClosedJsonBytes } from "../../src/closed-json.ts"

// The private-state JSON contract as literals (independent oracle): strict UTF-8, a byte bound, duplicate-aware
// objects, no `__proto__` member, and only the four JSON whitespace characters between tokens.

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const LIMIT = 1024

describe("parseClosedJsonBytes", () => {
	test("decodes nested values exactly as JSON.parse does for well-formed input", () => {
		const text = ' {"a": [1, 2.5, -3e2, true, false, null, "s\\u0041\\n"], "b": {"c": {}}, "d": []}\n'
		expect(parseClosedJsonBytes(bytes(text), LIMIT)).toEqual(JSON.parse(text))
	})

	test("accepts the four JSON whitespace characters around every token", () => {
		expect(parseClosedJsonBytes(bytes('\t\n\r {\r\n\t"k" \t:\n 1 \r}\n'), LIMIT)).toEqual({ k: 1 })
	})

	test.each([
		["a duplicate object key", '{"k": 1, "k": 2}', /duplicate object key "k"/],
		["a __proto__ member", '{"schemaVersion": 3, "__proto__": {"polluted": true}}', /unsafe object key "__proto__"/],
		["a nested __proto__ member", '{"a": {"__proto__": []}}', /unsafe object key "__proto__"/],
		["a no-break space between tokens", '{"k":\u00a01}', /expected a JSON value/],
		["a vertical tab before a value", "\u000b1", /expected a JSON value/],
		["a form feed after a value", "1\u000c", /trailing content/],
		["trailing content", "{} x", /trailing content/],
		["an unterminated string", '"abc', /unterminated JSON string/],
		["an unescaped control character", '"a\u0001b"', /unescaped control character/],
		["a leading-zero number", "01", /trailing content/],
		["a non-finite number", "1e999", /non-finite JSON number/],
		["an invalid literal", "nul", /invalid JSON literal/],
	])("refuses %s", (_label, text, message) => {
		expect(() => parseClosedJsonBytes(bytes(text), LIMIT)).toThrow(message)
	})

	test("refuses input over the byte bound before decoding it", () => {
		expect(() => parseClosedJsonBytes(bytes(`"${"x".repeat(LIMIT)}"`), LIMIT)).toThrow(/exceeds 1024 bytes/)
	})

	test("refuses bytes that are not strict UTF-8", () => {
		expect(() => parseClosedJsonBytes(new Uint8Array([0x22, 0xff, 0x22]), LIMIT)).toThrow(/not strict UTF-8/)
	})

	test("a decoded object never gains a prototype member, so Object.keys is the whole field set", () => {
		const decoded = parseClosedJsonBytes(bytes('{"constructor": 1, "toString": 2}'), LIMIT) as Record<string, unknown>
		expect(Object.keys(decoded)).toEqual(["constructor", "toString"])
		expect((decoded as { polluted?: unknown }).polluted).toBeUndefined()
	})
})
