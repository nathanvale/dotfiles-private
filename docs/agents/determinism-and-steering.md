# Determinism and Steering

Two ways to make an agent do the right thing.

**Steering** is an instruction that asks. A Clause in the Instruction Core, a
Rule File, a line in a skill.

**Determinism** is a Gate: a check that runs. A hook, a test, a validator.

## Sorting a Clause

The test is **must this hold late in a long session**, not "could this be
automated".

| Character | Fate | Reason |
| --- | --- | --- |
| Irreversible, must hold at any depth | Gate | Unrecoverable when it fails |
| Shapes how work is done, cheap when missed | Clause | Decay costs a worse outcome, not a lost one |
| Restates default behaviour | Delete | It was doing no work at any depth |

Gate: destructive Git operations, credential access, irreversible writes.
Clause: comment style, output verbosity, scope discipline.
Delete: anything that reads as a reminder to be careful.

Sort every Clause you touch, not only the one you came to change. Name the
fate and the destination file for each: a Clause that must reach both
Harnesses goes in the Instruction Core, `config/agents/global.md`; a Rule
File reaches Claude Code only.

Reinstating counts: a Clause parked in `rules-archived/` is a sorting decision
deferred, not settled.

## Why steering decays

Startup Instructions load at position zero and stay there. Their position does
not change; their share of attention does. Lost in the middle: a long
instruction set pushes its own later Clauses into the weakest position.

A Gate runs outside the context window. It fires at 95 percent of a session
exactly as it fires at 5 percent.

Trim, then gate. Either alone fails: trimming removes guidance, gating leaves
an unreadable prompt in place.

## A Gate closes a loop

A Gate refuses, names the change, and runs again. The loop closes only when
each refusal carries the next action: its cause and its repair path. Where no
repair exists, naming the human handoff is the repair path.

the `cli-design` plugin skill owns the CLI form: exit codes, stderr shape, and the structure of
a hint.

## What a Gate costs

A decayed Clause fails softly and occasionally. A Gate that stops running fails
completely and silently. Silence is its failure mode, and nothing reports
silence, so a Gate needs its own liveness check. `hooks.md` owns the trust
and teardown mechanics that cause the silence.

Two live cases on this machine:

- **A Codex hook stops running when its content hash changes.** It runs only
  against an approved hash, and re-trusting is manual. Nothing announces the
  gap.
- **An installed payload is not a wired hook by itself.**
  `git-guardrails-claude-code` has declared shared-agent and Claude Code
  Tracking Links. Its Claude override remains `off`, and no `hooks.json`
  `PreToolUse` entry exists. The guard has never guarded anything.

Gates have a throughput ceiling and its location is unknown, so add one per
irreversible action rather than by default.

## Which surfaces exist

A Clause that must reach both Harnesses needs a surface both offer.

| Surface | Claude Code | Codex |
| --- | --- | --- |
| `PreToolUse` hook, blocking | yes | in source, unproven on this build |
| `PostToolUse`, `Stop` | yes | yes |
| Rule Directory of authored Clauses | yes | none |
| Startup Entry Point | `CLAUDE.md` | `AGENTS.md` |
| Command policy engine | none | `execpolicy` |

`~/.codex/rules/` holds generated, machine-read `execpolicy` `prefix_rule`
entries, not a Rule Directory.

Source for the decay mechanism and the throughput ceiling: Robert C. Martin,
[on agents and clean code](https://youtu.be/zcLPGC-tvgk), 2026, 13:30 to 16:15.
One practitioner's account, not a controlled result.
