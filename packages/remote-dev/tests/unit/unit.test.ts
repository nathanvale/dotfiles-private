import { expect, test } from "bun:test";
import { Config } from "../../src/command-contract.ts";
import { parseInventory, redactLog, stripControl } from "../../src/engine.ts";
import { baseConfig, DEVBOX_ID, PILOT_ID } from "../support/harness.ts";

test("inventory parsing keeps safe rows and counts every unsafe one", () => {
  const parsed = parseInventory(
    [
      `${PILOT_ID} shepherdr-pilot-main-20261112 running`,
      `${DEVBOX_ID} devbox-1,alias-two exited`,
      "not-an-id name running",
      `${DEVBOX_ID} bad;name running`,
      `${DEVBOX_ID} name running extra`,
      "",
    ].join("\n"),
  );
  expect(parsed).toEqual({
    containers: [
      { id: PILOT_ID, names: ["shepherdr-pilot-main-20261112"], running: true, state: "running" },
      { id: DEVBOX_ID, names: ["devbox-1", "alias-two"], running: false, state: "exited" },
    ],
    rejected: 3,
  });
});

test("control sequences are removed but tabs and newlines remain", () => {
  expect(stripControl("a\u001b[2Jb\u001b]8;;x\u0007c\td\n\u0007e\u009bf")).toBe("abc\td\nef");
});

test.each([
  ["api_key: sk-abcdefghijklmnopqrstu", "api_key: [REDACTED]"],
  ["GITHUB_TOKEN=ghp_abcdefghijklmnop", "GITHUB_TOKEN=[REDACTED]"],
  ["using ghp_abcdefghijklmnop now", "using [REDACTED] now"],
  ["tailscale tskey-auth-abcdefgh1234", "tailscale [REDACTED]"],
  ['{"password":"swordfish"}', '{"password":"[REDACTED]"}'],
  ["plain line with no secret", "plain line with no secret"],
])("log redaction %#", (input, expected) => {
  expect(redactLog(input)).toBe(expected);
});

test.each([
  ["a board URL with credentials", (c: Record<string, unknown>[]) => ((c[0] as Record<string, unknown>).board = "https://u:p@board.test/")],
  ["a plain-http board", (c: Record<string, unknown>[]) => ((c[0] as Record<string, unknown>).board = "http://board.test/")],
  ["a shell metacharacter in a container name", (c: Record<string, unknown>[]) => ((c[0] as Record<string, unknown>).container = "pilot;rm")],
  ["a short container id", (c: Record<string, unknown>[]) => ((c[0] as Record<string, unknown>).containerId = "3b6ad4e9ef16")],
  ["a coordinator role claim", (c: Record<string, unknown>[]) => ((c[0] as Record<string, unknown>).role = "coordinator")],
  ["a target on an undeclared host", (c: Record<string, unknown>[]) => ((c[0] as Record<string, unknown>).host = "cloud")],
  ["a duplicate target id", (c: Record<string, unknown>[]) => ((c[1] as Record<string, unknown>).id = "pilot")],
])("config validation rejects %s", (_name, mutate) => {
  const config = baseConfig("/tmp/remote-dev");
  mutate(config.targets);
  expect(Config.safeParse(config).success).toBe(false);
});

test("the fixture config itself is valid", () => {
  expect(Config.safeParse(baseConfig("/tmp/remote-dev")).success).toBe(true);
});
