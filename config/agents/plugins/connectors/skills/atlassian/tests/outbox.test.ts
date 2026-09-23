// Proof of the tenant upload outbox at its filesystem interface: the staged
// path names the exact bytes hashed, and an existing destination symlink is
// refused rather than written through.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { outboxDirectory, stageFile } from "../scripts/outbox.ts";

let root: string;
let env: { HOME: string };
beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "outbox-"));
	env = { HOME: root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const digestOf = (content: string) => createHash("sha256").update(content).digest("hex");

describe("stageFile", () => {
	test("stages the exact bytes it hashed, under a path named by their digest", () => {
		const source = path.join(root, "report.pdf");
		writeFileSync(source, "evidence-bytes");
		const result = stageFile("acme", env, source);
		expect(result).toEqual({ ok: true, relative: `${digestOf("evidence-bytes")}/report.pdf` });
		const staged = path.join(outboxDirectory("acme", env), (result as { relative: string }).relative);
		expect(readFileSync(staged, "utf8")).toBe("evidence-bytes");
	});

	test("stages a file across multiple bounded copy buffers", () => {
		const source = path.join(root, "large.pdf");
		const content = Buffer.alloc(1024 * 1024 + 13, 0x5a);
		content[content.length - 1] = 0x21;
		writeFileSync(source, content);
		const digest = createHash("sha256").update(content).digest("hex");
		const result = stageFile("acme", env, source);
		expect(result).toEqual({ ok: true, relative: `${digest}/large.pdf` });
		const outbox = outboxDirectory("acme", env);
		expect(readFileSync(path.join(outbox, `${digest}/large.pdf`))).toEqual(content);
		expect(readdirSync(outbox)).toEqual([digest]);
	});

	test("re-stages identical content over the same digest path idempotently", () => {
		const source = path.join(root, "report.pdf");
		writeFileSync(source, "same-bytes");
		expect(stageFile("acme", env, source)).toEqual({ ok: true, relative: `${digestOf("same-bytes")}/report.pdf` });
		expect(stageFile("acme", env, source)).toEqual({ ok: true, relative: `${digestOf("same-bytes")}/report.pdf` });
	});

	test("refuses to write through an existing symlink at the staged destination", () => {
		const source = path.join(root, "report.pdf");
		writeFileSync(source, "attack-bytes");
		const digest = digestOf("attack-bytes");
		const outsideTarget = path.join(root, "outside-secret.txt");
		writeFileSync(outsideTarget, "untouched");
		const directory = path.join(outboxDirectory("acme", env), digest);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		symlinkSync(outsideTarget, path.join(directory, "report.pdf"));
		const result = stageFile("acme", env, source);
		expect(result).toEqual({ ok: false, reason: "outbox-unavailable" });
		expect(existsSync(path.join(directory, "report.pdf"))).toBe(true);
		expect(readFileSync(outsideTarget, "utf8")).toBe("untouched");
	});

	test("refuses a symlinked source file", () => {
		const real = path.join(root, "real.pdf");
		writeFileSync(real, "x");
		const link = path.join(root, "link.pdf");
		symlinkSync(real, link);
		expect(stageFile("acme", env, link)).toEqual({ ok: false, reason: "file-unreadable" });
	});
});
