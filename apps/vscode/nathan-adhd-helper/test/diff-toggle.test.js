const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')

function uri(filePath, scheme = 'file') {
	return {
		scheme,
		fsPath: filePath,
		toString() {
			return `${scheme}://${filePath}`
		},
	}
}

function editor(fileUri) {
	return {
		document: { uri: fileUri },
		selection: { active: { line: 0 } },
		setDecorations() {},
	}
}

function disposable() {
	return { dispose() {} }
}

function createHarness({
	activeFile,
	previewFile,
	quickPickTarget,
	rejectSource = false,
	renderedDiff = false,
	rejectSettingUpdate = false,
	settingsState = {},
	workspaceFolders,
	failingCommands = [],
} = {}) {
	const commands = new Map()
	const settingsWrites = []
	const executed = []
	const openedDiffs = []
	const shownDocuments = []
	const sourceFile = activeFile ?? uri('/repo/a.md')
	const repo = {
		rootUri: uri('/repo'),
		state: {
			workingTreeChanges: [
				{ uri: sourceFile, decorations: { tooltip: 'modified' } },
			],
			indexChanges: [],
			mergeChanges: [],
			onDidChange: () => disposable(),
		},
	}
	const gitApi = {
		repositories: [repo],
		onDidOpenRepository: () => disposable(),
	}
	const vscode = {
		commands: {
			registerCommand(name, handler) {
				commands.set(name, handler)
				return disposable()
			},
			async executeCommand(name, ...args) {
				executed.push({ name, args })

				if (failingCommands.includes(name)) {
					throw new Error(`command unavailable: ${name}`)
				}

				if (commands.has(name)) {
					return commands.get(name)(...args)
				}

				if (name === 'git.openChange') {
					const fileUri = args[0]
					openedDiffs.push(fileUri)
					vscode.window.activeTextEditor = renderedDiff
						? undefined
						: editor(uri(fileUri.fsPath, 'git'))
					vscode.window.tabGroups.activeTabGroup.activeTab = renderedDiff
						? { input: { viewType: 'vscode.markdown.preview.diff' } }
						: {
								input: {
									original: uri(fileUri.fsPath, 'git'),
									modified: fileUri,
								},
							}
				}

				if (name === 'markdown.showSource' && previewFile) {
					vscode.window.activeTextEditor = editor(previewFile)
					vscode.window.tabGroups.activeTabGroup.activeTab = {
						input: { uri: previewFile },
					}
				}

				if (name === 'markdown.reopenAsSource' && previewFile) {
					vscode.window.activeTextEditor = editor(previewFile)
					vscode.window.tabGroups.activeTabGroup.activeTab = {
						input: { uri: previewFile },
					}
				}
			},
		},
		extensions: {
			getExtension(name) {
				if (name !== 'vscode.git') return undefined
				return { isActive: true, exports: { getAPI: () => gitApi } }
			},
		},
		window: {
			activeTextEditor: editor(sourceFile),
			activeTerminal: undefined,
			tabGroups: {
				activeTabGroup: { activeTab: { input: { uri: sourceFile } } },
				onDidChangeTabs: () => disposable(),
			},
			createStatusBarItem() {
				return { show() {}, dispose() {} }
			},
			createTextEditorDecorationType: () => disposable(),
			onDidChangeActiveTextEditor: () => disposable(),
			onDidChangeTextEditorSelection: () => disposable(),
			showQuickPick: async (items) =>
				quickPickTarget ? items.find(quickPickTarget) : undefined,
			async showTextDocument(fileUri) {
				shownDocuments.push(fileUri)
				if (rejectSource) throw new Error('missing source')
				vscode.window.activeTextEditor = editor(fileUri)
				vscode.window.tabGroups.activeTabGroup.activeTab = {
					input: { uri: fileUri },
				}
				return vscode.window.activeTextEditor
			},
		},
		workspace: {
			workspaceFolders: workspaceFolders ?? [{ uri: uri('/repo') }],
			getConfiguration() {
				return {
					inspect(section) {
						return settingsState[section]
					},
					async update(section, value, target) {
						if (rejectSettingUpdate) {
							throw new Error('read-only settings')
						}

						settingsWrites.push({ section, value, target })

						const entry = settingsState[section] ?? {}
						if (target === 2) {
							entry.workspaceValue = value
						} else {
							entry.globalValue = value
						}
						settingsState[section] = entry
					},
				}
			},
		},
		ConfigurationTarget: { Global: 1, Workspace: 2 },
		MarkdownString: class {
			appendMarkdown() {}
		},
		OverviewRulerLane: { Full: 1, Left: 2 },
		QuickPickItemKind: { Separator: -1 },
		Range: class {},
		StatusBarAlignment: { Left: 1 },
		ThemeColor: class {},
	}

	return {
		commands,
		executed,
		gitApi,
		openedDiffs,
		repo,
		settingsState,
		settingsWrites,
		shownDocuments,
		vscode,
	}
}

function loadExtension(vscode) {
	const extensionPath = path.resolve(__dirname, '..', 'extension.js')
	const originalLoad = Module._load

	delete require.cache[extensionPath]
	Module._load = function load(request, parent, isMain) {
		if (request === 'vscode') return vscode
		return originalLoad.call(this, request, parent, isMain)
	}

	try {
		return require(extensionPath)
	} finally {
		Module._load = originalLoad
	}
}

function activate(extension, harness) {
	extension.activate({ subscriptions: [] })
	return harness.commands
}

function focusSource(harness, file) {
	harness.vscode.window.activeTextEditor = editor(file)
	harness.vscode.window.tabGroups.activeTabGroup.activeTab = {
		input: { uri: file },
	}
}

async function pressDiffChord(commands) {
	await commands.get('nathan.runChordAction')({
		key: 'D',
		command: 'nathan.toggleGitDiff',
		receipt: false,
	})
}

test('Ctrl+G,D targets the current file after leaving an earlier diff', async () => {
	const fileA = uri('/repo/a.md')
	const fileB = uri('/repo/b.md')
	const harness = createHarness({ activeFile: fileA })
	harness.repo.state.workingTreeChanges.push({
		uri: fileB,
		decorations: { tooltip: 'modified' },
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleGitDiff')()
	focusSource(harness, fileB)
	await pressDiffChord(commands)

	assert.deepEqual(harness.openedDiffs, [fileA, fileB])
	assert.deepEqual(harness.shownDocuments, [])
})

test('Ctrl+G,D resolves a rendered Markdown preview through its source', async () => {
	const file = uri('/repo/readme.md')
	const harness = createHarness({ activeFile: file, previewFile: file })
	harness.vscode.window.activeTextEditor = undefined
	harness.vscode.window.tabGroups.activeTabGroup.activeTab = {
		input: { viewType: 'markdown.preview' },
	}
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleGitDiff')()

	assert.ok(harness.executed.some(({ name }) => name === 'markdown.showSource'))
	assert.deepEqual(harness.openedDiffs, [file])
})

test('Ctrl+G,D reopens a default Markdown preview editor as source', async () => {
	const file = uri('/repo/readme.md')
	const harness = createHarness({ activeFile: file, previewFile: file })
	harness.vscode.window.activeTextEditor = undefined
	harness.vscode.window.tabGroups.activeTabGroup.activeTab = {
		input: { viewType: 'vscode.markdown.preview.editor' },
	}
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleGitDiff')()

	assert.ok(
		harness.executed.some(({ name }) => name === 'markdown.reopenAsSource'),
	)
	assert.deepEqual(harness.openedDiffs, [file])
})

test('Ctrl+G,D returns from the active diff to its source', async () => {
	const file = uri('/repo/a.md')
	const harness = createHarness({ activeFile: file })
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleGitDiff')()
	await pressDiffChord(commands)

	assert.deepEqual(harness.shownDocuments, [file])
})

test('Ctrl+G,D returns from a rendered Markdown diff to its source', async () => {
	const file = uri('/repo/a.md')
	const harness = createHarness({ activeFile: file, renderedDiff: true })
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleGitDiff')()
	await pressDiffChord(commands)

	assert.deepEqual(harness.shownDocuments, [file])
})

test('the Toggle Git Diff command also returns from diff to source', async () => {
	const file = uri('/repo/a.md')
	const harness = createHarness({ activeFile: file })
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleGitDiff')()
	await commands.get('nathan.toggleGitDiff')()

	assert.deepEqual(harness.shownDocuments, [file])
})

test('changed files are deduplicated across staged and unstaged states', () => {
	const file = uri('/repo/a.md')
	const harness = createHarness({ activeFile: file })
	harness.repo.state.indexChanges.push({
		uri: file,
		decorations: { tooltip: 'staged' },
	})
	const extension = loadExtension(harness.vscode)

	const changes = extension.__test.getRepoChanges(harness.repo)
	const items = extension.__test.getChangedFileItems(harness.gitApi)

	assert.equal(changes.length, 1)
	assert.equal(changes[0].status, 'modified + staged')
	assert.equal(items.length, 2)
})

test('a missing source clears old diff state before the next file', async () => {
	const fileA = uri('/repo/a.md')
	const fileB = uri('/repo/b.md')
	const harness = createHarness({ activeFile: fileA, rejectSource: true })
	harness.repo.state.workingTreeChanges.push({
		uri: fileB,
		decorations: { tooltip: 'modified' },
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleGitDiff')()
	await pressDiffChord(commands)

	focusSource(harness, fileB)
	await pressDiffChord(commands)

	assert.deepEqual(harness.openedDiffs, [fileA, fileB])
})

test('the chord HUD cycles modes and runs a picked action', async () => {
	const harness = createHarness({
		quickPickTarget: (item) => item.action?.key === 'T',
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.enterChordMode')()
	await commands.get('nathan.cycleChordHud')()
	await commands.get('nathan.pinChordHud')()
	await commands.get('nathan.expandChordHudForInspection')()
	await commands.get('nathan.showChordPalette')()
	await commands.get('nathan.exitChordMode')()

	assert.ok(
		harness.executed.some(
			({ name, args }) => name === 'setContext' && args[1] === true,
		),
	)
	assert.ok(
		harness.executed.some(
			({ name }) => name === 'workbench.action.terminal.toggleTerminal',
		),
	)
	assert.ok(
		harness.executed.some(
			({ name, args }) => name === 'setContext' && args[1] === false,
		),
	)
})

test('the changed-file picker opens the selected source', async () => {
	const harness = createHarness({
		quickPickTarget: (item) => item.target === 'source',
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.showChangedFiles')()

	assert.deepEqual(
		harness.shownDocuments.map(({ fsPath }) => fsPath),
		['/repo/a.md'],
	)
})

test('the changed-file picker opens the selected diff', async () => {
	const harness = createHarness({
		quickPickTarget: (item) => item.target === 'diff',
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.showChangedFiles')()

	assert.deepEqual(
		harness.openedDiffs.map(({ fsPath }) => fsPath),
		['/repo/a.md'],
	)
})

test('the changed-file picker reports an empty repository', async () => {
	const harness = createHarness()
	harness.repo.state.workingTreeChanges = []
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.showChangedFiles')()

	assert.deepEqual(harness.openedDiffs, [])
	assert.deepEqual(harness.shownDocuments, [])
})

test('the sort toggle flips modified to default in workspace scope', async () => {
	const harness = createHarness({
		settingsState: { 'explorer.sortOrder': { globalValue: 'modified' } },
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleSortOrder')()

	assert.deepEqual(harness.settingsWrites, [
		{ section: 'explorer.sortOrder', value: 'default', target: 2 },
	])
})

test('the sort toggle returns to modified on the second press', async () => {
	const harness = createHarness({
		settingsState: { 'explorer.sortOrder': { globalValue: 'modified' } },
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleSortOrder')()
	await commands.get('nathan.toggleSortOrder')()

	assert.deepEqual(
		harness.settingsWrites.map(({ value }) => value),
		['default', 'modified'],
	)
})

test('a workspace value wins over a global value when toggling', async () => {
	const harness = createHarness({
		settingsState: {
			'explorer.sortOrder': {
				globalValue: 'modified',
				workspaceValue: 'default',
			},
		},
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleSortOrder')()

	assert.equal(harness.settingsWrites[0].value, 'modified')
})

test('the nesting toggle flips true to false in workspace scope', async () => {
	const harness = createHarness({
		settingsState: { 'explorer.fileNesting.enabled': { globalValue: true } },
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleFileNesting')()

	assert.deepEqual(harness.settingsWrites, [
		{ section: 'explorer.fileNesting.enabled', value: false, target: 2 },
	])
})

test('a toggle falls back to global scope when no folder is open', async () => {
	const harness = createHarness({
		settingsState: { 'explorer.sortOrder': { globalValue: 'modified' } },
		workspaceFolders: [],
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleSortOrder')()

	assert.deepEqual(harness.settingsWrites, [
		{ section: 'explorer.sortOrder', value: 'default', target: 1 },
	])
})

test('an unwritable settings file leaves the toggle unchanged', async () => {
	const harness = createHarness({
		settingsState: { 'explorer.sortOrder': { globalValue: 'modified' } },
		rejectSettingUpdate: true,
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.toggleSortOrder')()

	assert.deepEqual(harness.settingsWrites, [])
})

test('an unknown current value restarts the toggle at the first value', () => {
	const harness = createHarness()
	const extension = loadExtension(harness.vscode)
	const { nextToggleValue, settingToggles } = extension.__test

	const sort = settingToggles['explorer.sortOrder']

	assert.equal(nextToggleValue(sort, 'type'), 'modified')
	assert.equal(nextToggleValue(sort, undefined), 'modified')
})

test('toggle receipts name the state in plain words', () => {
	const harness = createHarness()
	const extension = loadExtension(harness.vscode)
	const { describeToggleValue, settingToggles } = extension.__test

	assert.equal(
		describeToggleValue(settingToggles['explorer.sortOrder'], 'modified'),
		'newest first',
	)
	assert.equal(
		describeToggleValue(settingToggles['explorer.fileNesting.enabled'], false),
		'flat',
	)
})

test('the git layout chord restores the graph on the right', async () => {
	const harness = createHarness()
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.openGitLayout')()

	const open = harness.executed.find(
		({ name }) => name === 'workbench.scm.history.open',
	)

	assert.ok(open, 'expected the graph view to be opened, not merely focused')
	assert.deepEqual(open.args, [{ preserveFocus: true }])
})

test('the git layout chord opens source control and keeps focus left', async () => {
	const harness = createHarness()
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.openGitLayout')()

	const order = harness.executed
		.map(({ name }) => name)
		.filter((name) => name.startsWith('workbench.'))

	assert.deepEqual(order, ['workbench.scm.history.open', 'workbench.view.scm'])
})

test('the git layout chord still opens the left panel when the graph fails', async () => {
	const harness = createHarness({
		failingCommands: ['workbench.scm.history.open'],
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.openGitLayout')()

	assert.ok(
		harness.executed.some(({ name }) => name === 'workbench.view.scm'),
		'a missing graph must not cost Nathan the left panel too',
	)
})

test('the git layout chord repeats without toggling a panel shut', async () => {
	const harness = createHarness()
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.openGitLayout')()
	await commands.get('nathan.openGitLayout')()

	const toggles = harness.executed.filter(({ name }) =>
		name.toLowerCase().includes('toggle'),
	)

	assert.deepEqual(toggles, [])
})

test('the chat chord opens chat in the right panel', async () => {
	const harness = createHarness()
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.openChatRight')()

	assert.ok(
		harness.executed.some(
			({ name }) => name === 'workbench.panel.chat.view.copilot.open',
		),
		'expected the chat view to be opened into its pinned container',
	)
})

test('the chat chord falls back when the right-panel view is missing', async () => {
	const harness = createHarness({
		failingCommands: ['workbench.panel.chat.view.copilot.open'],
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.openChatRight')()

	assert.ok(
		harness.executed.some(({ name }) => name === 'workbench.action.openChat'),
		'a missing right-panel view must still open chat somewhere',
	)
})

test('the git layout chord opens both staged and unstaged changes', async () => {
	const harness = createHarness()
	harness.repo.state.indexChanges.push({
		uri: uri('/repo/staged.md'),
		decorations: { tooltip: 'staged' },
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.openGitLayout')()

	const diffs = harness.executed
		.map(({ name }) => name)
		.filter((name) => name.startsWith('git.view'))

	assert.deepEqual(diffs, ['git.viewStagedChanges', 'git.viewChanges'])
})

test('the git layout chord opens staged changes when nothing is unstaged', async () => {
	const harness = createHarness()
	harness.repo.state.workingTreeChanges = []
	harness.repo.state.indexChanges.push({
		uri: uri('/repo/staged.md'),
		decorations: { tooltip: 'staged' },
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.openGitLayout')()

	const diffs = harness.executed
		.map(({ name }) => name)
		.filter((name) => name.startsWith('git.view'))

	assert.deepEqual(diffs, ['git.viewStagedChanges'])
})

test('the git layout chord never opens an empty change group', async () => {
	const harness = createHarness()
	harness.repo.state.workingTreeChanges = []
	harness.repo.state.indexChanges = []
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.openGitLayout')()

	const diffs = harness.executed.filter(({ name }) =>
		name.startsWith('git.view'),
	)

	assert.deepEqual(diffs, [], 'an empty group shows a modal message')
	assert.ok(
		harness.executed.some(({ name }) => name === 'workbench.view.scm'),
		'the rest of the layout must still open',
	)
})

test('a refused change group does not stop the other one', async () => {
	const harness = createHarness({
		failingCommands: ['git.viewStagedChanges'],
	})
	harness.repo.state.indexChanges.push({
		uri: uri('/repo/staged.md'),
		decorations: { tooltip: 'staged' },
	})
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.openGitLayout')()

	assert.ok(
		harness.executed.some(({ name }) => name === 'git.viewChanges'),
		'the working tree diff must still open',
	)
})

test('every printable key is bound while the chord HUD is open', () => {
	const manifest = require('../package.json')
	const bound = new Set(
		manifest.contributes.keybindings
			.filter((entry) => entry.when === 'nathan.adhdChordMode')
			.map((entry) => entry.key),
	)

	const printable = [
		...'abcdefghijklmnopqrstuvwxyz',
		...'0123456789',
		...['`', '[', ']', '\\', "'", '-', '=', ',', '.', '/', ';'],
	]

	const unbound = printable.filter((key) => !bound.has(key))

	assert.deepEqual(
		unbound,
		[],
		'an unbound key types itself into the document instead of reporting',
	)
})

test('an unbound chord key warns and leaves chord mode', async () => {
	const harness = createHarness()
	const extension = loadExtension(harness.vscode)
	const commands = activate(extension, harness)

	await commands.get('nathan.enterChordMode')()
	await commands.get('nathan.unboundChordKey')()

	assert.ok(
		harness.executed.some(
			({ name, args }) => name === 'setContext' && args[1] === false,
		),
		'chord mode must close so the next keystroke behaves normally',
	)
})
