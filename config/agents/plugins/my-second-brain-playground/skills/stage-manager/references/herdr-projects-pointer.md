# Herdr Projects coordinator pointer

A Herdr Projects coordinator reaches the Stage Manager role through an
explicit `/my-second-brain-playground:stage-manager` invocation, sent as its
first prompt by whoever launches it: the Stage Manager, Nathan or a launcher.
The line below in the project's `PROJECT.md` `# Instructions` section is a
recovery hint only, for a coordinator that restarts or loses context. The
guide check never relies on it. In a live proof on 2026-09-25, a Claude
Sonnet 5 coordinator ignored the pointer and cast a worker with no guide
check; with the explicit first prompt, the same model refused the cast.
`PROJECT.md` belongs to Nathan; the coordinator edits it only when Nathan
asks.

Enforcement gap: prose cannot force the invocation. A gate, such as a plugin
hook or a Herdr Projects coordinator start option, is a follow-up outside S2.

Herdr Projects writes the project's `AGENTS.md` and `CLAUDE.md` itself and
refreshes them with `doctor --fix`, so keep them unedited. It also copies the
whole `# Instructions` section into every thread brief, so every worker reads
this line too. Prose scoping cannot keep a worker out. The role therefore
turns on an observable pane check: your own `HERDR_PANE_ID` must equal the
`pane_id` Herdr Projects recorded in `.state/coordinator.json`, read-only.
The skill also confirms you are that pane's own agent process, not a nested
session that inherited its `HERDR_PANE_ID`.

## Pointer text

```markdown
- Coordinator only: when your `HERDR_PANE_ID` equals `pane_id` in this
  project's `.state/coordinator.json`, invoke
  `my-second-brain-playground:stage-manager` and finish its startup before any
  cast, then read `library/stage-manager-handoff.md`. Otherwise keep the role
  your brief names.
```

Before the plugin is installed, name the skill file instead of the skill:
`<plugin source>/skills/stage-manager/SKILL.md`, read in full.

## Check

- The coordinator's first prompt was the explicit skill invocation.
- The coordinator's startup receipt exists before its first `thread start`.
- A thread whose pane differs from the recorded coordinator pane keeps its
  worker role, and its report names that role.
