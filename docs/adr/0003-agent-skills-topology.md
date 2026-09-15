# Separate skill ownership from Harness discovery

The installed skills topology mixes Git-tracked personal sources, real
third-party copies, per-skill links, Codex-owned skills, and versioned plugin
payloads. A name can appear at several Harness discovery addresses without
making any address its source. Treating one mixed directory as canonical would
overwrite Harness-owned state or erase upstream provenance.

**Decision.** Classify every skill by provenance before changing it. Give each
legacy personal skill one transitional source at
`config/agents/skills/personal/<name>` and flat per-skill Tracking Links at its
supported Harness addresses. Put new reusable personal skills in a versioned
personal plugin instead of expanding the legacy corpus.

Keep reviewed third-party payloads at
`config/agents/skills/third-party/<owner>/<skill>`. Declare every persistent
Harness address in `config/agents/skills/topology.json`; each installed address
is a same-skill Tracking Link to the reviewed source. The locked
`mattpocock/skills` set is accepted as persistently installed for shared agents
and Claude Code, except retired `loop-me`. The locked `vercel-labs/skills`
`find-skills` payload is also accepted as persistently installed for both
addresses. The `herdrdev/herdr` `herdr` payload is pinned to the installed
Herdr release and accepted at both addresses. The locked
`steipete/agent-scripts` `browser-use` payload was accepted at both addresses
and replaced the personal browser-use implementation and its local supporting
runtimes; [ADR-0004](0004-browser-use-entry-ownership.md) later retired that
payload in favour of the `browser-lanes` plugin's `browser-use` entry skill.
Other reviewed payloads stay source-only until a named installation is
approved.

The 30 locked `openclaw/gogcli` skills use
`config/agents/skills/third-party/openclaw/gogcli/<skill>` as their canonical
source. Each has a Tracking Link at `~/.agents/skills/<skill>` and
`~/.claude/skills/<skill>`, with `addresses: ["agents", "claude"]` and its
existing `disabledAddresses: ["claude"]` override retained.
The inventory requires every active lock key to have a matching
`thirdParty` declaration, so the lock and topology key sets remain complete.

Leave Codex-owned, Codex-installed, and plugin-owned skills with their owning
Harnesses. Do not replace `~/.codex/skills`.

Use `config/agents/AGENTS.md` as the shared Startup Instruction source. The two
user Startup Entry Points are direct same-name Tracking Links. Fresh outside,
root, and nested Claude Code and Codex canaries passed against those links, so
the adapters and `agent-adapter-setup` are retired.

## Consequences

Migration proceeds in small uncoupled tranches with inventory reconciliation,
link validation, and before-and-after content hashes. A tranche stops on an
ambiguous owner, unsafe link, content disagreement, or Harness canary failure.
The topology manifest records the explicitly accepted Codex-skill and plugin
cache baselines; changing them requires Nathan's approval of the Harness-owned
change.

The retired `skills-sync` workflow stays retired. Third-party practice remains
owned by `docs/agents/third-party-skills.md`; operational topology remains
owned by `docs/agents/skills.md`.

Retire `ac-convergence`, `ica-seam-swarm`, `newsroom-investigate`, and
`decision-mode`. Keep `path-component-parity` in the legacy personal source as the first bounded tranche. Their later destination is an
employer-private plugin, outside this topology cutover.

The accepted retirement classification also retires `adhd-helper`,
`bft-booking`, `browser-use-support-ticket`, `browserclaw`, `ce-work-inspect`,
`domain-modeling-retrospective`, `improve-test-architecture`, `issue-to-pr`,
`lll-account-switch`, `notebooklm`, `pr-review-loop`,
`productivity-connectors`, `productivity-sync`, `prompt-system-router`,
`prompt-system-workflow`, `record-decision`, `runbook-orchestrator`,
`skill-self-audit-loop`, `skills-sync`, `unit-closeout`, and
`work-style-convert`. The shorthand `kills-sync` means `skills-sync`, and
`issue-to-pr.lll-account-switch` names two skills.

The later accepted retirement retires `skill-author`. Current skill-work
routing is defined in `docs/agents/skills.md#skill-work-routing`.

The personal `browser-use` implementation and its `browser-connect`, Warm
Chrome, security, authentication, and transport runtimes are retired. The
companion `browser-use-ledger` and `browser-use-prototyper` skills are also
retired. The upstream `browser-use` payload was later retired by
[ADR-0004](0004-browser-use-entry-ownership.md); the `browser-use` name now
belongs to the `browser-lanes` plugin's entry skill, so it is not listed as a
retired personal skill.

All other personal legacy skills migrated in bounded tranches. The startup
cutover gate passed and `agent-adapter-setup` retired with both adapter
templates. `last30days` `__pycache__` directories and `.pyc` files remained
Runtime State. The approved manifest entries remain preserved and
`storybook-matrix` remains enabled.

A retirement requires absence from active sources, every Harness discovery
address, the third-party lock, active skill dependencies, setup paths, and
Harness registrations. Git history remains the recovery owner; historical
provenance may keep the retired name.

Reusable personal plugin implementation starts only after the legacy topology
is implemented and both Harnesses pass the required canaries.
