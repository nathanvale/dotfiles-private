import { inspectVaultGitDurableWorkState } from "@side-quest/vault-git-transaction-manager";

/** Fail-closed classification of Vault Git durable work evidence. */
export type VaultGitWorkState = "clear" | "active" | "uncertain";

/**
 * Classify Vault Git durable state under one XDG state root.
 *
 * Returns `clear` only for proven terminal-or-absent evidence, `active` for a
 * proven open receipt or nonterminal Completion or Doctor Task, and
 * `uncertain` for every missing, malformed, unsafe, or unknown evidence shape.
 */
export async function inspectVaultGitWorkState(
	stateRoot: string,
): Promise<VaultGitWorkState> {
	return inspectVaultGitDurableWorkState(stateRoot);
}
