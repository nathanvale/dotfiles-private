import { cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PLUGIN_ROOT } from "./harness.ts";

// Compiles a test-only front door with one source fault injected. The copy
// keeps the plugin's bin/ and skills/ side by side, so relative imports that
// cross from bin/ into a skill resolve exactly as in the shipped build.
export function buildFaultedFrontDoor(root: string, outfile: string, fault: { readonly find: string; readonly replace: string }): void {
	const source = path.join(root, "test-source");
	const shipped = path.join(PLUGIN_ROOT, "bin", "connectors");
	cpSync(path.join(PLUGIN_ROOT, "bin"), path.join(source, "bin"), { recursive: true, filter: (file) => file !== shipped });
	cpSync(path.join(PLUGIN_ROOT, "skills"), path.join(source, "skills"), { recursive: true });
	const entry = path.join(source, "bin", "connectors.ts");
	const original = readFileSync(entry, "utf8");
	if (original.split(fault.find).length !== 2) throw new Error(`fault anchor must occur exactly once in connectors.ts: ${fault.find}`);
	writeFileSync(entry, original.replace(fault.find, fault.replace));
	const built = Bun.spawnSync(["bun", "build", entry, "--compile", "--target=bun-darwin-arm64", "--outfile", outfile], { stdout: "pipe", stderr: "pipe" });
	if (built.exitCode !== 0) throw new Error(new TextDecoder().decode(built.stderr));
}
