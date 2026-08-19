# Determinism and Steering

Two ways to make an agent do the right thing. They fail differently, and the
difference is what decides which one a rule needs.

**Steering** is an instruction that asks. A Clause in the Instruction Core, a
Rule File, a line in a skill.

**Determinism** is a check that runs. A hook, a test, a validator, a type.

## Why steering weakens

Startup Instructions load at position zero and stay there. The session grows
around them. Their position does not change; their share of attention does.

```
 0%                                                            100%
├──────────────────────────────────────────────────────────────┤
│ Clauses │       work       │      more work     │  recency   │
   ▲                                                    ▲
   strong early                                  what gets attended to
```

This is the lost-in-the-middle effect. The beginning and the end of a context
window carry more weight than the middle, so a long instruction set pushes its
own later Clauses into the weakest position.

Robert C. Martin, in [Uncle Bob on agents and clean
code](https://youtu.be/zcLPGC-tvgk) (2026, at 13:30), after trying five to ten
pages of authored rules. Quotes are from the published transcript, lightly
cleaned of speech disfluency, and this is one practitioner's account rather
than a controlled result:

> The models treat those rules in the Pirates of the Caribbean sense. They're
> more like guidelines.

and on the mechanism:

> As the context window builds up, the stuff at the very beginning and the
> stuff at the very end have more prominence than the stuff in the middle.
> Anything you say at the very beginning is going to get shoved into the middle
> if it's long. Maybe the first three sentences remain as priority, but the 50th
> and the 80th sentence, they're gone.

> Deterministic tools don't disappear that way.

A check runs outside the context window. It fires at 95 percent of a session
exactly as it fires at 5 percent.

His prescription is two-sided, and both sides matter: trim the initial prompt
to its minimum so what remains sits in the priority zone, then add
deterministic tools after the fact. Trimming alone removes guidance. Checking
alone leaves an unreadable prompt in place.

## Sorting a Clause

The test is not "could this be automated". It is **must this hold late in a
long session**.

| Character | Fate | Reason |
| --- | --- | --- |
| Irreversible, must hold at any depth | Gate | Decay here is unrecoverable, and long sessions are when it happens |
| Shapes how work is done, cheap when missed | Clause | Attention decay costs a slightly worse outcome, not a lost one |
| Restates default behaviour | Delete | It was doing no work at any depth |

Destructive Git operations, credential access, and irreversible writes are the
first row. Comment style, output verbosity, and scope discipline are the
second. Anything that reads as a reminder to be careful is usually the third.

## A gate is a loop, not a wall

The check does not only refuse. It tells the agent what to change, and the
agent runs again. Martin, at 16:15:

> You're putting them into a loop and you're saying, okay, you must change the
> code until this tool says that it's okay.

The loop closes only when each refusal carries the next action. A check that
reports a violation and stops leaves the agent to guess, and a guessing agent
improvises. This is why every failure names its cause **and** its repair path.
Human handoff is the answer when no repair exists, and saying so is itself the
repair path.

`cli-author` owns the CLI form of this contract: exit codes, stderr shape, and
the structure of a hint.

## What a gate costs

A gate is not free, and its failure mode is worse than a Clause's.

A decayed Clause fails softly and occasionally. A gate that stops running fails
completely and silently, and nothing reports the silence.

Concrete cases on this machine:

- **Codex trust hashes.** An unmanaged Codex hook runs only with an approved
  trust status verified against its content hash. Edit the hook script and the
  hash changes; the hook stops running until it is trusted again. Nothing
  announces this.
- **An installed skill is not a wired hook.** `git-guardrails-claude-code` is
  installed and lock-file tracked, and is set `off` in `settings.json`. No
  `hooks.json` on this machine declares the `PreToolUse` entry it exists to
  create, so the guard it describes has never guarded anything. Presence of
  the skill proves nothing about the gate.

So a gate needs its own liveness check. `hooks.md` states the general form:
silence is the failure mode.

There is also a throughput ceiling, and its location is not known. Martin, at
16:00:

> Obviously there has to be a case where there's too much. Eventually you will
> slow the agents down to the point where they're slower than humans. And at
> that point you've lost the game.

He reports still running two to four times human throughput while slowing
agents considerably, and describes finding that ceiling as unsolved work.

## Which surfaces exist

Not every Harness offers every gate. A rule enforced in one Harness and absent
in the other is a rule that half your sessions ignore.

| Surface | Claude Code | Codex |
| --- | --- | --- |
| `PreToolUse` hook, blocking | yes | yes, same `hooks.json` shape |
| `PostToolUse`, `Stop` | yes | yes |
| Rule Directory of authored Clauses | yes | none |
| Startup Entry Point | `CLAUDE.md` | `AGENTS.md` |
| Command policy engine | no | `execpolicy` |

The Rule Directory row is the important one: a Rule File steers Claude Code
only. A Clause that must reach both Harnesses belongs in the Instruction Core.

`~/.codex/rules/` exists and is not a counterexample. It holds `execpolicy`
`prefix_rule` entries, generated and machine-read. It carries no authored
Clause and no Scope Trigger.

Codex hook support is confirmed in the published source. Whether the installed
build on this machine fires them is a separate question and is not proven here.

## When to reach for which

Writing, editing, or reinstating an instruction that guards an irreversible
action is the moment to ask which of the three fates applies. Reinstating
counts: a Clause parked in `rules-archived/` is a sorting decision deferred,
not settled.

That moment is early in a session, which is exactly when steering still works.
This document is reached by a Pointer for that reason: the Clause that sends
you here has to survive only long enough to be read at design time.
