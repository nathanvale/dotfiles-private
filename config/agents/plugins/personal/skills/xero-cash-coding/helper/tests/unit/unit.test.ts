import { expect, test } from "bun:test";
import { CacheDocument, Observation } from "../../src/command-contract.ts";

test("line amount basis remains observed and required", () => {
  const input = {
    organisation: { id: "org-1", name: "Synthetic" },
    bankAccount: { id: "bank-1", name: "Synthetic" },
    coverage: [],
    transactions: [{ id: "t-1", date: "2026-04-01", direction: "out", currency: "AUD", amountMinor: -100,
      payee: null, description: null, contact: null, reconciled: true, observedAt: "2026-09-28T00:00:00Z",
      lines: [{ accountCode: "400", accountName: "Costs", taxType: "GST", amountMinor: -100, amountBasis: null }] }],
  };
  expect(Observation.safeParse(input).success).toBe(true);
  const invalid = { ...input, transactions: [{ ...input.transactions[0], lines: [{ accountCode: "400", accountName: "Costs", taxType: "GST", amountMinor: -100, amountBasis: "guessed" }] }] };
  expect(Observation.safeParse(invalid).success).toBe(false);
  expect(CacheDocument.safeParse({ ...input, transactions: { "t-1": input.transactions[0] }, schemaVersion: 1, updatedAt: "2026-09-28T00:00:00Z" }).success).toBe(true);
});
