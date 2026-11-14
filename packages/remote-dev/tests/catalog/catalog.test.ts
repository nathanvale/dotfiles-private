import { expect, test } from "bun:test";
import { reasonsFor, stationsFor } from "../../src/branch-station-catalog.ts";

function tuples(command: string): string[] {
  return stationsFor(command).map((station) =>
    [station.outcome, station.causeCode, station.exitCode, station.transactionState, station.guidance].join("|"),
  );
}

// Independent literal oracles for the sealed station vocabulary (Contract Core 2.0 causes).
const SOURCE = [
  "refused|DOMAIN_CONFIG_MISSING|3|unchanged|next",
  "refused|DOMAIN_PRECONDITION_UNMET|3|unchanged|next",
  "failed|INTERNAL_RESULT_UNCHANGED|1|unchanged|handoff",
  "refused|SCHEMA_CONFIG_INVALID|4|unchanged|next",
  "failed|TRANSIENT_ATTEMPT_UNCHANGED|75|unchanged|next",
];
const TARGET = [
  "refused|DOMAIN_AUTHORITY_REQUIRED|3|unchanged|handoff",
  "refused|SCHEMA_INVALID_INPUT|4|unchanged|next",
];
const LAUNCH = [
  "failed|INTERNAL_RESULT_UNKNOWN|1|unknown|handoff",
  "success|SUCCESS_COMPLETED|0|completed|next",
];

test("list declares only inspection and source-failure stations", () => {
  expect(tuples("remote-dev.list").sort()).toEqual([...SOURCE, "success|SUCCESS_UNCHANGED|0|unchanged|next"].sort());
});

test("open declares recheck refusals, launch outcomes, and no inspect success", () => {
  expect(tuples("remote-dev.open").sort()).toEqual([...SOURCE, ...TARGET, ...LAUNCH].sort());
});

test("logs is inspect-only and never completes an effect", () => {
  expect(tuples("remote-dev.logs").sort()).toEqual([...SOURCE, ...TARGET, "success|SUCCESS_UNCHANGED|0|unchanged|next"].sort());
  expect(stationsFor("remote-dev.logs").every((station) => station.effectClass === "inspect")).toBe(true);
});

test("board declares recheck refusals and launch outcomes", () => {
  expect(tuples("remote-dev.board").sort()).toEqual([...SOURCE, ...TARGET, ...LAUNCH].sort());
});

test("choose adds the TTY refusal and cancellation to the dispatched outcomes", () => {
  expect(tuples("remote-dev.choose").sort()).toEqual(
    [
      ...SOURCE,
      "refused|DOMAIN_AUTHORITY_REQUIRED|3|unchanged|handoff",
      ...LAUNCH,
      "failed|INTERNAL_RESULT_PARTIAL|1|partially-completed|handoff",
      "success|SUCCESS_UNCHANGED|0|unchanged|next",
      "refused|USAGE_INVALID_INVOCATION|2|unchanged|next",
    ].sort(),
  );
});

test("each product condition is a named reason under its station", () => {
  expect(reasonsFor("remote-dev.open")).toEqual([
    "config-invalid",
    "config-missing",
    "editor-dispatched",
    "editor-profile-missing",
    "host-command-failed",
    "host-unreachable",
    "input-invalid",
    "launch-unconfirmed",
    "target-missing",
    "target-replaced",
    "target-stopped",
    "target-unknown",
    "tool-unavailable",
  ]);
  const authority = stationsFor("remote-dev.open").find((station) => station.causeCode === "DOMAIN_AUTHORITY_REQUIRED");
  expect(authority?.reasons.map((reason) => reason.reason)).toEqual([
    "editor-profile-missing",
    "target-missing",
    "target-replaced",
    "target-stopped",
  ]);
  expect(reasonsFor("remote-dev.choose")).toContain("needs-tty");
  expect(reasonsFor("remote-dev.choose")).toContain("cancelled");
  expect(reasonsFor("remote-dev.choose")).not.toContain("input-invalid");
});

test("only the transient station is retryable, with a bounded fixed delay", () => {
  const retryable = ["remote-dev.list", "remote-dev.open", "remote-dev.logs", "remote-dev.board", "remote-dev.choose"]
    .flatMap((command) => stationsFor(command))
    .filter((station) => station.retryable);
  expect(retryable).toHaveLength(5);
  for (const station of retryable) {
    expect(station.causeCode).toBe("TRANSIENT_ATTEMPT_UNCHANGED");
    expect(station.retryDelayPolicy).toEqual({ kind: "fixed", milliseconds: 5000 });
  }
});

test("discovery and dispatch routes declare their own single stations", () => {
  expect(tuples("remote-dev.dispatch")).toEqual(["refused|USAGE_INVALID_INVOCATION|2|unchanged|next"]);
  expect(tuples("remote-dev.help")).toEqual(["success|SUCCESS_UNCHANGED|0|unchanged|next"]);
  expect(stationsFor("remote-dev.restart")).toEqual([]);
});

test("start declares source failures, opt-in refusals and complete, partial or unknown external effects", () => {
  expect(tuples("remote-dev.start").sort()).toEqual([
    ...SOURCE, ...TARGET, ...LAUNCH,
    "failed|INTERNAL_RESULT_PARTIAL|1|partially-completed|handoff",
  ].sort());
});
