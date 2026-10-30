# Message types

Choose by the reader's next action. Read only the matching template and adapt
its sections to the evidence. Placeholders are inputs to resolve, not copy to
send. Keep recipient identities, channels and ticket facts in their current
project owner rather than in these reusable templates.

| Reader needs to | Reference |
| --- | --- |
| Answer ambiguities found during a build or review | [Open questions](open-questions.md) |
| Integrate an extension or review a delivered package | [Extension handover](extension-handover.md) |
| Review a visible change or settle a design choice | [Design feedback](design-feedback.md) |

For another message type, draft from the request and source evidence. Add a
template when Nathan asks to retain that type; keep its selection here.

## Slack presentation

- Use short paragraphs, descriptive section headings and numbered questions.
  Put the relevant `[Storybook example](url) | [Jira key](url)` beside each item.
  A general preview homepage does not replace an available exact story link.
- Use a list for comparisons in Slack. Reserve Markdown pipe tables for a
  destination that renders them.
- Check the current composer mode before pasting. In markup mode, use `*bold*`
  and `[label](url)`; Slack renders them after Send. In rich-text mode, inspect
  the actual formatting and link targets after paste. HTML paste can lose links
  in markup mode. Follow [Slack's formatting guidance](https://slack.com/help/articles/360039953113-Format-your-messages-in-Slack-with-markup).
- Explain Storybook once when the audience may not know it: "Storybook is our
  online gallery of screens and interactive examples. It lets us review how
  the form looks and behaves in different states." Say "Storybook build" for
  that checkpoint; name an extension build or package release only when that
  is the actual subject.
- Resolve stakeholder roles from the current project record and verify their
  Slack identities in the live workspace. Select real mention suggestions and
  inspect the inserted tags. A typed name or copied Jira mention is not proof
  of a Slack tag. Use the requested channel or thread and preserve its drafts.
- Before handoff, account for every requested question, paired link and tag.
  Apply the preview-link checks below. Keep the skill's draft/send boundary
  and the service's write rules.

## Verify preview links

- Open every distinct preview URL and wait for its rendered content. Confirm
  that the selected story shows the state or behaviour named beside the
  question. An index entry, successful HTTP response or preserved URL proves
  neither rendering nor relevance.
- For an update, use the delivery record to establish which revision the
  preview shows. Label unknown source or an older build explicitly rather
  than presenting it as the new change.
- Link directly to the specific story. For responsive comparisons, provide the
  relevant desktop, tablet and mobile stories separately. Use Docs when the
  documentation itself answers the reader's need; label it as documentation.
- When no matching preview exists, write "No published Storybook example for
  {behaviour}" beside the Jira link. Keep general overview links in the
  introduction. A general page or unrelated example does not fill a missing
  preview slot.
- Label a held notice "Held notice: {topic} (no built screen)" after checking
  its content. Describe provisional examples and partial coverage explicitly,
  so readers can distinguish an example from an accepted product decision.
- After an authorised post or edit, read back the saved link targets and
  compare them with the rendered destinations checked above. Account for every
  item, preserve ticket links and native mentions, and report any unverified
  destination as a gap.

## Reusing examples

Read the actual prior message and its linked evidence when adapting a named
example. Extract its structure and tone. Refresh the facts, links, audience
and next action; prior delivery, approval and test claims are not defaults.
