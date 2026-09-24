# Connectors Coding Standards

Extend the [shared coding standards](../../../../docs/agents/coding-standards.md).
The owning Spec and Tickets define acceptance; this file defines how Connectors
code and tests prove their claims.

## Command contract

- Keep command identities, routes, causes, exit meanings, and result
  correlations in one typed contract owner. When a command or outcome station
  changes, update its implementation, catalogue, discovery and help, and public
  process test together.
- Resolve required input and configuration before acquiring dependency,
  credential, or Provider capability. Prove missing and malformed input refuses
  without starting a child or changing state.
- Check discovery against both test-owned expected identities and the declared
  station catalogue. Catalogue agreement proves consistency; the literals
  prove the accepted command set. Reach each required new station in a test and
  refuse an observed station absent from the catalogue.

## CLI proof

- Prove public CLI behavior by spawning the packaged `bin/connectors` executable
  with controlled `HOME`, `PATH`, stdin, and plugin state. Assert its JSON
  envelope, exit code, streams, and resulting files or absence of effects.
  A private-module test supports diagnosis, not a claim about the executable.
- On ordinary machine-mode completion, assert one validated JSON envelope on
  stdout and empty stderr. Test refusal output with a secret-shaped sentinel;
  it must not echo that input. Treat crash and pre-drain EPIPE as the declared
  no-envelope exceptions, never as permission to print a replacement envelope.
- Apply the shared independent-oracle, cardinality, and RED/GREEN rules to
  command identities, cause/exit pairs, allowed tools, and effect inventories.
  Pin expectations from the accepted contract, never from the production
  catalogue or manifest. Useful negative controls include accepting an unknown
  command, selecting a global MCPorter, and leaking a sentinel.
- Keep fixture, process, installed, authenticated, and live-effect claims tied
  to the boundary actually observed. A fake's success response does not prove
  installation, hosted behavior, or an external write.
