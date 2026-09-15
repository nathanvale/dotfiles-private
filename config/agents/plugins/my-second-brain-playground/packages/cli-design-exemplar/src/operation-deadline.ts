export interface OperationDeadline {
	expired(): boolean
}

export type MonotonicNow = () => number

export function createOperationDeadline(milliseconds: number, now: MonotonicNow = () => performance.now()): OperationDeadline {
	const expiresAt = now() + milliseconds
	return { expired: () => now() >= expiresAt }
}
