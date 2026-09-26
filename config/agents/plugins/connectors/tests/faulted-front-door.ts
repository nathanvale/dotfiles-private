import { cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileFrontDoor } from "./compile-front-door.ts";
import { PLUGIN_ROOT } from "./harness.ts";

// Compiles a test-only front door with one source fault injected. The copy
// keeps the plugin's bin/, skills/, and root requirements.json side by side, so
// relative imports that leave bin/ resolve exactly as in the shipped build.
export function buildFaultedFrontDoor(root: string, outfile: string, fault: { readonly find: string; readonly replace: string }): void {
	const source = path.join(root, "test-source");
	const shipped = path.join(PLUGIN_ROOT, "bin", "connectors");
	cpSync(path.join(PLUGIN_ROOT, "bin"), path.join(source, "bin"), { recursive: true, filter: (file) => file !== shipped });
	cpSync(path.join(PLUGIN_ROOT, "skills"), path.join(source, "skills"), { recursive: true });
	cpSync(path.join(PLUGIN_ROOT, "requirements.json"), path.join(source, "requirements.json"));
	const entry = path.join(source, "bin", "connectors.ts");
	const original = readFileSync(entry, "utf8");
	if (original.split(fault.find).length !== 2) throw new Error(`fault anchor must occur exactly once in connectors.ts: ${fault.find}`);
	writeFileSync(entry, original.replace(fault.find, fault.replace));
	compileFrontDoor(entry, outfile);
}
