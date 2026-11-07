# Credential verification map

Record each entry point separately. This map describes journeys, not a claim
that they all passed. Use the loaded skill's instructions and the current
credential owner's help before an operation.

| Feature | Entry points | Proof boundary |
| --- | --- | --- |
| [Diagnose metadata](metadata.md) | Local shell, trusted SSH shell | Real host metadata and wrong-context refusal. |
| [Deliver through 1Password](one-password.md) | Custody check, declared consumer injection | Actual custody and exact consumer access, separately authorized. |
| [Use Google Workspace custody](gog.md) | Named account, selected backend, authorized read | Native gog consumer access in the receiving process. |
| [Use native harness auth](native-harness.md) | Codex shell, Claude Code shell | Native status and authorized real request in that context. |
| [Hand off over SSH](ssh-handoff.md) | Sender, receiving worker | Receiver operation, with desktop dispatch qualified separately. |
| [Set up storage](setup.md) | Existing custody owner, Developer Environments | Native setup and readback, requiring credential-write authority. |

For every claim, name host, harness, launch route, account context, source or
installed revision, feature ID, action, resulting state, and unrun branches.
Use a private runtime-state evidence directory. Synthetic state stays labelled
synthetic. Installation and activation require native manager readback and a
fresh harness discovery proof.
