/** Print `help` and exit(0) if `arg` is -h/--help; no-op otherwise. */
export function maybeExitWithHelp(arg: string, help: string): void {
	if (arg === "-h" || arg === "--help") {
		console.log(help);
		process.exit(0);
	}
}

/** Run `main`, printing any rejection to stderr and exiting 1. Shared
 * entrypoint-catch boilerplate for every classic-cinema command script. */
export function runMain(main: () => Promise<void>): void {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}
