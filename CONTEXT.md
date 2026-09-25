# Personal Agent Configuration

This context covers how Nathan's authored agent configuration is owned, tracked,
and made reachable by each agent harness. It governs the vocabulary for
instructions, rules, adapters, and the tracking links between a harness location
and this repository.

## Language

### Instructions

**Harness**:
An agent product that discovers and loads configuration from locations it
defines. Claude Code and Codex are the supported harnesses.
_Avoid_: Runtime, host, tool, agent

**Startup Instructions**:
Instruction content a Harness loads at session start, before any task. The
class, not any one file.
_Avoid_: Memory, system prompt, context file

**Startup Entry Point**:
The specific file a Harness discovers by its own convention to load Startup
Instructions. `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` are the two
entry points.
_Avoid_: AGENTS.md, CLAUDE.md, when speaking about the role rather than one file

**Instruction Core**:
`config/agents/global.md`. The single harness-neutral source of Universal
Clauses, reached from every Startup Entry Point.
_Avoid_: Global instructions, personal instructions, the global file

**Clause**:
One instruction. A single bullet or directive inside Startup Instructions or a
Rule File.
_Avoid_: Rule, when meaning a single instruction rather than a file

**Universal Clause**:
A Clause that applies in every session, in every repository. Universal Clauses
live in the Instruction Core.
_Avoid_: Global rule, always-on rule

**Scoped Clause**:
A Clause that applies only when its Scope Trigger fires. Scoped Clauses live in
Rule Files.
_Avoid_: Conditional rule, lazy rule, path rule

**Context Load**:
Tokens a Startup Instruction spends on every turn, whether or not it changes
behaviour. The cost the scoping model exists to control.
_Avoid_: Token cost, context window usage, overhead

**Gate**:
A deterministic check that runs outside the context window and refuses an
action until a condition holds. A hook, a test, a validator. Its refusal
carries the repair path. A Gate does not decay as a session fills; a Clause
does.
_Avoid_: guard, check; and hook, when the enforcement role rather than the
specific mechanism is meant

### Rules

**Rule File**:
One file in a Rule Directory, carrying a Scope Trigger and the Scoped Clauses it
gates. A Rule File must carry a Scope Trigger; content that applies everywhere
belongs in the Instruction Core.
_Avoid_: Rule, rules file, instruction file

**Rule Directory**:
A directory of Rule Files at a location a Harness discovers. `~/.claude/rules`
is the user-scope Rule Directory; it resolves into
`dotfiles/config/agents/claude/rules`. A repository's own `.claude/rules` is
project scope and is never linked into user scope.
_Avoid_: Rules folder, `.claude/rules`, when the scope distinction matters

**Scope Trigger**:
The condition that loads a Rule File. Each Harness expresses this differently;
Codex has no equivalent.
_Avoid_: Paths frontmatter, glob, matcher

### Branch guidance

**Branch Document**:
A file in `docs/agents/` holding guidance an agent needs on some runs and not
others. Reached only by a Pointer, never loaded at startup.
_Avoid_: Doc, reference, guide

**Pointer**:
A line in Startup Instructions naming a Branch Document and the condition for
reading it. Its wording, not its target, decides whether the document is ever
reached.
_Avoid_: Link, reference, route

**Branch**:
One distinct case a document handles, so different runs take different paths
through it. A Pointer earns its place by naming a Branch no other Pointer
claims.
_Avoid_: Case, path, scenario

**Pointer Scope**:
The scope a Pointer's path resolves from. A Pointer in the Instruction Core has
User Scope and writes an absolute path from `$HOME`. A Pointer in Repository
Instructions writes a path relative to that repository root. Owned by
[ADR 0001](docs/adr/0001-pointer-scope.md).
_Avoid_: Path style, relative path, absolute path, when the scope rather than
the notation is meant

**Repository Instructions**:
The `AGENTS.md` at a repository root. Loads only inside that repository, and
holds only what is true of it. Content true in every repository belongs in the
Instruction Core.
_Avoid_: AGENTS.md, when speaking about the role rather than one file; repo
rules, project instructions

**Owner**:
The single file or system that decides one contract. Other documents point at
it rather than restating it.
_Avoid_: Source of truth, authority; `OWNER` as a forge role is unrelated

**Recovery Copy**:
An installed but unconfigured copy kept only for rollback; it owns nothing and
no configuration selects it. Distinct from an Owner, which decides a contract.
_Avoid_: fallback

### Ownership and tracking

**User Scope**:
Configuration that applies to every project, at the location a Harness expects
under `$HOME`. Distinct from project scope, which applies only inside one
repository.
_Avoid_: Global config, home config

**Canonical Address**:
The Harness location where a configuration file is read and edited. The Harness
defines it. Nathan and every agent use it. It is unaffected by how the file is
tracked.
_Avoid_: Source of truth, when speaking about location rather than authority

**Tracking Link** _(planned, not yet in effect)_:
A symlink from a Canonical Address into this repository, so an Authored File can
be committed. The Harness is unaware of it.
_Avoid_: Symlink, projection

**Adapter**:
Content shaped for one Harness's discovery convention so that Harness reaches
the Instruction Core.
_Avoid_: Template, shim, wrapper

**Harness Neutrality**:
The property that one authored source serves both harnesses. Neutrality applies
to the source, not to loading behaviour: each Harness may load the same content
differently, or not at all.
_Avoid_: Cross-platform, portable, harness-agnostic

**Authored File**:
A file Nathan or an agent writes deliberately. Only Authored Files get a
Tracking Link. Runtime state, credentials, caches, and generated files are
excluded.
_Avoid_: Config file, dotfile

**Runtime State**:
Content a Harness writes during normal operation: sessions, logs, caches,
project records, generated automations. Never tracked, never linked.
_Avoid_: Cache, temp files, junk
