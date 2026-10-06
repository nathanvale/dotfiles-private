// Test-only preload: redirects the array-form Bun.spawn of the pinned system chooser (/usr/bin/osascript) to the
// test-owned stand-in named by SOURCE_INTAKE_TEST_CHOOSER, so no dialog ever opens during tests. The production bin
// wrapper loads no preload. It fails closed: any other spawn naming an osascript (the object form, Bun.spawnSync, or
// a non-pinned path) throws instead of running, and a missing variable fails the run before any spawn.
import { basename } from "node:path"

const SYSTEM_CHOOSER = "/usr/bin/osascript"
const standIn = process.env.SOURCE_INTAKE_TEST_CHOOSER
if (standIn === undefined) throw new Error("chooser-redirect preload needs SOURCE_INTAKE_TEST_CHOOSER")

/** The command words of either spawn form: an array first argument, or an options object with cmd. */
function commandOf(first: unknown): readonly unknown[] {
	if (Array.isArray(first)) return first
	const cmd = (first as { cmd?: unknown } | null)?.cmd
	return Array.isArray(cmd) ? cmd : []
}

function namesChooser(first: unknown): boolean {
	const program = commandOf(first)[0]
	return typeof program === "string" && basename(program) === "osascript"
}

const spawn = Bun.spawn
const spawnSync = Bun.spawnSync

Bun.spawn = ((first: unknown, options?: unknown) => {
	if (!namesChooser(first)) return (spawn as (...args: unknown[]) => unknown)(first, options)
	if (!Array.isArray(first) || first[0] !== SYSTEM_CHOOSER) throw new Error("chooser-redirect: only the array-form spawn of the pinned chooser is redirected")
	return (spawn as (...args: unknown[]) => unknown)([standIn, ...first.slice(1)], options)
}) as typeof Bun.spawn

Bun.spawnSync = ((first: unknown, options?: unknown) => {
	if (namesChooser(first)) throw new Error("chooser-redirect: a synchronous chooser spawn is never redirected")
	return (spawnSync as (...args: unknown[]) => unknown)(first, options)
}) as typeof Bun.spawnSync
