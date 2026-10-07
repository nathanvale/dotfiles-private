import { readFileSync } from "node:fs";
import path from "node:path";
import { discoverPluginCheckSteps, type PluginCheckStep } from "./plugin-tests.ts";

// The repository-checks workflow runs plugin checks as matrix legs instead of
// one `test:plugins` call. This guard keeps that matrix equal to the plugins
// `test:plugins` discovers, with every shard of every plugin present once, so
// splitting the work across jobs can never drop a plugin or a shard.

const repoRoot = path.resolve(import.meta.dir, "..");
const WORKFLOW_RELATIVE_PATH = ".github/workflows/repository-checks.yml";
const MATRIX_JOB = "plugin-tests";

interface ShardLeg {
	plugin: string;
	shard: number;
	shards: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMatrixLegs(workflowText: string): { legs: ShardLeg[]; errors: string[] } {
	const workflow: unknown = Bun.YAML.parse(workflowText);
	const jobs = isRecord(workflow) && isRecord(workflow.jobs) ? workflow.jobs : {};
	const job = jobs[MATRIX_JOB];
	const strategy = isRecord(job) && isRecord(job.strategy) ? job.strategy : {};
	const matrix = isRecord(strategy.matrix) ? strategy.matrix : {};
	if (!Array.isArray(matrix.include)) {
		return { legs: [], errors: [`${WORKFLOW_RELATIVE_PATH}: jobs.${MATRIX_JOB}.strategy.matrix.include must list the plugin shards`] };
	}

	const legs: ShardLeg[] = [];
	const errors: string[] = [];
	for (const entry of matrix.include) {
		const { plugin, shard, shards } = isRecord(entry) ? entry : {};
		if (typeof plugin !== "string" || !Number.isInteger(shard) || !Number.isInteger(shards)) {
			errors.push(`matrix leg ${JSON.stringify(entry)} needs a string plugin and integer shard and shards`);
			continue;
		}
		legs.push({ plugin, shard: shard as number, shards: shards as number });
	}
	return { legs, errors };
}

function shardSetErrors(plugin: string, legs: ShardLeg[]): string[] {
	const counts = [...new Set(legs.map((leg) => leg.shards))];
	const shards = counts[0];
	if (counts.length !== 1 || shards === undefined) {
		return [`${plugin}: matrix legs disagree on the shard count (${counts.join(", ")})`];
	}
	const seen = legs.map((leg) => leg.shard).sort((a, b) => a - b);
	const expected = Array.from({ length: shards }, (_, index) => index + 1);
	if (shards < 1 || seen.join(",") !== expected.join(",")) {
		return [`${plugin}: matrix shards are [${seen.join(", ")}] but ${shards} shard(s) need exactly [${expected.join(", ")}]`];
	}
	return [];
}

function coverageErrors(steps: PluginCheckStep[], legs: ShardLeg[]): string[] {
	const errors: string[] = [];
	const tested = new Set(steps.filter((step) => step.script === "test").map((step) => step.plugin));
	const typechecked = new Set(steps.filter((step) => step.script === "typecheck").map((step) => step.plugin));
	const legsByPlugin = Map.groupBy(legs, (leg) => leg.plugin);

	for (const plugin of [...tested].sort()) {
		const pluginLegs = legsByPlugin.get(plugin);
		if (!pluginLegs) errors.push(`${plugin}: test:plugins runs its tests but the workflow matrix has no leg for it`);
		else errors.push(...shardSetErrors(plugin, pluginLegs));
		if (!typechecked.has(plugin)) errors.push(`${plugin}: the workflow typechecks every matrix plugin, so it must declare scripts.typecheck`);
	}
	for (const plugin of [...legsByPlugin.keys()].sort()) {
		if (!tested.has(plugin)) errors.push(`${plugin}: the workflow matrix runs it but test:plugins does not discover it`);
	}
	return errors;
}

const { legs, errors: parseErrors } = readMatrixLegs(readFileSync(path.join(repoRoot, WORKFLOW_RELATIVE_PATH), "utf8"));
const errors = [...parseErrors, ...coverageErrors(discoverPluginCheckSteps(), legs)];
if (errors.length > 0) {
	console.error(`FAIL: ${WORKFLOW_RELATIVE_PATH} plugin shards do not match test:plugins:`);
	for (const error of errors) console.error(`  ${error}`);
	process.exit(1);
}
const plugins = new Set(legs.map((leg) => leg.plugin));
console.log(`PASS: ${legs.length} plugin shard leg(s) cover ${plugins.size} plugin(s) that test:plugins discovers.`);
