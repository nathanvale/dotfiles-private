/**
 * Shell Tokenizer
 *
 * A two-stage lexer for safe command parsing. Splits shell command strings
 * into typed tokens (operators, text, heredoc bodies) while tracking quoting
 * and subshell nesting state. Provides higher-level utilities to extract
 * command words, parse git invocations, and unwrap shell wrappers (sh -c,
 * eval, env, xargs).
 *
 * This module is intentionally limited to parsing/tokenizing -- it contains
 * no policy or safety logic. See git-safety.ts for the safety hook that
 * consumes these utilities.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LexerState =
	| 'normal'
	| 'single-quote'
	| 'double-quote'
	| 'backtick'
	| 'dollar-paren'
	| 'dollar-brace'
	| 'escape'

export type TokenType = 'operator' | 'text' | 'heredoc-body'

export interface Token {
	type: TokenType
	value: string
}

export interface TokenizeResult {
	tokens: Token[]
	unbalanced: boolean
}

export interface ShellParseResult {
	segments: string[]
	unbalanced: boolean
}

export interface CommandWords {
	words: string[]
	cmdIndex: number
	head: string | null
}

export interface GitInvocation {
	subcommand: string
	args: string[]
}

/** Result of removing benign command-execution prefixes (time/nice/command). */
interface PrefixStripResult {
	headIndex: number
	skippedPrefix: boolean
}

// ---------------------------------------------------------------------------
// Core tokenizer
// ---------------------------------------------------------------------------

/** Mutable cursor threaded through every per-state stepper function below. */
interface LexerContext {
	readonly command: string
	readonly length: number
	tokens: Token[]
	state: LexerState
	prevState: LexerState
	depth: number
	parenReturnStack: LexerState[]
	braceReturnStack: LexerState[]
	buf: string
	heredocDelimiter: string | null
	heredocStrip: boolean
	i: number
}

function createLexerContext(command: string): LexerContext {
	return {
		command,
		length: command.length,
		tokens: [],
		state: 'normal',
		prevState: 'normal',
		depth: 0,
		parenReturnStack: [],
		braceReturnStack: [],
		buf: '',
		heredocDelimiter: null,
		heredocStrip: false,
		i: 0,
	}
}

function flushBuf(ctx: LexerContext, type: TokenType = 'text'): void {
	if (ctx.buf.length > 0) {
		ctx.tokens.push({ type, value: ctx.buf })
		ctx.buf = ''
	}
}

function pushOperatorToken(ctx: LexerContext, op: string): void {
	flushBuf(ctx)
	ctx.tokens.push({ type: 'operator', value: op })
}

/** Enters escape state (backslash consumes the next char literally). */
function tryEnterEscape(
	ctx: LexerContext,
	ch: string,
	fromState: LexerState,
): boolean {
	if (ch !== '\\') return false
	ctx.prevState = fromState
	ctx.state = 'escape'
	ctx.buf += ch
	ctx.i++
	return true
}

/** Enters `$(...)` or `${...}` expansion state, remembering `returnState` so
 * the matching close paren/brace resumes the caller's state. */
function tryStartCommandOrParamExpansion(
	ctx: LexerContext,
	ch: string,
	returnState: LexerState,
): boolean {
	const { command, length } = ctx
	if (ch === '$' && ctx.i + 1 < length && command[ctx.i + 1] === '(') {
		ctx.parenReturnStack.push(returnState)
		ctx.state = 'dollar-paren'
		ctx.depth++
		ctx.buf += '$('
		ctx.i += 2
		return true
	}
	if (ch === '$' && ctx.i + 1 < length && command[ctx.i + 1] === '{') {
		ctx.braceReturnStack.push(returnState)
		ctx.state = 'dollar-brace'
		ctx.depth++
		ctx.buf += '${'
		ctx.i += 2
		return true
	}
	return false
}

/** Consumes a top-level shell operator (`;`, `&&`, `||`, `|`) and emits an
 * operator token. Returns false if `ch` does not start an operator. */
function tryConsumeOperator(ctx: LexerContext, ch: string): boolean {
	const { command, length } = ctx
	if (ch === ';') {
		pushOperatorToken(ctx, ';')
		ctx.i++
		return true
	}
	if (ch === '&' && ctx.i + 1 < length && command[ctx.i + 1] === '&') {
		pushOperatorToken(ctx, '&&')
		ctx.i += 2
		return true
	}
	if (ch === '|' && ctx.i + 1 < length && command[ctx.i + 1] === '|') {
		pushOperatorToken(ctx, '||')
		ctx.i += 2
		return true
	}
	if (ch === '|') {
		pushOperatorToken(ctx, '|')
		ctx.i++
		return true
	}
	return false
}

/** True when `ch` at ctx.i begins a heredoc redirect (`<<` or `<<-`), while
 * excluding the `<<<` here-string operator. Shared by the top-level heredoc
 * detector and the one used while scanning inside `$(...)`. */
function isHeredocRedirectStart(ctx: LexerContext, ch: string): boolean {
	const { command, length } = ctx
	return (
		ch === '<' &&
		ctx.i + 1 < length &&
		command[ctx.i + 1] === '<' &&
		(ctx.i + 2 >= length || command[ctx.i + 2] !== '<')
	)
}

/** Skips an optional `-` (heredoc strip flag) at `pos`. */
function readHeredocStripFlag(
	command: string,
	pos: number,
): { pos: number; strip: boolean } {
	if (command[pos] === '-') return { pos: pos + 1, strip: true }
	return { pos, strip: false }
}

/** Parses a heredoc delimiter (quoted, backslash-escaped, or bare) at `pos`,
 * discarding the source text (used when the delimiter itself never needs to
 * be replayed, i.e. top-level heredoc detection). */
function readHeredocDelimiterAt(
	command: string,
	pos: number,
): { delimiter: string; pos: number } {
	const length = command.length
	if (pos < length && (command[pos] === "'" || command[pos] === '"')) {
		const quoteChar = command[pos]
		let p = pos + 1
		let delimiter = ''
		while (p < length && command[p] !== quoteChar) {
			delimiter += command[p]
			p++
		}
		if (p < length) p++
		return { delimiter, pos: p }
	}
	if (pos < length && command[pos] === '\\') {
		let p = pos + 1
		let delimiter = ''
		while (p < length && /\S/.test(command[p] as string)) {
			delimiter += command[p]
			p++
		}
		return { delimiter, pos: p }
	}
	let p = pos
	let delimiter = ''
	while (p < length && /[A-Za-z0-9_]/.test(command[p] as string)) {
		delimiter += command[p]
		p++
	}
	return { delimiter, pos: p }
}

// Check for heredoc at end of a segment. Called after we see `<<`.
function tryParseHeredocStart(ctx: LexerContext): boolean {
	const { command, length } = ctx
	const { pos: afterStrip, strip } = readHeredocStripFlag(command, ctx.i)
	let pos = afterStrip
	while (pos < length && command[pos] === ' ') pos++
	const { delimiter, pos: afterDelimiter } = readHeredocDelimiterAt(
		command,
		pos,
	)
	if (delimiter.length === 0) return false
	ctx.heredocStrip = strip
	ctx.heredocDelimiter = delimiter
	ctx.i = afterDelimiter
	return true
}

/** Detects `<<`/`<<-` in normal state and attempts to parse a heredoc
 * delimiter immediately after it. Always consumes the `<<` characters when
 * matched, regardless of whether a valid delimiter was found. */
function tryStartHeredocRedirect(ctx: LexerContext, ch: string): boolean {
	if (!isHeredocRedirectStart(ctx, ch)) return false
	ctx.buf += '<<'
	ctx.i += 2
	// Try to parse heredoc delimiter
	if (tryParseHeredocStart(ctx)) {
		flushBuf(ctx)
		// heredocDelimiter is now set, the outer loop will collect the body
	}
	// If no valid delimiter found, just continue as text
	return true
}

/**
 * Collects a heredoc body starting at ctx.i until a line exactly matching
 * ctx.heredocDelimiter (after optional tab-stripping) is found, or input
 * ends. Pushes a single heredoc-body token (even if empty, as long as a
 * terminator was seen) and clears heredocDelimiter so the outer loop resumes
 * normal lexing.
 */
/** Reads one heredoc line starting at `i` (up to the next newline or end of
 * input), stripping a leading tab run when `strip` is set. Returns the
 * (possibly stripped) line, used only to test for the terminator, and the
 * index of the line's end (before its trailing newline, if any). */
function readHeredocLine(
	command: string,
	i: number,
	strip: boolean,
): { line: string; end: number } {
	const lineStart = i
	let end = i
	while (end < command.length && command[end] !== '\n') end++
	const raw = command.slice(lineStart, end)
	return { line: strip ? raw.replace(/^\t+/, '') : raw, end }
}

function collectHeredocBody(ctx: LexerContext): void {
	const { command, length } = ctx
	// We may be right after a newline or at start -- skip to next line
	// if current char is newline
	let pos = command[ctx.i] === '\n' ? ctx.i + 1 : ctx.i

	let body = ''
	let foundEnd = false
	while (pos < length) {
		const { line, end } = readHeredocLine(command, pos, ctx.heredocStrip)
		if (line.trim() === ctx.heredocDelimiter) {
			foundEnd = true
			pos = end < length ? end + 1 : end // skip the newline after delimiter
			break
		}
		body += `${command.slice(pos, end)}\n`
		pos = end < length ? end + 1 : end // skip newline
	}

	if (body.length > 0 || foundEnd) {
		ctx.tokens.push({ type: 'heredoc-body', value: body })
	}
	ctx.heredocDelimiter = null
	ctx.i = pos
}

function stepNormalState(ctx: LexerContext): void {
	const ch = ctx.command[ctx.i] ?? ''
	if (tryEnterEscape(ctx, ch, 'normal')) return
	if (ch === "'") {
		ctx.state = 'single-quote'
		ctx.buf += ch
		ctx.i++
		return
	}
	if (ch === '"') {
		ctx.state = 'double-quote'
		ctx.buf += ch
		ctx.i++
		return
	}
	if (ch === '`') {
		ctx.state = 'backtick'
		ctx.buf += ch
		ctx.i++
		return
	}
	if (tryStartCommandOrParamExpansion(ctx, ch, 'normal')) return
	if (tryConsumeOperator(ctx, ch)) return
	if (tryStartHeredocRedirect(ctx, ch)) return
	ctx.buf += ch
	ctx.i++
}

function stepEscapeState(ctx: LexerContext): void {
	ctx.buf += ctx.command[ctx.i]
	ctx.state = ctx.prevState
	ctx.i++
}

function stepSingleQuoteState(ctx: LexerContext): void {
	const ch = ctx.command[ctx.i] ?? ''
	ctx.buf += ch
	if (ch === "'") ctx.state = 'normal'
	ctx.i++
}

function stepDoubleQuoteState(ctx: LexerContext): void {
	const ch = ctx.command[ctx.i] ?? ''
	if (tryEnterEscape(ctx, ch, 'double-quote')) return
	if (tryStartCommandOrParamExpansion(ctx, ch, 'double-quote')) return
	ctx.buf += ch
	if (ch === '"' && ctx.depth === 0) ctx.state = 'normal'
	ctx.i++
}

function stepBacktickState(ctx: LexerContext): void {
	const ch = ctx.command[ctx.i] ?? ''
	ctx.buf += ch
	if (ch === '`') ctx.state = 'normal'
	ctx.i++
}

/** Tracks `$()` nesting depth as parens open/close inside dollar-paren
 * state. Returns false when `ch` is neither. */
function handleDollarParenNesting(ctx: LexerContext, ch: string): boolean {
	if (ch === '(') {
		ctx.depth++
		ctx.buf += ch
		ctx.i++
		return true
	}
	if (ch === ')') {
		ctx.depth--
		ctx.buf += ch
		ctx.i++
		if (ctx.depth === 0) {
			ctx.state = ctx.parenReturnStack.pop() ?? 'normal'
		}
		return true
	}
	return false
}

/** Consumes a single-quoted span (literal, no escapes) into ctx.buf. Assumes
 * ctx.command[ctx.i] is the opening quote -- single quotes inside `$()` still
 * work per shell semantics. */
function consumeSingleQuotedIntoBuf(ctx: LexerContext): void {
	const { command, length } = ctx
	ctx.buf += command[ctx.i]
	ctx.i++
	while (ctx.i < length && command[ctx.i] !== "'") {
		ctx.buf += command[ctx.i]
		ctx.i++
	}
	if (ctx.i < length) {
		ctx.buf += command[ctx.i]
		ctx.i++
	}
}

/** Consumes a double-quoted span (honoring backslash escapes) into ctx.buf.
 * Assumes ctx.command[ctx.i] is the opening quote. */
function consumeDoubleQuotedIntoBuf(ctx: LexerContext): void {
	const { command, length } = ctx
	ctx.buf += command[ctx.i]
	ctx.i++
	while (ctx.i < length && command[ctx.i] !== '"') {
		if (command[ctx.i] === '\\') {
			ctx.buf += command[ctx.i]
			ctx.i++
			if (ctx.i < length) {
				ctx.buf += command[ctx.i]
				ctx.i++
			}
		} else {
			ctx.buf += command[ctx.i]
			ctx.i++
		}
	}
	if (ctx.i < length) {
		ctx.buf += command[ctx.i]
		ctx.i++
	}
}

/** Consumes a `'quoted'`/`"quoted"` heredoc delimiter into ctx.buf, given that
 * `ctx.command[ctx.i]` is the opening quote character. */
function consumeQuotedHeredocDelimiterIntoBuf(ctx: LexerContext): string {
	const { command, length } = ctx
	const quoteChar = command[ctx.i]!
	let delimiter = ''
	ctx.buf += quoteChar
	ctx.i++
	while (ctx.i < length && command[ctx.i] !== quoteChar) {
		delimiter += command[ctx.i]
		ctx.buf += command[ctx.i]!
		ctx.i++
	}
	if (ctx.i < length) {
		ctx.buf += command[ctx.i]!
		ctx.i++
	}
	return delimiter
}

/** Consumes a `\delimiter`-style heredoc delimiter into ctx.buf, given that
 * `ctx.command[ctx.i]` is the leading backslash. */
function consumeEscapedHeredocDelimiterIntoBuf(ctx: LexerContext): string {
	const { command, length } = ctx
	let delimiter = ''
	ctx.buf += command[ctx.i]!
	ctx.i++
	while (ctx.i < length && /\S/.test(command[ctx.i] as string)) {
		delimiter += command[ctx.i]
		ctx.buf += command[ctx.i]!
		ctx.i++
	}
	return delimiter
}

/** Consumes an unquoted `[A-Za-z0-9_]+` heredoc delimiter into ctx.buf. */
function consumeBareHeredocDelimiterIntoBuf(ctx: LexerContext): string {
	const { command, length } = ctx
	let delimiter = ''
	while (ctx.i < length && /[A-Za-z0-9_]/.test(command[ctx.i] as string)) {
		delimiter += command[ctx.i]
		ctx.buf += command[ctx.i]!
		ctx.i++
	}
	return delimiter
}

/** Parses a heredoc delimiter after `<<`/`<<-` while preserving the exact
 * source text in ctx.buf -- used inside `$()`, where the original heredoc
 * text must survive so the substitution can be recursively re-parsed. */
function consumeHeredocDelimiterIntoBuf(ctx: LexerContext): {
	delimiter: string
	strip: boolean
} {
	const { command, length } = ctx
	let strip = false
	// Parse optional `-` for <<-
	if (ctx.i < length && command[ctx.i] === '-') {
		strip = true
		ctx.buf += '-'
		ctx.i++
	}
	// Skip spaces between << and delimiter
	while (ctx.i < length && command[ctx.i] === ' ') {
		ctx.buf += ' '
		ctx.i++
	}

	if (ctx.i < length && (command[ctx.i] === "'" || command[ctx.i] === '"')) {
		return { delimiter: consumeQuotedHeredocDelimiterIntoBuf(ctx), strip }
	}
	if (ctx.i < length && command[ctx.i] === '\\') {
		return { delimiter: consumeEscapedHeredocDelimiterIntoBuf(ctx), strip }
	}
	return { delimiter: consumeBareHeredocDelimiterIntoBuf(ctx), strip }
}

/** Consumes a heredoc body line-by-line into ctx.buf, preserving the exact
 * source text, until a line trimming to `delimiter` is found or input ends. */
function consumeHeredocBodyIntoBuf(
	ctx: LexerContext,
	delimiter: string,
	strip: boolean,
): void {
	const { command, length } = ctx
	// Consume heredoc body until closing delimiter line.
	// Skip leading newline if present.
	if (ctx.i < length && command[ctx.i] === '\n') {
		ctx.buf += '\n'
		ctx.i++
	}

	let foundEnd = false
	while (ctx.i < length && !foundEnd) {
		const lineStart = ctx.i
		while (ctx.i < length && command[ctx.i] !== '\n') ctx.i++
		let line = command.slice(lineStart, ctx.i)
		if (strip) {
			line = line.replace(/^\t+/, '')
		}
		ctx.buf += command.slice(lineStart, ctx.i)
		if (line.trim() === delimiter) {
			foundEnd = true
		}
		if (ctx.i < length) {
			ctx.buf += '\n'
			ctx.i++
		}
	}
}

/** Handles a heredoc redirect encountered while inside `$()`, consuming both
 * the delimiter and body into ctx.buf so the substitution's raw text is
 * preserved for recursive re-parsing -- the heredoc content must not
 * interfere with depth tracking or get misread as flags/arguments. */
function consumeHeredocInsideSubstitution(ctx: LexerContext): void {
	ctx.buf += '<<'
	ctx.i += 2
	const { delimiter, strip } = consumeHeredocDelimiterIntoBuf(ctx)
	if (delimiter.length > 0) {
		consumeHeredocBodyIntoBuf(ctx, delimiter, strip)
	}
}

function stepDollarParenState(ctx: LexerContext): void {
	const ch = ctx.command[ctx.i] ?? ''
	if (handleDollarParenNesting(ctx, ch)) return
	if (ch === "'") {
		consumeSingleQuotedIntoBuf(ctx)
		return
	}
	if (ch === '"') {
		consumeDoubleQuotedIntoBuf(ctx)
		return
	}
	if (isHeredocRedirectStart(ctx, ch)) {
		consumeHeredocInsideSubstitution(ctx)
		return
	}
	ctx.buf += ch
	ctx.i++
}

function stepDollarBraceState(ctx: LexerContext): void {
	const ch = ctx.command[ctx.i] ?? ''
	if (ch === '{') {
		ctx.depth++
		ctx.buf += ch
		ctx.i++
		return
	}
	if (ch === '}') {
		ctx.depth--
		ctx.buf += ch
		ctx.i++
		if (ctx.depth === 0) {
			ctx.state = ctx.braceReturnStack.pop() ?? 'normal'
		}
		return
	}
	ctx.buf += ch
	ctx.i++
}

const STATE_STEPPERS: Record<LexerState, (ctx: LexerContext) => void> = {
	normal: stepNormalState,
	escape: stepEscapeState,
	'single-quote': stepSingleQuoteState,
	'double-quote': stepDoubleQuoteState,
	backtick: stepBacktickState,
	'dollar-paren': stepDollarParenState,
	'dollar-brace': stepDollarBraceState,
}

/**
 * Char-by-char shell tokenizer that tracks quoting/subshell state and emits
 * typed tokens. Operators (`;`, `&&`, `||`, `|`) are only recognized in
 * normal (unquoted) state at nesting depth 0.
 *
 * **Limitations (by design):**
 * - No alias expansion, glob expansion, or shell function tracking
 * - No arithmetic expansion `$(( ))` -- treated as `$()` nesting
 * - No process substitution `<()` / `>()`
 * - Complex redirections beyond heredocs are not modeled
 *
 * Fail-closed: if the lexer finishes with unbalanced state (unterminated
 * quote, unclosed `$()`), the result has `unbalanced: true`.
 */
export function tokenizeShell(command: string): TokenizeResult {
	const ctx = createLexerContext(command)

	while (ctx.i < ctx.length) {
		// If we're collecting a heredoc body, scan for the closing delimiter
		if (ctx.heredocDelimiter !== null) {
			collectHeredocBody(ctx)
			continue
		}
		STATE_STEPPERS[ctx.state](ctx)
	}

	flushBuf(ctx)

	const unbalanced =
		ctx.state !== 'normal' || ctx.depth > 0 || ctx.heredocDelimiter !== null

	return { tokens: ctx.tokens, unbalanced }
}

// ---------------------------------------------------------------------------
// Segment splitting
// ---------------------------------------------------------------------------

/**
 * Splits a shell command into top-level segments separated by operators
 * (`;`, `&&`, `||`, `|`). Heredoc bodies are excluded from segments.
 */
export function splitShellSegments(command: string): ShellParseResult {
	const { tokens, unbalanced } = tokenizeShell(command)
	const segments: string[] = []
	let current = ''

	for (const token of tokens) {
		if (token.type === 'operator') {
			const trimmed = current.trim()
			if (trimmed.length > 0) {
				segments.push(trimmed)
			}
			current = ''
		} else if (token.type === 'text') {
			current += token.value
		}
		// heredoc-body tokens are deliberately excluded
	}

	const trimmed = current.trim()
	if (trimmed.length > 0) {
		segments.push(trimmed)
	}

	return { segments, unbalanced }
}

// ---------------------------------------------------------------------------
// Command word extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the first command word from a shell segment, skipping leading
 * environment variable assignments (e.g., `FOO=bar git commit`).
 * Returns the command head (e.g., `git`, `echo`, `rm`) or null.
 */
export function extractCommandHead(segment: string): string | null {
	const trimmed = segment.trim()
	const words = trimmed.split(/\s+/)

	for (const word of words) {
		// Skip env var assignments like FOO=bar, HOME=/tmp
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
		// Return the first non-assignment word
		return word || null
	}

	return null
}

/** Single-character ANSI-C escapes that decode to one fixed replacement
 * character, keyed by the character following the backslash. */
const ANSI_C_SIMPLE_ESCAPES: Record<string, string> = {
	n: '\n',
	t: '\t',
	r: '\r',
	a: '\x07',
	b: '\b',
	f: '\f',
	v: '\v',
	'\\': '\\',
	"'": "'",
	'"': '"',
}

/** Parses a `\xHH` hex escape whose digits start at `body[i + 2]`. Returns
 * null (leaving the caller to emit the backslash literally) when the next
 * two characters aren't valid hex digits. */
function parseAnsiCHexEscape(
	body: string,
	i: number,
): { char: string; next: number } | null {
	const hex = body.slice(i + 2, i + 4)
	if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null
	return { char: String.fromCharCode(Number.parseInt(hex, 16)), next: i + 4 }
}

/** Parses a `\NNN`/`\0NNN` octal escape (1-3 octal digits, or up to 4 when
 * introduced by a leading `0`) whose digits start at `body[i + 1]`. Returns
 * null when that character isn't an octal digit. */
function parseAnsiCOctalEscape(
	body: string,
	i: number,
): { char: string; next: number } | null {
	const leadingDigit = body[i + 1]!
	const octSlice = body.slice(i + 1, i + 5)
	const match = octSlice.match(/^([0-7]{1,4})/)
	if (!match) return null
	const digits = match[1]!.slice(0, leadingDigit === '0' ? 4 : 3)
	return {
		char: String.fromCharCode(Number.parseInt(digits, 8) & 0xff),
		next: i + 1 + digits.length,
	}
}

/**
 * Expands ANSI-C escape sequences within a `$'...'` string body.
 * Handles: \xHH (hex), \0NNN (octal), \n, \t, \r, \\, \', \", \a, \b, \f, \v
 */
/** Parses a `\xHH` hex or `\NNN`/`\0NNN` octal escape at `body[i]`; returns
 * null for any other escape so the caller falls back to a literal
 * backslash. */
function parseAnsiCNumericEscape(
	body: string,
	i: number,
): { char: string; next: number } | null {
	const next = body[i + 1]!
	if (next === 'x') return parseAnsiCHexEscape(body, i)
	if (next >= '0' && next <= '7') return parseAnsiCOctalEscape(body, i)
	return null
}

function expandAnsiCEscapes(body: string): string {
	let result = ''
	let i = 0
	while (i < body.length) {
		if (body[i] !== '\\' || i + 1 >= body.length) {
			result += body[i]
			i++
			continue
		}
		const next = body[i + 1]!
		if (Object.hasOwn(ANSI_C_SIMPLE_ESCAPES, next)) {
			result += ANSI_C_SIMPLE_ESCAPES[next]
			i += 2
			continue
		}
		const parsed = parseAnsiCNumericEscape(body, i)
		result += parsed ? parsed.char : body[i]
		i = parsed ? parsed.next : i + 1
	}
	return result
}

/**
 * Performs POSIX/Bash-style quote removal on a word. Handles fully quoted
 * words, mixed fragments (e.g. --fo"rce" -> --force), and ANSI-C $'...' escapes.
 */
function unquoteWord(word: string): string {
	// Fast paths for fully quoted words
	if (word.length >= 3 && word.startsWith("$'") && word.endsWith("'")) {
		return expandAnsiCEscapes(word.slice(2, -1))
	}
	if (word.length >= 2 && word.startsWith("'") && word.endsWith("'")) {
		return word.slice(1, -1)
	}
	if (word.length >= 2 && word.startsWith('"') && word.endsWith('"')) {
		return word.slice(1, -1)
	}
	// No quotes at all - return as-is
	if (!word.includes("'") && !word.includes('"') && !word.includes('\\')) {
		return word
	}
	// Mixed quoted/unquoted fragments: strip quotes per POSIX quote removal
	return removeMixedQuoting(word)
}

/** Strips quotes from a word containing mixed quoted/unquoted fragments
 * (e.g. `--fo"rce"` -> `--force`), honoring backslash escapes outside single
 * quotes. Only reached once `unquoteWord`'s fully-quoted fast paths don't
 * apply. */
function removeMixedQuoting(word: string): string {
	let out = ''
	let i = 0
	let inSingle = false
	let inDouble = false
	while (i < word.length) {
		const ch = word[i]!
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle
			i++
			continue
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble
			i++
			continue
		}
		if (ch === '\\' && !inSingle && i + 1 < word.length) {
			out += word[i + 1]!
			i += 2
			continue
		}
		out += ch
		i++
	}
	return out
}

/** Mutable `'`/`"` quoting and single-character escape state, shared by the
 * scanners below that walk a shell segment looking for command
 * substitutions without letting `$(`/`)`/backtick inside quotes confuse
 * them. */
interface QuoteScanState {
	inSingle: boolean
	inDouble: boolean
	escaped: boolean
}

/** Advances quote/escape tracking for one character. Returns true when `ch`
 * was fully handled by quote/escape bookkeeping (the caller should treat its
 * own scan position as consumed and move on without further inspecting
 * `ch`). `escapesInSingleQuotes` controls whether a backslash inside a
 * single-quoted span still starts an escape -- callers disagree on this, so
 * each passes its own existing behavior rather than a fixed POSIX rule. */
function stepQuoteScan(
	state: QuoteScanState,
	ch: string,
	escapesInSingleQuotes: boolean,
): boolean {
	if (state.escaped) {
		state.escaped = false
		return true
	}
	if (ch === '\\' && (escapesInSingleQuotes || !state.inSingle)) {
		state.escaped = true
		return true
	}
	if (ch === "'" && !state.inDouble) {
		state.inSingle = !state.inSingle
		return true
	}
	if (ch === '"' && !state.inSingle) {
		state.inDouble = !state.inDouble
		return true
	}
	return false
}

/**
 * Consumes a `$(...)` command substitution starting at position `start`,
 * tracking nested parentheses and quotes. Returns the index one past the
 * closing `)`.
 */
function consumeCommandSubstitution(
	segment: string,
	start: number,
): number {
	let i = start + 2
	let depth = 1
	const quote: QuoteScanState = {
		inSingle: false,
		inDouble: false,
		escaped: false,
	}

	while (i < segment.length && depth > 0) {
		const ch = segment[i] || ''

		if (stepQuoteScan(quote, ch, false)) {
			i++
			continue
		}

		if (!quote.inSingle && !quote.inDouble) {
			if (ch === '$' && segment[i + 1] === '(') {
				depth++
				i += 2
				continue
			}
			if (ch === ')') {
				depth--
				i++
				continue
			}
		}

		i++
	}

	return i
}

/** Mutable scan state threaded through `stepWordScan` while splitting a
 * shell segment into words. */
interface WordScanState {
	segment: string
	words: string[]
	current: string
	inSingle: boolean
	inDouble: boolean
	i: number
}

/** Advances a word split by one step: flushes the current word on
 * unquoted whitespace, consumes a backslash escape or `$(...)` substitution
 * verbatim, tracks quote state, or otherwise appends the character to the
 * word being built. */
function stepWordScan(state: WordScanState): void {
	const { segment } = state
	const ch = segment[state.i] || ''

	if (!state.inSingle && !state.inDouble && /\s/.test(ch)) {
		if (state.current.length > 0) {
			state.words.push(unquoteWord(state.current))
			state.current = ''
		}
		state.i++
		return
	}

	// Backslash escape outside quotes: consume next char as literal
	if (!state.inSingle && ch === '\\' && state.i + 1 < segment.length) {
		state.current += segment[state.i + 1]
		state.i += 2
		return
	}

	if (!state.inSingle && ch === '$' && segment[state.i + 1] === '(') {
		const end = consumeCommandSubstitution(segment, state.i)
		state.current += segment.slice(state.i, end)
		state.i = end
		return
	}

	if (ch === "'" && !state.inDouble) {
		state.inSingle = !state.inSingle
		state.current += ch
		state.i++
		return
	}

	if (ch === '"' && !state.inSingle) {
		state.inDouble = !state.inDouble
		state.current += ch
		state.i++
		return
	}

	state.current += ch
	state.i++
}

/**
 * Splits a shell segment into individual words, respecting single/double
 * quotes and `$(...)` command substitutions. Unquotes simple quoted words.
 */
export function splitShellWords(segment: string): string[] {
	// Fast path: no quoting characters at all
	if (!/['"`$\\]/.test(segment)) {
		return segment.trim().split(/\s+/).filter(Boolean)
	}

	const state: WordScanState = {
		segment,
		words: [],
		current: '',
		inSingle: false,
		inDouble: false,
		i: 0,
	}

	while (state.i < segment.length) {
		stepWordScan(state)
	}

	if (state.current.length > 0) {
		state.words.push(unquoteWord(state.current))
	}

	return state.words.filter((word) => word.length > 0)
}

/**
 * Returns the word list, the index of the first command word (skipping
 * env var assignments), and the command head.
 */
export function getCommandWords(segment: string): CommandWords {
	const words = splitShellWords(segment)
	let cmdIndex = -1

	for (let i = 0; i < words.length; i++) {
		const word = words[i] || ''
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
		cmdIndex = i
		break
	}

	if (cmdIndex === -1) {
		return { words, cmdIndex: -1, head: null }
	}

	return { words, cmdIndex, head: words[cmdIndex] || null }
}

// ---------------------------------------------------------------------------
// Executable name normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes an executable name by stripping directory prefixes and the
 * `.exe` suffix. Returns null if the input is null.
 */
export function normalizeExecutableName(head: string | null): string | null {
	if (!head) return null
	const normalized = head.replace(/\\/g, '/')
	const base = normalized.split('/').pop() || normalized
	return base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base
}

// ---------------------------------------------------------------------------
// Git invocation parsing
// ---------------------------------------------------------------------------

/** Git global options that consume a following value argument. */
const GIT_OPTIONS_WITH_VALUE = new Set([
	'-C',
	'-c',
	'--git-dir',
	'--work-tree',
	'--namespace',
	'--super-prefix',
	'--config-env',
])

function isWordOption(word: string): boolean {
	return word.startsWith('-')
}

/** Skips option words for a prefix command until `--` or the first
 * non-option word, treating any word for which `takesValue` returns true as
 * consuming a following argument. Returns the index past `--` when one was
 * seen, otherwise the index of the first non-option word. */
function skipPrefixOptions(
	words: string[],
	start: number,
	takesValue: (word: string) => boolean,
): number {
	let i = start
	while (i < words.length) {
		const word = words[i] || ''
		if (word === '--') return i + 1
		if (!isWordOption(word)) return i
		i += takesValue(word) ? 2 : 1
	}
	return i
}

/** `chrt` accepts a bare numeric realtime priority before the wrapped
 * command (e.g. `chrt -r 5 <command>`); consume it only when a command word
 * still follows. */
function skipChrtPriority(words: string[], i: number): number {
	const maybePriority = words[i] || ''
	return /^\d+$/.test(maybePriority) && i + 1 < words.length ? i + 1 : i
}

const TIME_OPTIONS_WITH_VALUE = new Set(['-f', '-o', '--format', '--output'])
const NICE_OPTIONS_WITH_VALUE = new Set(['-n', '--adjustment'])
const SUDO_OPTIONS_WITH_VALUE = new Set([
	'-u',
	'--user',
	'-g',
	'--group',
	'-h',
	'--host',
	'-p',
	'--prompt',
	'-C',
	'--close-from',
	'-r',
	'--role',
	'-t',
	'--type',
	'-T',
	'--command-timeout',
])
const STDBUF_OPTIONS_WITH_VALUE = new Set(['-i', '-o', '-e'])
const SCHED_OPTIONS_WITH_VALUE = new Set([
	'-p',
	'--pid',
	'-c',
	'--class',
	'-n',
	'--classdata',
])

interface PrefixHandler {
	match(head: string): boolean
	/** Skips the prefix's own options, given the index right after its head
	 * word; returns the index of the next head candidate. */
	skip(words: string[], afterHead: number, head: string): number
}

/** One entry per recognized execution-wrapping prefix (see module doc for the
 * exact commands). Order doesn't matter -- heads never match more than one
 * entry. */
const PREFIX_HANDLERS: PrefixHandler[] = [
	{
		match: (head) => head === 'command' || head === 'builtin',
		skip: (words, i) => skipPrefixOptions(words, i, () => false),
	},
	{
		match: (head) => head === 'time',
		skip: (words, i) =>
			skipPrefixOptions(words, i, (w) => TIME_OPTIONS_WITH_VALUE.has(w)),
	},
	{
		match: (head) => head === 'nice',
		skip: (words, i) =>
			skipPrefixOptions(words, i, (w) => NICE_OPTIONS_WITH_VALUE.has(w)),
	},
	{
		match: (head) => head === 'nohup' || head === 'chronic',
		skip: (words, i) => ((words[i] || '') === '--' ? i + 1 : i),
	},
	{
		match: (head) => head === 'sudo',
		skip: (words, i) =>
			skipPrefixOptions(words, i, (w) => SUDO_OPTIONS_WITH_VALUE.has(w)),
	},
	{
		match: (head) => head === 'stdbuf',
		skip: (words, i) =>
			skipPrefixOptions(words, i, (w) => STDBUF_OPTIONS_WITH_VALUE.has(w)),
	},
	{
		match: (head) => head === 'chrt' || head === 'ionice' || head === 'setsid',
		skip: (words, i, head) => {
			const afterOptions = skipPrefixOptions(words, i, (w) =>
				SCHED_OPTIONS_WITH_VALUE.has(w),
			)
			return head === 'chrt' ? skipChrtPriority(words, afterOptions) : afterOptions
		},
	},
]

/**
 * Strips common execution prefixes that wrap a real command while preserving
 * command semantics (e.g., `command git ...`, `time git ...`, `nice -n 5 git ...`).
 */
function stripExecutionPrefixes(
	words: string[],
	startIndex: number,
): PrefixStripResult {
	let i = startIndex
	let skippedPrefix = false

	while (i < words.length) {
		const head = normalizeExecutableName(words[i] || null)
		if (!head) break

		const handler = PREFIX_HANDLERS.find((candidate) => candidate.match(head))
		if (!handler) break

		skippedPrefix = true
		i = handler.skip(words, i + 1, head)
	}

	return { headIndex: i, skippedPrefix }
}

/**
 * Parses a shell segment to extract a git subcommand and its arguments,
 * skipping global git options (e.g., `-C`, `--git-dir`). Returns null if
 * the segment is not a git invocation.
 */
export function parseGitInvocation(segment: string): GitInvocation | null {
	const { words, cmdIndex, head } = getCommandWords(segment)
	if (cmdIndex === -1 || !head) return null
	const { headIndex } = stripExecutionPrefixes(words, cmdIndex)
	if (headIndex >= words.length) return null
	if (normalizeExecutableName(words[headIndex] || null) !== 'git') return null

	// Skip git global options before subcommand.
	const i = skipPrefixOptions(words, headIndex + 1, (word) =>
		GIT_OPTIONS_WITH_VALUE.has(word),
	)

	if (i >= words.length) return null

	const subcommand = words[i] || ''
	if (subcommand.length === 0) return null
	return { subcommand, args: words.slice(i + 1) }
}

// ---------------------------------------------------------------------------
// Command substitution extraction
// ---------------------------------------------------------------------------

/** Consumes a backtick command substitution starting at its opening
 * backtick (`segment[start] === '\`'`), honoring backslash escapes. Returns
 * the trimmed inner command text and the index one past the closing
 * backtick (or the end of input if unterminated). */
function consumeBacktickSubstitution(
	segment: string,
	start: number,
): { inner: string; end: number } {
	let j = start + 1
	let inner = ''
	let innerEscaped = false
	while (j < segment.length) {
		const innerCh = segment[j] || ''
		if (innerEscaped) {
			inner += innerCh
			innerEscaped = false
			j++
			continue
		}
		if (innerCh === '\\') {
			innerEscaped = true
			j++
			continue
		}
		if (innerCh === '`') break
		inner += innerCh
		j++
	}
	return { inner: inner.trim(), end: j < segment.length ? j + 1 : j }
}

/** Consumes a `$(...)` substitution during extraction, recording its
 * trimmed inner text in `snippets` when non-empty. Returns the index one
 * past the closing `)`. */
function consumeDollarParenSubstitution(
	segment: string,
	start: number,
	snippets: string[],
): number {
	const end = consumeCommandSubstitution(segment, start)
	const inner = segment.slice(start + 2, Math.max(start + 2, end - 1)).trim()
	if (inner.length > 0) snippets.push(inner)
	return end
}

/**
 * Extracts all `$(...)` and backtick command substitutions from a shell
 * segment, returning the inner command strings.
 */
export function extractCommandSubstitutions(segment: string): string[] {
	const snippets: string[] = []
	let i = 0
	const quote: QuoteScanState = {
		inSingle: false,
		inDouble: false,
		escaped: false,
	}

	while (i < segment.length) {
		const ch = segment[i] || ''

		if (stepQuoteScan(quote, ch, true)) {
			i++
			continue
		}

		if (!quote.inSingle && ch === '$' && segment[i + 1] === '(') {
			i = consumeDollarParenSubstitution(segment, i, snippets)
			continue
		}

		if (!quote.inSingle && ch === '`') {
			const { inner, end } = consumeBacktickSubstitution(segment, i)
			if (inner.length > 0) snippets.push(inner)
			i = end
			continue
		}

		i++
	}

	return snippets
}

// ---------------------------------------------------------------------------
// Shell wrapper unwrapping
// ---------------------------------------------------------------------------

const SHELL_INTERPRETER_HEADS = new Set([
	'sh',
	'bash',
	'zsh',
	'dash',
	'ksh',
	'fish',
	'pwsh',
	'powershell',
])

/** Finds a `-c`/`--command`/`-Command` flag (or a bundled short option
 * containing `c`, e.g. `-ec`) among a shell interpreter's arguments and
 * returns the command string that follows it. */
function extractShellDashCCommand(args: string[]): string | null {
	for (let i = 0; i < args.length - 1; i++) {
		const arg = args[i] || ''
		if (
			arg === '-c' ||
			arg === '--command' ||
			arg === '-Command' ||
			(/^-[A-Za-z]+$/.test(arg) && arg.includes('c'))
		) {
			return args[i + 1] || null
		}
	}
	return null
}

const ENV_OPTIONS_WITH_VALUE = new Set([
	'-u',
	'--unset',
	'-C',
	'--chdir',
	'-a',
	'--argv0',
	'-S',
	'--split-string',
])

/** Skips `env`'s own options and leading `NAME=value` assignments to find
 * where the wrapped command begins. */
function skipEnvOptionsAndAssignments(args: string[]): number {
	let i = 0
	while (i < args.length) {
		const arg = args[i] || ''
		if (arg === '--') return i + 1
		if (
			arg.startsWith('--chdir=') ||
			arg.startsWith('--unset=') ||
			arg.startsWith('--argv0=') ||
			arg.startsWith('--split-string=')
		) {
			i++
			continue
		}
		if (ENV_OPTIONS_WITH_VALUE.has(arg)) {
			i += 2
			continue
		}
		if (arg.startsWith('-')) {
			i++
			continue
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
			i++
			continue
		}
		return i
	}
	return i
}

const XARGS_OPTIONS_WITH_VALUE = new Set([
	'-I',
	'--replace',
	'-n',
	'-L',
	'-P',
	'-s',
	'-d',
	'-E',
	'-e',
])

const EXECUTION_PREFIX_HEADS = new Set([
	'command',
	'builtin',
	'time',
	'nice',
	'nohup',
	'chronic',
	'sudo',
	'stdbuf',
	'chrt',
	'ionice',
	'setsid',
])

/** `command`/`time`/`nice`/etc. wrap a real command without changing it;
 * reuses `stripExecutionPrefixes` to find where the wrapped command begins. */
function extractExecutionPrefixWrappedCommand(
	words: string[],
	cmdIndex: number,
): string | null {
	const { headIndex, skippedPrefix } = stripExecutionPrefixes(words, cmdIndex)
	if (!skippedPrefix || headIndex >= words.length) return null
	return words.slice(headIndex).join(' ').trim() || null
}

/**
 * Detects shell wrappers (`sh -c`, `bash -c`, `eval`, `env`, `xargs`) and
 * extracts the inner command string for recursive safety analysis.
 * Returns null if the segment is not a recognized wrapper pattern.
 */
export function extractWrappedShellCommand(segment: string): string | null {
	const { words, cmdIndex, head } = getCommandWords(segment)
	if (cmdIndex < 0) return null
	const normalizedHead = normalizeExecutableName(head)
	const args = words.slice(cmdIndex + 1)

	if (normalizedHead !== null && SHELL_INTERPRETER_HEADS.has(normalizedHead)) {
		return extractShellDashCCommand(args)
	}

	if (normalizedHead === 'eval') {
		return args.join(' ').trim() || null
	}

	if (normalizedHead === 'env') {
		return args.slice(skipEnvOptionsAndAssignments(args)).join(' ').trim() || null
	}

	if (normalizedHead === 'xargs') {
		const i = skipPrefixOptions(args, 0, (arg) =>
			XARGS_OPTIONS_WITH_VALUE.has(arg),
		)
		return args.slice(i).join(' ').trim() || null
	}

	if (normalizedHead !== null && EXECUTION_PREFIX_HEADS.has(normalizedHead)) {
		return extractExecutionPrefixWrappedCommand(words, cmdIndex)
	}

	return null
}
