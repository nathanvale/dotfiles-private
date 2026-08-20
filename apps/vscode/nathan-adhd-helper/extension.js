const path = require('path')
const vscode = require('vscode')

const CHORD_TIMEOUT_MS = 7000
const CHORD_INSPECT_TIMEOUT_MS = 30000
const RECEIPT_LIMIT = 3

const chordHudMode = {
	COMPACT: 'compact',
	EXPANDED: 'expanded',
	PINNED: 'pinned',
}

const chordActions = [
	{ key: 'E', label: 'Explorer', command: 'workbench.view.explorer' },
	{
		key: 'D',
		label: 'Diff/source toggle',
		command: 'nathan.toggleGitDiff',
		receipt: false,
	},
	{
		key: ',',
		label: 'Changed files',
		command: 'nathan.showChangedFiles',
		receipt: false,
	},
	{
		key: 'S',
		label: 'Explorer sort toggle',
		command: 'nathan.toggleSortOrder',
		receipt: false,
	},
	{
		key: 'N',
		label: 'File nesting toggle',
		command: 'nathan.toggleFileNesting',
		receipt: false,
	},
	{
		key: 'G',
		label: 'Git layout',
		command: 'nathan.openGitLayout',
		receipt: false,
	},
	{ key: 'F', label: 'Find in files', command: 'workbench.action.findInFiles' },
	{ key: 'X', label: 'Extensions', command: 'workbench.view.extensions' },
	{ key: 'O', label: 'Symbols', command: 'workbench.action.gotoSymbol' },
	{ key: 'I', label: 'Info/hover', command: 'editor.action.showHover' },
	{
		key: 'T',
		label: 'Terminal',
		command: 'workbench.action.terminal.toggleTerminal',
	},
	{ key: 'C', label: 'Chat', command: 'workbench.action.openChat' },
	{
		key: 'W',
		label: 'Close all editors',
		command: 'workbench.action.closeAllEditors',
	},
	{ key: 'Z', label: 'Zen mode', command: 'workbench.action.toggleZenMode' },
	{
		key: 'H',
		label: 'Focus left group',
		command: 'workbench.action.focusLeftGroup',
	},
	{
		key: 'J',
		label: 'Focus below group',
		command: 'workbench.action.focusBelowGroup',
	},
	{
		key: 'K',
		label: 'Focus above group',
		command: 'workbench.action.focusAboveGroup',
	},
	{
		key: 'L',
		label: 'Focus right group',
		command: 'workbench.action.focusRightGroup',
	},
	{ key: 'A', label: 'Stage all changes', command: 'git.stageAll' },
	{ key: 'U', label: 'Undo commit', command: 'git.undoCommit' },
	{ key: '.', label: 'Quick fix', command: 'editor.action.quickFix' },
	{
		key: ';',
		label: 'Keyboard shortcuts',
		command: 'workbench.action.openGlobalKeybindings',
	},
	{ key: 'M', label: 'Markdown source', command: 'markdown.showSource' },
	{ key: 'R', label: 'Run task', command: 'workbench.action.tasks.runTask' },
	{
		key: 'Shift+R',
		label: 'Rerun task',
		command: 'workbench.action.tasks.reRunTask',
	},
	{
		key: 'Shift+T',
		label: 'Test task',
		command: 'workbench.action.tasks.test',
	},
	{
		key: 'Shift+D',
		label: 'Go to definition',
		command: 'editor.action.revealDefinition',
	},
	{ key: '-', label: 'Back', command: 'workbench.action.navigateBack' },
	{ key: '=', label: 'Forward', command: 'workbench.action.navigateForward' },
	{ key: '/', label: 'Filter tree (Explorer)', command: 'list.find' },
]

const chordGroups = [
	{ label: 'Views', keys: ['E', 'G', 'F', 'X', '/'] },
	{ label: 'Git', keys: ['D', ',', 'A', 'U', 'P'] },
	{ label: 'Nav', keys: ['-', '=', 'O', 'H', 'J', 'K', 'L'] },
	{ label: 'Actions', keys: ['.', 'I', 'T', 'C', 'W', 'Z', 'R'] },
]

const modeColor = {
	DIFF: 'rgba(73, 142, 255, 0.9)',
	SOURCE: 'rgba(54, 174, 124, 0.9)',
	TERMINAL: 'rgba(255, 196, 0, 0.9)',
	WORKBENCH: 'rgba(160, 160, 160, 0.8)',
}

function sameUri(left, right) {
	return left?.toString() === right?.toString()
}

function isInside(rootUri, fileUri) {
	const rootPath = rootUri.fsPath
	const filePath = fileUri.fsPath

	return filePath === rootPath || filePath.startsWith(rootPath + path.sep)
}

function getChangeUri(change) {
	return change?.uri ?? change?.resourceUri
}

function getRepoChanges(repo) {
	const changes = [
		...repo.state.workingTreeChanges,
		...repo.state.indexChanges,
		...repo.state.mergeChanges,
	]
	const uniqueChanges = new Map()

	for (const change of changes) {
		const uri = getChangeUri(change)

		if (!uri) {
			continue
		}

		const key = uri.toString()
		const status = change.decorations?.tooltip ?? 'changed'
		const current = uniqueChanges.get(key)

		if (current) {
			current.statuses.add(status)
		} else {
			uniqueChanges.set(key, {
				uri,
				statuses: new Set([status]),
			})
		}
	}

	return [...uniqueChanges.values()].map(({ uri, statuses }) => ({
		uri,
		status: [...statuses].join(' + '),
	}))
}

function hasFileChange(repo, fileUri) {
	return getRepoChanges(repo).some((change) =>
		sameUri(getChangeUri(change), fileUri),
	)
}

async function getGitApi() {
	const extension = vscode.extensions.getExtension('vscode.git')

	if (!extension) {
		return undefined
	}

	if (!extension.isActive) {
		await extension.activate()
	}

	return extension.exports.getAPI(1)
}

function findRepository(api, fileUri) {
	return api.repositories
		.filter((repo) => isInside(repo.rootUri, fileUri))
		.sort(
			(left, right) => right.rootUri.fsPath.length - left.rootUri.fsPath.length,
		)[0]
}

function isDiffTab(tab) {
	const input = tab?.input

	return Boolean(input?.modified && input?.original)
}

function getFileUri(uri) {
	return uri?.scheme === 'file' ? uri : undefined
}

function getFileUriFromTab(tab) {
	const input = tab?.input

	return (
		getFileUri(input?.uri) ??
		getFileUri(input?.modified) ??
		getFileUri(input?.original)
	)
}

function isMarkdownPreviewTab(tab) {
	return /markdown/i.test(tab?.input?.viewType ?? '')
}

function isMarkdownPreviewEditorTab(tab) {
	return tab?.input?.viewType === 'vscode.markdown.preview.editor'
}

function getCurrentMode() {
	const tab = vscode.window.tabGroups.activeTabGroup.activeTab

	if (isDiffTab(tab) || activeDiffState?.tab === tab) {
		return 'DIFF'
	}

	const editor = vscode.window.activeTextEditor

	if (editor?.document.uri.scheme === 'git') {
		return 'DIFF'
	}

	if (editor?.document.uri.scheme === 'file') {
		return 'SOURCE'
	}

	if (vscode.window.activeTerminal) {
		return 'TERMINAL'
	}

	return 'WORKBENCH'
}

let flashItem
let flashDecoration
let chordItem
let chordTimer
let chordMode = chordHudMode.COMPACT
let cheatSheetItem
let receiptItem
let receiptHistory = []
let modeItem
let modeDecoration
let dirtyItem
let gitSubscriptions = []
let activeDiffState

function recordReceipt(message) {
	receiptHistory = [
		message,
		...receiptHistory.filter((item) => item !== message),
	].slice(0, RECEIPT_LIMIT)

	if (!receiptItem) {
		receiptItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			9998,
		)
		receiptItem.tooltip = 'Nathan ADHD Helper recent actions'
	}

	receiptItem.text = `$(history) Last: ${receiptHistory.join(' -> ')}`
	receiptItem.show()
}

function flash(message, editor, tone = 'warning', suggestion) {
	if (flashItem) {
		flashItem.dispose()
	}
	if (flashDecoration) {
		flashDecoration.dispose()
	}

	const visibleMessage = suggestion ? `${message} | ${suggestion}` : message

	recordReceipt(message)

	flashItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		10000,
	)
	flashItem.text =
		tone === 'success'
			? `$(check) ${visibleMessage}`
			: `$(warning) ${visibleMessage}`
	flashItem.tooltip = 'Nathan ADHD Helper feedback'
	flashItem.backgroundColor =
		tone === 'success'
			? new vscode.ThemeColor('statusBarItem.prominentBackground')
			: new vscode.ThemeColor('statusBarItem.warningBackground')
	flashItem.show()

	if (editor) {
		flashDecoration = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: 'rgba(255, 196, 0, 0.22)',
			overviewRulerColor: 'rgba(255, 196, 0, 0.9)',
			overviewRulerLane: vscode.OverviewRulerLane.Full,
		})

		const line = editor.selection.active.line
		const range = new vscode.Range(line, 0, line, 0)
		editor.setDecorations(flashDecoration, [range])
	}

	const currentFlashItem = flashItem
	const currentFlashDecoration = flashDecoration

	setTimeout(() => {
		currentFlashItem.dispose()
		currentFlashDecoration?.dispose()

		if (flashItem === currentFlashItem) {
			flashItem = undefined
		}

		if (flashDecoration === currentFlashDecoration) {
			flashDecoration = undefined
		}
	}, 2600)
}

function getAction(key) {
	return chordActions.find((action) => action.key === key)
}

function formatChordHud() {
	if (chordMode === chordHudMode.PINNED) {
		const groups = chordGroups
			.map((group) => `${group.label} ${group.keys.join('/')}`)
			.join('  |  ')

		return `$(pinned) Ctrl+G pinned: ${groups}  |  Space search  |  Esc close`
	}

	if (chordMode === chordHudMode.EXPANDED) {
		const groups = chordGroups
			.map((group) => {
				const items = group.keys
					.map((key) => {
						const action = getAction(key)

						return action ? `${key} ${action.label}` : key
					})
					.join(', ')

				return `${group.label}: ${items}`
			})
			.join(' | ')

		return `$(keyboard) Ctrl+G expanded: ${groups}`
	}

	const groups = chordGroups
		.map((group) => `${group.label} ${group.keys.join('/')}`)
		.join(' | ')

	return `$(keyboard) Ctrl+G ${groups} | Ctrl+G expand | ? pin | Space search`
}

function formatChordTooltip() {
	const tooltip = new vscode.MarkdownString()
	tooltip.isTrusted = false
	tooltip.appendMarkdown('**Nathan ADHD Helper chord HUD**\n\n')

	for (const group of chordGroups) {
		tooltip.appendMarkdown(`**${group.label}**\n\n`)

		for (const key of group.keys) {
			const action = getAction(key)

			if (action) {
				tooltip.appendMarkdown(`- \`${key}\` ${action.label}\n`)
			}
		}

		tooltip.appendMarkdown('\n')
	}

	tooltip.appendMarkdown('`Esc` cancel')
	tooltip.appendMarkdown('\n\n`Ctrl+G` cycles compact -> expanded -> pinned.')
	tooltip.appendMarkdown(
		'\n\n`?` pins the HUD. `Space` opens searchable actions.',
	)

	return tooltip
}

function ensureCheatSheetItem() {
	if (cheatSheetItem) {
		return
	}

	cheatSheetItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		10002,
	)
	cheatSheetItem.text = '$(keyboard) Ctrl+G ?'
	cheatSheetItem.tooltip =
		'Nathan ADHD Helper chord map. Click for searchable actions.'
	cheatSheetItem.command = 'nathan.showChordPalette'
	cheatSheetItem.show()
}

function getChordQuickPickItems() {
	const items = []

	for (const group of chordGroups) {
		items.push({
			label: group.label,
			kind: vscode.QuickPickItemKind.Separator,
		})

		for (const key of group.keys) {
			const action = getAction(key)

			if (action) {
				items.push({
					label: `${key} ${action.label}`,
					description: action.command,
					detail: `Press ${key} after Ctrl+G`,
					action,
				})
			}
		}
	}

	return items
}

async function showChordPalette() {
	await exitChordMode()

	const picked = await vscode.window.showQuickPick(getChordQuickPickItems(), {
		matchOnDescription: true,
		matchOnDetail: true,
		placeHolder: 'Search a Nathan ADHD Helper action',
		title: 'Nathan ADHD Helper chord map',
	})

	if (!picked || !picked.action) {
		recordReceipt('Chord map dismissed')
		return
	}

	await runChordAction(picked.action)
}

function updateModeFrame(modeOverride) {
	const mode = modeOverride ?? getCurrentMode()

	if (!modeItem) {
		modeItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			9997,
		)
		modeItem.tooltip = 'Nathan ADHD Helper focus mode'
		modeItem.show()
	}

	modeItem.text = `$(target) ${mode}`

	if (modeDecoration) {
		modeDecoration.dispose()
		modeDecoration = undefined
	}

	const editor = vscode.window.activeTextEditor

	if (!editor) {
		return
	}

	modeDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		borderColor: modeColor[mode] ?? modeColor.WORKBENCH,
		borderStyle: 'solid',
		borderWidth: '0 0 0 3px',
		overviewRulerColor: modeColor[mode] ?? modeColor.WORKBENCH,
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	})

	const line = editor.selection.active.line
	const range = new vscode.Range(line, 0, line, 0)
	editor.setDecorations(modeDecoration, [range])
}

async function refreshDirtyRadar() {
	const api = await getGitApi()
	const count = api
		? api.repositories.reduce(
				(total, repo) => total + getRepoChanges(repo).length,
				0,
			)
		: 0

	if (!dirtyItem) {
		dirtyItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			9996,
		)
		dirtyItem.command = 'nathan.showChangedFiles'
		dirtyItem.tooltip = 'Nathan ADHD Helper changed files'
	}

	dirtyItem.text = `$(git-commit) ${count} changed`
	dirtyItem.show()
}

async function registerGitListeners(context) {
	const api = await getGitApi()

	if (!api) {
		return
	}

	for (const subscription of gitSubscriptions) {
		subscription.dispose()
	}

	gitSubscriptions = []

	const watchRepo = (repo) => {
		const subscription = repo.state.onDidChange(() => {
			refreshDirtyRadar()
		})

		gitSubscriptions.push(subscription)
		context.subscriptions.push(subscription)
	}

	for (const repo of api.repositories) {
		watchRepo(repo)
	}

	if (api.onDidOpenRepository) {
		const openSubscription = api.onDidOpenRepository((repo) => {
			watchRepo(repo)
			refreshDirtyRadar()
		})

		gitSubscriptions.push(openSubscription)
		context.subscriptions.push(openSubscription)
	}

	await refreshDirtyRadar()
}

async function exitChordMode() {
	clearTimeout(chordTimer)
	chordTimer = undefined
	chordMode = chordHudMode.COMPACT

	if (chordItem) {
		chordItem.dispose()
		chordItem = undefined
	}

	await vscode.commands.executeCommand(
		'setContext',
		'nathan.adhdChordMode',
		false,
	)
}

function scheduleChordTimeout() {
	clearTimeout(chordTimer)
	chordTimer = undefined

	if (chordMode === chordHudMode.PINNED) {
		return
	}

	const timeout =
		chordMode === chordHudMode.EXPANDED
			? CHORD_INSPECT_TIMEOUT_MS
			: CHORD_TIMEOUT_MS

	chordTimer = setTimeout(() => {
		exitChordMode()
	}, timeout)
}

function renderChordHud() {
	if (!chordItem) {
		chordItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			10001,
		)
		chordItem.tooltip = formatChordTooltip()
		chordItem.backgroundColor = new vscode.ThemeColor(
			'statusBarItem.prominentBackground',
		)
		chordItem.show()
	}

	chordItem.text = formatChordHud()
	chordItem.tooltip = formatChordTooltip()
	chordItem.show()
}

async function enterChordMode(mode = chordHudMode.COMPACT) {
	await exitChordMode()
	await vscode.commands.executeCommand(
		'setContext',
		'nathan.adhdChordMode',
		true,
	)

	chordMode = mode
	renderChordHud()
	scheduleChordTimeout()
}

async function cycleChordHud() {
	if (!chordItem) {
		await enterChordMode(chordHudMode.COMPACT)
		return
	}

	if (chordMode === chordHudMode.COMPACT) {
		chordMode = chordHudMode.EXPANDED
		recordReceipt('Chord HUD expanded')
	} else if (chordMode === chordHudMode.EXPANDED) {
		chordMode = chordHudMode.PINNED
		recordReceipt('Chord HUD pinned')
	} else {
		chordMode = chordHudMode.COMPACT
		recordReceipt('Chord HUD compact')
	}

	renderChordHud()
	scheduleChordTimeout()
}

async function pinChordHud() {
	if (!chordItem) {
		await enterChordMode(chordHudMode.PINNED)
	} else {
		chordMode = chordHudMode.PINNED
		renderChordHud()
		scheduleChordTimeout()
	}

	recordReceipt('Chord HUD pinned')
}

async function expandChordHudForInspection() {
	if (!chordItem) {
		await enterChordMode(chordHudMode.EXPANDED)
	} else {
		chordMode = chordHudMode.EXPANDED
		renderChordHud()
		scheduleChordTimeout()
	}

	recordReceipt('Chord HUD inspect mode')
}

async function runChordAction(action) {
	await exitChordMode()

	if (!action || !action.command) {
		flash(
			'Unknown chord action',
			undefined,
			'warning',
			'Press Ctrl+G to reopen HUD',
		)
		return
	}

	if (action.key === 'D' && getCurrentMode() === 'DIFF') {
		await openSourceFromDiff()
		return
	}

	await vscode.commands.executeCommand(action.command)
	await refreshDirtyRadar()
	updateModeFrame()

	if (action.receipt !== false) {
		flash(action.label, undefined, 'success')
	}
}

function getChangeStatus(change) {
	return change.status ?? change.decorations?.tooltip ?? 'changed'
}

function getChangedFileItems(api) {
	const items = []

	for (const repo of api.repositories) {
		for (const change of getRepoChanges(repo)) {
			const uri = getChangeUri(change)

			if (!uri) {
				continue
			}

			const relativePath = path.relative(repo.rootUri.fsPath, uri.fsPath)
			const status = getChangeStatus(change)

			items.push({
				label: `$(git-compare) Diff ${relativePath}`,
				description: status,
				detail: repo.rootUri.fsPath,
				uri,
				target: 'diff',
			})
			items.push({
				label: `$(file-code) Source ${relativePath}`,
				description: status,
				detail: repo.rootUri.fsPath,
				uri,
				target: 'source',
			})
		}
	}

	return items
}

async function showChangedFiles() {
	await exitChordMode()

	const api = await getGitApi()

	if (!api) {
		flash(
			'Git extension unavailable',
			undefined,
			'warning',
			'Open Source Control',
		)
		return
	}

	const items = getChangedFileItems(api)

	if (items.length === 0) {
		flash(
			'No changed files',
			undefined,
			'warning',
			'Ctrl+G G opens Source Control',
		)
		await refreshDirtyRadar()
		return
	}

	const picked = await vscode.window.showQuickPick(items, {
		matchOnDescription: true,
		matchOnDetail: true,
		placeHolder: 'Open a changed file as source or diff',
		title: `${items.length / 2} changed file${items.length === 2 ? '' : 's'}`,
	})

	if (!picked) {
		recordReceipt('Changed files dismissed')
		return
	}

	if (picked.target === 'diff') {
		await vscode.commands.executeCommand('git.openChange', picked.uri)
		activeDiffState = {
			sourceUri: picked.uri,
			tab: vscode.window.tabGroups.activeTabGroup.activeTab,
		}
		await vscode.commands.executeCommand(
			'workbench.action.focusActiveEditorGroup',
		)
		flash('Changed file diff opened', undefined, 'success')
	} else {
		activeDiffState = undefined
		await vscode.window.showTextDocument(picked.uri)
		flash('Changed file source opened', undefined, 'success')
	}

	await refreshDirtyRadar()
	updateModeFrame()
}

async function getActiveFileUri() {
	const editorUri = getFileUri(vscode.window.activeTextEditor?.document.uri)

	if (editorUri) {
		return editorUri
	}

	const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
	const tabUri = getFileUriFromTab(activeTab)

	if (tabUri) {
		return tabUri
	}

	if (!isMarkdownPreviewTab(activeTab)) {
		return undefined
	}

	try {
		await vscode.commands.executeCommand(
			isMarkdownPreviewEditorTab(activeTab)
				? 'markdown.reopenAsSource'
				: 'markdown.showSource',
		)
	} catch {
		return undefined
	}

	return (
		getFileUri(vscode.window.activeTextEditor?.document.uri) ??
		getFileUriFromTab(vscode.window.tabGroups.activeTabGroup.activeTab)
	)
}

function getActiveDiffSourceUri() {
	const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab

	if (activeDiffState?.tab === activeTab) {
		return activeDiffState.sourceUri
	}

	if (!isDiffTab(activeTab)) {
		return undefined
	}

	return getFileUriFromTab(activeTab)
}

async function toggleGitDiff() {
	if (getCurrentMode() === 'DIFF') {
		await openSourceFromDiff()
		return
	}

	const fileUri = await getActiveFileUri()
	const editor = sameUri(vscode.window.activeTextEditor?.document.uri, fileUri)
		? vscode.window.activeTextEditor
		: undefined

	if (!fileUri) {
		flash(
			'No source file to diff',
			undefined,
			'warning',
			'Ctrl+G , shows changed files',
		)
		return
	}

	const api = await getGitApi()
	const repo = api ? findRepository(api, fileUri) : undefined

	if (!repo) {
		flash(
			'No Git repository for this file',
			editor,
			'warning',
			'Ctrl+G E opens Explorer',
		)
		await refreshDirtyRadar()
		return
	}

	if (!hasFileChange(repo, fileUri)) {
		flash(
			'No Git diff for this file',
			editor,
			'warning',
			'Ctrl+G , shows changed files',
		)
		await refreshDirtyRadar()
		return
	}

	await vscode.commands.executeCommand('git.openChange', fileUri)
	await vscode.commands.executeCommand(
		'workbench.action.focusActiveEditorGroup',
	)
	activeDiffState = {
		sourceUri: fileUri,
		tab: vscode.window.tabGroups.activeTabGroup.activeTab,
	}
	flash('Git diff opened', undefined, 'success')
	await refreshDirtyRadar()
	updateModeFrame('DIFF')
}

async function openSourceFromDiff() {
	await exitChordMode()
	const sourceUri = getActiveDiffSourceUri()

	if (!sourceUri) {
		flash(
			'No source file for this diff',
			undefined,
			'warning',
			'Ctrl+G , shows changed files',
		)
		return
	}

	activeDiffState = undefined

	try {
		await vscode.window.showTextDocument(sourceUri, { preview: false })
	} catch {
		flash(
			'Source file unavailable',
			undefined,
			'warning',
			'Ctrl+G , shows changed files',
		)
		await refreshDirtyRadar()
		updateModeFrame()
		return
	}

	await vscode.commands.executeCommand(
		'workbench.action.focusActiveEditorGroup',
	)
	flash('Source opened from diff', undefined, 'success')
	await refreshDirtyRadar()
	updateModeFrame('SOURCE')
}

const settingToggles = {
	'explorer.sortOrder': {
		label: 'Explorer sort',
		values: ['modified', 'default'],
		describe: {
			modified: 'newest first',
			default: 'alphabetical',
		},
	},
	'explorer.fileNesting.enabled': {
		label: 'File nesting',
		values: [true, false],
		describe: {
			true: 'nested',
			false: 'flat',
		},
	},
}

function nextToggleValue(toggle, current) {
	const index = toggle.values.indexOf(current)

	return index === -1 || index === toggle.values.length - 1
		? toggle.values[0]
		: toggle.values[index + 1]
}

function describeToggleValue(toggle, value) {
	return toggle.describe[String(value)] ?? String(value)
}

function hasWorkspaceFolder() {
	return (vscode.workspace.workspaceFolders?.length ?? 0) > 0
}

async function toggleSetting(section) {
	const toggle = settingToggles[section]

	if (!toggle) {
		flash('Unknown setting toggle', undefined, 'warning')
		return
	}

	const config = vscode.workspace.getConfiguration()
	const inspected = config.inspect(section)
	const workspace = hasWorkspaceFolder()

	const current = workspace
		? (inspected?.workspaceValue ??
			inspected?.globalValue ??
			inspected?.defaultValue)
		: (inspected?.globalValue ?? inspected?.defaultValue)

	const next = nextToggleValue(toggle, current)
	const target = workspace
		? vscode.ConfigurationTarget.Workspace
		: vscode.ConfigurationTarget.Global

	try {
		await config.update(section, next, target)
	} catch {
		flash(
			`${toggle.label} unchanged`,
			undefined,
			'warning',
			'Settings file is not writable',
		)
		return
	}

	flash(
		`${toggle.label}: ${describeToggleValue(toggle, next)}`,
		undefined,
		'success',
		workspace ? undefined : 'Global: no folder open',
	)
}

async function toggleSortOrder() {
	await exitChordMode()
	await toggleSetting('explorer.sortOrder')
}

async function toggleFileNesting() {
	await exitChordMode()
	await toggleSetting('explorer.fileNesting.enabled')
}

async function openGitLayout() {
	await exitChordMode()

	let graphOpened = false

	try {
		await vscode.commands.executeCommand('workbench.scm.history.open', {
			preserveFocus: true,
		})
		graphOpened = true
	} catch {
		graphOpened = false
	}

	try {
		await vscode.commands.executeCommand('workbench.view.scm')
	} catch {
		flash(
			'Source Control unavailable',
			undefined,
			'warning',
			'Open a folder with a Git repository',
		)
		return
	}

	if (!graphOpened) {
		flash(
			'Graph not restored',
			undefined,
			'warning',
			'Drag Source Control Graph to the right panel once',
		)
		return
	}

	flash('Git layout restored', undefined, 'success')
}

function activate(context) {
	const subscriptions = [
		vscode.commands.registerCommand('nathan.enterChordMode', enterChordMode),
		vscode.commands.registerCommand('nathan.cycleChordHud', cycleChordHud),
		vscode.commands.registerCommand('nathan.pinChordHud', pinChordHud),
		vscode.commands.registerCommand(
			'nathan.expandChordHudForInspection',
			expandChordHudForInspection,
		),
		vscode.commands.registerCommand(
			'nathan.showChordPalette',
			showChordPalette,
		),
		vscode.commands.registerCommand('nathan.exitChordMode', exitChordMode),
		vscode.commands.registerCommand('nathan.runChordAction', runChordAction),
		vscode.commands.registerCommand('nathan.toggleGitDiff', toggleGitDiff),
		vscode.commands.registerCommand(
			'nathan.openSourceFromDiff',
			openSourceFromDiff,
		),
		vscode.commands.registerCommand(
			'nathan.showChangedFiles',
			showChangedFiles,
		),
		vscode.commands.registerCommand('nathan.toggleSortOrder', toggleSortOrder),
		vscode.commands.registerCommand(
			'nathan.toggleFileNesting',
			toggleFileNesting,
		),
		vscode.commands.registerCommand('nathan.openGitLayout', openGitLayout),
		vscode.window.onDidChangeActiveTextEditor(() => {
			updateModeFrame()
		}),
		vscode.window.onDidChangeTextEditorSelection(() => {
			updateModeFrame()
		}),
		vscode.window.tabGroups.onDidChangeTabs(() => {
			updateModeFrame()
		}),
	]

	context.subscriptions.push(...subscriptions)

	ensureCheatSheetItem()
	updateModeFrame()
	registerGitListeners(context)
}

function deactivate() {
	for (const subscription of gitSubscriptions) {
		subscription.dispose()
	}
}

module.exports = {
	activate,
	deactivate,
	__test: {
		openGitLayout,
		describeToggleValue,
		nextToggleValue,
		settingToggles,
		toggleFileNesting,
		toggleSetting,
		toggleSortOrder,
		getActiveDiffSourceUri,
		getActiveFileUri,
		getChangedFileItems,
		getRepoChanges,
		openSourceFromDiff,
		runChordAction,
		toggleGitDiff,
	},
}
