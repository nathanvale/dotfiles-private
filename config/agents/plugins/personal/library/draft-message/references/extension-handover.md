# Extension handover

Use when a cross-functional team reviews or integrates an extension package.
For Monash work, follow the installed `monash-tools:extension-verify-deliver`
communications route. It owns qualification, recipients, publication and
readback; this reference owns the announcement's structure.

## Prepare

1. Read the current delivery record and existing message. Resolve the usable
   checkpoint, package, Catalog, guide, Jira requirements and example states.
   Preserve current mentions and unrelated edits when revising a saved post.
   Establish whether the requested handoff includes online interactive review,
   a source package, or both. Keep every requested deliverable accounted for.
2. Map each relevant Jira requirement to its actual family or scoped example.
   Name held references and uncovered acceptance criteria beside that mapping.
   Apply [preview-link verification](message-types.md#verify-preview-links).
3. Select up to three useful examples and describe one action or state to
   review in each. Use exact published links where available. For source-only
   handovers, label examples as packaged and name their module or story;
   explicitly state that no published preview is included. Use that branch when
   a source-only handoff was requested or accepted; it does not close a requested
   online-review deliverable.
4. Draft in the order below. Keep detailed proof in the linked receipt, with
   material limits and their practical effect visible in the announcement.
   End with one concrete review or integration request.
5. Run [handover verification](verify-handover.md) before returning the draft.
   Include every verified requested preview link in the link strip and relevant
   Jira/example rows. Report missing, inaccessible or mismatched requested
   previews as delivery gaps with the observed result and next owner. A local
   preview proves local review only. Keep publication with its delivery owner.

## Draft shape

```text
Hi team, the {extension and scoped checkpoint} is ready for {review/integration}.

[Source package](url) | [Full Catalog](url) | [Developer Guide](url)

The Catalog is our review gallery for {extension}'s sections and example states.
Product, design, BA and development owners can go from their Jira requirement
to the relevant family below. Each family's Docs explain what is built,
the examples to try and the remaining questions.

*Explore by Jira requirement*

- *{Requirement or capability}*, [{Jira key}](url): [{Family}](url), [{Family}](url).
- *{Requirement or capability}*, [{Jira key}](url): {scoped packaged reference or held state}.

*Three examples to try*

- [{Specific example}](url): {one useful action or state to review}.
- [{Specific example}](url): {one useful action or state to review}.
- [{Specific example}](url): {one useful action or state to review}.

{Concise qualification and practical limits. Distinguish sample data,
caller callbacks, held references and incomplete integrations.}

Please reply with the Jira item, exact Storybook example link, what needs
changing and what the student should see instead.

{Optional related handover, with verified links and its own scope.}
```

Adapt to the evidence, rather than filling every slot. Leave unavailable links
out of the copy and account for each requested missing link as a delivery gap.
Use a verification/limitations receipt when that is the useful technical home;
it does not replace the requested interactive preview.
For a source-only package, replace the Catalog explanation with a short map of
its packaged families and guides. Use `Examples to try` for fewer than three,
or `Three packaged examples to try` when the examples have no published URLs.
Ask source-only recipients for the Jira item and packaged example/module name.

Keep headings descriptive, use Slack lists rather than pipe tables, and use
verified clickable labels. Follow the service's composer mode and saved-link
readback rules. Keep hashes, commands and test counts in the technical record.
A preview, source handover, deployment and recipient acceptance are distinct
checkpoints; retain the delivery record's actual scope and limitations.
