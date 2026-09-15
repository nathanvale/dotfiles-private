import { STATIONS, type StationId, type StationRow } from "./command-contract.ts"

// Derivation and lookup over STATIONS (CDS-PE-4). No hand-maintained list: identity is derived from the
// observed envelope's commandIdentity, outcome and causeCode; declarations come from the contract owner.

export interface ObservedTuple {
	commandIdentity: string
	outcome: string
	causeCode: string
}

export function stationIdOf(envelope: ObservedTuple): string {
	return JSON.stringify([envelope.commandIdentity, envelope.outcome, envelope.causeCode])
}

// Only a declared row produces a finite StationId; the encoding is the same JSON tuple as stationIdOf.
export function stationIdOfRow(row: StationRow): StationId {
	return JSON.stringify([row.commandIdentity, row.outcome, row.causeCode]) as StationId
}

const BY_ID: ReadonlyMap<string, StationRow> = (() => {
	const map = new Map<string, StationRow>()
	for (const row of STATIONS) {
		const id = stationIdOfRow(row)
		if (map.has(id)) throw new Error(`duplicate station declaration: ${id}`)
		map.set(id, row)
	}
	return map
})()

export const STATION_IDS: readonly string[] = [...BY_ID.keys()]

// Every declaration for a tuple; the catalogue test rejects a tuple whose declarations disagree on signature.
export function declaredStation(id: string): readonly StationRow[] {
	const row = BY_ID.get(id)
	return row === undefined ? [] : [row]
}
