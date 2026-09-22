# Context Map

## Contexts

- [Agent Configuration](./CONTEXT.md): owns the language for personal agent
  instructions, Harness discovery, skill addresses, and tracked configuration.
- [My Second Brain Playground](./config/agents/plugins/my-second-brain-playground/CONTEXT.md):
  owns the language for the executable plugin product, workflow graphs, cast,
  recovery, and proof-backed vertical slices.
- [Connectors](./config/agents/plugins/connectors/CONTEXT.md): owns the language
  for external-service operations, Route Selection, provider compatibility
  evidence, and guarded write outcomes.

## Relationships

- **Agent Configuration to My Second Brain Playground**: Agent Configuration
  makes the plugin discoverable to each Harness; the plugin owns its packaged
  behavior and product vocabulary.
- **My Second Brain Playground to external owners**: the plugin integrates with
  the Vault, GitHub Issues, Beads, Herdr, Git, and the Board without absorbing
  their records or lifecycle authority.
- **Agent Configuration to Connectors**: Agent Configuration makes the plugin
  discoverable to each Harness; Connectors owns its agent-facing vocabulary.
- **Connectors to external providers**: Connectors selects routes, records
  compatibility evidence, and guards write outcomes; each provider owns its
  live data, authorization, and tool surface.
- **Connectors to credential custody**: credential custody owns secret values;
  Connectors passes only non-secret Route Selection and requests scoped
  credentials inside the selected provider process.
