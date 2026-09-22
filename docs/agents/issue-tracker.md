# Issue tracker: GitHub

Publish repository Specs and Tickets as GitHub Issues in
`nathanvale/dotfiles-private`. Use the `ghh` account wrapper for every
operation:

```sh
ghh exec --account nathanvale -- <gh arguments>
```

## Conventions

- **Create an issue**: `ghh exec --account nathanvale -- issue create -R nathanvale/dotfiles-private --title "..." --body-file <path>`.
- **Read an issue**: `ghh exec --account nathanvale -- issue view <number> -R nathanvale/dotfiles-private --comments`.
- **List issues**: `ghh exec --account nathanvale -- issue list -R nathanvale/dotfiles-private --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- **Comment on an issue**: `ghh exec --account nathanvale -- issue comment <number> -R nathanvale/dotfiles-private --body-file <path>`.
- **Apply or remove labels**: use `ghh exec --account nathanvale -- issue edit` with `--add-label` or `--remove-label`.
- **Close**: `ghh exec --account nathanvale -- issue close <number> -R nathanvale/dotfiles-private --comment "..."`.

Keep `-R nathanvale/dotfiles-private` explicit. Do not infer the target
from a neighboring checkout or similarly named repository.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues through
the corresponding `ghh` commands:

- **Read a PR**: use `ghh exec --account nathanvale -- pr view` and `pr diff` with the explicit repository.
- **List external PRs for triage**: use `ghh exec --account nathanvale -- pr list` and keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
- **Comment, label, or close**: use the corresponding `ghh exec --account nathanvale -- pr` command.

GitHub shares one number space across issues and PRs. Resolve a bare `#42`
through `ghh` as a PR first, then fall back to an issue lookup.

## When a skill says "publish to the issue tracker"

Create a GitHub issue through `ghh` in
`nathanvale/dotfiles-private`.

## When a skill says "fetch the relevant ticket"

Run this command:

```sh
ghh exec --account nathanvale -- issue view <number> -R nathanvale/dotfiles-private --comments
```

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. Create it through `ghh` with `--label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue through `ghh api`. Where sub-issues are unavailable, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving developer.
- **Blocking**: GitHub native issue dependencies are the canonical UI-visible representation. Add an edge through `ghh api --method POST` on `repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by`. Supply the blocker's numeric database ID from a `ghh api` issue lookup, rather than its issue number or node ID. GitHub reports open blockers in `issue_dependencies_summary.blocked_by`. Where dependencies are unavailable, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children through `ghh`, drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: use `ghh exec --account nathanvale -- issue edit <n> --add-assignee @me`; this is the session's first write.
- **Resolve**: comment and close through `ghh`, then append a context pointer and link to the map's Decisions-so-far.
