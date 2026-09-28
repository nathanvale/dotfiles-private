import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Independent plugin packages keep their own lockfiles outside root workspaces,
// so this script runs their declared test and typecheck routes. `proof` is a
// direct root workspace; `personal` owns a nested root workspace helper. Their
// tests already run under `bun run --filter '*' test`.

const repoRoot = path.resolve(import.meta.dir, "..");
const pluginsRoot = path.join(repoRoot, "config/agents/plugins");
const SKIP = new Set(["personal", "proof"]);

interface Step {
	plugin: string;
	script: "test" | "typecheck";
}

function discoverSteps(): Step[] {
	const pluginNames = readdirSync(pluginsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !SKIP.has(entry.name))
		.map((entry) => entry.name)
		.sort();

	const steps: Step[] = [];
	for (const plugin of pluginNames) {
		const manifestPath = path.join(pluginsRoot, plugin, "package.json");
		if (!existsSync(manifestPath)) continue;
		const scripts = JSON.parse(readFileSync(manifestPath, "utf8")).scripts ?? {};
		if (typeof scripts.test !== "string") continue;
		steps.push({ plugin, script: "test" });
		if (typeof scripts.typecheck === "string") steps.push({ plugin, script: "typecheck" });
	}
	return steps;
}

function runStep(step: Step): boolean {
	console.log(`\n> bun run ${step.script}  (config/agents/plugins/${step.plugin})`);
	const result = Bun.spawnSync(["bun", "run", step.script], {
		cwd: path.join(pluginsRoot, step.plugin),
		stdout: "inherit",
		stderr: "inherit",
	});
	return result.exitCode === 0;
}

const steps = discoverSteps();
const failures: Step[] = [];
for (const step of steps) {
	if (!runStep(step)) failures.push(step);
}

const pluginCount = new Set(steps.map((step) => step.plugin)).size;
if (failures.length === 0) {
	console.log(`\nPASS: ${steps.length} plugin check(s) across ${pluginCount} plugin(s).`);
} else {
	const failureList = failures.map((step) => `${step.plugin}:${step.script}`).join(", ");
	console.log(`\nFAIL: ${failures.length}/${steps.length} plugin check(s) failed across ${pluginCount} plugin(s): ${failureList}`);
}
process.exit(failures.length === 0 ? 0 : 1);
