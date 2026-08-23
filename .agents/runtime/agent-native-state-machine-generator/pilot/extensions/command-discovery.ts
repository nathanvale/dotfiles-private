/**
 * Handwritten Extension: the pilot's command discovery projection.
 *
 * Lives beside, never inside, the Generated Artifact Root: files inside that
 * root are generator-owned and replaced as one unit. The generated Branch
 * Station Catalog imports this function to judge its stations against live
 * discovery. It projects the generated Command Surface Contract record
 * through the facade unchanged; it adds, ranks, and reinterprets nothing.
 */
import { projectCommandDiscoveryTree } from '@side-quest/cli-command-facade'
import { vaultGitReimaginedCommandContracts } from '../generated/src/command-surface-contract.ts'

export type VaultGitReimaginedCommand =
	keyof typeof vaultGitReimaginedCommandContracts

const contractEntries = (
	Object.keys(vaultGitReimaginedCommandContracts) as VaultGitReimaginedCommand[]
)
	.sort()
	.map(
		(command) =>
			[command, vaultGitReimaginedCommandContracts[command]] as const,
	)

export function projectVaultGitReimaginedCommandDiscoveryTree() {
	return projectCommandDiscoveryTree(contractEntries)
}
