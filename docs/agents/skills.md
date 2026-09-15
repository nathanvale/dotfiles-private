# Skills

Classify a skill before changing its source or live address.

## Skill-work routing

| Work | Owner |
|---|---|
| Skill content and review | Invoke the external `writing-for-agents` skill. |
| Provenance, source, live address, migration, and retirement | Follow this document. |
| CLI and runtime surfaces | Use the `cli-design` skill from the My Second Brain Playground plugin. |

Dependent agent documents point here when a branch crosses these owners. Keep
the routing policy in this map only.

## Personal plugin development mode

- New skill or plugin development, and every use, edit, create, or test
  operation on it, runs through native Harness primitives against dotfiles
  sources under `config/agents/plugins`.
- Installing or using an external plugin remains allowed at its existing
  route: the My Second Brain production marketplace and reviewed third-party
  marketplaces keep their native marketplace/add/install commands. Point to
  those commands or the official references beside each route below, and to
  `$HOME/code/my-second-brain-plugin/docs/installing.md` for the production
  owner. Never route an external plugin through an `npx` skill installer.
- The separate My Second Brain checkout's own dev-mode is not ready; it is not
  an accepted development route today. Revisit it only once that lifecycle is
  ready and accepted.
- Keep candidate, installed, invoked, hook-trusted, and released evidence
  distinct. A build, a staged payload, or a cache/installation receipt is not
  activation proof. Require a fresh Harness invocation. Resolve exact flags
  from installed `--help` and the linked docs; build the payload only when its
  own source needs a build step.

| Task | Claude Code | Codex | Proof |
| --- | --- | --- | --- |
| Use | Inspect `claude plugin list --json`; invoke `/NAME:SKILL`. | Inspect `codex plugin list --json`; invoke via `$`/`/skills` ([use plugins](https://learn.chatgpt.com/docs/plugins)). | Intended identity enabled; direct invocation behaves as expected. |
| Edit | `claude --plugin-dir <payload>` ([test locally](https://code.claude.com/docs/en/plugins#test-your-plugins-locally)); `/reload-plugins` to iterate. | Resolve the [admitted development marketplace's](https://developers.openai.com/plugins/build/plugins) registered root to the intended candidate worktree so it cannot silently install main, bump its cachebuster/version, `codex plugin add NAME@MARKETPLACE --json` ([commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)), then start a fresh task. | Candidate and loaded behavior agree; marketplace root matches the intended worktree; no edit landed only in a cache. |
| Create | Add the native manifest and skill under `config/agents/plugins/<name>` ([plugins reference](https://code.claude.com/docs/en/plugins-reference)). | Add the accepted Codex-compatible manifest beside it. | Structural validation passes; correct namespaces and paths in both Harnesses. |
| Test | `claude plugin validate <payload> --strict --json`, then a fresh direct skill canary and representative workflow cases. | Fresh direct skill canary plus representative workflow cases; review hook trust separately from discovery. | Behavior tied to the exact candidate and surface tested; negative and boundary cases included. |
| Publish | Use the owning repository's release/marketplace owner. | Same payload/release owner, plus the native Codex catalog. | Release identity and installed behavior confirmed; public or workspace directory submission is a separate decision. |

- Installed Claude copy: `claude plugin marketplace update MARKETPLACE`, then
  `claude plugin update NAME@MARKETPLACE --scope SCOPE`. A checkout edit alone
  does not refresh copied bytes.
- Installed Codex copy: register the `personal` marketplace once with
  `codex plugin marketplace add "$HOME/code/dotfiles/config/agents/plugins"
  --json`. After a version bump, run
  `codex plugin add browser-lanes@personal --json`, then start a fresh task for
  activation proof. Keep that production identity separate from the admitted
  development marketplace's candidate.
- Treat promotion through the production marketplace as a separate release
  decision with its own proof and approval.

## Ownership

| Class | Declared source | Live-address rule |
|---|---|---|
| Legacy personal | `config/agents/skills/personal/<name>` | Add a flat per-skill Tracking Link at each supported Harness address. |
| New reusable personal | Versioned personal plugin payload | Discover through the plugin. Do not expand the legacy corpus. |
| Third-party reviewed | `config/agents/skills/third-party/<owner>/<skill>` | Declare every persistent Harness address in `topology.json`; each installed address is a flat per-skill Tracking Link. |
| Project-only | Owning project repository | Discover only within that project. |
| Codex-owned or Codex-installed | `~/.codex/skills/<name>` | Leave at the Codex-owned address. |
| Plugin-owned | Versioned plugin payload | Leave with the owning plugin and Harness. |

Treat `~/.agents/skills` and `~/.claude/skills` as discovery addresses, not
sources. Never replace `~/.codex/skills`; Codex owns `.system` and installed
skills there.

Declare a disabled Claude live address with `disabledAddresses: ["claude"]`.
Declare Codex disabling a shared-agent address with
`disabledHarnesses: ["codex"]`. The inventory reconciles both declarations
against their live Harness configuration.

All locked `mattpocock/skills` payloads except retired `loop-me` are accepted
persistent third-party installs at both the shared-agent and Claude Code
addresses. Preserve each declared enabled or disabled Harness state.
The locked `vercel-labs/skills` `find-skills` payload is also an accepted
persistent install at both addresses.
The `herdrdev/herdr` `herdr` payload is also an accepted persistent install at
both addresses. Pin its reviewed source to the installed Herdr release so
`herdr --skill` and the installed skill stay byte-identical.
The `browser-use` name belongs to the `browser-lanes` plugin's entry skill; the
former `steipete/agent-scripts` payload is retired by
[ADR-0004](../adr/0004-browser-use-entry-ownership.md).
The 30 locked `openclaw/gogcli` skills use
`config/agents/skills/third-party/openclaw/gogcli/<skill>` as their canonical
source and are linked at `~/.agents/skills/<skill>` and
`~/.claude/skills/<skill>`, with `addresses: ["agents", "claude"]` and the
existing `disabledAddresses: ["claude"]` override. Every active lock key needs
one `thirdParty` declaration, and the inventory fails when the lock and
topology key sets are incomplete.

## Accepted legacy tranche

- Retire `ac-convergence`, `ica-seam-swarm`, `newsroom-investigate`, and
  `decision-mode`.
- Keep `path-component-parity` in the legacy personal source.
- Keep their later employer-private plugin migration outside this topology
  cutover.

## Accepted retirement classification

- Retire `adhd-helper`, `bft-booking`, `browser-use-support-ticket`,
  `browser-use-ledger`, `browser-use-prototyper`, `browserclaw`,
  `ce-work-inspect`, `domain-modeling-retrospective`,
  `improve-test-architecture`, `issue-to-pr`, `lll-account-switch`,
  `notebooklm`, `pr-review-loop`, `productivity-connectors`,
  `productivity-sync`, `prompt-system-router`, `prompt-system-workflow`,
  `record-decision`, `runbook-orchestrator`, `skill-self-audit-loop`,
  `skills-sync`, `unit-closeout`, and `work-style-convert`.
- Read `kills-sync` as `skills-sync`.
- Read `issue-to-pr.lll-account-switch` as `issue-to-pr` and
  `lll-account-switch`.
- Retire `skill-author`. Follow the [skill-work routing](#skill-work-routing)
  map for its surviving responsibilities.
- Retire `fallow` (façade; the name now belongs to the generated project-scope
  Fallow pointer skill), `skill-feedback`, `cli-execution-auditor`, and
  `vault-git`; retire the `setup` and `vault-git-transaction-manager` runtimes
  with them.
- Retire `cli-author`; the `cli-design` plugin skill owns CLI design and runtime surfaces.

## Completed migration

- Every retained personal legacy skill has moved in a bounded tranche.
- The direct startup cutover passed fresh Claude Code and Codex canaries.
- `agent-adapter-setup` and both adapter template sources are retired.
- Treat `last30days` `__pycache__` directories and `.pyc` files as Runtime
  State. Require its remaining authored content to match before migration.
- Preserve the ten approved manifest entries.
- Keep `storybook-matrix` enabled; do not add a Claude disable override.

## Change a skill

1. Inventory the name across `config/agents/skills`, `~/.agents/skills`,
   `~/.claude/skills`, and `~/.codex/skills`.
2. Inspect live `~/.codex/config.toml` skill registrations before declaring
   Codex activation. A disabled registration can hide a shared-agent link.
3. Record provenance, declared source, filesystem kind, stored link target,
   resolved target, and content agreement.
4. Resolve every ambiguous or duplicate owner before mutation.
5. Follow the [skill-work routing](#skill-work-routing) map for content,
   topology, and CLI or runtime work.
6. Follow [Third-Party Skills](third-party-skills.md) for install, update,
   restore, or removal of a skill Nathan did not write.
7. Migrate one uncoupled tranche. Preserve pre-change hashes for every source,
   Harness-owned skill, and plugin payload in scope.
8. Validate each stored and resolved Tracking Link without following an unsafe
   ancestor.
9. Fence `~/.codex/config.toml`, `~/.codex/skills`, and the plugin cache
   immediately around fresh Codex canaries. Use the active Harness version.
   Stop on Harness-owned mutation; never rebaseline it implicitly.
10. Prove fresh Claude Code and Codex discovery before starting another tranche.

`config/agents/skills/topology.json#protectedHarness` owns the accepted
Codex-skill and plugin-cache counts and Git-tree hashes. Update those literals
only after Nathan confirms the Harness-owned change is intentional and approves
the new baseline. Exclude the Codex-generated `.codex/skills/.system` entry;
fence every other `.codex/skills` entry. The inventory must match before and
after each Codex canary.

### Runtime-backed personal skills

- Treat a skill registered in the root `package.json` workspaces as a runtime
  move, not a byte-only move.
- Update its exact workspace path in `package.json` and `bun.lock` in the same
  tranche.
- Run `bun install --frozen-lockfile`, then prove generated `node_modules`
  links resolve.
- Inspect relative configuration paths, including `tsconfig.json`, because the
  transitional source has a different directory depth.
- Compare authored files and modes against an independent Git archive. Exclude
  generated dependency links and declared Runtime State.
- Reproduce a failing package check against unchanged `HEAD` before calling it
  migration-caused. Keep pre-existing repair outside the topology tranche.

Declare persistent third-party installation by skill and Harness in
`config/agents/skills/topology.json`. The accepted Matt Pocock owner batch is
persistent. The accepted Vercel `find-skills` payload is persistent. Other
reviewed payloads remain source-only until Nathan approves a named installation.
The approved Herdr payload is persistent at the shared-agent and Claude Code
addresses.

## Retirement gate

Retire a personal skill only when all checks pass:

### Pre-delegation inventory

Before delegation, inventory the exact skill name across the complete working
tree, live Harness addresses, lock and topology declarations, Startup
Instructions, skill dependencies, setup paths, Harness registrations, and
plugin registrations, versioned plugin payloads, and installed plugin caches.
Include ignored and untracked working-tree occurrences.

Record one row for every exact-name occurrence or named live surface. Give each
row exactly one classification: `active`, `historical`, `generic-language`, or
`already-removed`. Record its owner, evidence, and required action. Reconcile
the row count with the search and `bin/agent-skills-inventory --json` results.

Delegation is allowed only when every row is classified and every `active` row
appears in the worker specification with its exact owner and action. An
unclassified occurrence or an active route missing from the specification
stops delegation.

### Absence checks

- No active source exists under `.agents/skills/` or
  `config/agents/skills/personal/`.
- No entry exists at `~/.agents/skills`, `~/.claude/skills`, or
  `~/.codex/skills`.
- No third-party lock key claims the name.
- No active Startup Instruction, skill dependency, setup path, or Harness
  registration routes to the name.
- Git history remains the recovery owner.

Allow historical provenance and archived sources to retain the name. They are
evidence, not active routes.

## Direct discovery canary

For each retirement, declare the surviving and retired skill names plus exact
positive and unavailable markers before running a canary. Use a fresh,
non-persistent, read-only process for each invocation. Run both invocations in
all three contexts:

- A fresh directory outside every repository.
- The repository root.
- A nested skill directory.

Use the active Harness binary and its documented direct invocation syntax. For
non-interactive Codex, preserve the exact mention link emitted by the active
`$` selector; a bare name passed directly to `codex exec` is not a resolved
mention. Substitute literal names, paths, and markers in these command shapes:

```bash
claude -p --no-session-persistence --permission-mode plan --tools "" \
  --output-format text '/<surviving-skill> Return only this marker with no punctuation or other text: <POSITIVE_MARKER>'
claude -p --no-session-persistence --permission-mode plan --tools "" \
  --output-format text '/<retired-skill> Return exactly <RETIRED_UNAVAILABLE> when this command is unavailable.'

codex -s read-only -a never exec --ephemeral --skip-git-repo-check \
  -C <context> --json '[$<surviving-skill>](<resolved-SKILL.md>) Return only this marker with no punctuation or other text: <POSITIVE_MARKER>'
codex -s read-only -a never exec --ephemeral --skip-git-repo-check \
  -C <context> --json '$<retired-skill> Return only this marker with no punctuation or other text unless this skill loaded: <RETIRED_UNAVAILABLE>'
```

Claude positive proof is the exact positive marker. Claude negative proof is
the exact Harness-owned `Unknown command: /<retired-skill>` response. Codex
positive proof is the exact declared agent-message marker from the
selector-resolved mention whose link names the surviving skill's exact
`SKILL.md` path. Only read-only command items are allowed. Codex negative proof
is the exact declared agent-message marker from the unresolved retired name,
with no command or item that names or loads a retired skill path. Read-only
Startup Instruction loads are allowed. A catalog question or implicit
description match is not direct proof.

Immediately before and after each Codex invocation, hash
`~/.codex/config.toml` and run `bin/agent-skills-inventory --json`. Compare the
config hash and the complete `.protected_harness` value, which covers
`~/.codex/skills` and the plugin cache. Fence each invocation separately.

A context passes only when both direct invocations return the exact expected
result and its Codex fences match. Treat the declared Claude `Unknown command`
response as negative success. Any other invalid command, unresolved literal
mention, non-zero process status, extra or ambiguous result content, tool item
outside the declared allowances, or protected-state mutation invalidates the
canary.

## Startup entry points

Use these direct same-name Tracking Links:

| Canonical address | Dotfiles source |
|---|---|
| `~/.codex/AGENTS.md` | `config/agents/AGENTS.md` |
| `~/.claude/CLAUDE.md` | `config/agents/claude/CLAUDE.md` |

Fresh outside, root, and nested Claude Code and Codex canaries passed against
the direct links. The adapter sources, `agent-adapter-setup`, and its
Instruction Core route are retired.

## Cutover boundary

- Migrate the legacy personal corpus in bounded tranches.
- Preserve Codex-owned and plugin-owned payloads byte-identically.
- Keep the retired `skills-sync` workflow retired.
- Finish and prove this topology before starting personal-plugin workflow work.
- Treat third-party upgrades, skill repairs, portability work, publication,
  commits, and pushes as separate authority.
