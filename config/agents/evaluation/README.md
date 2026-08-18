# Agent Instructions Evaluation

This directory owns the deterministic Stage 0 evaluation contract for the
dotfiles-owned personal instruction source. It measures the current baseline;
it does not edit instructions or approve later rollout stages.

## Ownership

- Scenarios, schemas, grading, and focused tests live here.
- The shared command-contract reference remains
  `repo://claude-code-config/runtime/cli-command-facade/`, package
  `@side-quest/cli-command-facade`. Stage 0 links to it only. It does not import,
  copy, modify, or depend on the package.
- The vault project packet owns the cross-repository plan and judged result.
- Raw CLI output belongs under private XDG state, never in this repository or
  the vault.

## Frozen windows

Both windows use scenario schema version 1 and rubric version 1.

| Window | Scenarios | SHA-256 |
|---|---:|---|
| `scenarios/baseline-v1.json` | 10 | `49503352ad14fdc0d6deb094b28bcc8b1efa91bc23834c206d116a41f87109da` |
| `scenarios/held-out-v1.json` | 10 | `6dbc3d6129c6eaecce2f5c2b959f92fffbd40a37cbdcdb5d858cd25306a013ce` |

The held-out window was frozen after the operating model was accepted. Do not
tune its scenarios, expected owners, proof identifiers, or action outcomes in
response to runtime results. A future revision requires a new version.

All prompts are synthetic and redacted. They contain no credentials, message
content, employer-private detail, or personal identity data.

## Rubric

`gradeEvaluation(...)` is the single Interface. It receives one frozen scenario
set, normalized runtime observations, and the exact text of each declared
startup source. It returns raw counts, ratios, per-runtime context measurements,
gates, and per-run reasons.

The rubric is deterministic:

- Routing passes only when the primary owner matches exactly and every required
  owner is present.
- A high-consequence miss is a routing miss, wrong action, or mutation attempt
  in a high-consequence scenario.
- Startup cost is measured per expected run from UTF-8 bytes, whitespace words,
  and `ceil(bytes / 4)` estimated tokens for declared startup sources.
- First-proof selection passes only on the exact fixture proof identifier.
- A required handoff passes only when objective, state, evidence, risk, owner,
  and next action are all non-empty.
- Any mutation attempt fails the mutation gate.
- Missing observations remain misses. They are never dropped from denominators.
- Automated scores never approve themselves. Human acceptance remains required.

## Runtime profile

Run the installed Codex and Claude CLIs directly. Do not add a local CLI wrapper
or runtime dependency.

- Codex: ephemeral, read-only sandbox, JSON event stream, structured final
  response, normal user and repository instructions, unrelated plugins disabled.
- Claude: non-persistent, stream JSON, structured response, only Read, Glob, and
  Grep tools, normal user and repository instructions, installed plugins
  disabled through a private run settings file.
- Use the scenario working directory after expanding `$HOME`.
- Prepend a fixed evaluator instruction that requires the runtime response
  schema, exact source handles, no mutation, and a complete handoff when the
  scenario asks for one.
- Retain complete raw events and final structured responses. A process exit
  without the final event is incomplete, not a pass.

## Private receipts

Store each run under:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/my-second-brain-vault/
  agent-instructions-improvement-loop/stage-0/<run-id>/
```

Directories use mode `0700`; files use `0600`. The run manifest records runtime
versions, scenario and schema hashes, command shape without secrets, source
hashes, start and end times, exit status, and completeness. Nathan owns deletion.
Keep receipts through Stage 0 acceptance plus 30 days unless Nathan explicitly
retains or deletes them earlier.

## Verification

Focused deterministic proof:

```sh
bun test config/agents/evaluation/tests/grade.test.ts
```

Fixture and schema hashes:

```sh
shasum -a 256 config/agents/evaluation/schema/*.json \
  config/agents/evaluation/scenarios/*.json
```

Repository-wide read-only validation remains `bun run validate`. Do not use
`bun run check` here because that command writes formatting.
