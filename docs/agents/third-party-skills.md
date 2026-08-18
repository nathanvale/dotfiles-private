# Third-Party Skills

- Install and update with `npx skills`. Read `--help` for command syntax.
- Upstreams: `openclaw/gogcli`, `mattpocock/skills`, `vercel-labs/skills`.

## Always scope the agent

- Pass `-a claude-code,codex` on every `add`.
- Without it the CLI installs to every agent it detects, including any whose
  config directory merely exists. On 2026-08-19 an unscoped install wrote 69
  symlinks into `config/crush`, `config/devin`, and `config/goose` inside this
  repository, because `~/.config/` holds those three directories.
- Scoped installs create no stray directories. Verified the same day.

## Lock file

- Address: `~/.agents/.skill-lock.json`, a Tracking Link into
  `config/agents/skills/`.
- Break that link and every entry reports `Source: local`. Provenance is lost
  and `npx skills update` has nothing to act on.
- Symptom seen 2026-08-18: 164 entries local, 0 upstream. Restoring the link
  returned 43 entries to their upstreams.
- The link accepts writes, not only reads. `add` and `remove` on 2026-08-19
  changed the lock from 49 entries to 72 to 66; each write landed in the
  dotfiles working tree and the link survived.
- Keep the lock describing the machine. A skill renamed upstream leaves a dead
  entry that a restore would try to install. Six such entries were pruned on
  2026-08-19.

## No commit pinning

- The lock records `source`, `sourceType`, `skillPath`, and a post-install
  content hash. No commit ref.
- `add` accepts a branch or tag through a `#fragment`. A full commit SHA fails.
- `experimental_install` never reads the stored hash. It clones current branch
  HEAD, then overwrites the hash with whatever it fetched.
- Restore therefore reproduces HEAD, not the reviewed commit.

## Review after update

- Read the diff after `npx skills update`. That is the whole practice.
- Skills run with full agent permissions. A prompt injection reaches the agent
  before it reaches you.
- Snyk's ToxicSkills audit, 5 February 2026: 13.4 percent of 3,984 marketplace
  skills carried a critical issue, and 91 percent of confirmed-malicious skills
  paired prompt injection with the payload to defeat a skim. The curated
  skills.sh top 100 scored zero. Named repositories with identifiable
  maintainers sit closer to the curated set.
- Free checks, all clean on 2026-08-18: threat actors `zaycv`, `Aslaep123`,
  `pepe276`, `moonshine-100rze`, `aztr0nutzs`; `curl` piped to a shell;
  password-protected archive installs; `ignore previous instructions`
  phrasings; `SOUL.md` and `MEMORY.md` tampering.
- `uvx snyk-agent-scan` now requires a Snyk account. The scanner named in that
  audit is no longer free.
