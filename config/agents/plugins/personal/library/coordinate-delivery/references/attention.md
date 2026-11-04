# Route attention without making the human relay it

Use these cases when an attention label conflicts with the conversation or when
you must decide who owns the next action. The selected application's actual state
and supported controls remain authoritative.

| Observation | Next action |
| --- | --- |
| Worker says "Awaiting independent review." | Request the assigned reviewer and record the candidate and return route. |
| Worker acknowledges instructions. | Retain the message. Continue the task's existing next action without requesting another acknowledgement. |
| Board says "Needs you" but no decision is present. | Read the task and conversation. Route the actual work and report the misleading label without claiming to fix it. |
| Dependency is complete but its code is absent from the checkout. | Integrate the admitted prerequisite if authorized, then verify the checkout before continuation. |
| Review finds an acceptance failure. | Send a scoped Repair to the existing worker within the remaining allowance. |
| Required evidence belongs to an older candidate. | Determine which claims remain valid and obtain the missing evidence for the changed candidate. |
| External operation returned no conclusive outcome. | Inspect the same target and reconcile it before another write. |
| Review and checks pass but merge approval is required. | Present the existing native merge control. Keep the merge held. |
| Authority expires while a worker is finishing. | Preserve its checkpoint and seek the authority needed for the next action. |

A necessary question explains one decision in plain language.

> The reviewed change is ready to merge. I recommend merging it into the agreed
> base. That makes the change available to dependent tasks. Your existing
> permission covers implementation and review; merge approval is still required.
> Use the Merge action on the existing task card.

For an account-access decision, describe the access rather than its mechanism.

> The preview cannot publish its PR until it can use the existing GitHub login.
> I recommend allowing that access. It lets this preview act with that account's
> existing permissions. Keeping access blocked leaves publication held.

Use explicit action labels and short consequences when choices are supported.
Preserve the actual native control wording when it governs approval. Give
credentials only through their supported secret or authentication interface.

