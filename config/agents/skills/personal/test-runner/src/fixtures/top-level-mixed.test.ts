import { describe, expect, test } from "bun:test";

function tokenBudget(): number {
	return 11;
}

test("top-level sibling failure", () => {
	expect(tokenBudget()).toBe(13);
});

test("top-level [bracketed] sibling failure", () => {
	expect(tokenBudget()).toBe(15);
});

describe("mixed fixture", () => {
	test("nested sibling failure", () => {
		expect(tokenBudget()).toBe(17);
	});
});
