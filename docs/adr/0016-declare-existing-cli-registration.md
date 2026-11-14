---
status: proposed
---

# Declare the existing CLI registration owner

## Context and Problem

Template spec revision 4 requires composition to extend one existing CLI and
preserve its invocation and behaviour. A foreign CLI can have any registration
mechanism. Automatic rewriting needs a bounded compatibility contract.

## Decision Drivers

- Preserve the original entry point and existing commands.
- Integrate automatically when compatibility is established.
- Refuse unsafe integration before host writes.

## Considered Options

| Option | Preserve behaviour | Automatic integration | Bounded writes |
| --- | --- | --- | --- |
| Rewrite arbitrary dispatch source | Cannot establish generally | Broad syntax support needed | Uncertain ownership |
| Refuse every existing CLI | Preserved | Does not meet the accepted requirement | No writes |
| Require a declared registration owner | Verify discovery and original invocation | Supported declaration only | Scoped registration and source delta |

## Decision

Recommend the declared owner. The template records `registrationVersion: 1`,
`entryPoint` and `commandOwner` in `.cli-design-template.json`. The composer
extends the typed `commands` array used by that entry point. Unsupported CLIs
use the existing maintenance route. Nathan owns acceptance of this ADR.

## Consequences

- Positive: one registry supplies dispatch, help and discovery.
- Negative: an arbitrary existing CLI requires a reviewed maintenance step.
- Neutral: command grammar and domain folder choices remain with each repo.

## Confirmation

The composer process tests preserve commands through a nondefault entry point,
reject overlapping routes, and compare every host file after refusal. Revisit
this declaration when a real consumer cannot express its registration through it.

## References

- [Composer source](../../config/agents/plugins/my-second-brain-playground/packages/cli-design-compose/src/repository-cli.ts)
- [Accepted template spec revision 4](https://github.com/myagentdojo/my-second-brain-playground/blob/d23249717dec789da2b31ffaf7f9546f0b58a33b/projects/cli-design-skill/specs/template-skill-hardening.md)
