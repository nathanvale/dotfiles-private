---
title: "Removing every non-personal marketplace"
labels: [wayfinder:grilling]
parent: skill-corpus-addressing
blocked_by: [01-true-listing-measurement]  # dependency clauses cleared by 06 and 07
status: open
---

## Question

Nathan ruled: remove all marketplaces; only personal ones such as
my-second-brain are ever allowed. What exactly does that mean operationally, and
what is lost?

Currently 4 marketplaces are registered and 5 plugins enabled:
`frontend-design`, `bitbucket-pr`, `codex`, `compound-engineering`,
`harness-native-plugin-prototype`.

Decide:
- Which of the 5 enabled plugins carry capability Nathan actually relies on, and
  what replaces each — `codex` backs the `/codex:*` route and
  `compound-engineering` backs the `ce-*` skills referenced throughout the
  global rules.
- Whether "remove the marketplace" means unregistering it, disabling its
  plugins, or purging the cache, and what each does to the listing cost.
- Whether the global rules in `dotfiles/config/agents/claude/rules/` need
  rewriting where they route to plugin-provided skills.

`git-workflow.md` names `compound-engineering:ce-code-review` as the gate for
complex commits on main-direct repos, so turning that plugin off changes an
accepted working practice.
