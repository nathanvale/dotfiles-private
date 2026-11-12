import { expect, test } from "bun:test";
import { join } from "node:path";
import { Config } from "../../src/command-contract.ts";

test("the shipped example names the current consolidated pilot and is valid configuration", async () => {
  const example = await Bun.file(join(import.meta.dir, "../../examples/targets.json")).json();
  const parsed = Config.safeParse(example);
  expect(parsed.success).toBe(true);
  // Independent literal oracle: the assigned pilot's identity as supplied by the foreground owner.
  expect(parsed.data?.targets).toEqual([
    {
      container: "shepherdr-consolidated-20261112-01-agent-1",
      containerId: "393c8a52cb8a957946e34f63fd7975ddb02b50c371785f61e45ccedd600cd117",
      guide: "/workspace/START-HERE.md",
      host: "mini",
      id: "pilot",
      label: "Shepherdr consolidated pilot",
      role: "ui-pilot",
      serviceLog: "/home/agent/.local/state/pilot-runtime/consolidated-20261112-01/service.log",
      workspaceFolder: "/workspace",
    },
  ]);
  expect(parsed.data?.editor).toEqual({
    extensionsDir: "~/.local/state/remote-devcontainer-isolation/trial-01/extensions",
    userDataDir: "~/.local/state/remote-devcontainer-isolation/trial-01/user-data",
  });
  expect(parsed.data?.hosts.map((host) => `${host.id}|${host.sshAlias}|${host.dockerHost}`)).toEqual([
    "mini|mac-mini|unix:///Users/server/.orbstack/run/docker.sock",
  ]);
});

test("the in-container guide names the current pilot, its service log, and the readiness limits", async () => {
  const guide = await Bun.file(join(import.meta.dir, "../../guide/START-HERE.md")).text();
  expect(guide).toContain("mac-mini > OrbStack > shepherdr-consolidated-20261112-01-agent-1 > /workspace");
  expect(guide).toContain("(../home/agent/.local/state/pilot-runtime/consolidated-20261112-01/service.log)");
  expect(guide).toContain("/workspace/dotfiles");
  expect(guide).toContain("Connecting does not mean an engineering repository or a coding agent is ready.");
  expect(guide).not.toContain("shepherdr-pilot-main-20261112");
  expect(guide).not.toContain("main-d57a0261");
  expect(guide).not.toContain("No engineering repository has been set up");
});
