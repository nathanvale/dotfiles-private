// Test-only preload: redirects a spawn of the pinned system chooser (/usr/bin/osascript) to the test-owned stand-in
// named by SOURCE_INTAKE_TEST_CHOOSER, so no dialog ever opens during tests. The production bin wrapper loads no
// preload, so this seam cannot reach a real run. Without the variable it fails the run instead of opening a dialog.
const SYSTEM_CHOOSER = "/usr/bin/osascript"
const standIn = process.env.SOURCE_INTAKE_TEST_CHOOSER
if (standIn === undefined) throw new Error("chooser-redirect preload needs SOURCE_INTAKE_TEST_CHOOSER")

const spawn = Bun.spawn
Bun.spawn = ((command: string[], options: Parameters<typeof Bun.spawn>[1]) => {
	// Fail closed: any other spelling of osascript (a PATH lookup) would open a real dialog, so it fails the run.
	if (command[0] !== SYSTEM_CHOOSER && command[0]?.endsWith("osascript")) throw new Error("chooser spawned without the pinned system path")
	return spawn(command[0] === SYSTEM_CHOOSER ? [standIn, ...command.slice(1)] : command, options)
}) as typeof Bun.spawn
