# Setup Runtime

- Keep one flat `setup` facade-backed CLI.
- Keep Vault Git Host Enrollment behind explicit `setup sync --domain vault-git`.
- Keep private input on stdin, never argv or public output.
- Keep runtime publication, selection, rollback, and Activation Configuration inside the Host Enrollment module.
- Preserve unrelated Setup domains as absent. They have no current owner in this package.
