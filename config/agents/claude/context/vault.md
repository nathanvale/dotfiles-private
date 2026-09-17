# Durable Knowledge Vault

Status: active

Vault root: `/Users/nathanvale/code/my-second-brain-playground`

Read fallback: `/Users/nathanvale/code/my-second-brain-vault-spike`

## Lookup and fallback

1. Search the canonical playground by subject, aliases, and relevant family.
2. If needed information is missing, search the spike for that information.
3. Identify fallback evidence with its source path; follow successor links.
4. Prefer the canonical note for current ownership. Surface conflicting facts
   rather than silently overwriting either source or assuming newer is correct.
5. If the playground is unavailable, report that limitation and allow spike
   reads. Pause writes until the canonical root is available.

Write new notes and updates only in the playground. When an authorized update
concerns a spike-only note, preserve useful content and provenance in the matching
playground family after checking for an existing owner. Leave the spike source
intact unless an explicit migration authorizes a forwarding note. Avoid bulk
copying or automatic synchronization.

## Entry

1. Read the vault root `AGENTS.md`.
2. Read the vault root `README.md`.
3. Read the destination family `README.md` before writing.
4. Update the canonical existing note before creating another one.

## Ownership

The vault owns Nathan's plans, research, synthesis, project memory, status,
personal reasoning, handoffs, durable lessons, and cross-repository context.

Before creating or relocating an artifact, follow
`$HOME/code/dotfiles/docs/agents/work-placement.md`. Keep vault project packets
in the vault when their executable implementation moves to a code repository.

## Write Authority

- An explicit foreground request may create or update a scoped vault note after
  reading the vault rules.
- A delegated, background, or ambiguous request proposes the target and change
  unless its handoff explicitly grants vault-write authority.
- Preview bulk, structural, destructive, privacy-sensitive, public, or
  cross-corpus changes.

## Migration Boundary

Nathan designated the playground canonical on 2026-09-09. The spike remains
historical read fallback. This routing change does not migrate the whole corpus,
activate search indexing, or transfer Agent Ledger and runtime ownership.
