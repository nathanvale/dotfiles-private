# Open questions from a build

Use for a team update pointing readers to questions already on tickets.

1. Read the source tickets and current discussion. Combine repeated questions;
   distinguish a confirmed answer from an initial suggestion. Preserve every
   remaining decision and choice in the requested scope.
2. Introduce where the ambiguities came from and invite links to decisions
   already made elsewhere. Explain the preview using the message-types reference
   when the audience needs it.
3. Group by the reader's work, such as the student form, design/content,
   review/approval and task/access. Use only relevant sections. Give each
   numbered item its question and ticket links on adjacent lines. Add preview
   links using [preview-link verification](message-types.md#verify-preview-links).
4. Ask for answers on the source tickets. Jira owns question status; this
   announcement is a readable index, not another tracker. Keep questions that
   have no preview, with their missing-example note and ticket link.

## Draft shape

```text
Hi everyone, we've brought together the questions that came up while comparing
{tickets, specification and design} during the {Storybook build or checkpoint}.

Some may already be resolved elsewhere. A link to the decision or updated
design on the relevant ticket would help us catch up.

*{Section}*

*1. {Topic}*
{Specific question and the choices that need deciding.}
[Storybook: {state}](url) | [{Jira key}](url)

Please add answers or existing decision links to the relevant tickets so we
have a clear reference for the next update. Thanks!

cc: {verified stakeholder mentions}
```

Add an acknowledgement of discussion already underway when the thread supports
it. Preserve tentative wording and held scope. A ticket still being open does
not establish that its question remains unanswered.
