# Herdr Projects coordinator pointer

A Herdr Projects coordinator reaches the Stage Manager role through an
explicit `/my-second-brain-playground:stage-manager` invocation, sent as its
first prompt by whoever launches it: the Stage Manager, Nathan or a launcher.
The line below in the project's `PROJECT.md` `# Instructions` section is a
recovery hint only, for a coordinator that restarts or loses context. The
role check never relies on it. In a live proof on 2026-09-25, a Claude
Sonnet 5 coordinator ignored the pointer and cast without loading the skill;
with the explicit first prompt, it followed the then-required guide refusal.
Current guide applicability and cast permission are owned by `SKILL.md`.
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
  `/my-second-brain-playground:stage-manager` and confirm the role before any
  cast, then read `library/stage-manager-handoff.md`. Otherwise keep the role
  your brief names.
```

Before the plugin is installed, name the skill file instead of the skill:
`<plugin source>/skills/stage-manager/SKILL.md`, read in full.

## Restart

Without `--new`, `herdr-projects open <slug>` only refocuses a coordinator
that is still running, so that agent keeps the Harness binary it launched
with and misses any update (observed in Herdr Projects 0.2.25,
`src/coordinator.rs`, on 2026-09-30).

1. Quit the coordinator agent in its pane.
2. Run `herdr-projects open <slug>`, adding `--profile <name>` to change
   profile. It launches the agent from `PATH` and resumes the recorded session
   only when the recorded profile equals the requested one. Leave out
   `--new`: it starts a second coordinator beside the first instead of
   restarting it.
3. Send `/my-second-brain-playground:stage-manager` as the first prompt;
   `open` sends none.
4. Refresh observations for the new process before the next cast. Include
   them in that cast's record; an earlier record covers the earlier process.

## Check

- The coordinator's first prompt was the explicit skill invocation.
- The coordinator confirms its role before casting; its cast record includes
  current observations and any skipped-guide reason.
- A bounded read-only request can be answered without a thread or receipt.
- A thread whose pane differs from the recorded coordinator pane keeps its
  worker role, and its report names that role.
