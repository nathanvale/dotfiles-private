# Spike-candidate fixtures (unadmitted drafts)

These Specification Candidates were hand-written during the falsification
spike (dotfiles issue 75) and posted as spike artifacts on 2026-08-21.

They carry **no semantic authority**. No Specification Admission has occurred.
They exist here only as positive compiler-boundary fixtures: stage 1's gate
requires that a candidate validates and produces an identical canonical digest
on repeat runs.

- `vault-git.state-machine.jsonc`: full durable-work surface, re-authored
  against **Input Schema v2** on 2026-08-22. It is unadmitted, and its identity
  is deliberately pinned nowhere: an unadmitted candidate gets a pinned digest
  only if its own Specification Admission gives it one.
- `vault-git.v1-frozen.state-machine.jsonc`: the vault-git candidate's bytes as
  they stood before that re-authoring, kept frozen as the Input Schema v1
  exemplar. It is the subject for every claim about what v1 input does, and it
  holds the pinned `f22e836b..` identity through its Registered Reader. Its
  bytes are history and never track the live candidate.
- `fallow.state-machine.jsonc`: mostly stateless, still on **Input Schema v1**;
  must inherit zero durable machinery.

Input Schema v1 was defined as the union of the two original spike candidates,
nothing more (product-owner ruling on dotfiles issue 55, 2026-08-21).
That ruling describes v1, which is unchanged and frozen. It no longer describes
this directory's contents: the live vault-git candidate has moved to v2, and
the frozen exemplar rather than that candidate is now v1's half of the union.
