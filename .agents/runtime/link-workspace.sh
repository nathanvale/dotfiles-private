#!/usr/bin/env bash
# Recreate the @side-quest workspace links that let vendored skills resolve
# their runtime packages. node_modules is gitignored, so a fresh clone has
# none of these; run this after cloning or after `bun install`.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
skills="$here/../skills"
personal="$here/../../config/agents/skills/personal"

link_skill() { # <skill> <pkg>
  mkdir -p "$skills/$1/node_modules/@side-quest"
  ln -sfn "../../../../runtime/$2" "$skills/$1/node_modules/@side-quest/$2"
}
link_personal() { # <skill> <pkg>
  mkdir -p "$personal/$1/node_modules/@side-quest"
  ln -sfn "../../../../../../../.agents/runtime/$2" "$personal/$1/node_modules/@side-quest/$2"
}
link_runtime() { # <pkg> <dep>
  mkdir -p "$here/$1/node_modules/@side-quest"
  ln -sfn "../../../$2" "$here/$1/node_modules/@side-quest/$2"
}

for s in classic-cinema cli-author test-runner worktree; do
  link_personal "$s" cli-command-facade
done
link_personal session-recovery session-corpus

link_runtime agent-worktree cli-command-facade

# cli-command-facade owns the only external dependency (@logtape/logtape).
(cd -- "$here/cli-command-facade" >/dev/null 2>&1 && bun install --silent)

echo "workspace links rebuilt"
