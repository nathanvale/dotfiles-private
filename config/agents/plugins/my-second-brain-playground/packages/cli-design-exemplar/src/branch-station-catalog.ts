import { type CauseCode, STATIONS, type StationId, type StationRow } from "./command-contract.ts"
import type { FallbackCase } from "./model.ts"

// Derivation and lookup over STATIONS (CDS-PE-4). No hand-maintained list: identity is derived from the
// observed envelope's commandIdentity, outcome and causeCode; declarations come from the contract owner.

export interface ObservedTuple {
	commandIdentity: string
	outcome: string
	causeCode: string | null
}

export function stationIdOf(envelope: ObservedTuple): string {
	return `${envelope.commandIdentity}|${envelope.outcome}|${envelope.causeCode ?? "null"}`
}

export function stationIdOfRow(row: StationRow): StationId {
	return `${row.commandIdentity}|${row.outcome}|${row.causeCode ?? "null"}`
}

const BY_ID: ReadonlyMap<string, readonly StationRow[]> = (() => {
	const map = new Map<string, StationRow[]>()
	for (const row of STATIONS) {
		const id = stationIdOfRow(row)
		const rows = map.get(id)
		if (rows) rows.push(row)
		else map.set(id, [row])
	}
	return map
})()

export const STATION_IDS: readonly string[] = [...BY_ID.keys()]

// Every declaration for a tuple; the catalogue test rejects a tuple whose declarations disagree on signature.
export function declaredStation(id: string): readonly StationRow[] {
	return BY_ID.get(id) ?? []
}

function assertNever(value: never): never {
	throw new Error(`unreachable: ${String(value)}`)
}

// The accepted D6-c mapping (PE revision 3): presented outcome and trusted transaction state select the cause.
export function fallbackCause(fallbackCase: FallbackCase): CauseCode {
	switch (fallbackCase) {
		case "preparation":
			return "INTERNAL_PREPARATION"
		case "result-unchanged":
			return "INTERNAL_RESULT_UNCHANGED"
		case "result-completed":
			return "INTERNAL_RESULT_COMPLETED"
		case "result-unknown":
			return "INTERNAL_RESULT_UNKNOWN"
		case "unknown-unresolved":
			return "INTERNAL_RESULT_UNKNOWN"
		default:
			return assertNever(fallbackCase)
	}
}
