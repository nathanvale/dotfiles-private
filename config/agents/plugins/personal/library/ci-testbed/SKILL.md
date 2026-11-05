---
name: ci-testbed
description: "Compatibility entry for the earlier Bun CI testbed. Use ci-reproduce for CI diagnosis."
role: bridge
---

# CI testbed compatibility entry

## Next safe actions

Read [ci-reproduce](../ci-reproduce/SKILL.md) and continue there, including when
invoked without arguments. It owns the generic diagnosis workflow.

This name remains because both native manifests and existing skill selections
expose it. Retire the bridge after those references and user invocations migrate.
The retained Bun-only helper is historical, not the default execution route;
it assumes a base branch and force-removes its checkout. Use the repository's
current commands and cleanup owner through ci-reproduce instead.
