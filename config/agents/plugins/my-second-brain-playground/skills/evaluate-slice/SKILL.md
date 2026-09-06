---
name: evaluate-slice
description: Independently evaluate a My Second Brain playground vertical slice through real process, persistence, and fresh-agent recovery evidence. Use to define observable acceptance or judge an implemented slice before promoting its baseline.
---

# Evaluate Slice

Judge a bounded user or agent journey against declared observations. Qualify
only the surfaces actually exercised. Keep implementation and judgment separate.

## Choose the evidence

Start with LLM analysis of existing traces, instructions, and outcomes. Name the
specific uncertainty before adding verification. Reuse the current evidence owner.

- For routing, wording, or ceremony changes, inspect the proposed instructions
  against existing evidence. Return recommendations and remaining uncertainty;
  analysis alone does not prove new behavior or timing.
- For a concrete deterministic uncertainty, use the smallest relevant check:
  pointer resolution, schema validation, artifact comparison, or a focused
  regression. Preserve required checks.
- For a material agent-behavior or delivery boundary that still needs observation,
  use one bounded live trial under the contract below. Repeat only for a new
  failure, changed boundary, or explicit reliability claim. Keep earlier results.

Analysis and static checks require no new participant session or compaction run.
Use independent LLM judgment of existing evidence when independence matters;
reserve fresh participant execution for the behavior claim being qualified.

## Fix the contract

Resolve the playground from the caller or
`~/.config/my-second-brain-playground/vault.json`. Read its entry and matching
agent-document branches. Identify the selected plugin source or installed
artifact, executable, project, Register, and permitted effects.

Before execution, record each criterion with its starting state, ordinary task
request, expected observation, evidence owner, and pass/fail condition. Name the
run count and stop boundary. Use an existing criterion set when supplied; do
not weaken it to fit the implementation. Mark missing prerequisites explicitly.

Tie each semantic criterion to the ordinary request or a named standing
invariant. Extra detail and stylistic preferences are advisory unless the request
requires them. Before freezing, check that a useful, source-faithful answer can
pass without reproducing the evaluator's preferred answer.

Keep answer-bearing criteria and expected outputs in private runtime state,
outside the participant's searched corpus. Record the request and evidence route
in the existing project packet. After execution, preserve the frozen verdict;
label any criterion-design error separately from a product failure. Keep raw
answers and corrections with receipts; durable proof links to canonical knowledge.

Separate deterministic checks from semantic agent behavior. Choose repetitions
proportionate to the claim and report each run, including failures. One successful
trial proves that trial, not reliability across models or harnesses.

## Exercise independently

- Use a fresh evaluator with no implementation conversation. If the current
  agent built the slice, delegate judgment when authorized; otherwise record
  independence as unavailable. Give the evaluator the criteria, normal entry,
  permitted interfaces, and raw artifacts, without an answer key disguised as
  a user prompt or the implementer's verdict.
- Use a separate fresh participant for navigation or continuation claims when
  the evaluator knows the expected answers. Give the participant the ordinary
  task and normal entry route only. The evaluator compares its actions and
  resulting state with the criteria.
- Run through the public installed skill or compiled process when that is the
  claimed delivery surface. Label explicit source-skill runs as source proof.
- Inspect actual resulting files and committed database state after processes
  exit. Read-only SQLite may provide independent durability proof when supported
  reads are absent; direct SQL writes cannot substitute for a product command.
- Prove absent or refused effects by comparing before/after state. For retries,
  inspect the exact prior outcome before repeating a mutating command.
- For README drift, compare the body before and after changes through its owner.
  For a derived cache, rebuild and compare its meaningful content.
- For recovery, withhold prior conversation and require identity, evidence,
  acceptance, and next-action recovery. Include stale or missing context when
  relevant. For compaction claims, use the separate boundaries in
  [compaction recovery](../playground-slice/references/compaction-recovery.md#qualify-each-delivery-boundary).
  Observe actual Codex and Claude compact events where available, delivered
  context before continuation, and the next operation. Keep source behavior,
  installed bytes, Codex trust/activation, event delivery, and fresh-agent
  recovery verdicts separate; unavailable events remain proof gaps.
- For concurrency, record overlapping process intervals and inspect every
  writer's exact durable content. Keep commits within the owning commit skill
  and the caller's authority.
- Give an independent verdict on the
  [Ceremony Smell Check](../playground-slice/SKILL.md#ceremony-smell-check)
  in the existing slice proof. Judge observed ordinary-journey friction; separate
  product costs from costs introduced by the evaluation harness. State when
  observation or independence is unavailable.

Stop at the first unsafe effect or lost ownership boundary. Preserve the failed
state and report its cause. Continue independent safe criteria if their evidence
does not depend on that failure. When a fix requires another live trial, name that run separately and retain the old one.

## Hand back evidence

Keep raw receipts under private XDG state with `0700` directories and `0600`
files. The run manifest names retention and deletion ownership. Return:

- slice and criterion identities, artifact version/hash, model/harness, and runs;
- one verdict per criterion: proved, not-proved, or unknown, with the observation;
- exact file, database, commit, or receipt pointers supporting each verdict;
- independence, delivery, persistence, recovery, and concurrency limits;
- the smallest repair or next proof for each missing criterion.

Write durable synthesis only to the caller-authorized owner. Preserve the
README as a stable map. Call the slice qualified only when every required
criterion is proved within the stated scope. Schema validity, an implementer's
claim, or a zero exit status alone is insufficient.
