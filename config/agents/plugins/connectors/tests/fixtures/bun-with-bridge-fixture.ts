// Test-only Bun launcher. Provider scripts use /usr/bin/env bun; this adds a
// module preload inside isolated process fixtures without a production switch.
import path from "node:path";

const preload = path.join(import.meta.dir, "bridge-preload.ts");
const child = Bun.spawnSync([process.execPath, "--preload", preload, ...process.argv.slice(2)], {
	env: process.env,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(child.exitCode);
