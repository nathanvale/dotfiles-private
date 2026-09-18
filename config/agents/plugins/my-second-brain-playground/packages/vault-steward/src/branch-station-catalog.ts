import { type StationId, type StationRow, STATIONS } from "./command-contract.ts"

// Derivation and lookup over STATIONS. Identity is the JSON tuple [commandIdentity, outcome, causeCode] derived from an
// observed envelope; declarations come from the contract owner, never from a second hand-maintained list.

export interface ObservedTuple {
	commandIdentity: string
	outcome: string
	causeCode: string
}

export function stationIdOf(envelope: ObservedTuple): string {
	return JSON.stringify([envelope.commandIdentity, envelope.outcome, envelope.causeCode])
}

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

// The station a command reaches for one product reason in one transaction state; undefined means the catalogue does
// not declare it, which the writer reports as INTERNAL_UNEXPECTED with the reason named in the message.
export function stationForReason(commandIdentity: string, productCause: string, transactionState: string): StationRow | undefined {
	return STATIONS.find((row) => row.commandIdentity === commandIdentity && row.transactionState === transactionState && row.reasons.includes(productCause))
}
