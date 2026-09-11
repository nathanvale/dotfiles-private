import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Invariant: every workspace member exposes the same check entry points, so an
// agent can run `bun run lint` / `bun run test` (and `bun run typecheck` where
// TypeScript exists) inside any package without guessing. TypeScript members
// must also extend the single root tsconfig.base.json.

const repoRoot = path.resolve(import.meta.dir, "../..");
const rootBaseConfig = path.join(repoRoot, "tsconfig.base.json");

function listWorkspaceMembers(rootManifest: { workspaces: string[] }): string[] {
	const members: string[] = [];
	for (const entry of rootManifest.workspaces) {
		if (!entry.endsWith("/*")) {
			members.push(entry);
			continue;
		}
		const parent = entry.slice(0, -"/*".length);
		for (const child of readdirSync(path.join(repoRoot, parent), { withFileTypes: true })) {
			if (child.isDirectory()) members.push(`${parent}/${child.name}`);
		}
	}
	return members;
}

function violationsFor(member: string): string[] {
	const memberDir = path.join(repoRoot, member);
	const manifestPath = path.join(memberDir, "package.json");
	if (!existsSync(manifestPath)) return [`${member}: package.json is missing`];

	const scripts = JSON.parse(readFileSync(manifestPath, "utf8")).scripts ?? {};
	const hasTypeScript = readdirSync(memberDir, { recursive: true, encoding: "utf8" }).some(
		(relative) => !relative.split(path.sep).includes("node_modules") && /\.tsx?$/.test(relative),
	);
	const requiredScripts = hasTypeScript ? ["lint", "test", "typecheck"] : ["lint", "test"];
	const violations = requiredScripts
		.filter((script) => typeof scripts[script] !== "string")
		.map((script) => `${member}: scripts.${script} is missing`);
	if (!hasTypeScript) return violations;

	const tsconfigPath = path.join(memberDir, "tsconfig.json");
	if (!existsSync(tsconfigPath)) return [...violations, `${member}: tsconfig.json is missing`];
	const extendsValue = JSON.parse(readFileSync(tsconfigPath, "utf8")).extends;
	if (typeof extendsValue !== "string" || path.resolve(memberDir, extendsValue) !== rootBaseConfig) {
		violations.push(`${member}: tsconfig.json must extend the root tsconfig.base.json (got ${JSON.stringify(extendsValue)})`);
	}
	return violations;
}

test("every workspace member declares lint, test, and (for TypeScript) typecheck against the root base config", () => {
	const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
	const violations = listWorkspaceMembers(rootManifest).flatMap(violationsFor);

	expect(violations.join("\n")).toBe("");
});
