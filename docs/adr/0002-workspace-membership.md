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

Two packages are deliberately excluded, both blocked by the same missing
dependency. `@side-quest/browser-connect` declares
`@side-quest/cli-test-fixtures` at `file:../cli-test-fixtures`, a package with
no directory and no history in this repository. The `browser-use` skill depends
on `browser-connect`, and additionally pins its local siblings by bare version
(`"0.1.0"`) rather than `workspace:*`, which sends Bun to npm for private
packages that are not published. Either package as a member fails the whole
install, so both stay out until the fixtures package is restored or the
dependency is removed.

The three `adapter-install` manifests under `browser-connect` stay out by
design. Each is a source-controlled install manifest with its own
`package-lock.json`, read by an isolated installer that requires the full
dependency-graph integrity that lockfile carries. Workspace hoisting would
defeat their purpose. The literal-path rule keeps them out for free; a
`.agents/runtime/*` glob would not have reached them either, but only by
accident.

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
