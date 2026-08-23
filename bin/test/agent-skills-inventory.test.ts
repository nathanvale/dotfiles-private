import { afterEach, describe, expect, test } from 'bun:test'
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const subject = resolve(import.meta.dir, '..', 'agent-skills-inventory')
const fixtures: string[] = []

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		rmSync(fixture, { recursive: true, force: true })
	}
})

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, content)
}

function skill(path: string, name: string): void {
	write(path, `---\nname: ${name}\ndescription: "Fixture ${name}."\n---\n`)
}

function gitTreeHash(skillRoot: string, assertProcess = true): string {
	const hashRepo = mkdtempSync(join(tmpdir(), 'agent-skills-hash-'))
	fixtures.push(hashRepo)
	cpSync(skillRoot, hashRepo, { recursive: true })
	const result = Bun.spawnSync(['git', 'init', '-q'], { cwd: hashRepo })
	if (assertProcess) expect(result.exitCode).toBe(0)
	else if (result.exitCode !== 0) throw new Error('git init failed')
	const add = Bun.spawnSync(['git', 'add', '--', '.'], { cwd: hashRepo })
	if (assertProcess) expect(add.exitCode).toBe(0)
	else if (add.exitCode !== 0) throw new Error('git add failed')
	const tree = Bun.spawnSync(['git', 'write-tree'], { cwd: hashRepo })
	if (assertProcess) expect(tree.exitCode).toBe(0)
	else if (tree.exitCode !== 0) throw new Error('git write-tree failed')
	return tree.stdout.toString().trim()
}

function entryCount(root: string): number {
	let count = 0
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		count += 1
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			count += entryCount(join(root, entry.name))
		}
	}
	return count
}

function makeFixture() {
	const fixture = mkdtempSync(join(tmpdir(), 'agent-skills-inventory-'))
	fixtures.push(fixture)
	const home = join(fixture, 'home')
	const dotfiles = join(home, 'code', 'dotfiles')
	const legacySource = join(dotfiles, '.agents', 'skills')
	const canonicalLockSource = join(dotfiles, 'config', 'agents', 'skills')
	const personalSource = join(dotfiles, 'config', 'agents', 'skills', 'personal')
	const thirdPartySource = join(
		dotfiles,
		'config',
		'agents',
		'skills',
		'third-party',
	)
	const agents = join(home, '.agents', 'skills')
	const claude = join(home, '.claude', 'skills')
	const codex = join(home, '.codex', 'skills')
	for (const path of [
		legacySource,
		canonicalLockSource,
		personalSource,
		thirdPartySource,
		agents,
		claude,
		codex,
	]) {
		mkdirSync(path, { recursive: true })
	}

	skill(join(personalSource, 'personal-one', 'SKILL.md'), 'personal-one')
	symlinkSync(join(personalSource, 'personal-one'), join(agents, 'personal-one'))
	symlinkSync(join(personalSource, 'personal-one'), join(claude, 'personal-one'))
	skill(join(personalSource, 'disabled-one', 'SKILL.md'), 'disabled-one')
	symlinkSync(join(personalSource, 'disabled-one'), join(agents, 'disabled-one'))
	symlinkSync(join(personalSource, 'disabled-one'), join(claude, 'disabled-one'))
	skill(join(personalSource, 'codex-disabled-one', 'SKILL.md'), 'codex-disabled-one')
	symlinkSync(
		join(personalSource, 'codex-disabled-one'),
		join(agents, 'codex-disabled-one'),
	)
	symlinkSync(
		join(personalSource, 'codex-disabled-one'),
		join(claude, 'codex-disabled-one'),
	)

	const lockedStaging = join(fixture, 'locked-staging')
	skill(join(lockedStaging, 'SKILL.md'), 'locked-one')
	const lockedHash = gitTreeHash(lockedStaging)
	const lockedSource = join(thirdPartySource, 'fixture', 'skills', 'locked-one')
	cpSync(lockedStaging, lockedSource, { recursive: true })
	symlinkSync(lockedSource, join(agents, 'locked-one'))
	symlinkSync(lockedSource, join(claude, 'locked-one'))
	const installedStaging = join(fixture, 'installed-staging')
	skill(join(installedStaging, 'SKILL.md'), 'installed-one')
	const installedHash = gitTreeHash(installedStaging)
	const installedSource = join(
		thirdPartySource,
		'fixture',
		'skills',
		'installed-one',
	)
	cpSync(installedStaging, installedSource, { recursive: true })
	symlinkSync(installedSource, join(agents, 'installed-one'))
	symlinkSync(installedSource, join(claude, 'installed-one'))
	skill(join(codex, '.system', 'SKILL.md'), 'system-fixture')

	write(
		join(canonicalLockSource, '.skill-lock.json'),
		JSON.stringify({
			skills: {
				'locked-one': {
					source: 'fixture/skills',
					skillFolderHash: lockedHash,
				},
				'installed-one': {
					source: 'fixture/skills',
					skillFolderHash: installedHash,
				},
			},
		}),
	)
	symlinkSync(
		join(canonicalLockSource, '.skill-lock.json'),
		join(home, '.agents', '.skill-lock.json'),
	)
	write(
		join(dotfiles, 'config', 'agents', 'skills', 'topology.json'),
		JSON.stringify({
			schemaVersion: 1,
			personal: {
				'disabled-one': {
					addresses: ['agents', 'claude'],
					disabledAddresses: ['claude'],
				},
				'codex-disabled-one': {
					addresses: ['agents', 'claude'],
					disabledHarnesses: ['codex'],
				},
				'personal-one': { addresses: ['agents', 'claude'] },
			},
			thirdParty: {
				'locked-one': {
					owner: 'fixture/skills',
					addresses: ['agents', 'claude'],
				},
				'installed-one': {
					owner: 'fixture/skills',
					addresses: ['agents', 'claude'],
				},
			},
			retired: ['retired-one'],
		}),
	)
	write(
		join(dotfiles, 'config', 'agents', 'claude', 'settings.json'),
		JSON.stringify({ skillOverrides: { 'disabled-one': 'off' } }),
	)
	write(
		join(home, '.codex', 'config.toml'),
		`[[skills.config]]\npath = "${join(agents, 'codex-disabled-one', 'SKILL.md')}"\nenabled = false\n`,
	)

	return {
		agents,
		canonicalLockSource,
		claude,
		codex,
		dotfiles,
		home,
		legacySource,
		personalSource,
		thirdPartySource,
	}
}

function makeProtectedBaselineFixture() {
	const fixture = makeFixture()
	const skillsRoot = join(fixture.home, '.codex', 'skills')
	const cacheRoot = join(fixture.home, '.codex', 'plugins', 'cache')
	rmSync(skillsRoot, { recursive: true, force: true })
	rmSync(cacheRoot, { recursive: true, force: true })

	write(join(skillsRoot, '.system', 'SKILL.md'), 'system fixture\n')
	write(join(skillsRoot, 'personal', 'SKILL.md'), 'personal fixture\n')
	symlinkSync(join(skillsRoot, '.system'), join(skillsRoot, 'system-alias'))
	write(join(cacheRoot, 'plugin-a', 'index.js'), 'export default 1\n')
	write(join(cacheRoot, 'plugin-b', 'README.md'), '# plugin b\n')
	symlinkSync(join(cacheRoot, 'plugin-a'), join(cacheRoot, 'latest'))

	const protectedBaseline = {
		algorithm: 'git-tree-sha1',
		version: 1,
		roots: [
			{
				path: '.codex/skills',
				entryCount: entryCount(skillsRoot),
				gitTreeSha1: gitTreeHash(skillsRoot, false),
			},
			{
				path: '.codex/plugins/cache',
				entryCount: entryCount(cacheRoot),
				gitTreeSha1: gitTreeHash(cacheRoot, false),
			},
		],
	}
	const topologyPath = join(
		fixture.dotfiles,
		'config',
		'agents',
		'skills',
		'topology.json',
	)
	const topology = JSON.parse(readFileSync(topologyPath, 'utf8'))
	topology.protectedHarness = protectedBaseline
	writeFileSync(topologyPath, JSON.stringify(topology))

	return { ...fixture, protectedBaseline }
}

function declareProjectOnlyDotfiles(fixture: ReturnType<typeof makeFixture>) {
	const source = join(fixture.dotfiles, '.claude', 'skills', 'dotfiles')
	const address = join(fixture.legacySource, 'dotfiles')
	skill(join(source, 'SKILL.md'), 'dotfiles')
	symlinkSync('../../.claude/skills/dotfiles', address)

	const topologyPath = join(
		fixture.dotfiles,
		'config',
		'agents',
		'skills',
		'topology.json',
	)
	const topology = JSON.parse(readFileSync(topologyPath, 'utf8'))
	topology.projectOnly = {
		dotfiles: {
			source: '.claude/skills/dotfiles',
			projectAddresses: ['.agents/skills/dotfiles'],
		},
	}
	writeFileSync(topologyPath, JSON.stringify(topology))

	return { address, source, topologyPath }
}

function run(home: string, ...args: string[]) {
	return Bun.spawnSync([subject, ...args], {
		env: { ...process.env, HOME: home },
	})
}

describe('agent-skills-inventory public process', () => {
	test('reconciles accepted personal, third-party, and Codex-owned entries', () => {
		const fixture = makeFixture()
		const result = run(fixture.home, '--json')
		expect(result.stderr.toString()).toBe('')
		if (result.exitCode !== 0) {
			const failedReport = JSON.parse(result.stdout.toString())
			throw new Error(JSON.stringify(failedReport.issues))
		}

		const report = JSON.parse(result.stdout.toString())
		expect(report.schema_version).toBe(1)
		expect(report.status).toBe('ok')
		expect(report.issues).toEqual([])
		expect(report.entries).toHaveLength(11)
		expect(report.lock_path).toBe(
			realpathSync(join(fixture.canonicalLockSource, '.skill-lock.json')),
	)

		const byAddressAndName = new Map(
			report.entries.map((entry: Record<string, unknown>) => [
				`${entry.address}:${entry.name}`,
				entry,
			]),
		)
		expect(byAddressAndName.has('dotfiles:.skill-lock.json')).toBe(false)
		expect(byAddressAndName.get('agents:personal-one')).toMatchObject({
			content_agreement: 'match',
			filesystem_kind: 'symlink',
			provenance: 'personal-transitional',
			source_owner: 'dotfiles',
			source_path: realpathSync(join(fixture.personalSource, 'personal-one')),
		})
		expect(byAddressAndName.get('claude:locked-one')).toMatchObject({
			content_agreement: 'match',
			filesystem_kind: 'symlink',
			provenance: 'third-party-installed',
			source_owner: 'fixture/skills',
		})
		expect(byAddressAndName.get('agents:installed-one')).toMatchObject({
			content_agreement: 'match',
			filesystem_kind: 'symlink',
			provenance: 'third-party-installed',
			source_owner: 'fixture/skills',
			source_path: realpathSync(
				join(fixture.thirdPartySource, 'fixture', 'skills', 'installed-one'),
			),
		})
		expect(byAddressAndName.get('claude:disabled-one')).toMatchObject({
			activation: 'disabled',
			content_agreement: 'match',
			provenance: 'personal-transitional',
		})
		expect(byAddressAndName.get('agents:codex-disabled-one')).toMatchObject({
			activation: 'enabled',
			harness_activation: {
				agents: 'enabled',
				codex: 'disabled',
			},
		})
		expect(byAddressAndName.get('codex:.system')).toMatchObject({
			content_agreement: 'owned',
			filesystem_kind: 'directory',
			provenance: 'codex-owned',
			source_owner: 'codex',
		})
	})

	test('fails closed when a locked third-party key has no declaration', () => {
		const fixture = makeFixture()
		const topologyPath = join(
			fixture.dotfiles,
			'config',
			'agents',
			'skills',
			'topology.json',
		)
		const topology = JSON.parse(readFileSync(topologyPath, 'utf8'))
		delete topology.thirdParty['installed-one']
		writeFileSync(topologyPath, JSON.stringify(topology))

		const result = run(fixture.home, '--json')
		expect(result.stderr.toString()).toBe('')
		expect(result.exitCode).toBe(1)
		const report = JSON.parse(result.stdout.toString())
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					address: 'third-party-lock',
					code: 'undeclared-third-party-lock',
					name: 'installed-one',
				}),
			]),
		)
	})

	test('fails closed when a declared third-party install is not an exact Tracking Link', () => {
		const fixture = makeFixture()
		const installedAddress = join(fixture.agents, 'installed-one')
		rmSync(installedAddress)
		cpSync(
			join(fixture.thirdPartySource, 'fixture', 'skills', 'installed-one'),
			installedAddress,
			{ recursive: true },
		)

		const result = run(fixture.home, '--json')
		expect(result.stderr.toString()).toBe('')
		expect(result.exitCode).toBe(1)
		const report = JSON.parse(result.stdout.toString())
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					address: 'agents',
					code: 'third-party-not-tracking-link',
					name: 'installed-one',
				}),
				expect.objectContaining({
					address: 'agents',
					code: 'wrong-third-party-target',
					name: 'installed-one',
				}),
			]),
		)
	})

	test('classifies a repository-owned skill as project-only', () => {
		const fixture = makeFixture()
		const projectOnly = declareProjectOnlyDotfiles(fixture)

		const result = run(fixture.home, '--json')
		expect(result.stderr.toString()).toBe('')
		if (result.exitCode !== 0) {
			const failedReport = JSON.parse(result.stdout.toString())
			throw new Error(JSON.stringify(failedReport.issues))
		}

		const report = JSON.parse(result.stdout.toString())
		expect(report.status).toBe('ok')
		expect(report.issues).toEqual([])
		const projectRow = report.entries.find(
			(entry: { address: string; name: string }) =>
				entry.address === 'dotfiles' && entry.name === 'dotfiles',
		)
		expect(projectRow).toMatchObject({
			content_agreement: 'source',
			filesystem_kind: 'symlink',
			provenance: 'project-only',
			resolved_target: realpathSync(projectOnly.source),
			source_owner: 'dotfiles',
			source_path: realpathSync(projectOnly.source),
		})
		expect(
			report.entries.some(
				(entry: { address: string; name: string }) =>
					['agents', 'claude', 'codex'].includes(entry.address) &&
					entry.name === 'dotfiles',
			),
		).toBe(false)
	})

	test('fails closed on invalid project-only declarations and addresses', () => {
		const fixture = makeFixture()
		const projectOnly = declareProjectOnlyDotfiles(fixture)

		rmSync(projectOnly.address)
		mkdirSync(projectOnly.address)
		let result = run(fixture.home, '--json')
		expect(result.stderr.toString()).toBe('')
		expect(result.exitCode).toBe(1)
		let report = JSON.parse(result.stdout.toString())
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					address: 'dotfiles',
					code: 'project-only-not-tracking-link',
					name: 'dotfiles',
				}),
			]),
		)

		rmSync(projectOnly.address, { recursive: true })
		symlinkSync('../../.claude/skills/dotfiles', projectOnly.address)
		symlinkSync(projectOnly.source, join(fixture.agents, 'dotfiles'))
		result = run(fixture.home, '--json')
		expect(result.exitCode).toBe(1)
		report = JSON.parse(result.stdout.toString())
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					address: 'agents',
					code: 'project-only-user-address',
					name: 'dotfiles',
				}),
			]),
		)

		rmSync(join(fixture.agents, 'dotfiles'))
		const topology = JSON.parse(readFileSync(projectOnly.topologyPath, 'utf8'))
		topology.projectOnly.dotfiles.source = '../outside/dotfiles'
		writeFileSync(projectOnly.topologyPath, JSON.stringify(topology))
		result = run(fixture.home, '--json')
		expect(result.exitCode).toBe(1)
		report = JSON.parse(result.stdout.toString())
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					address: 'topology',
					code: 'invalid-project-only-declaration',
					name: 'dotfiles',
				}),
			]),
		)
	})

	test('fails closed on legacy, retired, dangling, and content disagreement', () => {
		const fixture = makeFixture()
		skill(join(fixture.legacySource, 'legacy-one', 'SKILL.md'), 'legacy-one')
		symlinkSync(join(fixture.legacySource, 'legacy-one'), join(fixture.agents, 'legacy-one'))
		symlinkSync(
			join(fixture.legacySource, 'legacy-one'),
			join(fixture.agents, 'retired-one'),
		)
		symlinkSync(join(fixture.home, 'missing-skill'), join(fixture.claude, 'dangling-one'))
		write(join(fixture.agents, 'locked-one', 'SKILL.md'), 'changed\n')
		write(
			join(fixture.home, '.codex', 'config.toml'),
			`[[skills.config]]\npath = "${join(fixture.agents, 'personal-one', 'SKILL.md')}"\nenabled = false\n`,
		)

		const result = run(fixture.home, '--json')
		expect(result.stderr.toString()).toBe('')
		expect(result.exitCode).toBe(1)
		const report = JSON.parse(result.stdout.toString())
		expect(report.status).toBe('issues')
		expect(report.issues.map((issue: { code: string }) => issue.code)).toEqual(
			expect.arrayContaining([
				'content-mismatch',
				'dangling-symlink',
				'legacy-source',
				'missing-disabled-harness-state',
				'retired-present',
				'undeclared-disabled-harness',
			]),
		)

		const human = run(fixture.home)
		expect(human.exitCode).toBe(1)
		expect(human.stdout.toString()).toContain('TOPOLOGY ISSUES')
		expect(human.stdout.toString()).toContain('legacy-source')
	})

	test('reports the accepted protected Harness baseline and detects mutation', () => {
		const fixture = makeProtectedBaselineFixture()
		const baseline = run(fixture.home, '--json')
		expect(baseline.stderr.toString()).toBe('')
		if (baseline.exitCode !== 0) {
			const failedReport = JSON.parse(baseline.stdout.toString())
			throw new Error(JSON.stringify(failedReport.issues))
		}
		const report = JSON.parse(baseline.stdout.toString())
		expect(report.protected_harness).toEqual(fixture.protectedBaseline)
		expect(report.protected_harness.issues).toBeUndefined()

		write(join(fixture.home, '.codex', 'skills', 'baseline-mutation.txt'), 'mutation\n')
		const mutated = run(fixture.home, '--json')
		expect(mutated.exitCode).toBe(1)
		const mutatedReport = JSON.parse(mutated.stdout.toString())
		expect(mutatedReport.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					address: 'protected-harness',
					code: 'protected-entry-count-drift',
					name: '.codex/skills',
				}),
				expect.objectContaining({
					address: 'protected-harness',
					code: 'protected-tree-hash-drift',
					name: '.codex/skills',
				}),
			]),
		)

		rmSync(join(fixture.home, '.codex', 'plugins', 'cache'), {
			recursive: true,
			force: true,
		})
		const missing = run(fixture.home, '--json')
		expect(missing.exitCode).toBe(1)
		const missingReport = JSON.parse(missing.stdout.toString())
		expect(missingReport.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					address: 'protected-harness',
					code: 'protected-root-missing',
					name: '.codex/plugins/cache',
				}),
			]),
		)
	})
})
