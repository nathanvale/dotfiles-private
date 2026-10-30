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
  Label a held state, related example or Docs fallback when no direct example
  exists. Verify the URL's story or node, not merely its hostname or HTTP status.
  Keep the skill's draft/send boundary and the service's write rules.

## Reusing examples

Read the actual prior message and its linked evidence when adapting a named
example. Extract its structure and tone. Refresh the facts, links, audience
and next action; prior delivery, approval and test claims are not defaults.
