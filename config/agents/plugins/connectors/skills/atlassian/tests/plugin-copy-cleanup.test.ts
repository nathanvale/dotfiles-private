// Substituted plugin copy lifetime. A real `bun test` child, in an isolated
// TMPDIR, takes the shared copy and then passes or fails; once the child has
// exited, none of its copies may remain, while an older copy it never took
// survives. Runner hooks are not trusted here: `bun test` fires no process
// "exit" handler, which is how earlier runs leaked their copies.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Independent oracles: the copy's directory prefix, and a copy some earlier
// run left behind.
const PREFIX = "connectors-substituted-plugin-";
const OLDER = `${PREFIX}older`;
const PLUGIN_COPY = path.join(import.meta.dir, "fixtures", "plugin-copy.ts");

type Where = "module" | "test";
type ChildFile = { name: string; where: Where; tests: number; outcome: "pass" | "fail"; throwingHook?: boolean };

// One child test file: it takes the copy at module scope or inside each test,
// and inside each test records the copy and whether it is still live there.
// A throwing hook, after those tests, also takes and records the copy, then
// throws, as the one-password-custody MCPorter bootstrap does on failure.
function childSource(file: ChildFile, record: string): string {
	const take = "const copy = substitutedPluginRoot();";
	const append = `appendFileSync(${JSON.stringify(record)}, JSON.stringify({ file: ${JSON.stringify(file.name)}, copy, live: existsSync(copy) }) + "\\n");`;
	const tests = Array.from({ length: file.tests }, (_, index) => [
		`test(${JSON.stringify(`${file.name} ${index + 1}`)}, () => {`,
		file.where === "test" ? take : "",
		`	${append}`,
		`	expect(1).toBe(${file.outcome === "pass" ? 1 : 2});`,
		"});",
	]);
	const hook = ['describe("throwing hook", () => {', `	beforeAll(() => { ${take} ${append} throw new Error("hook failed"); });`, '	test("after the hook", () => {});', "});"];
	return [
		'import { beforeAll, describe, expect, test } from "bun:test";',
		'import { appendFileSync, existsSync } from "node:fs";',
		`import { substitutedPluginRoot } from ${JSON.stringify(PLUGIN_COPY)};`,
		file.where === "module" ? take : "",
		...tests.flat(),
		...(file.throwingHook ? hook : []),
	].join("\n");
}

// Runs the child files in one `bun test` process with an isolated TMPDIR
// that already holds an older copy.
async function runChild(files: ChildFile[]) {
	const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "connectors-copy-cleanup-")));
	const childTmp = path.join(tmp, "tmpdir");
	mkdirSync(path.join(childTmp, OLDER), { recursive: true });
	writeFileSync(path.join(childTmp, OLDER, "marker"), "older run");
	const record = path.join(tmp, "copies.jsonl");
	const paths = files.map((file) => {
		const child = path.join(tmp, `${file.name}.test.ts`);
		writeFileSync(child, childSource(file, record));
		return child;
	});
	const proc = Bun.spawn([process.execPath, "test", ...paths], { cwd: tmp, env: { HOME: tmp, PATH: "/usr/bin:/bin", TMPDIR: `${childTmp}/` }, stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	const taken = existsSync(record)
		? readFileSync(record, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { file: string; copy: string; live: boolean })
		: [];
	return { exitCode, taken, tmp, childTmp, remaining: readdirSync(childTmp).filter((entry) => entry.startsWith(PREFIX)) };
}

// `taken` is the independent oracle for which tests recorded a copy, in order.
const CASES: { name: string; files: ChildFile[]; exitCode: number; taken: string[] }[] = [
	{
		name: "a passing file that takes the copy at module scope for two tests",
		files: [{ name: "module-pass", where: "module", tests: 2, outcome: "pass" }],
		exitCode: 0,
		taken: ["module-pass", "module-pass"],
	},
	{ name: "a failing file that takes the copy inside its test", files: [{ name: "test-fail", where: "test", tests: 1, outcome: "fail" }], exitCode: 1, taken: ["test-fail"] },
	{
		name: "two files in one process, the first failing",
		files: [
			{ name: "first-fail", where: "module", tests: 1, outcome: "fail" },
			{ name: "second-pass", where: "module", tests: 1, outcome: "pass" },
		],
		exitCode: 1,
		taken: ["first-fail", "second-pass"],
	},
	{
		name: "a file that takes the copy at module scope before a hook that asks and throws",
		files: [{ name: "module-hook-throws", where: "module", tests: 1, outcome: "pass", throwingHook: true }],
		exitCode: 1,
		taken: ["module-hook-throws", "module-hook-throws"],
	},
];

describe("substituted plugin copy lifetime", () => {
	for (const testCase of CASES) {
		test(`${testCase.name} leaves no copy after the child exits`, async () => {
			const run = await runChild(testCase.files);
			try {
				expect(run.exitCode).toBe(testCase.exitCode);
				// Positive control: every test held its file's live copy in the child's TMPDIR while it ran.
				expect(run.taken.map((entry) => entry.file)).toEqual(testCase.taken);
				for (const entry of run.taken) {
					expect(path.dirname(entry.copy)).toBe(run.childTmp);
					expect(path.basename(entry.copy).startsWith(PREFIX)).toBe(true);
					expect(entry.copy).not.toBe(path.join(run.childTmp, OLDER));
					expect(entry.live).toBe(true);
				}
				// One path per file: a later test in the file still holds the copy the first test held.
				for (const file of testCase.files) expect(new Set(run.taken.filter((entry) => entry.file === file.name).map((entry) => entry.copy)).size).toBe(1);
				expect(run.remaining).toEqual([OLDER]);
				expect(readFileSync(path.join(run.childTmp, OLDER, "marker"), "utf8")).toBe("older run");
			} finally {
				rmSync(run.tmp, { recursive: true, force: true });
			}
		}, 60_000);
	}
});
