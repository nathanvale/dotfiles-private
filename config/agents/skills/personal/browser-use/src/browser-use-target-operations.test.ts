import { describe, expect, test } from "bun:test";
import { parseBrowserUseArgv } from "./browser-use-parser";

describe("browser-use operate target plan contract", () => {
	test("the public parser admits the structured target plan command", () => {
		const parsed = parseBrowserUseArgv([
			"operate",
			"target",
			"--plan",
			"/private/run/plan.json",
			"--handoff",
			"/private/run/handoff.json",
			"--json",
		]);
		expect(parsed.kind).toBe("command");
		if (parsed.kind !== "command") return;
		expect(parsed.command).toBe("operate-target");
	});

	test("operate help exposes the target-plan leaf", () => {
		const parsed = parseBrowserUseArgv(["operate", "target", "--help"]);
		expect(parsed).toMatchObject({ kind: "help", family: "operate", command: "operate-target" });
	});

	test("the plan parser rejects raw or unknown step shapes before mutation", async () => {
		const operations = await import("./browser-use-target-operations");
		expect(() =>
			operations.parseBrowserUseTargetOperationPlan({
				steps: [{ kind: "eval", script: "document.body" }],
			}),
		).toThrow();
	});

	test("typed steps map without exposing native command vocabulary", async () => {
		const operations = await import("./browser-use-target-operations");
		const parsed = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "1",
			steps: [
				{ kind: "navigate", url: "https://example.test/form" },
				{ kind: "inspect", selector: "#name", fields: ["dom", "geometry", "visibility"] },
				{ kind: "review-state", selector: "#name", state: "focus" },
				{ kind: "input", action: "focus", selector: "#name" },
				{ kind: "overlay-cleanup", method: "escape" },
			],
		});
		expect(parsed.steps).toHaveLength(5);
		expect(JSON.stringify(parsed)).not.toMatch(/agent-browser|--cdp|session|tab/);
	});

	test("plan digest is deterministic and target-local", async () => {
		const operations = await import("./browser-use-target-operations");
		const plan = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "1",
			steps: [{ kind: "inspect", selector: "#name", fields: ["focus"] }],
		});
		expect(operations.targetOperationPlanDigest(plan)).toMatch(/^[a-f0-9]{64}$/);
		expect(plan.scope).toBe("target-local");
	});

	test("the public input vocabulary keeps press keyed and release keyless", async () => {
		const operations = await import("./browser-use-target-operations");
		expect(() =>
			operations.parseBrowserUseTargetOperationPlan({
				contract: "browser-use.target-operation-plan",
				schema_version: "1",
				steps: [{ kind: "input", action: "release" }],
			}),
		).not.toThrow();
		expect(() =>
			operations.parseBrowserUseTargetOperationPlan({
				contract: "browser-use.target-operation-plan",
				schema_version: "1",
				steps: [{ kind: "input", action: "release", key: "Enter" }],
			}),
		).toThrow();
		expect(() =>
			operations.parseBrowserUseTargetOperationPlan({
				contract: "browser-use.target-operation-plan",
				schema_version: "1",
				steps: [{ kind: "input", action: "key", key: "Enter" }],
			}),
		).toThrow();
	});

	test("navigation plans are checked against Browser Use's exact bound origin", async () => {
		const operations = await import("./browser-use-target-operations");
		const plan = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "1",
			steps: [{ kind: "navigate", url: "https://example.test/next" }],
		});
		expect(
			operations.targetOperationPlanMatchesBoundOrigin(plan, "https://example.test"),
		).toBe(true);
		expect(
			operations.targetOperationPlanMatchesBoundOrigin(plan, "https://other.example.test"),
		).toBe(false);
	});

	test("rejects ignored input fields and classifies mutating plans exactly", async () => {
		const operations = await import("./browser-use-target-operations");
		for (const step of [
			{ kind: "input", action: "press", key: "Enter", selector: "#ignored" },
			{ kind: "input", action: "release", delta: 1 },
			{ kind: "input", action: "click", selector: "#ok", key: "Enter" },
			{ kind: "input", action: "move", x: 1, y: 2, key: "Enter" },
		] as const) {
			expect(() =>
				operations.parseBrowserUseTargetOperationPlan({
					contract: "browser-use.target-operation-plan",
					schema_version: "1",
					steps: [step],
				}),
			).toThrow();
		}
		const observational = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "1",
			steps: [{ kind: "inspect", selector: "main", fields: ["dom"] }],
		});
		const mutating = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "1",
			steps: [{ kind: "input", action: "press", key: "Enter" }],
		});
		expect(operations.targetOperationPlanIsMutating(observational)).toBe(false);
		expect(operations.targetOperationPlanIsMutating(mutating)).toBe(true);
	});

	test("the closed target-plan evidence parses from success and controlled cleanup-failure receipts", async () => {
		const { parseBrowserOperationTargetPlanReceipt } = await import("./browser-use-operations");
		const targetPlan = {
			steps: [{ index: 0, kind: "input", status: "confirmed" }],
			cleanup: { attempted: true, closed: false, visible_owned_surface_count: 1 },
		};
		for (const receipt of [
			{ status: "ok", data: { target_plan: targetPlan } },
			{ status: "error", data: { target_plan: targetPlan }, error: { code: "browser_operation_cleanup_incomplete" } },
		]) {
			expect(parseBrowserOperationTargetPlanReceipt(JSON.stringify(receipt))).toEqual(targetPlan);
		}
	});

});
