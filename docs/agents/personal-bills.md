# Personal Bills

## Scope

- Use this workflow to understand, plan, pay, or confirm a personal or
  household bill, payment notice, billing renewal, billing account, or
  bill-payment portal.
- Treat related messages, calendar events, reminders, and bill-payment portal
  work as supporting steps. Route non-billing work directly to its owning
  skill.

## Orchestrate

1. Keep root on Sol / High. Root owns intent, decomposition, route choice,
   verification, escalation, and acceptance.
2. Select the smallest delivery route before task tools:
   - `solo`: default for work root can complete and verify directly.
   - `luna`: delegate one complete, bounded, fully specified unit to a fresh
     `default` agent with `fork_turns: none`, model `gpt-5.6-luna`, and effort
     `xhigh`.
   - `terra`: delegate one complete judgment-heavy or high-risk unit to a fresh
     `default` agent with `fork_turns: none`, model `gpt-5.6-terra`, and effort
     `high`.
   - `review`: after root verification, spawn a fresh
     `sol_advisor_sol_reviewer` with `fork_turns: none` when Nathan requests a
     review or independent scrutiny would materially reduce risk.
3. Use one auxiliary at a time. Use more only when Nathan explicitly requests
   independent parallel reviews and their scopes do not overlap. Make delegated
   work substitute for root work.
4. Give each worker `OBJECTIVE`, `FILES AND OWNERSHIP`, `INTERFACES`,
   `CONSTRAINTS`, `VERIFICATION`, and `RETURN`. Name the exact owned files or
   data, preserve concurrent edits, and require commands plus actual evidence.
5. Give each reviewer the stated goal, accumulated change set, constraints, and
   root verification evidence. Require `ship`, `fix-first`, or `rethink`.
   Treat any correction as invalidating the verdict and use a fresh reviewer
   after re-verification.
6. Treat every agent report as a claim. Root inspects the changed state and
   reruns the completion proof before acceptance.

## Resolve Context

1. Start from the live bill, payment notice, billing correspondence, or
   bill-payment portal. Fetch it through the applicable owning skill, such as
   `gog-gmail` for accessible Gmail or `browser-use` for a bill-payment portal.
2. Extract exact entity names and stable aliases or relationships, including
   the people, organization, property, owners corporation, manager, billing
   account label, and portal when relevant.
3. Resolve the canonical vault through `$HOME/.config/context/vault.md`. Search
   the configured vault using the extracted terms, including Area, System, and
   Organization notes. Verify every indexed result against the live vault file
   and read only the strong matches needed for the bill.
4. Use durable context for relationships, responsibilities, history, and prior
   decisions. Use the live evidence as current truth for mutable amounts, due
   dates, payment status, terms, and portal state. Surface conflicts instead of
   silently copying either source.
5. Keep credentials, authentication-bearing URLs, full payment identifiers,
   and other secrets out of durable notes.

## Act

1. Route the requested work through the applicable owning skill, such as
   `context-advisor` for unclear placement,
   `browser-use` for bill-payment portal work, `gog-gmail` for Gmail,
   `gog-calendar` for calendar work, `apple-reminders` for reminders, and
   `draft-message` or the applicable channel skill for messages. Follow that
   skill's procedure and approval rules.
2. Before a consequential action, identify the exact bill, payee, amount,
   payment method, and requested effect, then stop at the owning skill's
   approval checkpoint. A lookup, draft, reminder proposal, availability
   check, or proposed change does not authorize a payment, account creation or
   change, message send, calendar or reminder mutation, or portal submission.

## Finish

1. Complete advice after reporting the live source, matched durable context,
   current bill facts, conflicts, and next safe action.
2. Complete an action only when the owning skill's completion check verifies
   the live result. If identity, amount, due date, authority, or outcome remains
   ambiguous, report it and stop. Do not infer success or retry an unknown
   consequential result.
