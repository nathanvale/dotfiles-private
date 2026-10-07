import { expect, test } from "bun:test";

function tokenBudget(): number {
	return 11;
}

test("top-level scalar failure", () => {
	expect(tokenBudget()).toBe(13);
});
