/**
 * Generation lane for the pilot's Generated Artifact Set.
 *
 * Two verbs, both through the package front door and the pilot emitter
 * registry:
 *
 *   bun pilot/generate.ts generate   - write the complete set into pilot/generated
 *   bun pilot/generate.ts verify     - read-only drift check against regeneration
 *
 * Generation and green checks never constitute Specification Admission; the
 * pilot candidate stays an unadmitted draft until the product owner admits it.
 */
import { join } from 'node:path'
import {
	compileSpecificationCandidate,
	generateArtifactSet,
	verifyArtifactSet,
} from '../src/index.ts'
import { PILOT_EMITTERS } from './generation/pilot-derivation.ts'

const PILOT_DIR = import.meta.dir
const CANDIDATE_PATH = join(
	PILOT_DIR,
	'vault-git-reimagined.state-machine.jsonc',
)
const OUTPUT_DIR = join(PILOT_DIR, 'generated')

async function main(verb: string | undefined): Promise<number> {
	if (verb !== 'generate' && verb !== 'verify') {
		console.error('usage: bun pilot/generate.ts <generate|verify>')
		return 2
	}

	const source = await Bun.file(CANDIDATE_PATH).text()
	const compiled = compileSpecificationCandidate(source, {
		sourcePath: 'pilot/vault-git-reimagined.state-machine.jsonc',
	})
	if (!compiled.ok) {
		console.error('the pilot candidate does not compile:')
		for (const diagnostic of compiled.diagnostics) {
			console.error(
				`  ${diagnostic.cause} at ${diagnostic.path}: ${diagnostic.message}`,
			)
		}
		return 1
	}

	const options = { outputDir: OUTPUT_DIR, emitters: PILOT_EMITTERS }

	if (verb === 'generate') {
		const generated = await generateArtifactSet(
			compiled.ir,
			compiled.digest,
			options,
		)
		if (!generated.ok) {
			console.error(`generation failed: ${generated.cause}`)
			console.error(`  ${generated.message}`)
			for (const refusal of generated.refusals) {
				console.error(
					`  ${refusal.cause} (${refusal.subject}): ${refusal.message}`,
				)
			}
			return 1
		}
		console.log(
			`generated ${generated.declaredOutputs.length} declared outputs for specification digest ${generated.specificationDigest}:`,
		)
		for (const path of generated.declaredOutputs) {
			console.log(`  ${path}`)
		}
		return 0
	}

	const verified = await verifyArtifactSet(
		compiled.ir,
		compiled.digest,
		options,
	)
	if (!verified.ok) {
		console.error(`drift verification refused the set: ${verified.cause}`)
		for (const finding of verified.findings) {
			console.error(
				`  ${finding.cause}${finding.subject === '' ? '' : ` (${finding.subject})`}: ${finding.message}`,
			)
		}
		return 1
	}
	console.log(
		`verification clean: ${verified.declaredOutputs.length} declared outputs match their isolated regeneration`,
	)
	return 0
}

process.exit(await main(Bun.argv[2]))
