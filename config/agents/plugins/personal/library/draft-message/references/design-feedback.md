# Design feedback

Use for an update addressed to a named designer in a design/dev conversation.
Start from the designer's actual feedback and the current visible result.

1. Address the verified recipient by their native mention. State the visible
   change in a friendly opening using the project's collective voice.
2. Pair the exact example link with the ticket or focused comment. Keep useful
   labelled screenshots and identify relevant desktop, mobile or error states.
3. Separate what changed from what needs a design decision. Ask concrete
   questions about the observed layout, content or behaviour. Preserve supported
   alternatives, such as two spacing values; supply no guessed design policy.
4. Ask for the current frame if its identity or access is missing. Include
   practical remaining issues and a preview/package distinction only when the
   recipient needs them. Keep review logs and implementation internals in Jira.

## Draft shape

```text
Hi {verified designer mention}, we've updated {visible examples or change}.

{Short description of what the reviewer will see and the states checked.}
[Try {specific example}](url) | [{Jira key}: details and screenshots](url)

Could you take a look and confirm:
- {Design choice, including supported alternatives where useful.}
- {Another distinct decision, if needed.}

{Useful screenshot captions, current-frame request or material limitation.}
{One clear next step.}

cc: {verified affected stakeholder mentions, when needed}
```

The named designer example supplies a structure, not a fixed recipient,
component, viewport, spacing value, ticket or approval claim. Resolve each from
the current request and evidence.
