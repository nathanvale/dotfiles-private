# Third-Party Skills

- Install and update with `npx skills`. Read `--help` for command syntax.
- Upstreams: `openclaw/gogcli`, `mattpocock/skills`, `vercel-labs/skills`.
- Pass `-a claude-code,codex` on every `add`. Unscoped, the CLI installs to
  every agent whose config directory exists, including ones you do not use, and
  writes those directories into this repository.

## Lock file

- Address: `~/.agents/.skill-lock.json`, a Tracking Link into
  `config/agents/skills/`. It accepts reads and writes.
- Break the link and every entry reports `Source: local`. Provenance is lost and
  `npx skills update` has nothing to act on. Restore the link to recover it.
- Keep the lock describing the machine. A skill renamed upstream leaves a dead
  entry that restore will try to install.
- `experimental_install` restores every entry. Proven 2026-08-19 in a scratch
  `HOME`: 66 of 66, none missing.

## No commit pinning

- The lock records `source`, `sourceType`, `skillPath`, and a post-install
  content hash. No commit ref.
- `add` accepts a branch or tag through a `#fragment`. A full commit SHA fails.
- `experimental_install` never reads the stored hash. It clones current branch
  HEAD, then overwrites the hash with what it fetched.
- Restore reproduces HEAD, not the reviewed commit. Read the diff after
  `npx skills update`. That is the whole practice.

## Why the diff matters

- Skills run with full agent permissions. A prompt injection reaches the agent
  before it reaches you, and 91 percent of confirmed-malicious skills pair
  injection with the payload to defeat a skim.
- Evidence, scoping, and the checks that ran clean:
  `my-second-brain-vault-spike/projects/user-scope-config-consolidation/reference/skills-supply-chain.md`.
