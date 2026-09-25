import { readFileSync } from "node:fs";
import path from "node:path";

// The package's build script owns the compile flags; a test binary reuses
// them with its own entry and outfile, run by the test runner's own Bun, so
// it compiles from exactly the source tree it is given.
const BUILD_ENTRY = "./bin/connectors.ts";
const BUILD_OUTFILE = "bin/connectors";

function buildArgv(entry: string, outfile: string): string[] {
	const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as { scripts: { build: string } };
	const [runner, ...args] = manifest.scripts.build.split(" ");
	const outfileAt = args.indexOf("--outfile") + 1;
	if (runner !== "bun" || args[0] !== "build" || args[1] !== BUILD_ENTRY || outfileAt === 0 || args[outfileAt] !== BUILD_OUTFILE) throw new Error("package.json scripts.build no longer has the shape the test compile reuses");
	return [process.execPath, ...args.map((arg, index) => (index === 1 ? entry : index === outfileAt ? outfile : arg))];
}

export function compileFrontDoor(entry: string, outfile: string): void {
	const built = Bun.spawnSync(buildArgv(entry, outfile), { stdout: "pipe", stderr: "pipe" });
	if (built.exitCode !== 0) throw new Error(new TextDecoder().decode(built.stderr));
}
