# Herdr Projects coordinator pointer

A Herdr Projects coordinator reaches the Stage Manager role through one short
line in its project's `PROJECT.md` `# Instructions` section. `PROJECT.md`
belongs to Nathan; the coordinator makes this edit only when Nathan asks.

Herdr Projects writes the project's `AGENTS.md` and `CLAUDE.md` itself and
refreshes them with `doctor --fix`, so keep them unedited. It also copies the
whole `# Instructions` section into every thread brief. The line therefore
scopes itself to the project folder, and a thread reads it as out of scope.

## Pointer text

```markdown
- Coordinator only, when your working directory is exactly this project
  folder: invoke `my-second-brain-playground:stage-manager` and finish its
  startup before any cast, then read `library/stage-manager-handoff.md`.
  A thread keeps the role its brief names.
```

Before the plugin is installed, name the skill file instead of the skill:
`<plugin source>/skills/stage-manager/SKILL.md`, read in full.

## Check

- The coordinator's startup receipt exists before its first `thread start`.
- A new thread's `brief.md` contains the pointer only in this scoped form, and
  the thread's report names its worker role.
