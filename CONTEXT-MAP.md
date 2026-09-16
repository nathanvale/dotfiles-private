# Context Map

## Contexts

- [Agent Configuration](./CONTEXT.md): owns the language for personal agent
  instructions, Harness discovery, skill addresses, and tracked configuration.
- [My Second Brain Playground](./config/agents/plugins/my-second-brain-playground/CONTEXT.md):
  owns the language for the executable plugin product, workflow graphs, cast,
  recovery, and proof-backed vertical slices.

## Relationships

- **Agent Configuration to My Second Brain Playground**: Agent Configuration
  makes the plugin discoverable to each Harness; the plugin owns its packaged
  behavior and product vocabulary.
- **My Second Brain Playground to external owners**: the plugin integrates with
  the Vault, GitHub Issues, Beads, Herdr, Git, and the Board without absorbing
  their records or lifecycle authority.
