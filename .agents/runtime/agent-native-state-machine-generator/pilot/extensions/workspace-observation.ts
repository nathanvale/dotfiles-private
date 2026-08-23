/**
 * Handwritten Extension: the pilot's workspace Fact Provider.
 *
 * Obtains the one Observed Fact the candidate declares
 * (states.workspace_observability): whether the workspace root carries a
 * .git entry. It reports the observation and nothing else; selecting state,
 * Authority, retry posture, or continuation belongs to the generated
 * Projection Composer.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface VaultWorkspaceObservation {
	/** True when the workspace root contains a .git entry (file or directory). */
	readonly workspaceObservable: boolean
}

export function observeVaultWorkspace(root: string): VaultWorkspaceObservation {
	return { workspaceObservable: existsSync(join(root, '.git')) }
}
