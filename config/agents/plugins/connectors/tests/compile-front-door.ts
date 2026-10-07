import { readFileSync } from "node:fs";
import path from "node:path";

// The package's build script owns the compile flags and the signing step; a
// test binary reuses both with its own entry and outfile, run by the test
// runner's own Bun, so it compiles from exactly the source tree it is given
// and is signed exactly as the shipped front door is.
const BUILD_ENTRY = "./bin/connectors.ts";
const BUILD_OUTFILE = "bin/connectors";
// Bun's compiled output carries an invalid linker signature; once executed,
// the kernel kills any process that maps its pages (git re-hashing the
// tracked file), so the build re-signs it ad hoc.
const SIGN = ["codesign", "--force", "--sign", "-", BUILD_OUTFILE];
const SHAPE_ERROR = "package.json scripts.build:cli no longer has the shape the test compile reuses";

function buildSteps(entry: string, outfile: string): string[][] {
	const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as { scripts: { "build:cli": string } };
	const [compile = "", sign = "", ...rest] = manifest.scripts["build:cli"].split(" && ");
	const [runner, ...args] = compile.split(" ");
	const outfileAt = args.indexOf("--outfile") + 1;
	if (runner !== "bun" || args[0] !== "build" || args[1] !== BUILD_ENTRY || outfileAt === 0 || args[outfileAt] !== BUILD_OUTFILE) throw new Error(SHAPE_ERROR);
	if (rest.length !== 0 || JSON.stringify(sign.split(" ")) !== JSON.stringify(SIGN)) throw new Error(SHAPE_ERROR);
	return [
		[process.execPath, ...args.map((arg, index) => (index === 1 ? entry : index === outfileAt ? outfile : arg))],
		["/usr/bin/codesign", ...SIGN.slice(1, -1), outfile],
	];
}

export function compileFrontDoor(entry: string, outfile: string): void {
	for (const step of buildSteps(entry, outfile)) {
		const ran = Bun.spawnSync(step, { stdout: "pipe", stderr: "pipe" });
		if (ran.exitCode !== 0) throw new Error(new TextDecoder().decode(ran.stderr));
	}
}
