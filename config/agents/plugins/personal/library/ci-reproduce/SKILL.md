---
name: ci-reproduce
description: "Diagnose failing CI builds, tests or deployments when local checks pass, build inputs differ, or remote logs are unavailable. Reproduce the failing stage and verify the correction in CI."
---

# Reproduce CI failures

## Next safe actions

With no arguments, inspect the current task for a failing job, revision or log.
Resolve the exact run through the repository's existing CI owner. Ask for the
run link only when that evidence cannot identify it. Begin with read-only
inspection; state the next experiment before starting expensive work.

Use the repository's commands, verification skills and service tools. This skill
owns diagnosis, not a package manager, browser driver or deployment command.
A failure record is input; the output is a supported cause, scoped correction,
retained proof and the next safe action. Mark missing proof explicitly.

## 1. Identify the failure

- Read the nearest instructions, CI definition, build scripts and verification
  owners. Reuse their dependency setup, isolation, resource locks and commands.
- Record the exact run/job, failing stage, checked-out commit, target branch and
  error. Resolve PR merge commits separately from source and base revisions.
- Distinguish setup, compilation, tests, packaging, publication and runtime
  failures. A permission error while reading logs is not the build's cause.
- Retain sanitized logs and exits under the project's evidence owner, outside
  disposable build state. Record missing observations as unknown.

Proceed when the failing identity and the next discriminating experiment are
named. If logs are unavailable, reconstruct the stage from its definition and
available artifacts. Use existing access; do not request broader permissions
just to read diagnostic logs.

## 2. Reconstruct the actual inputs

Read [environment comparison](references/environment.md) before reproduction.
Pin the failing revision in an isolated checkout. Follow the project's install
contract. Compare CI's uploaded or generated input set with the checkout,
including ignored files, compiler configs, executable modes and generated inputs.

Match the actual image, OS/architecture, runtime, package manager, lockfile,
working directory and command. Use the real CI input manifest or upload rules.
Reproduce packaging stages before the build when CI does so. Record every
unmatched input, platform difference and substituted external dependency.

Use existing credentials only through their approved owner. Keep secrets out
of logs and copied contexts. Execute repository scripts only within the current
task's trust and authority. Publication, spending and access changes keep their
existing approval boundaries.

## 3. Reproduce and isolate

- Run the failing stage with complete output, an exit code and an owned timeout.
  Prefer the cheapest check that distinguishes the current hypothesis.
- Require the same failure signature. A missing install or unrelated setup error
  is an unsuccessful reproduction, not confirmation of the CI diagnosis.
- State one hypothesis and its predicted observation. Change only its required
  inputs, then compare failure and success on otherwise equivalent inputs.
- If two attempts do not reproduce the failure, stop rerunning. Inventory the
  remaining differences and choose a new evidence source or report the gap.
- Reuse expensive results only after comparing all inputs relevant to the claim.
  Change evidence or inputs before retrying; inspect an uncertain remote outcome
  before issuing another job or write.

## 4. Correct and verify

Fix the smallest authoritative source, not its generated output. Add or extend
an existing regression check at the failed boundary, using an independent
expected result. Demonstrate the relevant omission or defect fails the check,
restore the correction, and retain both results. Keep genuine required checks;
a skip or weaker assertion is not a repair.

Run focused checks and the affected real build. Obtain the project's required
review against the final candidate. Through the authorized CI owner, verify the
actual new job's terminal result and revision. A local success leaves remote
verification pending until that job completes.

For deployments, join the published receipt or equivalent build identity to the
served artifacts, then use the project's user-facing verification route. Open
and exercise the affected page, command or service operation and observe its
result. HTTP success and an index entry alone do not prove it works. Where no
trusted identity mechanism exists, report that gap separately from behaviour.

## 5. Leave evidence and a clean boundary

Return the cause, changed inputs, candidate/run identities, local and remote
results, evidence locations, remaining differences and next safe action. Keep
reproduced, fixed, reviewed, CI-passed, deployed and user-verified distinct.

Stop only owned processes by recorded identity. Release acquired locks and
inspect owned disposable paths for work before cleanup. Preserve evidence and
unrelated workloads, credentials, containers and checkouts. Report retained
scratch resources; do not force-remove worktrees or prune shared resources.

Read [the compiler-config case](references/compiler-config-case.md) for the
sanitized worked example. It illustrates this workflow, not commands to copy.
