---
name: agents-md-setup
description: "Install, repair, or verify personal AGENTS.md and CLAUDE.md pointers from this dotfiles project."
disable-model-invocation: true
---

# Agent Instruction Setup

Use a prompt-driven setup conversation. With no requested mode, inspect both
hosts and recommend one next operation.

## Owners

- Use `$HOME/code/dotfiles` as the canonical dotfiles root. Stop when this skill
  is invoked from another project root.
- Read `config/agents/global.md` as the personal instruction source.
- Read `config/agents/adapters/codex/AGENTS.md` as the Codex adapter template.
- Read `config/agents/adapters/claude/CLAUDE.md` as the Claude Code adapter
  template.
- Keep product-specific loading mechanics with current product documentation
  and runtime help.

## Flow

1. Inspect the source, both templates, and these destinations before following
   any link:
   - `$HOME/.codex/AGENTS.md`
   - `$HOME/.claude/CLAUDE.md`
   - `$HOME/.claude/AGENTS.md`
2. Classify each destination as correct, missing, live symlink, broken symlink,
   or unknown.
3. Explain the observed state and recommend one operation: install, repair,
   verify, or stop.
4. Show the exact content of every file to create or replace. Show the stored
   target of every live or broken symlink. Name every path to remove.
5. Ask one yes-or-no approval before writing.
6. After approval, create or replace the two installed adapters from their
   matching templates as regular files.
7. Remove `$HOME/.claude/AGENTS.md` only when it is a symlink and that exact
   removal was approved.
8. Verify the installed files and both runtimes. Report what changed, what
   consumed it, any skipped check, and the next safe action.

## Preservation gate

Treat every existing destination as user-owned until inspection proves it
matches an adapter template or Nathan approves replacing its shown live or
broken symlink. Stop on every unknown regular file or directory. Preserve its
content and report its exact path and type. Offer no force mode. Leave
`config/agents/global.md` unchanged during installation or repair.

## Verification

- Prove both installed adapters are regular files, not symlinks.
- Prove each installed adapter matches its owned template byte for byte.
- Prove `config/agents/global.md` is readable.
- Read current `codex --help` and `claude --help` before constructing canaries.
- Start fresh, non-persistent Codex and Claude Code sessions from outside the
  repository.
- Ask each runtime for two values found only in the personal source: Nathan's
  timezone and the project setup skill name.
- State a proof gap when either runtime cannot run.
