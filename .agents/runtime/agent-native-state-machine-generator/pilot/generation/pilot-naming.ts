/**
 * The pilot's derived symbol names, held once.
 *
 * The generator derives these prefixes from the product name
 * `vault-git-reimagined`; the pilot restates them because the derivation
 * helpers are generator internals behind the package front door. The emission
 * test proves the generated catalog exports the symbols these prefixes
 * predict, so agreement is checked rather than trusted.
 */
export const PILOT_PRODUCT = 'vault-git-reimagined'

/** camel form, e.g. `vaultGitReimaginedBranchStationCatalog`. */
export const PILOT_SYMBOL_PREFIX = 'vaultGitReimagined'

/** pascal form, e.g. `VaultGitReimaginedStationId`. */
export const PILOT_TYPE_PREFIX = 'VaultGitReimagined'

/** screaming form, e.g. `VAULT_GIT_REIMAGINED_STATION_IDS`. */
export const PILOT_CONSTANT_PREFIX = 'VAULT_GIT_REIMAGINED'
