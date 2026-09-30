// Test-only preload: answers the OS account-record lookup with a synthetic home from SOURCE_INTAKE_TEST_ACCOUNT_HOME,
// so a test can place a receipt under the account's default state root without touching the real account's state.
const accountHome = process.env.SOURCE_INTAKE_TEST_ACCOUNT_HOME
const spawnSync = Bun.spawnSync
const ACCOUNT_RECORD_COMMANDS = new Set(["/usr/bin/id", "/usr/bin/getent"])

if (accountHome !== undefined) {
	;(Bun as { spawnSync: unknown }).spawnSync = (options: { cmd: string[] }) => {
		if (!ACCOUNT_RECORD_COMMANDS.has(options.cmd[0] ?? "")) return (spawnSync as (options: unknown) => unknown)(options)
		const record = `synthetic:*:${process.getuid?.() ?? 0}:0::0:0:Synthetic Account:${accountHome}:/bin/sh\n`
		return { exitCode: 0, success: true, stdout: new TextEncoder().encode(record), stderr: new Uint8Array() }
	}
}
