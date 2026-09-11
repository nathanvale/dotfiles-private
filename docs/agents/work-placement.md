# Work Placement

Choose the owner before the first write or move. The current working directory
does not acquire ownership because a session started there.

## Owner map

| Artifact | Owner | Boundary |
| --- | --- | --- |
| Existing product, skill, tool, test, fixture, harness, package, generated documentation, API contract, or changelog | Its code repository | Follow that repository's branch, worktree, and check contract |
| Personal plugin or skill not yet extracted | Dotfiles source tree | Read `docs/agents/skills.md`; adopt a dedicated repository before transferring ownership |
| Substantial standalone product | Dedicated repository under `~/code/<repository>/` | Create or adopt the repository explicitly; link its project packet |
| Resumable experiment with no adopted product owner | Standalone Git repository under `~/code/scratch/<project-slug>/` | Keep the experiment contained; record its source packet and retirement or promotion condition |
| Disposable one-run probe | Temporary directory | Keep only the useful conclusion or evidence pointer |
| Personal or cross-repository project packet, plan, research, synthesis, specification, ticket, study manifest, readable finding, durable proof, or evidence link | Configured vault | Keep executable implementation outside the packet |
| Repository-binding specification, ADR, contributor instruction, API schema, or deterministic contract | Its code repository | Keep implementation truth beside the implementation it binds |
| Raw run output, prompts, admissions, event streams, stderr, staged executable copies, or receipts | The selected runtime state owner, normally `$XDG_STATE_HOME` | Promote only readable conclusions and evidence pointers |

Link between owners. Keep one canonical copy of each artifact.

## Scratch profile

A scratch repository is a containment boundary, not a production-readiness
claim.

- Declare `scratch` and the dump-and-run purpose in its `README.md`.
- Record the source vault packet, the shortest run command, and the condition
  for deletion, retirement, or promotion.
- Add only the toolchain needed to run or reproduce the experiment.
- Leave Fallow, complexity governance, monorepo structure, CI, release tooling,
  hooks, and other product ceremony out unless the experiment specifically
  needs them.
- Apply the durable repository bootstrap contract only when the work becomes a
  maintained product, shared library, reusable tool, or long-lived code owner.

A bootstrap template may expose separate `scratch` and `durable` profiles. Its
README must state which checks each profile includes. Keep a monorepo layout as
an optional example, not the scratch default.

## Vault-led qualification

Keep `GOAL.md`, specifications, tickets, study manifests, readable findings,
durable proof, and evidence links in the vault project packet. Put harness
source, tests, wrappers, fixture source, and build utilities in the selected
code repository. Put raw runs and staged executable copies in runtime state.

When extracting misplaced code, preserve the vault packet and its history.
Pause before moving any artifact whose owner is ambiguous. A placement fix does
not authorize cleanup, deletion, promotion, or a change of project ownership.
