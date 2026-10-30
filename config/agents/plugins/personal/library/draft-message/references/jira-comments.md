# Jira comments

Use for progress, open questions, design feedback and handover comments on an
existing issue. Derive the structure from the GR09 Storybook comments: a brief
reader-facing outcome, relevant examples, criterion coverage, decisions and an
owner's next action. Resolve current facts from the issue and discussion.

## Prepare and verify

1. Read the issue, acceptance criteria and existing comments. Reuse answered
   decisions and identify the new contribution. Check for an equivalent comment
   before posting; after an uncertain write, reconcile its outcome before retrying.
2. Choose the shape below and use only useful sections. Apply
   [professional voice](comms-style.md), including collective project wording.
   Keep the update on this issue; link related tickets or focused comments
   rather than repeating their full discussions.
3. Apply [preview-link verification](message-types.md#verify-preview-links).
   Explain Storybook as an online gallery of screens and interactive examples
   when the audience needs it. Distinguish a Storybook build from an extension
   package or release. Keep missing previews explicit.
4. Resolve Jira mentions using the intended person's verified Jira identity.
   Use the supported service workflow's native mention representation; a typed
   @name or Slack ID does not establish a Jira mention. If identity is uncertain,
   name the required role outside ready-to-post copy.
5. Follow the selected Jira workflow's current formatting contract. In the web
   editor, use its link, heading, list and table controls and inspect the rendered
   result. For connector writes, use the supported rich-text format, such as ADF
   when required. Convert the shapes below rather than pasting Slack markup or
   assuming Markdown pipe tables render. Tables suit parallel criterion/status
   rows; numbered lists suit questions.
6. Check every claim against the source. Preserve provisional, held, checked,
   released and accepted distinctions. Include only observed criterion coverage;
   frontend examples do not establish backend behaviour or acceptance. Keep
   technical logs in the evidence owner unless this reader needs them.
7. Present an unsent draft unless posting or editing is authorised. Follow the
   service workflow for the write, then read back the saved comment, link targets,
   mentions and formatting. Retain its focused-comment receipt with the existing
   project record. Editing a comment does not authorise changing issue status.

## Progress or Storybook review update

```text
{Short subject identifying the checkpoint}

Hi {verified mentions}, we've {visible outcome}. {What is ready to review.}

Review examples
{Specific story links and relevant issue/criterion references.}

Coverage and limits
{Criteria demonstrated; provisional assumptions; held or unrepresented scope.}

Next step
{One concrete action, owner and supported timing.}
```

Include an exact build identity in linked evidence when needed for reproducibility.
Keep exhaustive story inventories and build logs there instead of making every
comment a delivery report.

## Open decisions or clarification

```text
Hi {verified decision-owner mentions}, we found these ambiguities while
comparing {issue/specification/design} during the {checkpoint}.
Some may already be resolved elsewhere; links to those decisions would help.

1. {Question, affected criterion and supported alternatives.}
   {Relevant verified story/design link, or missing-example note.}
2. {Another distinct question when needed.}

Could you confirm {specific decision} on this issue?
```

Keep earlier unanswered questions visible and distinguish tentative replies from
confirmed answers. An open issue alone does not prove its questions remain open.

## Design feedback

Use the [design-feedback template](design-feedback.md), adapting its links,
mentions and sections through the Jira checks above. Address the designer, lead
with the visible change and ask concrete questions. Include labelled screenshots
only when supplied and relevant to the current revision.

## Delivery or integration handover

Use the [extension-handover template](extension-handover.md), adapting its
presentation through the Jira checks above. Preserve its delivery-workflow owner
and verification requirements. Link verified package, guide and preview receipts;
state the actual scope and integration owner's next step. A comment is not proof
of release, recipient acceptance or issue completion.
