---
name: agent-adapter-setup
description: "Install, repair, or verify personal AGENTS.md and CLAUDE.md pointers from this dotfiles project."
disable-model-invocation: true
---

# Harness Adapter Setup

Run only after Nathan explicitly invokes this project-scoped skill. With no
requested mode, inspect both hosts and recommend one next operation.

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

1. Inspect the source and both templates. Inspect every existing path component
   from `$HOME` through each destination without following symlinks:
   - `$HOME/.codex/AGENTS.md`
   - `$HOME/.claude/CLAUDE.md`
   - `$HOME/.claude/AGENTS.md`
2. Classify each destination as correct, missing, live symlink, broken symlink,
   symlinked ancestor, or unknown.
3. Explain the observed state and recommend one operation: install, repair,
   verify, or stop.
4. Show the exact content of every file to create or replace. Show the stored
   target of every live or broken symlink. Name every path to remove.
5. For install or repair, ask one yes-or-no approval before writing.
   Verification remains read-only.
6. After approval, record every approved destination's pre-state and stage each
   approved replacement beside its destination.
7. Replace only approved destinations atomically from their matching templates
   as regular files. Leave every correct adapter unchanged.
8. Remove `$HOME/.claude/AGENTS.md` only when it is a symlink and that exact
   removal was approved.
9. On any write failure or installed-state mismatch, restore every changed
   destination to its recorded pre-state. Stop and report the exact mixed state
   if rollback fails.
10. Verify the installed files and both runtimes. Report what changed, what
    consumed it, any skipped check, and the next safe action.

## Preservation gate

Treat every existing destination as user-owned until inspection proves it
matches an adapter template or Nathan approves replacing its shown live or
broken symlink. Stop before reading or writing through a symlinked ancestor;
report its exact path and stored target. Stop on every unknown regular file or
directory. Preserve its content and report its exact path and type. Offer no
force mode. Leave `config/agents/global.md` unchanged during installation or
repair.

## Verification

- Prove both installed adapters are regular files, not symlinks.
- Prove each installed adapter matches its owned template byte for byte.
- Prove `config/agents/global.md` is readable.
- Read current official instruction-loading documentation, `codex --help`, and
  `claude --help` before constructing canaries.
- Start fresh, non-persistent Codex and Claude Code sessions from outside the
  repository.
- Ask each runtime to name the host adapter and canonical personal source
  without placing either path in the prompt.
- Ask two behavioral questions whose answers occur in the personal source but
  not in the environment, prompt, adapter, or skill metadata. Compare the
  answers with the source; plausible paraphrase alone is not proof.
- Run disposable repository-root and nested-directory loading canaries on both
  hosts. Use each product's supported source inspection to prove the expected
  host-specific composition.
- State every unavailable documentation, source-inspection, or runtime check as
  a proof gap.
