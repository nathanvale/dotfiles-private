# List workspace members explicitly, one path per package

Bun resolves `workspace:*` and `catalog:` only for packages the root
`package.json` registers as members. Sixteen skills and two runtime packages
already wrote those protocols, but the root carried no `workspaces` field, so
none of them resolved. `bun install` inside such a package failed outright.

**Decision.** The root lists every member as a literal path. It does not use a
glob for anything under `.agents/`.

Bun's workspace glob expansion skips dot-directories, so `.agents/runtime/*`
matches nothing. It does not error; it registers zero packages and reports a
successful install. Membership silently evaporates, which is the same failure
this ADR exists to prevent. `apps/vscode/*` keeps its glob because that path
has no leading dot and expansion works there.

The root also defines a `catalog` for `@types/bun` and `typescript`, because
`catalog:` is what the member manifests already ask for.

## Consequences

Adding a package under `.agents/` requires editing the root `package.json`. A
new package that is not listed still installs cleanly and still fails to
resolve its siblings, so the omission surfaces late, at import time.

The former personal browser automation workspace was later registered after
its missing dependencies were repaired. It is now retired in favour of the
reviewed `steipete/agent-scripts` `browser-use` skill, so `browser-connect`,
Warm Chrome, the authentication and security packages, the transport adapter,
and the personal skill no longer participate in this workspace.

## Evidence

Found 2026-08-20. `bun install` in `.agents/skills/worktree` reported
`Workspace dependency "@side-quest/cli-command-facade" not found`, plus
`catalog:` resolution failures. The skill's own `SKILL.md` already stated the
facade was "Registered in root `package.json` workspaces"; it was not.

Resolution worked through hand-made symlinks in each skill's `node_modules`,
which are gitignored. A fresh clone had nothing. `ci-testbed/SKILL.md` records
the resulting confusion: a bare worktree reads as a phantom regression because
workspace imports fail there.

Probed on a copy before applying. A `.agents/runtime/*` glob installed cleanly
and registered only `apps/vscode/nathan-adhd-helper`, the dot-directory
finding above. With literal paths, 24 members registered, `bun run validate`
passed, and imports resolved from `worktree`, `session-recovery`,
`agent-worktree`, and `warm-chrome`.

`agent-worktree` and `warm-chrome` changed from `file:../cli-command-facade` to
`workspace:*`. Under `file:`, Bun wrote a duplicate resolution on each install
and `--frozen-lockfile` failed until the lockfile converged after three runs.
That flag is the fresh-worktree bootstrap contract in `worktree/SKILL.md`.
