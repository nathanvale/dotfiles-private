# Connectors Portable CLI standards research

Date: 2026-09-24 (Australia/Melbourne). Scope: the four named local first-party
`CODING_STANDARDS.md` files and two Matt Pocock upstream standards files,
compared with the current dotfiles shared standards and Connectors candidate.
This is a fit review input, not an admitted rule.

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

## Recommendation

Keep the independent-oracle, process-proof, count, perturbation and proof-layer
rules in their existing owners. The accepted Portable CLI contract confirms
separate streams, safe refusal, and no-envelope crash exceptions, so the
Connectors standard now asks for process assertions on those observables. It
also requires early missing-config refusal before capability acquisition.
The Matt Pocock sources reinforce public behavior proof, but their database,
provider and interactive CLI rules depend on those repositories' seams.

## Source paths

- `/Users/nathanvale/code/agent-plugin-kit/CODING_STANDARDS.md`
- `/Users/nathanvale/code/coding-agent-qualifier/CODING_STANDARDS.md`
- `/Users/nathanvale/code/agent-ledger/CODING_STANDARDS.md`
- `/Users/nathanvale/code/my-second-brain-plugin/plugin/skills/new-skill/CODING_STANDARDS.md`
- `/Users/nathanvale/code/dotfiles/.worktrees/standards-no-tautological-tests/docs/agents/coding-standards.md`
- `/Users/nathanvale/code/dotfiles/.worktrees/standards-no-tautological-tests/config/agents/plugins/connectors/AGENTS.md`
- `/Users/nathanvale/code/dotfiles/.worktrees/standards-no-tautological-tests/config/agents/plugins/connectors/CODING_STANDARDS.md`
