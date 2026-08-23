# Setup Runtime Context

**Vault Git Host Enrollment**: Setup-owned domain that validates private SSH prerequisites, persists Activation Configuration, publishes an immutable Installed Runtime, and owns Runtime Selection and rollback.

**Installed Runtime**: One content-addressed compiled Vault Git executable under the XDG data root.

**Runtime Selection**: The managed selector symlink to exactly one Installed Runtime. It refuses active or uncertain Vault Git work.
