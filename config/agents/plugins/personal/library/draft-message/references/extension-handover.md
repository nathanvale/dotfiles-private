# Extension handover

Use when a delivery team needs the current package, preview and integration
instructions. For Monash work, read the installed
`monash-tools:extension-verify-deliver` skill and follow its pointer to delivery
communications. That workflow owns qualification, recipients, publication and
readback; this template owns the readable announcement.

1. Resolve the admitted checkpoint, intended integration owner and verified
   artifact links from that delivery record. Retain its actual scope and gaps.
2. Lead with what the recipient can use now. Pair the canonical review or
   journey link with its Jira delivery item; supply the package and migration
   guide when they are part of this handover. Apply
   [preview-link verification](message-types.md#verify-preview-links) to the
   review link. Use the delivery owner's verified package and guide receipts;
   omit artifact links that have not been supplied or published.
3. Describe the contents and practical limits in plain language. Keep source
   hashes, commands and detailed qualification in the linked technical record.
4. Name one next action, its owner and any genuine deadline. Tag only verified
   intended stakeholders and use the approved delivery destination.

## Draft shape

```text
Hi team, we've prepared {extension and scoped checkpoint} for {next action}.

*Review and integration links*
[Storybook: {journey}](url) | [{Jira delivery item}](url)
[Source package](url) | [Developer or migration guide](url)

{One sentence explaining Storybook when needed.}

*What's included*
{Reader-facing scope and what the recipient can review or integrate.}

*What still needs attention*
{Material decisions, limitations or missing proof with the relevant ticket.}

*Next step*
{Named recipient's concrete action and supported timing.}

cc: {verified stakeholder mentions}
```

Use only sections that carry useful information. A preview, source handover,
package release, deployment and recipient acceptance are separate checkpoints;
reuse the delivery record's exact state rather than upgrading it in the copy.
