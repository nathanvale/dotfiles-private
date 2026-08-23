# Software Pattern Family

Entry contract, classification, and admission states live in
[`pattern-index.md`](pattern-index.md).

Gang of Four is one family within this file, not the boundary of it. The
catalog stays demand-led: admit an entry when live pressure or a qualification
fixture needs it, and judge an unlisted GoF name against its book definition
plus this family's shared rejection rules.

## Canonical Patterns (`admitted`)

### Strategy

- **Pressure**: Variants grow and each owns distinct behavior behind one call
  site.
- **Intent**: Define a family of interchangeable algorithms behind one
  interface.
- **Applicability**: A second variant exists now, not in prospect.
- **Participants and collaboration**: Context; strategy interface; concrete
  strategies selected by the context.
- **Consequences**: Variant behavior stays local; one more indirection for
  every reader.
- **Nearest alternative**: A `switch`, when variants are tiny, closed, stable,
  and mostly shared.
- **Source**: Gamma et al., Design Patterns (1994).
- **Corroboration**: `config/agents/claude/context/code-style.md` switch-versus-registry rule.
- **Owner status**: active. `last_verified`: 2026-08-20.

### Adapter

- **Pressure**: An existing interface does not match the one a caller needs.
- **Intent**: Convert one interface into another without editing either side.
- **Applicability**: Both interfaces are fixed and a real second implementation
  exists.
- **Participants and collaboration**: Target interface; adaptee; adapter
  translating between them.
- **Consequences**: Incompatible code composes; one more layer to trace.
- **Nearest alternative**: Editing the caller, when the interface is yours to
  change.
- **Source**: Gamma et al., Design Patterns (1994).
- **Owner status**: active. `last_verified`: 2026-08-20.

## Rejected Without Its Pressure

These names reach a rejected verdict when the named pressure is absent. The
pressure, not the shape, earns them.

- **Factory**: earned when construction itself varies across a seam. A
  function returning a value is a plain module.
- **Dependency Injection**: earned when a second adapter exists. One mocked
  seam is a hypothetical.
- **Registry or plugin system**: a registry is earned when variants may grow
  and each owns different behavior; a plugin system needs a real external
  extension boundary.

## Local Label Territory

When the GoF catalog would misname the pressure, return a Local Label that
describes the local structure accurately. It is a verdict, not an entry.
