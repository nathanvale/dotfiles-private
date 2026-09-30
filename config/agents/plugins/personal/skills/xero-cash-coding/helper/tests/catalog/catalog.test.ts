import { expect, test } from "bun:test";
import { stationsFor } from "../../src/branch-station-catalog.ts";
import { COMMANDS } from "../../src/command-contract.ts";

test("all five public commands disclose distinct relevant stations", () => {
  const domainCommands = COMMANDS.filter((item) => !["xero-history.command-discovery", "xero-history.discovery", "xero-history.help"].includes(item.commandIdentity));
  expect(domainCommands.map((item) => item.commandIdentity)).toEqual([
    "xero-history.status", "xero-history.lookup", "xero-history.preview", "xero-history.apply", "xero-history.recover",
  ]);
  for (const item of domainCommands) {
    const stations = stationsFor(item.commandIdentity);
    expect(stations.length).toBeGreaterThan(0);
    expect(stations.every((station) => station.commandIdentity === item.commandIdentity)).toBe(true);
  }
  expect(stationsFor("xero-history.recover").map((station) => [station.causeCode, station.outcome, station.effectClass, station.transactionState])).toEqual([
    ["SUCCESS_UNCHANGED", "success", "inspect", "unchanged"],
    ["SUCCESS_COMPLETED", "success", "repository-local", "completed"],
    ["TRANSIENT_NOT_STARTED", "refused", "inspect", "unchanged"],
    ["DOMAIN_RECOVERY_HANDOFF_REQUIRED", "refused", "inspect", "unchanged"],
    ["DOMAIN_RECOVERY_HANDOFF_REQUIRED", "refused", "inspect", "unchanged"],
    ["DOMAIN_RECOVERY_HANDOFF_REQUIRED", "refused", "inspect", "unchanged"],
    ["DOMAIN_RECOVERY_HANDOFF_REQUIRED", "refused", "inspect", "unchanged"],
    ["INTERNAL_RESULT_UNCHANGED", "failed", "inspect", "unchanged"],
  ]);
  for (const command of ["preview", "apply"] as const) {
    const pending = stationsFor(`xero-history.${command}`).find((station) => station.trigger === "Previous apply pending.");
    expect(pending).toMatchObject({ causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED", outcome: "refused", transactionState: "unchanged" });
  }
  const attempted = stationsFor("xero-history.apply").filter((station) => station.trigger === "Apply attempted; effect uncertain.");
  expect(attempted).toHaveLength(1);
  expect(attempted[0]).toMatchObject({ causeCode: "DOMAIN_RECOVERY_HANDOFF_REQUIRED", effectClass: "repository-local",
    outcome: "failed", transactionState: "unknown", exitCode: 3, failureClass: "domain", retryable: false,
    guidance: { handoff: { owner: "operator", reason: "Run recover and inspect before another apply." } } });
  for (const [command, effectClass] of [
    ["status", "inspect"], ["lookup", "inspect"], ["preview", "repository-local"],
    ["apply", "repository-local"], ["recover", "inspect"],
  ] as const) {
    const internal = stationsFor(`xero-history.${command}`).filter((station) => station.causeCode === "INTERNAL_RESULT_UNCHANGED");
    expect(internal).toHaveLength(1);
    expect(internal[0]).toMatchObject({ trigger: "Internal cache operation failed.", effectClass,
      outcome: "failed", transactionState: "unchanged", exitCode: 1, failureClass: "internal", retryable: false,
      repairAction: "Inspect local permissions and the journal before retrying.",
      guidance: { handoff: { owner: "operator", reason: "Inspect local permissions and the journal before retrying." } } });
  }
});
