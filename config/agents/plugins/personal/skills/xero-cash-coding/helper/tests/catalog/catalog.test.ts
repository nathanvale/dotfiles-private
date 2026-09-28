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
  expect(stationsFor("xero-history.recover").map((station) => station.transactionState).sort()).toEqual(["completed", "unchanged", "unknown"]);
});
