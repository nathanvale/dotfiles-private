import type { StationId, StationRow } from "./command-contract.ts"

// Only a declared row produces a finite StationId: the JSON tuple of its commandIdentity, outcome and causeCode.
export function stationIdOfRow(row: StationRow): StationId {
	return JSON.stringify([row.commandIdentity, row.outcome, row.causeCode]) as StationId
}
