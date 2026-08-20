# Write a Pointer path for the scope that loads it

A Pointer names a Branch Document and the condition for reading it. It also
carries a path, and the path must resolve from wherever the loading file is
read. The two Startup Instruction scopes resolve differently, so one path style
cannot serve both.

**Decision.** A Pointer in the Instruction Core writes an absolute path from
`$HOME`. A Pointer in Repository Instructions writes a path relative to that
repository root.

The Instruction Core loads in every repository, so a relative path there
resolves against whatever directory the session happens to be in. It reaches
the intended file only inside dotfiles and silently reaches nothing everywhere
else. Repository Instructions load only inside one repository, so the
repository root is a stable anchor and an absolute path would add noise and
break on a clone at a different location.

## Consequences

Silence is the failure mode. A Pointer with a path that does not resolve
produces no error; the agent reads no Branch Document and continues. Nothing
reports the miss, which is why this is written down rather than left to
judgement.

The rule is checkable: every Markdown path in `config/agents/global.md` starts
with `$HOME`, and no path in an `AGENTS.md` does. This is the shape a future
Gate would enforce.

## Evidence

Found 2026-08-20 in `config/agents/global.md`. Four Pointers used
`$HOME/...`; one used `docs/agents/determinism-and-steering.md`, which resolves
only inside dotfiles. The Instruction Core loads in every repository, so that
Pointer was dead in all of them but one.
