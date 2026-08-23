import {
	BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_SCHEMA_VERSION,
} from "./command-contract";

import { AsyncLocalStorage } from "node:async_hooks";

const SHA256 = /^[a-f0-9]{64}$/;

export type SealedQualificationRuntimeEvidence = {
	contract: typeof BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_CONTRACT_ID;
	schema_version: typeof BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_SCHEMA_VERSION;
	expected_manifest_digest: string;
	observed_manifest_digest: string;
	sealed_artifact_sha256: string;
};

type AdmittedSealedRuntimeContext = {
	evidence: SealedQualificationRuntimeEvidence;
	manifest: Readonly<Record<string, unknown>>;
};

const admittedSealedRuntimeContext =
	new AsyncLocalStorage<AdmittedSealedRuntimeContext>();

/** Establish sealed identity for exactly one admitted child invocation. */
export async function withSealedQualificationRuntimeEvidence<T>(
	evidence: SealedQualificationRuntimeEvidence,
	manifest: Readonly<Record<string, unknown>>,
	run: () => Promise<T>,
): Promise<T> {
	return await admittedSealedRuntimeContext.run({ evidence, manifest }, run);
}

export function sealedQualificationRuntimeEvidence(
	_env: NodeJS.ProcessEnv = process.env,
): SealedQualificationRuntimeEvidence | undefined {
	const evidence = admittedSealedRuntimeContext.getStore()?.evidence;
	return evidence &&
		SHA256.test(evidence.expected_manifest_digest) &&
		SHA256.test(evidence.observed_manifest_digest) &&
		SHA256.test(evidence.sealed_artifact_sha256)
		? evidence
		: undefined;
}

export function sealedQualificationRuntimeManifest():
	| Readonly<Record<string, unknown>>
	| undefined {
	return admittedSealedRuntimeContext.getStore()?.manifest;
}
