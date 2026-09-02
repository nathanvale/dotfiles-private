# Third-Party Skills

- Install and update with `npx skills`. Read `--help` for command syntax.
- Upstreams: `herdrdev/herdr`, `openclaw/gogcli`, `mattpocock/skills`,
  `steipete/agent-scripts`, `vercel-labs/skills`.
- Pass `-a claude-code -a codex` on every `add`. Unscoped, the CLI installs to
  every agent whose config directory exists, including ones you do not use, and
  writes those directories into this repository.

## Install or update one skill

1. **Fence.** Resolve the exact upstream skill path and intended local name.
   Inventory the name across the reviewed source, lock, topology, and every
   Harness address. Capture `~/.codex/config.toml` and the protected Harness
   inventory before any live install or canary. Completion: current ownership,
   activation, duplicates, and pre-existing protected drift are explicit.
2. **Stage.** Run `npx skills add` without `-g` in a task-only scratch directory.
   Pass only `-a claude-code -a codex` and select the exact skill. Inspect every staged
   file, mode, security warning, and dependency before live installation.
   Completion: the reviewed payload and any unresolved warning are named.
3. **Promote.** Run the same exact selection with `-g` so `npx skills` updates
   the machine lock. Copy the reviewed bytes to
   `config/agents/skills/third-party/<owner>/<skill>`, declare every persistent
   address in `topology.json`, and replace generated installed copies with flat
   same-skill Tracking Links. Completion: canonical source, lock, topology, and
   stored and resolved link targets agree.
4. **Verify.** Validate JSON, run path-limited `git diff --check`, compare the
   canonical payload with the staged payload, and run
   `bin/agent-skills-inventory --json`. Completion: every row for the skill is
   enabled or deliberately disabled, content-matching, and issue-free.
5. **Qualify.** Read invocation metadata before choosing a canary. A
   model-invoked skill needs an ordinary registry canary. A skill with
   `disable-model-invocation: true` or `allow_implicit_invocation: false` needs
   an explicit-mention canary and is not expected in the ordinary registry.
   Completion: the canary matches the skill's invocation contract.
6. **Fence each Codex canary.** Resolve the active Codex app-server binary and
   version, then compare it with the proposed canary binary. Use the
   Harness-matched binary. If the active binary is unavailable or the versions
   differ, stop and report Codex discovery as unqualified. Immediately before
   and after each canary, compare `~/.codex/config.toml`, `~/.codex/skills`, and
   the plugin cache with the captured fence. Completion: every protected value
   is unchanged; any mutation stops the workflow without rebaselining.
7. **Close.** Run fresh Claude Code and Codex discovery where the Harness is
   available, remove task-only scratch state, and report install state separately
   from discovery qualification. Completion: installation evidence, unavailable
   proof, pre-existing drift, and the commit or push boundary are explicit.

## Lock file

- Address: `~/.agents/.skill-lock.json`, a Tracking Link into
  `config/agents/skills/`. It accepts reads and writes.
- Break the link and every entry reports `Source: local`. Provenance is lost and
  `npx skills update` has nothing to act on. Restore the link to recover it.
- Keep the lock describing the machine. A skill renamed upstream leaves a dead
  entry that restore will try to install.
- `experimental_install` restores every entry. Proven 2026-08-19 in a scratch
  `HOME`: 66 of 66, none missing.

## Reviewed source and installed addresses

- Canonical reviewed source:
  `config/agents/skills/third-party/<owner>/<skill>`.
- `config/agents/skills/topology.json#thirdParty` declares persistent Harness
  addresses and disabled state by skill.
- Every declared address is a same-skill Tracking Link to the reviewed source.
  A real installed copy is topology drift.
- The complete locked `mattpocock/skills` set is accepted for persistent shared
  and Claude Code installation, except retired `loop-me`.
- The locked `vercel-labs/skills` `find-skills` payload is also accepted for
  persistent shared and Claude Code installation.
- The `herdrdev/herdr` `herdr` payload is pinned to the installed Herdr
  release and accepted for persistent shared and Claude Code installation.
- The locked `steipete/agent-scripts` `browser-use` payload is accepted for
  persistent shared and Claude Code installation. Its reviewed payload contains
  only `SKILL.md` and `mcporter-config.md`.
- The 30 locked `openclaw/gogcli` skills are canonical under
  `config/agents/skills/third-party/openclaw/gogcli/<skill>`.
- Each GOG skill is linked at `~/.agents/skills/<skill>` and
  `~/.claude/skills/<skill>` with `addresses: ["agents", "claude"]` and the
  proven `disabledAddresses: ["claude"]` override.
- Every active lock key must have one matching `thirdParty` declaration.
  `bin/agent-skills-inventory` reports an undeclared lock key as an issue.
- Preserve a lock mismatch as a visible blocker. Updating upstream content or
  accepting authored drift is a separate operation.

## No commit pinning

- The lock records `source`, `sourceType`, `skillPath`, and a post-install
  content hash. No commit ref.
- `add` accepts a branch or tag through a `#fragment`. A full commit SHA fails.
- `experimental_install` never reads the stored hash. It clones current branch
  HEAD, then overwrites the hash with what it fetched.
- Restore reproduces HEAD, not the reviewed commit. Read the diff after
  `npx skills update`. That is the whole practice.

## Why the diff matters

- Skills run with full agent permissions. A prompt injection reaches the agent
  before it reaches you, and 91 percent of confirmed-malicious skills pair
  injection with the payload to defeat a skim.
- Evidence, scoping, and the checks that ran clean:
  `my-second-brain-vault-spike/projects/user-scope-config-consolidation/reference/skills-supply-chain.md`.
