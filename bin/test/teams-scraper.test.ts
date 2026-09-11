import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Independent oracle: every expected file under fixtures/teams was captured
// from the pre-refactor teams-scraper.ts (commit 1a191133) on the matching
// input, with only the wall-clock `scrapedAt` field removed. The test never
// derives an expectation from the code under test.
const scraper = resolve(import.meta.dir, '..', 'teams', 'teams-scraper.ts')
const fixtures = resolve(import.meta.dir, 'fixtures', 'teams')
const env = { ...process.env, TZ: 'Australia/Melbourne' }
const sandboxes: string[] = []

afterEach(() => {
	for (const sandbox of sandboxes.splice(0)) {
		rmSync(sandbox, { recursive: true, force: true })
	}
})

function sandbox(): string {
	const dir = mkdtempSync(join(tmpdir(), 'teams-scraper-'))
	sandboxes.push(dir)
	return dir
}

function fixture(name: string): string {
	return readFileSync(join(fixtures, name), 'utf8')
}

interface Run {
	exitCode: number
	stdout: string
	stderr: string
	cwd: string
}

function run(cwd: string, args: string[]): Run {
	const result = Bun.spawnSync(['bun', scraper, ...args], { cwd, env })
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
		cwd,
	}
}

function scrape(name: string, extraArgs: string[] = []): Run {
	const cwd = sandbox()
	writeFileSync(join(cwd, 'input.txt'), fixture(`${name}.txt`))
	return run(cwd, [
		'--channel',
		'Expected',
		'--raw',
		'input.txt',
		'--output',
		'output.json',
		...extraArgs,
	])
}

function outputOf(cwd: string, file = 'output.json'): unknown {
	const data = JSON.parse(readFileSync(join(cwd, file), 'utf8'))
	expect(data.scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
	const { scrapedAt: _scrapedAt, ...stable } = data
	return stable
}

describe('teams-scraper characterization', () => {
	for (const name of ['plain-messages', 'replies', 'malformed', 'chrome-only']) {
		test(`${name}: JSON output and stdout match the recorded oracle`, () => {
			const result = scrape(name)
			expect(result.stderr).toBe('')
			expect(result.exitCode).toBe(0)
			expect(result.stdout).toBe(fixture(`${name}.stdout.txt`))
			expect(outputOf(result.cwd)).toEqual(
				JSON.parse(fixture(`${name}.expected.json`)),
			)
		})
	}

	test('output defaults to ./teams-messages.json when --output is omitted', () => {
		const cwd = sandbox()
		writeFileSync(join(cwd, 'input.txt'), fixture('chrome-only.txt'))
		const result = run(cwd, ['-r', 'input.txt'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('💾 Saved to: ./teams-messages.json')
		expect(outputOf(cwd, 'teams-messages.json')).toEqual(
			JSON.parse(fixture('chrome-only.expected.json')),
		)
	})

	test('--help prints the recorded help text and writes nothing', () => {
		const cwd = sandbox()
		const result = run(cwd, ['--help'])
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toBe('')
		expect(result.stdout).toBe(fixture('help.txt'))
		expect(() => readFileSync(join(cwd, 'teams-messages.json'))).toThrow()
	})

	test('an unknown flag is reported on stderr with exit code 0', () => {
		const result = run(sandbox(), ['--bogus'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('')
		expect(result.stderr).toContain('--bogus')
	})
})
