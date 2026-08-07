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
} = {}) {
  const commands = new Map()
  const executed = []
  const openedDiffs = []
  const shownDocuments = []
  const sourceFile = activeFile ?? uri('/repo/a.md')
  const repo = {
    rootUri: uri('/repo'),
    state: {
      workingTreeChanges: [{ uri: sourceFile, decorations: { tooltip: 'modified' } }],
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
            : { input: { original: uri(fileUri.fsPath, 'git'), modified: fileUri } }
        }

        if (name === 'markdown.showSource' && previewFile) {
          vscode.window.activeTextEditor = editor(previewFile)
          vscode.window.tabGroups.activeTabGroup.activeTab = { input: { uri: previewFile } }
        }

        if (name === 'markdown.reopenAsSource' && previewFile) {
          vscode.window.activeTextEditor = editor(previewFile)
          vscode.window.tabGroups.activeTabGroup.activeTab = { input: { uri: previewFile } }
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
        vscode.window.tabGroups.activeTabGroup.activeTab = { input: { uri: fileUri } }
        return vscode.window.activeTextEditor
      },
    },
    MarkdownString: class {
      appendMarkdown() {}
    },
    OverviewRulerLane: { Full: 1, Left: 2 },
    QuickPickItemKind: { Separator: -1 },
    Range: class {},
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class {},
  }

  return { commands, executed, gitApi, openedDiffs, repo, shownDocuments, vscode }
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
  harness.vscode.window.tabGroups.activeTabGroup.activeTab = { input: { uri: file } }
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

  assert.ok(harness.executed.some(({ name }) => name === 'markdown.reopenAsSource'))
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
