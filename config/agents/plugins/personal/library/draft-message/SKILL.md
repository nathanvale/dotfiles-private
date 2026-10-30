---
name: draft-message
description: Draft or revise Nathan's work messages for Jira, Slack, Teams or email.
---

# Draft message

Produce an unsent draft in Nathan's voice. Use the current request
when invoked without arguments; ask only for missing context that changes the ask.

1. Read the recipient's original request, relevant thread and source evidence.
   Read Nathan's actual messages when available. Confirm authorship before using
   them as voice samples: a post under his account may be an agent-written draft.
   If sources are unavailable, state the gap outside the draft and keep dependent
   claims provisional. Respect a request not to collect samples; use the accepted
   writing rules below and mark voice matching unverified.
2. Identify the audience, relationship, one main point and action Nathan wants
   from the recipient. For professional correspondence, including friendly
   messages to colleagues, read [comms style](references/comms-style.md) before
   drafting. Personal catch-ups and social messages keep their conversational tone.
   For announcements, handovers, open questions or design feedback, choose the
   matching [message type](references/message-types.md) and read its template.
   Finish this step when the recipient's next action is clear, or the update is
   explicitly for information.
3. Draft the visible outcome first, using the audience and voice guidance in
   comms style. Keep sentences direct and paragraphs short. Name
   concrete changes and useful next steps. Use verified links
   where they help the reader act. Add labelled images or a small table only
   when they make the review or decision easier. Give email a specific subject;
   keep Jira context attached to its issue and Slack or Teams updates compact.
4. Keep implementation logs, hashes, test counts and release qualifications in
   the evidence record unless this recipient needs them for the decision. Preserve
   material open issues and their practical effect in plain language. Compare
   the draft with the source so shortening retains the decision, choices,
   deadlines and limitations that matter. Keep proposed, checked, live, released
   and accepted claims at the state the evidence supports.
5. Read `$HOME/.agents/skills/unslop/SKILL.md` as the canonical editing checklist
   and apply its rules to the draft. This reads reference text; it does not
   automatically invoke the user-only Unslop skill or change its settings.
   If the file is unavailable, report the missing editing pass instead of
   claiming it ran. Preserve the meaning while editing.
6. Trace every factual claim, link, image, mention and recipient to its source.
   Check that links name the intended destination and mentions identify the
   intended person. Keep uncertain identities and unsupported claims out of
   ready-to-send copy. Sense-check the opening, tone and next action, then
   present one clearly separated draft with recipient, channel and email subject
   where relevant. Put source gaps or unresolved choices outside the copy.

Drafting grants no sending authority. Sending or editing an external message
requires Nathan's applicable authorization and the service's supported write
workflow. Follow that workflow's formatting, preview and readback requirements,
including any append-only restriction. Preserve authorization already given
within its scope; never report an unsent draft as delivered.
