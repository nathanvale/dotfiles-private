---
name: linear-intake
description: Capture a sourced idea in a Linear project's Triage, or triage existing intake into research, decisions or deferred work. Use when asked to save an idea to Linear or review its intake. Execution and tracker migration need separate scope.
---

# Linear intake

## Resolve the destination

Use the requested project URL or its canonical planning pointer. Verify the
workspace, team and project against live Linear records before writing. Ask
when several destinations fit. Keep private domain material in its approved
destination.

Prefer the connected Linear tools. If they lack the required operation, use
the current harness's supported browser controls and signed-in Linear session.
Use existing credential custody for authentication. Report an unavailable
route or missing prerequisite instead of inventing an API client or creating
another project, integration or automation.

## Capture an idea

Search the destination for matching wording, source links and the underlying
question, including completed and canceled records. Inspect plausible matches
before creating another issue. For a duplicate, retain any new source on the
canonical record within the requested write scope and return its link.

For a new idea, create one issue in the requested project with its team's
native Triage status and the project's idea label. Verify these choices in
the creation payload or form. Ordinary issue creation can default to another status.
Leave the idea unassigned unless an owner is supplied.

Keep the description small:

- Preserve the user's wording or a faithful summary.
- Link the original source. For conversation intake, use its permalink when
  available; otherwise record the date and supplied wording as the source.
- State why the idea matters and the question to resolve.
- Mark unverified claims as research leads.

## Triage when requested

Read the project overview, accepted decisions and relevant implementation
evidence. Include snoozed entries when auditing the complete intake.
Choose one disposition within the user's authority:

- Link a duplicate to its canonical issue and retain its source.
- Keep a useful later idea in Backlog with a reason.
- Snooze an item awaiting information with a return condition.
- Decline an item with a reason.
- Promote evidence gathering to research or a human choice to a decision.

Use the project's existing labels and status equivalents. For the
`kind/idea`, `kind/research`, `kind/decision` and `kind/build` convention,
keep one kind per issue. Preserve other labels and intake history. Record real
blockers through Linear relations. Put consequential choices to the user;
research completion does not supply their answer.

Create build work only under separate implementation authority with a bounded
outcome, acceptance evidence and a stop condition. A readiness label records
a check, not permission to dispatch. Leave execution to its adopted task owner.

## Return a verified receipt

Read the saved record back. Check its project, status, kind, description and
source. Return its actual issue key and permalink, disposition and any missing
proof. If the write outcome is uncertain, inspect that exact target before
retrying. If capture failed, say the idea remains unsaved.
