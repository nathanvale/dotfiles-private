import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Invariant: every workspace member exposes the same check entry points, so an
// agent can run `bun run lint` / `bun run test` (and `bun run typecheck` where
// TypeScript exists) inside any package without guessing. TypeScript members
// must also extend the single root tsconfig.base.json.

const repoRoot = path.resolve(import.meta.dir, "../..");
const rootBaseConfig = path.join(repoRoot, "tsconfig.base.json");

test("every workspace member declares lint, test, and (for TypeScript) typecheck against the root base config", () => {
	const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
	const members: string[] = [];
	for (const entry of rootManifest.workspaces as string[]) {
		if (!entry.endsWith("/*")) {
			members.push(entry);
			continue;
		}
		const parent = entry.slice(0, -"/*".length);
		for (const child of readdirSync(path.join(repoRoot, parent), { withFileTypes: true })) {
			if (child.isDirectory()) members.push(`${parent}/${child.name}`);
		}
	}

	const violations: string[] = [];
	for (const member of members) {
		const memberDir = path.join(repoRoot, member);
		const manifestPath = path.join(memberDir, "package.json");
		if (!existsSync(manifestPath)) {
			violations.push(`${member}: package.json is missing`);
			continue;
		}
		const scripts = JSON.parse(readFileSync(manifestPath, "utf8")).scripts ?? {};
		for (const script of ["lint", "test"]) {
			if (typeof scripts[script] !== "string") violations.push(`${member}: scripts.${script} is missing`);
		}

		const hasTypeScript = readdirSync(memberDir, { recursive: true, encoding: "utf8" }).some(
			(relative) => !relative.split(path.sep).includes("node_modules") && /\.tsx?$/.test(relative),
		);
		if (!hasTypeScript) continue;

		if (typeof scripts.typecheck !== "string") violations.push(`${member}: scripts.typecheck is missing`);
		const tsconfigPath = path.join(memberDir, "tsconfig.json");
		if (!existsSync(tsconfigPath)) {
			violations.push(`${member}: tsconfig.json is missing`);
			continue;
		}
		const extendsValue = JSON.parse(readFileSync(tsconfigPath, "utf8")).extends;
		if (typeof extendsValue !== "string" || path.resolve(memberDir, extendsValue) !== rootBaseConfig) {
			violations.push(`${member}: tsconfig.json must extend the root tsconfig.base.json (got ${JSON.stringify(extendsValue)})`);
		}
	}

	expect(violations.join("\n")).toBe("");
});
