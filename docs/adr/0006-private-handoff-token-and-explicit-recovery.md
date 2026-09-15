---
status: accepted
supersedes: 0005-attended-browser-login-handoff.md
---

# Keep handoff tokens private and recover exact reservations explicitly

## Context and Problem

The attended-login reservation keeps one Chrome profile unavailable to other
compliant agents while Nathan signs in. Its token authorizes normal resume or
release. Returning that token in command output and passing it in arguments
exposes it to logs and process inspection. Losing the token leaves a reservation
without a supported operator recovery command.

Nathan approved fixing both issues on 6 September 2026 in PR #118.

## Decision Drivers

- Reserve the declared profile before opening or authentication.
- Keep login credentials in the visible browser and with the human.
- Keep reservation tokens out of command arguments, environment, and output.
- Retain token access across separate agent commands and interrupted opening.
- Recover only the exact reservation the operator inspected and approved.
- Preserve competing ownership, explicit human authority, and durable evidence.
- Preserve the existing same-user bypass limitation.

## Considered Options

- Retain token arguments and manual repair: compatible, but leaves both defects.
- Use only inherited descriptors: private transport, but descriptors do not
  survive separate agent tool calls without additional custody infrastructure.
- Use private token files and explicit recovery of an observed reservation.

## Decision

Choose private token files and explicit operator recovery. The command creates
a new caller-selected token file with exclusive creation and private ownership
checks. Deliver the token before publishing the reservation or dispatching
Chrome. Resume and release read a bounded token through private file input.
Reject the old token argument with a migration instruction. No child process
receives the token in arguments or environment; ordinary and uncertain-opening
results contain no token.

The reservation stores only the token digest. An interrupted opening keeps the
reservation and caller's token file available for the same task's continuation.
The caller retains that file privately until it verifies completion or release,
then removes only its own token file.

Recovery defaults to a read-only preview of the reservation. Execution requires
an explicit operator acknowledgement and the exact observed reservation
fingerprint. Under the existing lane lease, recheck the fingerprint, persist an
audit receipt before removal, and record the outcome afterward. A replacement,
busy command, malformed state, or unavailable required audit storage refuses
recovery. Time alone never releases a reservation. Recovery aborts custody; it
does not authenticate, grant tab access, or prove browser readiness.

Keep ADR-0005's pre-admission opening, human sign-in, application-origin checks,
one exact-page grant, unrelated-tab preservation, and ordinary nonce-possession
resume/release behavior. This decision replaces token transport and adds the
explicit operator recovery path. CLI help owns exact flags and result fields.

## Consequences

- Positive: ordinary logs and process arguments no longer expose the token.
- Positive: lost-token recovery has an exact target and audit evidence.
- Negative: the caller must retain and retire a private token file.
- Negative: callers using the old token argument must migrate.
- Neutral: an acknowledgement records operator intent; it is not a new OS
  privilege boundary. The router cannot exclude same-user clients bypassing it.

## Confirmation

### Accepted revision: profile-local tab reuse before opening

Nathan approved metadata-only matching on 6 September 2026 and implementation
of visible profile-local tab cycling on 7 September 2026 after an unconditional
new-tab request duplicated an existing NotebookLM tab.

Replace the prior pre-admission prohibition on tab inventory only with this
bounded native URL-metadata check. Keep reservation-before-selection, token
privacy, human credential entry, and human tab grants unchanged. Use one exact
profile window's accessibility tab controls and document metadata; never bind
Chrome's scripting front window by guessing its profile. Chrome's scripting
interface has no profile property, while relay adapters require admission.

Unconditional creation preserves the old observation boundary but reproduces
the duplicate. A front-window scripting bridge avoids visible cycling but does
not establish profile identity. Choose scoped native cycling: it meets reuse
and profile isolation without moving credentials or grants into the agent.
The cost is visible selection changes and reliance on macOS accessibility
metadata. An incomplete inventory, duplicate match, profile ambiguity, or
interruption refuses creation. Restore the original selection when safe;
interrupted restoration remains uncertain. This does not control bypassing
clients or make browser navigation atomic.

Prove reuse, absence-only creation, refusal, unchanged grant boundaries, and
reservation retention through the existing public CLI tests. Native-host
doubles are not live qualification. Require separate real profile checks for
accessibility metadata, exact-tab reuse, and unchanged tab counts before
installing or claiming this behavior qualified.

Use the public command tests in `bin/test/browser-lane-test.sh` to prove private
file handling, token redaction, interrupted opening, exact recovery, competing
leases, replacement refusal, and audit failure behavior. Inspect durable state
independently. Retain the separate Codex/Claude and personal/work live login
qualification requirement before claiming installed behavior is qualified.

## References

- [Prior decision](0005-attended-browser-login-handoff.md).
- [Review](https://github.com/nathanvale/dotfiles-private-archive/pull/118).
- `bin/browser-lane --help` and `docs/agents/browser-automation.md`.
