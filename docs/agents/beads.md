# Beads Source Gate

Apply this gate before Beads-backed research, planning, implementation, review,
or workflow design. Finish the gate before creating or changing a task graph,
formula, molecule, gate, wisp, coordination rule, sync path, worktree policy,
plugin integration, board projection, or knowledge contract.

## Ground the work

1. Identify the executable and version with `which -a bd` and `bd version`.
2. When Context7 is available, resolve `Beads`, select
   `/gastownhall/beads`, and query the exact topic. Follow its cited upstream
   source files.
3. Read the upstream [`docs/index.md`](https://github.com/gastownhall/beads/blob/main/docs/index.md)
   and every matching source in the map below.
4. Match documentation to the installed release. When `main` documents a newer
   release, use that release's tag or read
   [`docs/getting-started/upgrading.md`](https://github.com/gastownhall/beads/blob/main/docs/getting-started/upgrading.md)
   before implementation or a schema write.
5. Inspect the public command contract with `bd <command> --help` and use JSON
   output for agent reads. Inspect the target store before a write.
6. Reconcile the release-matched docs and executable behavior with the local
   specification, accepted ADRs, and current Beads state. Stop on a
   contradiction until its owner is resolved.

Context7 is the discovery index. Release-matched upstream source defines the
supported contract. The selected executable and store prove what is currently
installed. Local specifications and accepted ADRs define product intent.

## Source map

| Topic | Upstream source |
|---|---|
| Model and terminology | [`docs/core-concepts/index.md`](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/index.md) |
| Issues, dependencies, links, labels, metadata, and IDs | [`docs/core-concepts/`](https://github.com/gastownhall/beads/tree/main/docs/core-concepts) |
| Dolt synchronization | [`docs/core-concepts/sync-concepts.md`](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md) |
| Workflow selection | [`docs/workflows/index.md`](https://github.com/gastownhall/beads/blob/main/docs/workflows/index.md) |
| Formulas and molecules | [`docs/workflows/formulas.md`](https://github.com/gastownhall/beads/blob/main/docs/workflows/formulas.md), [`docs/workflows/molecules.md`](https://github.com/gastownhall/beads/blob/main/docs/workflows/molecules.md) |
| Gates, wisps, and todos | [`docs/workflows/gates.md`](https://github.com/gastownhall/beads/blob/main/docs/workflows/gates.md), [`docs/workflows/wisps.md`](https://github.com/gastownhall/beads/blob/main/docs/workflows/wisps.md), [`docs/workflows/todo.md`](https://github.com/gastownhall/beads/blob/main/docs/workflows/todo.md) |
| Multi-agent ownership, claims, fan-out, fan-in, and communication | [`docs/multi-agent/coordination.md`](https://github.com/gastownhall/beads/blob/main/docs/multi-agent/coordination.md) |
| Claude Code setup, hooks, compaction, and resume | [`docs/integrations/claude-code.md`](https://github.com/gastownhall/beads/blob/main/docs/integrations/claude-code.md) |
| Claude Code plugin reference | [`docs/integrations/claude-code-plugin.md`](https://github.com/gastownhall/beads/blob/main/docs/integrations/claude-code-plugin.md) |
| Codex setup, hooks, compaction, and resume | [`docs/integrations/codex.md`](https://github.com/gastownhall/beads/blob/main/docs/integrations/codex.md) |
| Worktree behavior and lifecycle | [`docs/reference/worktrees.md`](https://github.com/gastownhall/beads/blob/main/docs/reference/worktrees.md) |
| Git integration | [`docs/reference/git-integration.md`](https://github.com/gastownhall/beads/blob/main/docs/reference/git-integration.md) |
| Configuration and precedence | [`docs/reference/configuration.md`](https://github.com/gastownhall/beads/blob/main/docs/reference/configuration.md) |
| Agent-readable JSON contract | [`docs/reference/json-schema.md`](https://github.com/gastownhall/beads/blob/main/docs/reference/json-schema.md) |
| Known boundaries and common decisions | [`docs/reference/faq.md`](https://github.com/gastownhall/beads/blob/main/docs/reference/faq.md) |
| Claude Code, Codex, and VS Code setup | [`docs/getting-started/ide-setup.md`](https://github.com/gastownhall/beads/blob/main/docs/getting-started/ide-setup.md) |

Use the rendered [Beads documentation](https://beads.gascity.com/) for
navigation. Preserve upstream source links in durable research and decisions.

## Reuse gate

Before designing custom workflow machinery, search the source map for an
existing Beads primitive and test it against the required journey. Record the
gap when formulas, molecules, dependencies, gates, wisps, todos, claims,
comments, or Dolt sync do not fit. Custom implementation begins only from that
observed gap.

## Completion

- Research names the installed version, exact source files, and unresolved
  version gaps.
- Planning maps each proposed responsibility to an existing Beads primitive or
  a recorded gap.
- Implementation proves the public command and durable-state seam named by the
  matched documentation.
- Review checks the same sources and rejects unsupported prose-only behavior.
