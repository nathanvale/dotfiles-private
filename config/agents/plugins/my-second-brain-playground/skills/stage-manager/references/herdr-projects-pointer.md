# Herdr Projects coordinator pointer

A Herdr Projects coordinator reaches the Stage Manager role through one short
line in its project's `PROJECT.md` `# Instructions` section. `PROJECT.md`
belongs to Nathan; the coordinator makes this edit only when Nathan asks.

Herdr Projects writes the project's `AGENTS.md` and `CLAUDE.md` itself and
refreshes them with `doctor --fix`, so keep them unedited. It also copies the
whole `# Instructions` section into every thread brief, so every worker reads
this line too. Prose scoping cannot keep a worker out. The role therefore
turns on an observable pane check: your own `HERDR_PANE_ID` must equal the
`pane_id` Herdr Projects recorded in `.state/coordinator.json`, read-only.

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

- The coordinator's startup receipt exists before its first `thread start`.
- A thread whose pane differs from the recorded coordinator pane keeps its
  worker role, and its report names that role.
