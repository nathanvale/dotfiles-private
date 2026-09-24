# Connectors Portable CLI standards research

Date: 2026-09-24 (Australia/Melbourne). Scope: the four named local first-party
`CODING_STANDARDS.md` files, two Matt Pocock upstream standards files, and
the upstream contributor and agent guidance below, compared with the current
dotfiles shared standards and Connectors candidate. This is a fit review input,
not an admitted rule.

## Findings

| Source rule | Connectors fit and current owner |
| --- | --- |
| `agent-plugin-kit/CODING_STANDARDS.md:20-25,51-58` and `coding-agent-qualifier/CODING_STANDARDS.md:18-24` require deterministic machine results, with diagnostics outside the structured result channel. `agent-ledger/CODING_STANDARDS.md:161-169` separately asserts exit, stdout, stderr and reads durable state outside the writer. | Useful for the public JSON CLI. The accepted Contract Core specifies one envelope on stdout and empty stderr for ordinary completion. Connectors `CODING_STANDARDS.md` now tells tests to assert both streams independently. Do not copy Agent Ledger's SQLite-specific rule. |
| `coding-agent-qualifier/CODING_STANDARDS.md:20-24` says to parse untrusted input defensively without echoing unsafe input. `agent-ledger/CODING_STANDARDS.md:62-72` provides a stricter owner-specific ingress design. | Useful for malformed argv, stdin, environment and refusal tests. Connectors `CODING_STANDARDS.md` now pins early refusal and a secret-shaped no-echo check. Agent Ledger's exactly-one-parse and no-defaults scheme is not portable without its validation architecture. |
| `agent-plugin-kit/CODING_STANDARDS.md:60-67`, `coding-agent-qualifier/CODING_STANDARDS.md:26-35` and `agent-ledger/CODING_STANDARDS.md:159-184` require caller-facing proof, independent oracles and a RED/GREEN perturbation. | Already owned by shared `docs/agents/coding-standards.md` and Connectors `CODING_STANDARDS.md`. Agent Ledger's SQLite requirements are repository-specific. No additional rule. |
| `agent-plugin-kit/CODING_STANDARDS.md:27-32,80-85` and `agent-ledger/CODING_STANDARDS.md:139-148` require one vocabulary/fake owner. `agent-plugin-kit/CODING_STANDARDS.md:87-93` limits proof claims to the observed layer. | Already owned by shared `docs/agents/coding-standards.md` and Connectors `AGENTS.md` plus `CODING_STANDARDS.md`. No additional rule. |
| `agent-plugin-kit/CODING_STANDARDS.md:20-23,42-49` records completed and remaining effects, transaction state and retry safety after an attempted effect. `coding-agent-qualifier/CODING_STANDARDS.md:47-52` also separates external-effect ownership from readiness. | Relevant to writes, but Connectors `AGENTS.md` already routes write capability through preview, apply, a durable journal and operator adjudication. Shared `docs/agents/coding-standards.md` owns readiness. Any extra result fields need the accepted write/CLI contract, not a copied standard. |
| `my-second-brain-plugin/plugin/skills/new-skill/CODING_STANDARDS.md:1-4` delegates to the target plugin's standards and declares no package-specific idiom. | No transferable rule. It supports reading Connectors' own owner instead of adding a second instruction copy. |

## Upstream fit

| Primary source | Connectors fit and duplication or conflict |
| --- | --- |
| [Course Video Manager testing rules](https://github.com/mattpocock/course-video-manager/blob/main/.sandcastle/CODING_STANDARDS.md#L35-L103) and [Sandcastle testing rules](https://github.com/mattpocock/sandcastle/blob/main/.sandcastle/CODING_STANDARDS.md#L99-L158) favor observable behavior through a public interface, discourage internal-call assertions, and put fakes at external boundaries. Course Video Manager also warns against trivial mapping tests that mirror implementation. | The shared independent-oracle rule and Connectors process proof already own the useful CLI portion. Provider or MCPorter fakes belong at their process boundary. Do not add a general ban on independent durable-state readers: both upstream files discourage direct database inspection for their API tests, while Connectors explicitly requires resulting files or absence of effects and Agent Ledger separately requires a reader outside the writer. The observed effect must follow the accepted claim. |
| [Course Video Manager environment rule](https://github.com/mattpocock/course-video-manager/blob/main/.sandcastle/CODING_STANDARDS.md#L27-L30) resolves required environment values at command entry so missing configuration fails before work. | Useful design check for a Connectors command that would otherwise discover missing configuration after a provider or write effect. Fit it to the command's required inputs and refusal contract; no general rule is justified from this one upstream case. |
| [Sandcastle provider rule](https://github.com/mattpocock/sandcastle/blob/main/.sandcastle/CODING_STANDARDS.md#L41-L45) keeps provider-specific SDK integration separate and shares only provider-agnostic utilities. | Connectors `AGENTS.md:9,12-13,18-20` already gives precise ownership: service code stays with its skill while common process, private-state and bridge plumbing lives in `bin/`. Copying Sandcastle's blanket provider rule would contradict that accepted seam. |
| [Sandcastle interactive CLI rule](https://github.com/mattpocock/sandcastle/blob/main/.sandcastle/CODING_STANDARDS.md#L71-L75) pairs each prompt with a non-interactive flag and fails clearly without a TTY. | Potential design question for an attended auth command. Connectors `AGENTS.md:11,18,22` already distinguishes attended native OAuth and its process proof. Adopt a matching non-interactive path only if the accepted auth command needs unattended use; otherwise retain its deliberate attended boundary. |

## Further upstream GitHub guidance

These are first-party `AGENTS.md`, `CLAUDE.md`, or `CONTRIBUTING.md` files,
not `CODING_STANDARDS.md` files. The first five rows cover the requested
MCPorter, Bun, MCP SDK, mise and 1Password shortlist. The final two rows are
additional OpenAI sources supplied for fit review.

| Repository and actual document | Connectors fit, duplicate coverage and conflict |
| --- | --- |
| MCPorter [AGENTS.md](https://github.com/openclaw/mcporter/blob/main/AGENTS.md#L1-L8) calls for focused regressions and project checks, while keeping live DeepWiki tests opt-in. | Reinforces separating fixture/process results from live provider claims. Connectors `AGENTS.md` already names distinct proof states and its Bun gates, so there is no new standards clause. MCPorter's pnpm commands and live-test switch are repository-specific and must not replace Connectors' Bun commands or imply live proof from a fixture. |
| Bun [CLAUDE.md](https://github.com/oven-sh/bun/blob/main/CLAUDE.md#L62-L108) runs the changed executable in isolated process fixtures, checks streams and exit status, avoids public Internet in ordinary tests, and waits for conditions instead of sleeping. | The isolated process and stream assertions duplicate Connectors `CODING_STANDARDS.md`. A useful test-design check is to keep fixture tests offline and await observable readiness, consistent with the shared readiness rule. Bun's debug-build command and snapshot preference are specific to Bun; snapshots cannot replace Connectors' test-owned literal command and cause oracles. |
| MCP TypeScript SDK [CONTRIBUTING.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/CONTRIBUTING.md#L79-L127) asks for focused tests with new functionality and points to self-verifying client/server example pairs across transport variants. | A real client/server pair could qualify a Connector transport claim when that claim is in scope. Connectors already distinguishes fixture, schema and live evidence, so examples cannot promote a fixture to a hosted or authenticated claim. Its pnpm build and test commands do not transfer to this Bun plugin. |
| mise [AGENTS.md](https://github.com/jdx/mise/blob/main/AGENTS.md#L21-L55) separates unit and CLI end-to-end tests and regenerates usage and completions; its [test structure](https://github.com/jdx/mise/blob/main/AGENTS.md#L107-L113) gives E2E fixtures a harness owner. | Connectors already requires packaged CLI process tests and updates implementation, catalogue, discovery and help together. If generated usage or completions become part of its accepted surface, mise's source-then-regenerate pattern is a useful check. Its snapshot output oracle and Rust-specific harness/commands must not displace Connectors' independently pinned identities. |
| 1Password Shell Plugins [CONTRIBUTING.md](https://github.com/1Password/shell-plugins/blob/main/CONTRIBUTING.md#L218-L247) pairs local-build trials with plugin tests and warns that locally built plugins take precedence over installed ones. | Reinforces the existing candidate-versus-installed proof distinction in Connectors `AGENTS.md`. For a 1Password-backed Connector, fixture values can prove parsing without using real secrets. Do not copy its Go `plugintest` harness or infer that a local build proves the intended installed plugin identity. |
| Codex Security [AGENTS.md](https://github.com/openai/codex-security/blob/main/AGENTS.md#L36-L60) rejects speculative restrictions and tests invented only to enforce them; it treats CLI syntax, accepted values, environment variables and defaults as public API. | Strong fit for the accepted-contract boundary: refuse only contract-defined cases and update help, schemas, docs and process tests together when public CLI behavior changes. Connectors already requires a typed command owner and coordinated help/discovery updates. Do not import its broad warning against new sanitization as a reason to weaken Connectors' established credential and path custody. |
| Codex [AGENTS.md](https://github.com/openai/codex/blob/main/AGENTS.md#L29-L31) discourages tests of static values or removed logic and favors whole-object assertions. | Useful when a test merely mirrors a private constant or obsolete branch. A blanket ban conflicts with Connectors' valid public process assertion that discovery emits the accepted command identities. Those test-owned literals are independent oracles for observable CLI output, not tests of a static implementation value. |

## Recommendation

Keep the independent-oracle, process-proof, count, perturbation and proof-layer
rules in their existing owners. The accepted Portable CLI contract confirms
separate streams, safe refusal, and no-envelope crash exceptions, so the
Connectors standard now asks for process assertions on those observables. It
also requires early missing-config refusal before capability acquisition.
The Matt Pocock sources reinforce public behavior proof, but their database,
provider and interactive CLI rules depend on those repositories' seams.
The narrow accepted-contract refusal rule is now in Connectors
`CODING_STANDARDS.md`: trace each tested refusal to the contract, a declared
security boundary, or a witnessed defect, rather than inventing a restriction
and proving only that invention. The other upstream guidance sharpens offline
fixtures and observable readiness while leaving Connectors' own process and
literal oracles authoritative.

## Candidate disposition

| Candidate from the sources above | Disposition and owner |
| --- | --- |
| Public CLI process proof, independent stdout/stderr and exit assertions, secret-safe early refusal, test-owned oracles, nonempty collections, and a RED/GREEN sensitivity check. | **Admitted.** Shared `docs/agents/coding-standards.md` owns cross-package test design; Connectors `CODING_STANDARDS.md` owns packaged CLI and refusal proof. |
| One vocabulary/fake owner, write preview and journal, readiness, and candidate-versus-installed qualification. | **Already owned.** Shared standards, Connectors `AGENTS.md`, and the accepted Spec and Tickets carry these. No duplicate clause. |
| Fixture tests offline with observable readiness; client/server transport pair when transport behavior is claimed; generated help/completions from their source when added to the accepted CLI surface. | **Conditional.** Use in the applicable Ticket or test-design brief; no unconditional standard without an accepted contract and observed need. |
| A non-interactive alternative to attended OAuth. | **Conditional design question.** Preserve the accepted attended auth boundary unless a Ticket requires unattended use. |
| Blanket provider separation, database-inspection ban, static-value-test ban, snapshot oracle, and source-repository build commands. | **Rejected for Connectors.** Each either conflicts with its accepted process/effect proof or names another repository's implementation seam. |

This accounts for every transferable candidate found in the scoped sources.
It does not claim every line of each upstream document is a candidate.

## Source paths

- `/Users/nathanvale/code/agent-plugin-kit/CODING_STANDARDS.md`
- `/Users/nathanvale/code/coding-agent-qualifier/CODING_STANDARDS.md`
- `/Users/nathanvale/code/agent-ledger/CODING_STANDARDS.md`
- `/Users/nathanvale/code/my-second-brain-plugin/plugin/skills/new-skill/CODING_STANDARDS.md`
- `docs/agents/coding-standards.md` in this repository
- `config/agents/plugins/connectors/AGENTS.md` in this repository
- `config/agents/plugins/connectors/CODING_STANDARDS.md` in this repository
